#!/usr/bin/env node
// Fault injection against the real server process: a mock AstekBet API (built from test fixtures) is switched
// between healthy and broken behaviours and the server is watched for the things that must never happen:
// a retry storm (request rate far above the backoff schedule), a crash, a stuck event loop, runaway memory -
// and the thing that must happen: recovery once the source is healthy again.
//
//   node tools/fault-injection.mjs [--window 45] [--modes http500,malformed,...]
//
// Exit code 1 if any mode violates its limits. Results are printed as a table and as JSON.
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'server');
const arg = (n, d) => { const i = process.argv.indexOf('--' + n); return i > 0 ? process.argv[i + 1] : d; };
const windowSec = Number(arg('window', 45));
const ALL = ['ok', 'http500', 'http429', 'http403', 'malformed', 'truncated', 'html', 'empty', 'slow', 'hang', 'reset', 'huge', 'success-false'];
const modes = String(arg('modes', ALL.join(','))).split(',').filter(Boolean);
const fixture = (name) => readFileSync(path.join(root, 'test/fixtures', name));
const liveBody = fixture('astek-live.json');

let mode = 'ok';
const hits = { live: [], other: [] };
const sockets = new Set();
const mock = http.createServer((req, res) => {
  const isLive = /LiveFeed\/Get1x2_VZip/.test(req.url);
  (isLive ? hits.live : hits.other).push(Date.now());
  const route = [[/LineFeed\/GetChampsZip/, 'astek-champs.json'], [/LineFeed\/Get1x2_VZip/, 'astek-prematch-games.json']].find(([re]) => re.test(req.url));
  if (!isLive && !route) { res.writeHead(404).end('{}'); return; }
  const body = isLive ? liveBody : fixture(route[1]);
  switch (mode) {
    case 'ok': return void res.writeHead(200, { 'content-type': 'application/json' }).end(body);
    case 'http500': return void res.writeHead(500).end('boom');
    case 'http429': return void res.writeHead(429, { 'retry-after': '30' }).end('slow down');
    case 'http403': return void res.writeHead(403).end('forbidden');
    case 'malformed': return void res.writeHead(200, { 'content-type': 'application/json' }).end('{"Value":[{"not json');
    case 'truncated': return void res.writeHead(200, { 'content-type': 'application/json' }).end(body.subarray(0, Math.floor(body.length / 2)));
    case 'html': return void res.writeHead(200, { 'content-type': 'text/html' }).end('<html><body>Just a moment...</body></html>');
    case 'empty': return void res.writeHead(200).end('');
    case 'success-false': return void res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ Success: false, Error: 'maintenance', Value: [] }));
    case 'slow': return void setTimeout(() => { if (!res.destroyed) res.writeHead(200, { 'content-type': 'application/json' }).end(body); }, 20000);
    case 'hang': return void 0;
    case 'reset': return void req.socket.destroy();
    case 'huge': return void res.writeHead(200, { 'content-type': 'application/json' }).end(Buffer.alloc(3 * 1024 * 1024, 32));
    default: return void res.writeHead(500).end();
  }
}).listen(0, '127.0.0.1');
mock.on('connection', (s) => { sockets.add(s); s.on('close', () => sockets.delete(s)); });
await new Promise((r) => mock.once('listening', r));
const upstream = `http://127.0.0.1:${mock.address().port}`;

const dataDir = mkdtempSync(path.join(tmpdir(), 'fault-'));
const port = 19500 + Math.floor(Math.random() * 400);
let exited = null;
const child = spawn('node', ['src/index.js'], { cwd: root, stdio: 'ignore', env: { ...process.env, DATA_DIR: dataDir, PORT: String(port), ASTEK_ORIGINS: upstream,
  FONBET_URLS: upstream + '/none', FONBET_DELTA_URLS: upstream + '/none', FONBET_RESULTS_URLS: upstream + '/none', GGBET_LIVE_ENABLED: '0', UPSTREAM_MAX_BYTES: String(1024 * 1024),
  LOG_LEVEL: 'warn', NODE_OPTIONS: '--disable-warning=ExperimentalWarning --max-old-space-size=320' } });
