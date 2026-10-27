import assert from "node:assert/strict";
import test from "node:test";
import {
	checkBuckets,
	cpuPercent,
	currentStatus,
	DAY,
	HOUR,
	hostBuckets,
	MINUTE,
	parseCpu,
	parseMem,
	parsePhira,
	percentile,
	summarizePhira,
	summarizeTarget,
	windowUptime,
} from "./lib.mjs";

test("cpu percent comes from the idle share of the /proc/stat delta", () => {
	const a = parseCpu("cpu  100 0 100 700 100 0 0 0 0 0\ncpu0 1 2 3 4");
	const b = parseCpu("cpu  200 0 200 1300 100 0 0 0 0 0\n");
	assert.deepEqual(a, { idle: 800, total: 1000 });
	assert.equal(cpuPercent(a, b), 25);
	assert.equal(cpuPercent(b, b), 0);
});

test("memory use is total minus available", () => {
	const mem = parseMem("MemTotal:  8388608 kB\nMemFree: 100 kB\nMemAvailable:  2097152 kB\n");
	assert.deepEqual(mem, { totalMb: 8192, usedMb: 6144, percent: 75 });
});

test("percentile picks the nearest rank", () => {
	assert.equal(percentile([], 95), null);
	assert.equal(percentile([5], 95), 5);
	assert.equal(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 95), 10);
	assert.equal(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 50), 5);
});

test("buckets average latency over successful checks only", () => {
	const rows = [
		{ ts: 0, ok: 1, latency: 100 },
		{ ts: MINUTE, ok: 1, latency: 300 },
		{ ts: 2 * MINUTE, ok: 0, latency: null },
		{ ts: HOUR + MINUTE, ok: 1, latency: 50 },
	];
	const [first, second] = checkBuckets(rows, {
		start: 0,
		size: HOUR,
		count: 2,
		now: HOUR + 2 * MINUTE,
		firstTs: 0,
		intervalMs: MINUTE,
		missingIsDown: false,
	});
	assert.deepEqual(first, { t: 0, checks: 3, uptime: 66.67, latency: 200, p95: 300 });
	assert.deepEqual(second, { t: HOUR, checks: 1, uptime: 100, latency: 50, p95: 50 });
});

test("for the host, missing checks count as down; elsewhere they are unknown", () => {
	const rows = [{ ts: 0, ok: 1, latency: 10 }];
	const opts = { start: 0, size: 10 * MINUTE, count: 1, now: 10 * MINUTE, firstTs: 0, intervalMs: MINUTE };
	assert.equal(checkBuckets(rows, { ...opts, missingIsDown: false })[0].uptime, 100);
	assert.equal(checkBuckets(rows, { ...opts, missingIsDown: true })[0].uptime, 10);
	assert.equal(
		windowUptime(rows, { from: 0, now: 10 * MINUTE, firstTs: 0, intervalMs: MINUTE, missingIsDown: true }),
		10,
	);
});

test("buckets before monitoring started have no uptime", () => {
	const [before] = checkBuckets([], {
		start: 0,
		size: DAY,
		count: 1,
		now: 2 * DAY,
		firstTs: DAY + HOUR,
		intervalMs: MINUTE,
		missingIsDown: true,
	});
	assert.equal(before.uptime, null);
});

test("status: one failure is degraded, two in a row are down, stale is unknown", () => {
	const ctx = { now: 10 * MINUTE, intervalMs: MINUTE, slowMs: 1000 };
	const ok = (ts, latency = 100) => ({ ts, ok: 1, latency });
	const bad = (ts) => ({ ts, ok: 0, latency: null });
	assert.equal(currentStatus([ok(10 * MINUTE)], ctx), "up");
	assert.equal(currentStatus([ok(10 * MINUTE, 2000)], ctx), "degraded");
	assert.equal(currentStatus([bad(10 * MINUTE), ok(9 * MINUTE)], ctx), "degraded");
	assert.equal(currentStatus([bad(10 * MINUTE), bad(9 * MINUTE)], ctx), "down");
	assert.equal(currentStatus([ok(MINUTE)], ctx), "unknown");
	assert.equal(currentStatus([], ctx), "unknown");
});

