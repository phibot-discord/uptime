export const MINUTE = 60_000;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;

const clamp = (n) => Math.min(100, Math.max(0, n));
const round1 = (n) => (n == null ? null : Math.round(n * 10) / 10);
const round2 = (n) => (n == null ? null : Math.round(n * 100) / 100);

export function parseCpu(stat) {
	const line = stat.split("\n").find((l) => l.startsWith("cpu "));
	if (!line) throw new Error("no cpu line in /proc/stat");
	const v = line.trim().split(/\s+/).slice(1).map(Number);
	const idle = (v[3] ?? 0) + (v[4] ?? 0);
	const total = v.reduce((a, b) => a + b, 0);
	return { idle, total };
}

export function cpuPercent(prev, cur) {
	const dt = cur.total - prev.total;
	if (dt <= 0) return 0;
	return round1(clamp(100 * (1 - (cur.idle - prev.idle) / dt)));
}

export function parseMem(meminfo) {
	const kb = (key) => {
		const m = meminfo.match(new RegExp(`^${key}:\\s+(\\d+)`, "m"));
		return m ? Number(m[1]) : 0;
	};
	const total = kb("MemTotal");
	const available = kb("MemAvailable");
	const used = Math.max(0, total - available);
	return {
		totalMb: Math.round(total / 1024),
		usedMb: Math.round(used / 1024),
		percent: total ? round1((100 * used) / total) : 0,
	};
}

export function percentile(sorted, p) {
	if (!sorted.length) return null;
	const i = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
	return sorted[Math.max(0, i)];
}

function expectedChecks(from, to, firstTs, intervalMs) {
	if (firstTs == null) return 0;
	const start = Math.max(from, firstTs);
	return to > start ? Math.round((to - start) / intervalMs) : 0;
}

export function checkBuckets(
	rows,
	{ start, size, count, now, firstTs, intervalMs, missingIsDown },
) {
	const acc = Array.from({ length: count }, (_, i) => ({
		t: start + i * size,
		checks: 0,
		ok: 0,
		lat: [],
	}));
	for (const r of rows) {
		const b = acc[Math.floor((r.ts - start) / size)];
		if (!b) continue;
		b.checks++;
		if (r.ok) {
			b.ok++;
			if (r.latency != null) b.lat.push(r.latency);
		}
	}
	return acc.map((b) => {
		const expected = expectedChecks(
			b.t,
			Math.min(b.t + size, now),
			firstTs,
			intervalMs,
		);
		const denom = missingIsDown ? Math.max(b.checks, expected) : b.checks;
		b.lat.sort((x, y) => x - y);
		const mean = b.lat.length
			? b.lat.reduce((a, x) => a + x, 0) / b.lat.length
			: null;
		return {
			t: b.t,
			checks: b.checks,
			uptime: denom ? round2((100 * b.ok) / denom) : null,
			latency: mean == null ? null : Math.round(mean),
			p95: percentile(b.lat, 95),
		};
	});
}

export function windowUptime(rows, { from, now, firstTs, intervalMs, missingIsDown }) {
	let checks = 0;
	let ok = 0;
	for (const r of rows) {
		if (r.ts < from) continue;
		checks++;
		if (r.ok) ok++;
	}
	const expected = expectedChecks(from, now, firstTs, intervalMs);
	const denom = missingIsDown ? Math.max(checks, expected) : checks;
	return denom ? round2((100 * ok) / denom) : null;
}

export function currentStatus(recent, { now, intervalMs, slowMs }) {
	const last = recent[0];
	if (!last || now - last.ts > 5 * intervalMs) return "unknown";
	if (!last.ok) return recent[1] && !recent[1].ok ? "down" : "degraded";
	const fails = recent.slice(0, 5).filter((r) => !r.ok).length;
	if ((last.latency ?? 0) > slowMs || fails >= 2) return "degraded";
	return "up";
}

export function averageBuckets(rows, keys, { start, size, count }) {
	const acc = Array.from({ length: count }, (_, i) => ({
		t: start + i * size,
		sum: keys.map(() => 0),
		n: keys.map(() => 0),
	}));
	for (const r of rows) {
		const b = acc[Math.floor((r.ts - start) / size)];
		if (!b) continue;
		keys.forEach((k, j) => {
			if (r[k] == null) return;
			b.sum[j] += r[k];
			b.n[j]++;
		});
	}
	return acc.map((b) => {
		const out = { t: b.t };
		keys.forEach((k, j) => {
			out[k] = b.n[j] ? round1(b.sum[j] / b.n[j]) : null;
		});
		return out;
	});
}