child.on('exit', (code, signal) => { exited = { code, signal }; });
const base = `http://127.0.0.1:${port}`;
const health = async () => { try { return await (await fetch(base + '/health', { signal: AbortSignal.timeout(4000) })).json(); } catch { return null; } };
const rss = () => Math.round(Number(/VmRSS:\s+(\d+)/.exec(readFileSync(`/proc/${child.pid}/status`, 'utf8'))[1]) / 1024);
for (let i = 0; i < 80 && !(await health()); i++) await new Promise((r) => setTimeout(r, 250));

async function waitHealthy(maxSec) {
  for (let t = 0; t < maxSec; t += 2) {
    const h = await health();
    if (h?.live?.astek && !h.live.astek.lastError && h.live.astek.count > 0 && !h.live.astek.stale) return t;
    await new Promise((r) => setTimeout(r, 2000));
  }
  return null;
}
const sleep = (s) => new Promise((r) => setTimeout(r, s * 1000));

const results = [];
const baseline = await waitHealthy(40);
console.log(`baseline: healthy after ${baseline}s, rss ${rss()} MiB`);
for (const m of modes) {
  mode = m;
  // Let in-flight requests of the previous mode finish so each window starts clean.
  for (const s of sockets) s.destroy();
  const from = hits.live.length, fromOther = hits.other.length, startRss = rss();
  let maxLag = 0, healthFailures = 0, sawError = '', liveAfter = -1;
  for (let t = 0; t < windowSec; t += 3) {
    await sleep(3);
    const h = await health();
    if (!h) healthFailures++; else { maxLag = Math.max(maxLag, h.runtime?.eventLoopMaxMs || 0); sawError ||= h.live?.astek?.lastError || ''; liveAfter = h.live?.astek?.count ?? -1; }
  }
  const windowHits = hits.live.length - from, otherHits = hits.other.length - fromOther;
  mode = 'ok';
  const recoveredAfter = await waitHealthy(m === 'http429' ? 75 : 50);
  const r = { mode: m, upstreamHitsInWindow: windowHits, hitsPerMinute: Math.round(windowHits * 60 / windowSec * 10) / 10, otherHitsPerMinute: Math.round(otherHits * 60 / windowSec * 10) / 10, serverLastError: sawError.slice(0, 60), eventsKeptWhileBroken: liveAfter,
    maxEventLoopMs: maxLag, healthFailures, rssStart: startRss, rssEnd: rss(), recoveredAfterSec: recoveredAfter, serverAlive: !exited };
  // Healthy polling is one request per ~5 s = 12/min. A failing source must be polled LESS than that (exponential backoff).
  const rateOk = m === 'ok' ? (r.hitsPerMinute >= 9 && r.hitsPerMinute <= 15) : r.hitsPerMinute <= 10;
  r.ok = r.serverAlive && rateOk && r.otherHitsPerMinute <= 25 && r.healthFailures === 0 && recoveredAfter !== null && r.maxEventLoopMs < 1500 && r.rssEnd - r.rssStart < 60;
  results.push(r);
  console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${m.padEnd(13)} hits/min live ${String(r.hitsPerMinute).padStart(5)} other ${String(r.otherHitsPerMinute).padStart(5)}  loop ${String(r.maxEventLoopMs).padStart(4)} ms  events kept ${String(r.eventsKeptWhileBroken).padStart(3)}  rss ${r.rssStart}->${r.rssEnd}  recovered ${recoveredAfter}s  lastError "${r.serverLastError}"`);
}
child.kill('SIGTERM'); mock.close(); for (const s of sockets) s.destroy();
await new Promise((r) => setTimeout(r, 1500));
rmSync(dataDir, { recursive: true, force: true });
console.log('\n' + JSON.stringify(results));
process.exit(results.every((r) => r.ok) ? 0 : 1);
