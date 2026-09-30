#!/usr/bin/env node
// Steady-state CPU/RAM of the real server process against a local mock of the AstekBet API
// (served from test fixtures), with one simulated extension: SSE stream + /api/ui polling.
//
//   node tools/bench-steady-state.mjs [--seconds 120]
//
// The other books (Fonbet, GGBET, Pinnacle) are not mocked and fail fast, so this measures a
// LOWER bound for a full production feed. Use it to compare before/after a change, not as an absolute budget.
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, readFileSync as read, rmSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'server');
const arg = (n, d) => { const i = process.argv.indexOf('--' + n); return i > 0 ? process.argv[i + 1] : d; };
const seconds = Number(arg('seconds', 120));
const fixture = (name) => readFileSync(path.join(root, 'test/fixtures', name));
const routes = [[/LiveFeed\/Get1x2_VZip/, 'astek-live.json'], [/LineFeed\/GetChampsZip/, 'astek-champs.json'], [/LineFeed\/Get1x2_VZip/, 'astek-prematch-games.json']];
let upstreamHits = 0;
const mock = http.createServer((req, res) => {
  const hit = routes.find(([re]) => re.test(req.url));
  if (!hit) { res.writeHead(404).end('{}'); return; }
  upstreamHits++;
  res.writeHead(200, { 'content-type': 'application/json' }).end(fixture(hit[1]));
}).listen(0, '127.0.0.1');
await new Promise((r) => mock.once('listening', r));
const dataDir = mkdtempSync(path.join(tmpdir(), 'bench-steady-'));
const port = 19000 + Math.floor(Math.random() * 500);
const child = spawn('node', ['src/index.js'], { cwd: root, stdio: 'ignore', env: {
  ...process.env, DATA_DIR: dataDir, PORT: String(port), ASTEK_ORIGINS: `http://127.0.0.1:${mock.address().port}`,
  FONBET_URLS: `http://127.0.0.1:${mock.address().port}/none`, FONBET_DELTA_URLS: `http://127.0.0.1:${mock.address().port}/none`, FONBET_RESULTS_URLS: `http://127.0.0.1:${mock.address().port}/none`,
  GGBET_LIVE_ENABLED: '0', PREMATCH_CONCURRENCY: '1', UV_THREADPOOL_SIZE: '2', LOG_LEVEL: 'warn',
  NODE_OPTIONS: '--disable-warning=ExperimentalWarning --max-old-space-size=320' } });
const base = `http://127.0.0.1:${port}`;
const clk = 100; // USER_HZ on Linux
const cpuTicks = () => { const f = readFileSync(`/proc/${child.pid}/stat`, 'utf8').split(') ')[1].split(' '); return Number(f[11]) + Number(f[12]); };
const rssMiB = () => { const m = /VmRSS:\s+(\d+) kB/.exec(read(`/proc/${child.pid}/status`, 'utf8')); return Math.round(Number(m[1]) / 1024); };
const peakMiB = () => { const m = /VmHWM:\s+(\d+) kB/.exec(read(`/proc/${child.pid}/status`, 'utf8')); return Math.round(Number(m[1]) / 1024); };
for (let i = 0; i < 60; i++) { try { if ((await fetch(base + '/health')).ok) break; } catch {} await new Promise((r) => setTimeout(r, 250)); }
const sse = new AbortController();
fetch(base + '/api/feed-stream?modes=live,prematch,results,history,leagues&thin=1', { signal: sse.signal }).then(async (r) => { for await (const _ of r.body); }).catch(() => {});
const poll = setInterval(() => { for (const p of ['/api/ui/live?meta=1&thin=1', '/api/ui/prematch?meta=1&thin=1']) fetch(base + p).catch(() => {}); }, 5000);
const idle = { rss: rssMiB(), cpu: cpuTicks() }, samples = []; let last = idle.cpu;
for (let t = 10; t <= seconds; t += 10) {
  await new Promise((r) => setTimeout(r, 10000));
  const now = cpuTicks(); samples.push({ t, rss: rssMiB(), cpuPct: Math.round(((now - last) / clk / 10) * 1000) / 10 }); last = now;
}
const health = await (await fetch(base + '/health')).json();
clearInterval(poll); sse.abort(); child.kill('SIGTERM'); mock.close(); rmSync(dataDir, { recursive: true, force: true });
const avg = (k) => Math.round(samples.reduce((n, s) => n + s[k], 0) / samples.length * 10) / 10;
console.log(JSON.stringify({ seconds, startRssMiB: idle.rss, avgRssMiB: avg('rss'), peakRssMiB: peakMiB(), avgCpuPct: avg('cpuPct'), maxCpuPct: Math.max(...samples.map((s) => s.cpuPct)),
  eventLoopMaxMs: health.runtime?.eventLoopMaxMs, heapUsedMiB: health.runtime?.heapUsedMiB, upstreamHits, liveEvents: health.live?.astek?.count, samples }, null, 1));
