#!/usr/bin/env node
// Summarises a soak-sampler file: peaks, averages, CPU, trends (least-squares slope per day) and disk forecasts.
//
//   node tools/soak-report.mjs /var/lib/esports-monitor-soak/samples.jsonl [--since-hours 24] [--json]
//
// Forecasts are straight-line extrapolations of the measured slope; they say so and are only as good as the
// length and representativeness of the measurement (a weekday/weekend cycle needs at least a week).
import { readFileSync } from 'node:fs';

const file = process.argv[2];
if (!file) { console.error('usage: soak-report.mjs <samples.jsonl> [--since-hours N] [--json]'); process.exit(2); }
const arg = (n, d) => { const i = process.argv.indexOf('--' + n); return i > 0 ? process.argv[i + 1] : d; };
const sinceHours = Number(arg('since-hours', 0));
let rows = readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter((r) => r && r.at);
if (sinceHours) rows = rows.filter((r) => r.at >= Date.now() - sinceHours * 3600_000);
if (rows.length < 2) { console.error('not enough samples'); process.exit(1); }

const DAY = 86_400_000;
const pick = (fn) => rows.map((r) => { try { const v = fn(r); return Number.isFinite(v) ? { t: r.at, v } : null; } catch { return null; } }).filter(Boolean);
const stats = (s) => { if (!s.length) return null; const v = s.map((x) => x.v).sort((a, b) => a - b); return { min: v[0], avg: v.reduce((a, b) => a + b, 0) / v.length, p95: v[Math.floor(v.length * 0.95)], max: v.at(-1), last: s.at(-1).v, first: s[0].v }; };
// Least-squares slope in units per day.
const slope = (s) => { if (s.length < 3) return null; const n = s.length, t0 = s[0].t; let sx = 0, sy = 0, sxy = 0, sxx = 0; for (const { t, v } of s) { const x = (t - t0) / DAY; sx += x; sy += v; sxy += x * v; sxx += x * x; } const d = n * sxx - sx * sx; return d ? (n * sxy - sx * sy) / d : null; };
const r1 = (x) => (x == null ? '—' : Math.round(x * 10) / 10);

const spanH = (rows.at(-1).at - rows[0].at) / 3600_000;
const metrics = {
  'Process RSS, MiB': pick((r) => r.proc?.rssMiB),
  'Service memory (cgroup), MiB': pick((r) => r.cgroup?.memoryCurrentMiB),
  'V8 heap used, MiB': pick((r) => r.health?.heapUsedMiB),
  'History rows resident': pick((r) => r.health?.history?.rows),
  'History rows persisted': pick((r) => r.health?.history?.persistedRows),
  'Event loop max, ms': pick((r) => r.health?.eventLoopMaxMs),
  'Open file descriptors': pick((r) => r.proc?.fds),
  'Threads': pick((r) => r.proc?.threads),
  'Client connections': pick((r) => r.connections),
  'SQLite file, MiB': pick((r) => r.disk?.dbMiB ?? r.health?.storage?.sizeMiB),
  'SQLite WAL, MiB': pick((r) => r.disk?.walMiB ?? r.health?.storage?.walMiB),
  'Data directory, MiB': pick((r) => r.disk?.dataMiB),
  'Odds journal rows': pick((r) => r.health?.storage?.oddsRows),
  'journald, MiB': pick((r) => r.journalMiB),
  'Free disk, MiB': pick((r) => r.disk?.fsFreeMiB ?? r.health?.storage?.freeMiB),
  'MemAvailable (system), MiB': pick((r) => r.system?.memAvailableMiB),
};
const out = { file, samples: rows.length, from: rows[0].iso, to: rows.at(-1).iso, hours: r1(spanH), metrics: {} };
for (const [name, s] of Object.entries(metrics)) { const st = stats(s); if (st) out.metrics[name] = { ...Object.fromEntries(Object.entries(st).map(([k, v]) => [k, r1(v)])), slopePerDay: r1(slope(s)) }; }

