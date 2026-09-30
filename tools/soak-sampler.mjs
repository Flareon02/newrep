#!/usr/bin/env node
// Long-running measurement: appends one JSON line per interval to a file, so a soak test can run unattended for
// days and be analysed later with tools/soak-report.mjs (also from a different session).
//
//   node tools/soak-sampler.mjs --url http://127.0.0.1:8080 --out /var/lib/esports-monitor-soak/samples.jsonl \
//        --service esports-monitor --data-dir /var/lib/esports-monitor/data [--interval 60]
//
// Without --service it finds the server by `--pid` or by scanning /proc for "node src/index.js".
// Everything is read-only; the sampler never sends a token and never talks to any bookmaker.
import { execFile } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const arg = (n, d) => { const i = process.argv.indexOf('--' + n); return i > 0 ? process.argv[i + 1] : d; };
const url = arg('url', 'http://127.0.0.1:8080'), out = arg('out', './samples.jsonl'), service = arg('service', ''), dataDir = arg('data-dir', '');
const interval = Number(arg('interval', 60)) * 1000, once = process.argv.includes('--once');
const MAX_FILE = 20 * 1024 * 1024;
mkdirSync(path.dirname(path.resolve(out)), { recursive: true });

const run = (cmd, args) => new Promise((resolve) => execFile(cmd, args, { timeout: 8000 }, (e, stdout) => resolve(e ? '' : String(stdout))));
const read = (f) => { try { return readFileSync(f, 'utf8'); } catch { return ''; } };
const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : null; };
const mib = (b) => (b == null ? null : Math.round((b / 1048576) * 10) / 10);

function dirSize(dir, depth = 0) {
  let total = 0;
  try {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { if (depth < 6) total += dirSize(full, depth + 1); }
      else try { total += statSync(full).size; } catch {}
    }
  } catch {}
  return total;
}

async function findPid() {
  if (service) {
    const show = await run('systemctl', ['show', service, '-p', 'MainPID', '-p', 'MemoryCurrent', '-p', 'MemoryPeak', '-p', 'CPUUsageNSec', '-p', 'NRestarts', '-p', 'ActiveState', '-p', 'TasksCurrent']);
    const props = Object.fromEntries(show.split('\n').filter(Boolean).map((l) => { const i = l.indexOf('='); return [l.slice(0, i), l.slice(i + 1)]; }));
    return { pid: num(props.MainPID) || null, cgroup: { memoryCurrentMiB: mib(num(props.MemoryCurrent)), memoryPeakMiB: mib(num(props.MemoryPeak)), cpuNsec: num(props.CPUUsageNSec), restarts: num(props.NRestarts), state: props.ActiveState, tasks: num(props.TasksCurrent) } };
  }
  const explicit = num(arg('pid', ''));
  if (explicit) return { pid: explicit, cgroup: null };
  for (const d of readdirSync('/proc').filter((x) => /^\d+$/.test(x))) if (/node\s+src\/index\.js/.test(read(`/proc/${d}/cmdline`).replace(/\0/g, ' '))) return { pid: Number(d), cgroup: null };
  return { pid: null, cgroup: null };
}