test("host buckets average cpu and memory, empty slots are null", () => {
	const out = hostBuckets(
		[
			{ ts: 0, cpu: 10, mem: 40 },
			{ ts: MINUTE, cpu: 20, mem: 50 },
		],
		{ start: 0, size: 5 * MINUTE, count: 2 },
	);
	assert.deepEqual(out, [
		{ t: 0, cpu: 15, mem: 45 },
		{ t: 5 * MINUTE, cpu: null, mem: null },
	]);
});

test("a target summary carries 30 days, 24 hours and the latest check", () => {
	const now = Date.UTC(2026, 9, 8, 12, 30);
	const rows = [
		{ ts: now - 2 * MINUTE, ok: 1, latency: 120, code: null },
		{ ts: now - MINUTE, ok: 0, latency: null, code: "timeout" },
	];
	const s = summarizeTarget({ id: "kv", slowMs: 1000 }, rows, {
		now,
		firstTs: rows[0].ts,
		intervalMs: MINUTE,
	});
	assert.equal(s.days.length, 30);
	assert.equal(s.hours.length, 24);
	assert.equal(s.status, "degraded");
	assert.equal(s.error, "timeout");
	assert.equal(s.latencyMs, null);
	assert.equal(s.uptime24h, 50);
	assert.equal(s.days.at(-1).t, Date.UTC(2026, 9, 8));
});

test("phira samples keep counts only, never room or player names", () => {
	const status = {
		status: "ok",
		players: 3,
		cpu: { process: 3.54, system: 12.5 },
		ram: { process: 52428800, used: 6442450944, total: 17179869184 },
	};
	const rooms = {
		rooms: [
			{ roomid: "1", state: "playing", players: [{ name: "a", id: 1 }] },
			{ roomid: "2", state: "select_chart", players: [] },
		],
	};
	assert.deepEqual(parsePhira(status, rooms), {
		players: 3,
		rooms: 2,
		playing: 1,
		cpu: 12.5,
		cpuProc: 3.5,
		ramProc: 52428800,
		ramUsed: 6442450944,
		ramTotal: 17179869184,
	});
	assert.equal(parsePhira(status, null).rooms, null);
	assert.equal(parsePhira({ status: "ok" }, rooms).players, null);
});

test("phira summary shows live numbers only while samples are fresh", () => {
	const now = Date.UTC(2026, 9, 27, 12, 0);
	const row = (ts, players) => ({
		ts,
		players,
		rooms: 2,
		playing: 1,
		cpu: 10,
		cpu_proc: 1.5,
		ram_proc: 52428800,
		ram_used: 1073741824,
		ram_total: 4294967296,
	});
	const fresh = summarizePhira([row(now - 6 * MINUTE, 2), row(now - MINUTE, 4)], {
		now,
		intervalMs: MINUTE,
	});
	assert.equal(fresh.players, 4);
	assert.equal(fresh.mem, 25);
	assert.equal(fresh.memProcessMb, 50);
	assert.equal(fresh.memTotalMb, 4096);
	assert.equal(fresh.series24h.length, 288);
	assert.equal(fresh.series30d.length, 720);
	assert.deepEqual(fresh.series24h.at(-2), { t: now - 5 * MINUTE, players: 4, rooms: 2, cpu: 10, mem: 25 });
	assert.deepEqual(fresh.series30d.at(-2), { t: now - HOUR, players: 3, rooms: 2, cpu: 10, mem: 25 });

	const stale = summarizePhira([row(now - 10 * MINUTE, 4)], { now, intervalMs: MINUTE });
	assert.equal(stale.players, null);
	assert.equal(stale.mem, null);
	assert.equal(stale.sampledAt, now - 10 * MINUTE);
});