export const hostBuckets = (rows, opts) => averageBuckets(rows, ["cpu", "mem"], opts);

const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);
const mb = (bytes) => (bytes == null ? null : Math.round(bytes / 1048576));

export function parsePhira(status, rooms) {
	const list = Array.isArray(rooms?.rooms) ? rooms.rooms : null;
	return {
		players: num(status?.players),
		rooms: list ? list.length : null,
		playing: list ? list.filter((r) => r?.state === "playing").length : null,
		cpu: round1(num(status?.cpu?.system)),
		cpuProc: round1(num(status?.cpu?.process)),
		ramProc: num(status?.ram?.process),
		ramUsed: num(status?.ram?.used),
		ramTotal: num(status?.ram?.total),
	};
}

export function summarizeTarget(target, rows, { now, firstTs, intervalMs }) {
	const missingIsDown = Boolean(target.missingIsDown);
	const opts = { now, firstTs, intervalMs, missingIsDown };
	const today = Math.floor(now / DAY) * DAY;
	const hour = Math.floor(now / HOUR) * HOUR;
	const recent = rows.slice(-6).reverse();
	const last = recent[0];
	return {
		id: target.id,
		status: currentStatus(recent, { now, intervalMs, slowMs: target.slowMs }),
		latencyMs: last?.ok ? last.latency : null,
		checkedAt: last?.ts ?? null,
		error: last && !last.ok ? last.code : null,
		uptime24h: windowUptime(rows, { ...opts, from: now - DAY }),
		uptime30d: windowUptime(rows, { ...opts, from: today - 29 * DAY }),
		days: checkBuckets(rows, { ...opts, start: today - 29 * DAY, size: DAY, count: 30 }),
		hours: checkBuckets(rows, { ...opts, start: hour - 23 * HOUR, size: HOUR, count: 24 }),
	};
}

export function summarizeHost(rows, { now, cores, uptimeSec }) {
	const last = rows.at(-1);
	const five = 5 * MINUTE;
	const slot = Math.floor(now / five) * five;
	const hour = Math.floor(now / HOUR) * HOUR;
	return {
		cpu: last?.cpu ?? null,
		mem: last?.mem ?? null,
		memUsedMb: last?.mem_used ?? null,
		memTotalMb: last?.mem_total ?? null,
		load1: last?.load1 ?? null,
		cores,
		uptimeSec,
		sampledAt: last?.ts ?? null,
		series24h: hostBuckets(rows, { start: slot - 287 * five, size: five, count: 288 }),
		series30d: hostBuckets(rows, { start: hour - 719 * HOUR, size: HOUR, count: 720 }),
	};
}

const PHIRA_KEYS = ["players", "rooms", "cpu", "mem"];

export function summarizePhira(rows, { now, intervalMs }) {
	const points = rows.map((r) => ({
		ts: r.ts,
		players: r.players,
		rooms: r.rooms,
		cpu: r.cpu,
		mem: r.ram_total ? round1((100 * r.ram_used) / r.ram_total) : null,
	}));
	const last = rows.at(-1);
	const live = last && now - last.ts <= 5 * intervalMs ? last : null;
	const five = 5 * MINUTE;
	const slot = Math.floor(now / five) * five;
	const hour = Math.floor(now / HOUR) * HOUR;
	return {
		players: live?.players ?? null,
		rooms: live?.rooms ?? null,
		playing: live?.playing ?? null,
		cpu: live?.cpu ?? null,
		cpuProcess: live?.cpu_proc ?? null,
		mem: live ? (points.at(-1)?.mem ?? null) : null,
		memProcessMb: mb(live?.ram_proc ?? null),
		memUsedMb: mb(live?.ram_used ?? null),
		memTotalMb: mb(live?.ram_total ?? null),
		sampledAt: last?.ts ?? null,
		series24h: averageBuckets(points, PHIRA_KEYS, { start: slot - 287 * five, size: five, count: 288 }),
		series30d: averageBuckets(points, PHIRA_KEYS, { start: hour - 719 * HOUR, size: HOUR, count: 720 }),
	};
}
