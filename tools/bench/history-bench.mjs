#!/usr/bin/env node
// DEV benchmark of the first History page (server side), on a COPY of a data directory. No collector runs and nothing is
// fetched from upstream: the states are loaded from SQLite, the API is mounted with idle stub collectors.
//
//   node tools/bench/history-bench.mjs /path/to/copy-of-data-dir [--runs 5]
//
// Prints the time of each phase: loading the states, the SQLite history reads, the matcher worker, and the HTTP request
// the extension makes (`/api/ui/history?...&fast=1&limit=200&offset=0&thin=1`) cold and warm.
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const dir = path.resolve(process.argv[2] || '');
const runs = Number((process.argv.indexOf('--runs') > 0 && process.argv[process.argv.indexOf('--runs') + 1]) || 5);
if (!process.argv[2]) { console.error('usage: history-bench.mjs <copy-of-data-dir> [--runs N]'); process.exit(2); }
process.env.DATA_DIR = dir; process.env.LOG_LEVEL = 'error'; process.env.GGBET_LIVE_ENABLED = '0'; process.env.DATABET_LIVE_ENABLED = '0';
const src = (f) => import(path.join(root, 'server/src', f));
const { SnapshotState } = await src('state.js');
const { createApi } = await src('api.js');
const { matchAsync, stopMatcher } = await src('matcher-client.js');
const { closeSqliteStorage } = await src('sqlite-storage.js');
const ms = (t0) => Math.round(performance.now() - t0);
const median = (a) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)];

let t0 = performance.now();
const names = ['live', 'prematch', 'fonbet-live', 'fonbet-prematch', 'ggbet-live', 'databet-live', 'pinnacle-prematch', 'pinnacle-live'];
const s = Object.fromEntries(names.map((n) => [n, new SnapshotState(n, 3600000)]));
for (const st of Object.values(s)) { st.persist = async () => {}; await st.load(); }
console.log(`load states: ${ms(t0)} ms; rows resident ${Object.values(s).reduce((n, st) => n + st.historyIndex.size, 0)}, total ${Object.values(s).reduce((n, st) => n + (st.historyTotal || 0), 0)}`);

// Phase timings, the same calls uiHistoryPage makes for the first page.
const pre = [s.prematch, s['fonbet-prematch'], s['pinnacle-prematch']], live = [s.live, s['fonbet-live'], s['pinnacle-live'], s['ggbet-live']];
const phase = { sqlite: [], worker: [] };
for (let i = 0; i < runs; i++) {
  t0 = performance.now(); const preParts = pre.map((st) => st.recentHistory(0, 800)), liveParts = live.map((st) => st.recentHistory(0, 800)); phase.sqlite.push(ms(t0));
  t0 = performance.now();
  await matchAsync('ui-history-page', { prematchHistory: preParts.flatMap((x) => x.events), liveHistory: liveParts.flatMap((x) => x.events), currentPrematch: pre.flatMap((st) => st.events || []), currentLive: live.flatMap((st) => st.events || []), params: { limit: '200', offset: '0', thin: '1', sources: 'astek,fonbet,pinnacle', showExtras: '1', fast: '1' } });
  phase.worker.push(ms(t0));
}
console.log(`history reads (7 states, take 800): median ${median(phase.sqlite)} ms [${phase.sqlite.join(', ')}]`);
console.log(`matcher worker ui-history-page:      median ${median(phase.worker)} ms [${phase.worker.join(', ')}]`);
const idle = { status: () => ({}), running: false, catalog: [] };
const server = createApi({ liveState: s.live, prematchState: s.prematch, fonbetLiveState: s['fonbet-live'], fonbetPrematchState: s['fonbet-prematch'], pinnaclePrematchState: s['pinnacle-prematch'], pinnacleLiveState: s['pinnacle-live'], ggbetLiveState: s['ggbet-live'], databetLiveState: s['databet-live'], liveCollector: idle, prematchCollector: idle, fonbetCollector: idle, pinnacleCollector: idle, ggbetCollector: { status: () => ({ enabled: false }) }, databetCollector: { status: () => ({ enabled: false }) }, resultsService: { status: () => ({}), days: new Map() }, startedAt: Date.now() });
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const url = `http://127.0.0.1:${server.address().port}/api/ui/history?limit=200&thin=1&sources=astek,fonbet,pinnacle&showExtras=1&fast=1`;
const http = [];
for (let i = 0; i < runs; i++) {
  t0 = performance.now(); const res = await fetch(url + `&q=&bust=${i}`); const body = await res.json(); http.push({ ms: ms(t0), status: res.status, n: body.events?.length, bytes: JSON.stringify(body).length });
}
console.log(`HTTP first page (distinct query each run, no page cache): median ${median(http.map((x) => x.ms))} ms ${JSON.stringify(http)}`);
t0 = performance.now(); await (await fetch(url + '&bust=0')).json(); console.log(`HTTP repeated query (page cache): ${ms(t0)} ms`);
await new Promise((r) => server.close(r)); await stopMatcher(); closeSqliteStorage();
process.exit(0);
