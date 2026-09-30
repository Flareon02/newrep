#!/usr/bin/env node
// ORIGINAL vs NEW: runs two servers (a Git ref such as `main`, and the working tree) against the same
// mock AstekBet upstream, calls the same endpoints on both and reports every difference in status
// code or payload (volatile timestamps/revisions removed).
//
//   node tools/compare-with-original.mjs [--original main]
//
// Expected differences are listed in docs/COMPATIBILITY-CHECKLIST.md; anything else is a regression.
import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const arg = (n, d) => { const i = process.argv.indexOf('--' + n); return i > 0 ? process.argv[i + 1] : d; };
const ref = arg('original', 'main');
const work = mkdtempSync(path.join(tmpdir(), 'compare-'));

// Checkout of the original server from Git (no node_modules: reuse the working tree's).
const originalDir = path.join(work, 'original');
mkdirSync(originalDir);
execFileSync('sh', ['-c', `git archive ${ref}:server | tar -x -C ${originalDir}`], { cwd: root });
const nodeModules = path.join(root, 'server', 'node_modules');
try { symlinkSync(nodeModules, path.join(originalDir, 'node_modules')); } catch {}

const fixtures = path.join(root, 'server', 'test', 'fixtures');
const routes = [[/LiveFeed\/Get1x2_VZip/, 'astek-live.json'], [/LineFeed\/GetChampsZip/, 'astek-champs.json'], [/LineFeed\/Get1x2_VZip/, 'astek-prematch-games.json']];
const mock = http.createServer((req, res) => {
  const hit = routes.find(([re]) => re.test(req.url));
  if (!hit) { res.writeHead(404).end('{}'); return; }
  res.writeHead(200, { 'content-type': 'application/json' }).end(readFileSync(path.join(fixtures, hit[1])));
}).listen(0, '127.0.0.1');
await new Promise((r) => mock.once('listening', r));
const upstream = `http://127.0.0.1:${mock.address().port}`;

function start(cwd, port) {
  const data = mkdtempSync(path.join(work, 'data-'));
  const child = spawn('node', ['src/index.js'], { cwd, stdio: 'ignore', env: { ...process.env, DATA_DIR: data, PORT: String(port), ASTEK_ORIGINS: upstream,
    FONBET_URLS: upstream + '/none', FONBET_DELTA_URLS: upstream + '/none', FONBET_RESULTS_URLS: upstream + '/none', GGBET_LIVE_ENABLED: '0', NODE_OPTIONS: '--disable-warning=ExperimentalWarning' } });
  return { child, base: `http://127.0.0.1:${port}` };
}
const a = start(originalDir, 18700), b = start(path.join(root, 'server'), 18701);
for (const s of [a, b]) for (let i = 0; i < 80; i++) { try { if ((await fetch(s.base + '/health')).ok) break; } catch {} await new Promise((r) => setTimeout(r, 250)); }
await new Promise((r) => setTimeout(r, 7000)); // let both collect the same fixtures

const VOLATILE = /(?:At|Time|Ms|ms|Revision|revision|uptime|elapsed|serverNow|version|Version|requestId|pending|Elapsed|Seconds|firstSeen|enteredLive)$|^(?:at|ts|rev|id|stamp|updated|generated)$/;
const strip = (v) => Array.isArray(v) ? v.map(strip) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).filter(([k]) => !VOLATILE.test(k)).map(([k, x]) => [k, strip(x)])) : v;
const liveId = async (base) => ((await (await fetch(base + '/api/ui/live?thin=1')).json()).events || [])[0]?.id;
const paths = ['/api/ui/live?thin=1', '/api/ui/live?compact=1&thin=1', '/api/ui/prematch?thin=1', '/api/ui/leagues?limit=20&thin=1', '/api/ui/history?limit=5&thin=1',
  '/api/live', '/api/prematch', '/api/live/astek', '/api/leagues', '/api/league-links', '/api/hltv/data', '/api/odds/history?source=astek&id=1',
  '/api/score-history?ids=astek:1', '/api/odds/timeline?ids=astek:1', '/api/prematch/odds?ids=astek:1', '/api/statistics/match?id=nope', '/api/team-logos/00000000000000000000000000000000',
  '/health', '/api/status', '/api/odds/job?id=nope', '/api/nope', '/api/odds/history?source=evil&id=1', '/api/ui/event-detail?view=live&id=missing'];
const id = await liveId(a.base);
if (id) paths.push('/api/ui/event-detail?view=live&id=' + encodeURIComponent(id));
const posts = [['/api/ui/odds-watch', { ids: ['1'] }], ['/api/prematch/compare', { events: [], options: {} }], ['/api/odds/manual', {}], ['/api/league-links', {}]];

async function fetchBoth(method, p, body) {
  const out = [];
  for (const s of [a, b]) {
    try {
      const r = await fetch(s.base + p, { method, headers: body ? { 'content-type': 'application/json' } : undefined, body: body ? JSON.stringify(body) : undefined });
      const text = await r.text(); let json; try { json = JSON.parse(text); } catch { json = text.slice(0, 80); }
      out.push({ status: r.status, json: strip(json) });
    } catch (e) { out.push({ status: 0, json: String(e.message) }); }
  }
  return out;
}
const diffKeys = (x, y, prefix = '') => {
  if (typeof x !== typeof y || Array.isArray(x) !== Array.isArray(y) || x === null || y === null || typeof x !== 'object') return JSON.stringify(x) === JSON.stringify(y) ? [] : [`${prefix || '.'}: ${JSON.stringify(x)?.slice(0, 60)} -> ${JSON.stringify(y)?.slice(0, 60)}`];
  const keys = new Set([...Object.keys(x), ...Object.keys(y)]), diffs = [];
  for (const k of keys) { if (!(k in x)) diffs.push(`${prefix}.${k}: (absent) -> added`); else if (!(k in y)) diffs.push(`${prefix}.${k}: REMOVED`); else diffs.push(...diffKeys(x[k], y[k], `${prefix}.${k}`)); }
  return diffs;
};
let different = 0;
for (const [method, p, body] of [...paths.map((p) => ['GET', p]), ...posts.map(([p, b2]) => ['POST', p, b2])]) {
  const [o, n] = await fetchBoth(method, p, body);
  const diffs = o.status === n.status ? diffKeys(o.json, n.json) : [`status ${o.status} -> ${n.status}`];
  if (diffs.length) { different++; console.log(`DIFF ${method} ${p}`); for (const d of diffs.slice(0, 8)) console.log('     ' + d); if (diffs.length > 8) console.log(`     ... +${diffs.length - 8} more`); }
  else console.log(`same ${method} ${p} (${n.status})`);
}
for (const s of [a, b]) s.child.kill('SIGTERM');
mock.close();
await new Promise((r) => setTimeout(r, 800));
rmSync(work, { recursive: true, force: true });
console.log(`\n${different} endpoint(s) differ between ${ref} and the working tree`);
