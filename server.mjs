import { mkdirSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import { DatabaseSync } from "node:sqlite";
import {
	cpuPercent,
	DAY,
	parseCpu,
	parseMem,
	parsePhira,
	summarizeHost,
	summarizePhira,
	summarizeTarget,
} from "./lib.mjs";

const env = process.env;
const trim = (s) => (s || "").trim().replace(/\/+$/, "");

const cfg = {
	host: env.UPTIME_HOST || "127.0.0.1",
	port: Number(env.UPTIME_PORT || 9321),
	db: env.UPTIME_DB || fileURLToPath(new URL("./data/uptime.db", import.meta.url)),
	intervalMs: Number(env.UPTIME_INTERVAL_SEC || 60) * 1000,
	timeoutMs: Number(env.UPTIME_TIMEOUT_SEC || 10) * 1000,
	keepMs: 31 * DAY,
	cacheMs: 30_000,
	publicUrl: trim(env.UPTIME_PUBLIC_URL) || "https://api.phibot.dev/uptime",
	workerUrl: trim(env.UPTIME_WORKER_URL) || "https://sync.phibot.dev",
	cf: {
		account: env.CLOUDFLARE_ACCOUNT_ID?.trim(),
		namespace: env.CLOUDFLARE_KV_NAMESPACE_ID?.trim(),
		token: env.CLOUDFLARE_API_TOKEN?.trim(),
	},
	unpack: {
		listen: env.UNPACK_LISTEN?.trim() || "127.0.0.1:8788",
		secret: env.UNPACK_SECRET?.trim(),
	},
	phira: {
		url: trim(env.UPTIME_PHIRA_URL) || "https://papi.phibot.dev",
		token: env.UPTIME_PHIRA_TOKEN?.trim(),
	},
};

async function probe(url, { headers, accept }) {
	const started = performance.now();
	try {
		const res = await fetch(url, {
			headers,
			redirect: "manual",
			signal: AbortSignal.timeout(cfg.timeoutMs),
		});
		const body = await res.text();
		const latency = Math.round(performance.now() - started);
		return accept(res.status, body)
			? { ok: 1, latency, code: null, body }
			: { ok: 0, latency, code: `http_${res.status}` };
	} catch (err) {
		const code = err?.name === "TimeoutError" ? "timeout" : "network";
		return { ok: 0, latency: null, code };
	}
}

const notConfigured = async () => ({ ok: 0, latency: null, code: "not_configured" });

function readJson(text) {
	try {
		return JSON.parse(text);
	} catch {
		return null;
	}
}

async function checkPhira() {
	const headers = { Authorization: `Bearer ${cfg.phira.token}` };
	const result = await probe(`${cfg.phira.url}/v1/status`, {
		headers,
		accept: (status, body) => status === 200 && readJson(body)?.status === "ok",
	});
	if (!result.ok) return result;
	const rooms = await fetch(`${cfg.phira.url}/v1/rooms`, {
		headers,
		signal: AbortSignal.timeout(cfg.timeoutMs),
	})
		.then((res) => res.text().then((text) => (res.ok ? readJson(text) : null)))
		.catch(() => null);
	return { ...result, phira: parsePhira(readJson(result.body), rooms) };
}

const TARGETS = [
	{
		id: "kv",
		slowMs: 1500,
		run:
			cfg.cf.account && cfg.cf.namespace && cfg.cf.token
				? () =>
						probe(
							`https://api.cloudflare.com/client/v4/accounts/${cfg.cf.account}/storage/kv/namespaces/${cfg.cf.namespace}/values/uptime%3Aprobe`,
							{
								headers: { Authorization: `Bearer ${cfg.cf.token}` },
								accept: (status, body) =>
									status === 200 || (status === 404 && body.includes('"code":10009')),
							},
						)
				: notConfigured,
	},
	{
		id: "workers",
		slowMs: 1500,
		run: cfg.unpack.secret
			? () =>
					probe(`${cfg.workerUrl}/`, {
						headers: { Authorization: `Bearer ${cfg.unpack.secret}` },
						accept: (status) => status === 200,
					})
			: notConfigured,
	},
	{
		id: "rust",
		slowMs: 500,
		run: cfg.unpack.secret
			? () =>
					probe(`http://${cfg.unpack.listen}/status`, {
						headers: { "x-phi-proxy-key": cfg.unpack.secret },
						accept: (status) => status === 200,
					})
			: notConfigured,
	},
	{
		id: "phira",
		slowMs: 1500,
		run: cfg.phira.token ? checkPhira : notConfigured,
	},
	{
		id: "assets",
		slowMs: 1500,
		missingIsDown: true,
		run: () =>
			probe(`${cfg.publicUrl}/ping`, {
				headers: { "cache-control": "no-cache" },
				accept: (status, body) => status === 200 && body.includes('"ok":true'),
			}),
	},
];

mkdirSync(dirname(cfg.db), { recursive: true });
const db = new DatabaseSync(cfg.db);
db.exec(`
	PRAGMA journal_mode = WAL;
	PRAGMA synchronous = NORMAL;
	CREATE TABLE IF NOT EXISTS checks (
		ts INTEGER NOT NULL,
		target TEXT NOT NULL,
		ok INTEGER NOT NULL,
		latency INTEGER,
		code TEXT
	);
	CREATE INDEX IF NOT EXISTS checks_target_ts ON checks (target, ts);
	CREATE TABLE IF NOT EXISTS host (
		ts INTEGER PRIMARY KEY,
		cpu REAL NOT NULL,
		mem REAL NOT NULL,
		mem_used INTEGER,
		mem_total INTEGER,
		load1 REAL
	);
	CREATE TABLE IF NOT EXISTS phira (
		ts INTEGER PRIMARY KEY,
		players INTEGER,
		rooms INTEGER,
		playing INTEGER,
		cpu REAL,
		cpu_proc REAL,
		ram_proc INTEGER,
		ram_used INTEGER,
		ram_total INTEGER
	);
`);

const insertCheck = db.prepare(
	"INSERT INTO checks (ts, target, ok, latency, code) VALUES (?, ?, ?, ?, ?)",
);
const insertHost = db.prepare(
	"INSERT OR REPLACE INTO host (ts, cpu, mem, mem_used, mem_total, load1) VALUES (?, ?, ?, ?, ?, ?)",
);
const insertPhira = db.prepare(
	"INSERT OR REPLACE INTO phira (ts, players, rooms, playing, cpu, cpu_proc, ram_proc, ram_used, ram_total) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
);
const selectChecks = db.prepare(
	"SELECT ts, ok, latency, code FROM checks WHERE target = ? AND ts >= ? ORDER BY ts",
);
const selectHost = db.prepare(
	"SELECT ts, cpu, mem, mem_used, mem_total, load1 FROM host WHERE ts >= ? ORDER BY ts",
);
const selectPhira = db.prepare(
	"SELECT ts, players, rooms, playing, cpu, cpu_proc, ram_proc, ram_used, ram_total FROM phira WHERE ts >= ? ORDER BY ts",
);
const selectFirst = db.prepare("SELECT MIN(ts) AS first FROM checks");
const purgeChecks = db.prepare("DELETE FROM checks WHERE ts < ?");
const purgeHost = db.prepare("DELETE FROM host WHERE ts < ?");
const purgePhira = db.prepare("DELETE FROM phira WHERE ts < ?");

let lastCpu = null;
let lastPurge = 0;
let cached = null;

async function sampleHost(ts) {
	const [stat, meminfo] = await Promise.all([
		readFile("/proc/stat", "utf8"),
		readFile("/proc/meminfo", "utf8"),
	]);
	const cpu = parseCpu(stat);
	const prev = lastCpu;
	lastCpu = cpu;
	if (!prev) return;
	const mem = parseMem(meminfo);
	insertHost.run(
		ts,
		cpuPercent(prev, cpu),
		mem.percent,
		mem.usedMb,
		mem.totalMb,
		Math.round(os.loadavg()[0] * 100) / 100,
	);
}

async function tick() {
	const ts = Date.now();
	const results = await Promise.all(TARGETS.map((t) => t.run()));
	db.exec("BEGIN");
	try {
		results.forEach((r, i) => {
			insertCheck.run(ts, TARGETS[i].id, r.ok, r.latency, r.code);
			if (r.phira) {
				const p = r.phira;
				insertPhira.run(ts, p.players, p.rooms, p.playing, p.cpu, p.cpuProc, p.ramProc, p.ramUsed, p.ramTotal);
			}
		});
		db.exec("COMMIT");
	} catch (err) {
		db.exec("ROLLBACK");
		throw err;
	}
	await sampleHost(ts).catch((err) => console.error("host sample failed:", err.message));
	if (ts - lastPurge > 3_600_000) {
		purgeChecks.run(ts - cfg.keepMs);
		purgeHost.run(ts - cfg.keepMs);
		purgePhira.run(ts - cfg.keepMs);
		lastPurge = ts;
	}
	cached = null;
}

function schedule() {
	const wait = cfg.intervalMs - (Date.now() % cfg.intervalMs);
	setTimeout(() => {
		tick()
			.catch((err) => console.error("tick failed:", err))
			.finally(schedule);
	}, wait);
}

function summary() {
	const now = Date.now();
	if (cached && now - cached.at < cfg.cacheMs) return cached;
	const since = now - 31 * DAY;
	const firstTs = selectFirst.get()?.first ?? null;
	const body = JSON.stringify({
		generatedAt: now,
		intervalSec: cfg.intervalMs / 1000,
		since: firstTs,
		targets: TARGETS.map((t) => {
			const rows = selectChecks.all(t.id, since);
			return summarizeTarget(t, rows, {
				now,
				firstTs: rows[0]?.ts ?? null,
				intervalMs: cfg.intervalMs,
			});
		}),
		host: summarizeHost(selectHost.all(since), {
			now,
			cores: os.cpus().length,
			uptimeSec: Math.round(os.uptime()),
		}),
		phira: summarizePhira(selectPhira.all(since), { now, intervalMs: cfg.intervalMs }),
	});
	cached = { at: now, body, gz: gzipSync(body) };
	return cached;
}

function send(res, status, body, cache = "no-store", gz = null) {
	const headers = {
		"content-type": "application/json; charset=utf-8",
		"cache-control": cache,
		"access-control-allow-origin": "*",
		"x-content-type-options": "nosniff",
		vary: "accept-encoding",
	};
	if (gz) headers["content-encoding"] = "gzip";
	res.writeHead(status, headers);
	res.end(gz ?? (typeof body === "string" ? body : JSON.stringify(body)));
}

const server = createServer((req, res) => {
	const path = new URL(req.url || "/", "http://local").pathname.replace(/\/+$/, "") || "/";
	if (req.method !== "GET" && req.method !== "HEAD") {
		return send(res, 405, { error: "method not allowed" });
	}
	if (path === "/uptime/ping" || path === "/ping") return send(res, 200, { ok: true });
	if (path === "/uptime" || path === "/") {
		try {
			const { body, gz } = summary();
			const wantsGzip = /\bgzip\b/.test(req.headers["accept-encoding"] || "");
			return send(res, 200, body, "public, max-age=30", wantsGzip ? gz : null);
		} catch (err) {
			console.error("summary failed:", err);
			return send(res, 500, { error: "summary failed" });
		}
	}
	send(res, 404, { error: "not found" });
});

server.listen(cfg.port, cfg.host, () => {
	console.log(`phi-uptime on http://${cfg.host}:${cfg.port} (db ${cfg.db})`);
	tick().catch((err) => console.error("first tick failed:", err));
	schedule();
});

for (const sig of ["SIGTERM", "SIGINT"]) {
	process.on(sig, () => {
		server.close();
		db.close();
		process.exit(0);
	});
}