// CPU: delta of consumed CPU time between consecutive samples (cgroup nanoseconds if present, else /proc ticks).
const cpu = [];
for (let i = 1; i < rows.length; i++) {
  const a = rows[i - 1], b = rows[i], dt = (b.at - a.at) / 1000;
  if (!(dt > 0) || (b.pid && a.pid && b.pid !== a.pid)) continue;
  const pct = a.cgroup?.cpuNsec != null && b.cgroup?.cpuNsec != null ? ((b.cgroup.cpuNsec - a.cgroup.cpuNsec) / 1e9 / dt) * 100 : (a.proc?.cpuTicks != null && b.proc?.cpuTicks != null ? ((b.proc.cpuTicks - a.proc.cpuTicks) / 100 / dt) * 100 : null);
  if (pct != null && pct >= 0) cpu.push({ t: b.at, v: pct });
}
out.cpuPercentOfOneCore = stats(cpu) && Object.fromEntries(Object.entries(stats(cpu)).map(([k, v]) => [k, r1(v)]));

const counters = (fn) => { const s = pick(fn); return s.length ? s.at(-1).v - s[0].v : null; };
out.counters = {
  restarts: counters((r) => r.cgroup?.restarts), processChanges: new Set(rows.map((r) => r.pid).filter(Boolean)).size - 1,
  healthProbeFailures: rows.filter((r) => r.health?.error).length, apiRequests: counters((r) => r.health?.apiTraffic?.requests),
  matcherFailures: counters((r) => r.health?.matcher?.failures), matcherTimeouts: counters((r) => r.health?.matcher?.timeouts),
};
const feedNames = new Set(rows.flatMap((r) => Object.keys(r.health?.feeds || {})));
out.feeds = {};
for (const name of feedNames) {
  const s = rows.map((r) => r.health?.feeds?.[name]).filter(Boolean);
  out.feeds[name] = { samples: s.length, stalePercent: r1((s.filter((x) => x.stale).length / s.length) * 100), withError: r1((s.filter((x) => x.err).length / s.length) * 100), lastCount: s.at(-1).count, lastError: s.at(-1).err || '' };
}
out.upstream = {};
const last = rows.findLast?.((r) => r.health?.upstream)?.health.upstream || {};
for (const [k, v] of Object.entries(last)) { const first = rows.find((r) => r.health?.upstream?.[k])?.health.upstream[k]; out.upstream[k] = { attempts: v.attempts - first.attempts, failures: v.failures - first.failures }; }

// Forecast of what grows on disk.
const growth = {};
for (const name of ['SQLite file, MiB', 'Data directory, MiB', 'journald, MiB']) {
  const m = out.metrics[name]; if (!m || m.slopePerDay == null) continue;
  const perDay = Math.max(0, m.slopePerDay);
  growth[name] = { now: m.last, perDay: r1(perDay), after30d: r1(m.last + perDay * 30), after90d: r1(m.last + perDay * 90), after365d: r1(m.last + perDay * 365) };
}
out.diskForecast = { note: `straight-line from ${r1(spanH)} h of samples; indicative only`, ...growth };

if (process.argv.includes('--json')) { console.log(JSON.stringify(out, null, 2)); process.exit(0); }
console.log(`Soak report: ${out.samples} samples, ${out.from} -> ${out.to} (${out.hours} h)\n`);
console.log('| Metric | first | avg | p95 | max | last | slope/day |\n|---|---|---|---|---|---|---|');
for (const [name, m] of Object.entries(out.metrics)) console.log(`| ${name} | ${m.first} | ${m.avg} | ${m.p95} | ${m.max} | ${m.last} | ${m.slopePerDay} |`);
if (out.cpuPercentOfOneCore) { const c = out.cpuPercentOfOneCore; console.log(`| CPU, % of one core | ${c.first} | ${c.avg} | ${c.p95} | ${c.max} | ${c.last} | — |`); }
console.log('\nCounters:', JSON.stringify(out.counters));
console.log('\nFeeds:'); for (const [k, v] of Object.entries(out.feeds)) console.log(`  ${k.padEnd(20)} stale ${String(v.stalePercent).padStart(5)}%  errors ${String(v.withError).padStart(5)}%  events ${v.lastCount}  ${v.lastError}`);
console.log('\nUpstream requests during the window:'); for (const [k, v] of Object.entries(out.upstream)) console.log(`  ${k.padEnd(20)} attempts ${v.attempts}  failures ${v.failures}`);
console.log('\nDisk forecast (' + out.diskForecast.note + '):'); for (const [k, v] of Object.entries(growth)) console.log(`  ${k.padEnd(22)} now ${v.now}  +${v.perDay}/day  30d ${v.after30d}  90d ${v.after90d}  365d ${v.after365d}`);