async function sample() {
  const at = Date.now();
  const { pid, cgroup } = await findPid();
  const row = { at, iso: new Date(at).toISOString(), pid, cgroup };
  if (pid) {
    const status = read(`/proc/${pid}/status`), field = (k) => num((new RegExp(`${k}:\\s+(\\d+)`).exec(status) || [])[1]);
    row.proc = { rssMiB: mib((field('VmRSS') || 0) * 1024), hwmMiB: mib((field('VmHWM') || 0) * 1024), threads: field('Threads') };
    try { row.proc.fds = readdirSync(`/proc/${pid}/fd`).length; } catch {}
    const stat = read(`/proc/${pid}/stat`).split(') ')[1]?.split(' ');
    if (stat) row.proc.cpuTicks = Number(stat[11]) + Number(stat[12]);
  }
  const conns = await run('ss', ['-Htn', 'state', 'established', `( sport = :${new URL(url).port || 80} )`]);
  row.connections = conns ? conns.split('\n').filter(Boolean).length : null;
  try {
    const t0 = Date.now(), h = await (await fetch(url + '/health', { signal: AbortSignal.timeout(6000) })).json();
    row.health = {
      ms: Date.now() - t0, version: h.version, uptime: h.uptimeSeconds, rssMiB: h.runtime?.rssMiB, heapUsedMiB: h.runtime?.heapUsedMiB, heapTotalMiB: h.runtime?.heapTotalMiB, externalMiB: h.runtime?.externalMiB,
      eventLoopMaxMs: h.runtime?.eventLoopMaxMs, matcher: h.runtime?.matcher && { workers: h.runtime.matcher.workers, failures: h.runtime.matcher.failures, timeouts: h.runtime.matcher.timeouts },
      history: h.runtime?.history, storage: h.runtime?.storage && { sizeMiB: h.runtime.storage.sizeMiB, walMiB: h.runtime.storage.walMiB, oddsRows: h.runtime.storage.oddsRows, freeMiB: h.runtime.storage.freeMiB, diskLevel: h.runtime.storage.diskLevel, integrity: h.runtime.storage.integrity },
      sse: h.sse, oddsWatch: h.oddsWatch, apiTraffic: h.apiTraffic && { requests: h.apiTraffic.requests, requestsLastMinute: h.apiTraffic.requestsLastMinute },
      upstream: Object.fromEntries(Object.entries(h.upstreamRequests || {}).map(([k, v]) => [k, { attempts: v.attempts, successes: v.successes, failures: v.failures, inFlight: v.inFlight }])),
      feeds: Object.fromEntries([...Object.entries(h.live || {}).map(([k, v]) => ['live.' + k, v]), ...Object.entries(h.prematch || {}).map(([k, v]) => ['prematch.' + k, v])].map(([k, v]) => [k, { count: v.count, historyCount: v.historyCount, stale: v.stale, err: String(v.lastError || '').slice(0, 80), http: v.lastHttpStatus }])),
      results: h.results && { lastError: String(h.results.lastError || '').slice(0, 80) },
    };
  } catch (e) { row.health = { error: String(e.message || e).slice(0, 100) }; }
  if (dataDir) {
    row.disk = { dataMiB: mib(dirSize(dataDir)), dbMiB: mib(existsSync(path.join(dataDir, 'monitor-v2.sqlite3')) ? statSync(path.join(dataDir, 'monitor-v2.sqlite3')).size : 0), walMiB: mib(existsSync(path.join(dataDir, 'monitor-v2.sqlite3-wal')) ? statSync(path.join(dataDir, 'monitor-v2.sqlite3-wal')).size : 0) };
    const fs = await run('df', ['-Pm', dataDir]); const parts = fs.trim().split('\n').pop()?.split(/\s+/); if (parts?.length > 4) row.disk.fsFreeMiB = Number(parts[3]);
  }
  const journal = await run('journalctl', ['--disk-usage']); const jm = /(\d+(?:\.\d+)?)([KMG])/.exec(journal); if (jm) row.journalMiB = Math.round(Number(jm[1]) * ({ K: 1 / 1024, M: 1, G: 1024 }[jm[2]]) * 10) / 10;
  const mem = read('/proc/meminfo'), kb = (k) => num((new RegExp(`${k}:\\s+(\\d+)`).exec(mem) || [])[1]);
  row.system = { memAvailableMiB: mib((kb('MemAvailable') || 0) * 1024), swapUsedMiB: mib(((kb('SwapTotal') || 0) - (kb('SwapFree') || 0)) * 1024), load1: os.loadavg()[0] };
  return row;
}

async function loop() {
  for (;;) {
    let row;
    try { row = await sample(); } catch (e) { row = { at: Date.now(), error: String(e.message || e) }; }
    try { if (existsSync(out) && statSync(out).size > MAX_FILE) renameSync(out, `${out}.${Date.now()}`); appendFileSync(out, JSON.stringify(row) + '\n'); } catch (e) { console.error('write failed', e.message); }
    if (once) { console.log(JSON.stringify(row, null, 1)); return; }
    await new Promise((r) => setTimeout(r, interval));
  }
}
loop();
