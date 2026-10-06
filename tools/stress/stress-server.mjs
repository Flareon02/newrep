// Stress server: the real API (createApi), matcher worker, SQLite history writer and timeline worker in one process,
// fed by synthetic LIVE/line updates through SnapshotState exactly like the collectors. No bookmaker is contacted.
//
//   DATA_DIR=<dir with monitor-v2.sqlite3> taskset -c 0 node --max-old-space-size=384 tools/stress/stress-server.mjs
//   env: PORT (18900), MATCHES (40), MARKETS (60), TICK_MS (1000), API_TOKEN
// Prints one JSON line every 10 s: event-loop lag, memory, history writer, timeline worker, feed revisions.
import { monitorEventLoopDelay } from 'node:perf_hooks';
import path from 'node:path';

const dataDir = process.env.DATA_DIR;
if (!dataDir) throw new Error('DATA_DIR is required');
// Never reach a bookmaker: every upstream origin points at a closed local port (fails at once).
for (const k of ['ASTEK_ORIGINS', 'GGBET_ORIGINS', 'DATABET_ORIGIN']) process.env[k] = 'http://127.0.0.1:9';
process.env.GGBET_LIVE_ENABLED = '0';
process.env.DATABET_LIVE_ENABLED = '0';
process.env.SQLITE_HISTORY_ENABLED = '1';
process.env.ODDS_HISTORY_ENABLED = '1';
const { config } = await import('../../server/src/config.js');
config.dataDir = dataDir;
const { setLogSink } = await import('../../server/src/logger.js');
setLogSink(() => {});
const { SnapshotState } = await import('../../server/src/state.js');
const { createApi } = await import('../../server/src/api.js');
const { UserStore } = await import('../../server/src/entitlements.js');
const { startSqliteHistory, sqliteHistoryStatus } = await import('../../server/src/match-history.js');
const { historyPrice } = await import('../../server/src/history-model.js');

const PORT = Number(process.env.PORT || 18900), MATCHES = Number(process.env.MATCHES || 40), MARKETS = Number(process.env.MARKETS || 60), TICK_MS = Number(process.env.TICK_MS || 1000);
const TOKEN = process.env.API_TOKEN || 'stress-token-0123456789abcdef';
const history = startSqliteHistory({ enabled: true, dataDir, retentionDays: 3650, minFreeMiB: 512 });

const states = Object.fromEntries(['live', 'prematch', 'fonbet-live', 'fonbet-prematch', 'pinnacle-live', 'pinnacle-prematch', 'ggbet-live'].map((n) => { const s = new SnapshotState(n, 60000); s.persist = async () => {}; return [n, s]; }));
const now0 = Date.now();
const rand = (a, b) => a + Math.random() * (b - a);
const price = (decimal, extra) => historyPrice({ ...extra, decimal: +decimal.toFixed(2) }, +decimal.toFixed(2));
// Per match: one score and a market book per provider in its own shape (Astek G/T, Fonbet factors, Pinnacle types).
const matches = Array.from({ length: MATCHES }, (_, i) => ({ i, team1: `Stress Alpha ${i}`, team2: `Stress Beta ${i}`, league: `Stress League ${i % 6}`, startAt: now0 - 1800000 + i * 60000, score: [0, 0], map: 1 }));
function astekMarkets(m) {
  const out = [{ key: `a${m.i}:0:1`, type: 'moneyline', title: 'Победитель', period: 0, status: 'open', rawGroup: 1, semanticGroup: 1, prices: [price(rand(1.4, 2.8), { designation: 'home', rawType: 1 }), price(rand(1.4, 2.8), { designation: 'away', rawType: 3 })] }];
  for (let k = 0; out.length < MARKETS / 3; k++) { const line = 18.5 + k; out.push({ key: `a${m.i}:${m.map}:17:${line}`, type: 'total', title: 'Тотал', period: m.map, status: 'open', rawGroup: 17, semanticGroup: 17, prices: [price(rand(1.6, 2.3), { designation: 'over', rawType: 9, points: line }), price(rand(1.6, 2.3), { designation: 'under', rawType: 10, points: line })] }); }
  return out;
}
function fonbetMarkets(m) {
  const out = [{ key: `f${m.i}:0:moneyline:main`, type: 'moneyline', title: 'Победитель', period: 0, status: 'open', prices: [price(rand(1.4, 2.8), { designation: 'home', rawType: 921 }), price(rand(1.4, 2.8), { designation: 'away', rawType: 923 })] }];
  const pairs = [[910, 912], [927, 928], [989, 991], [1569, 1572], [1672, 1675]];
  for (let k = 0; out.length < MARKETS / 3 && k < 40; k++) { const [h, a] = pairs[k % pairs.length], line = -0.5 - k; out.push({ key: `f${m.i}:${m.map}:handicap:${line}`, type: 'handicap', title: 'Фора', period: m.map, status: 'open', prices: [price(rand(1.6, 2.3), { designation: 'home', rawType: h, points: line }), price(rand(1.6, 2.3), { designation: 'away', rawType: a, points: -line })] }); }
  return out;
}
function pinnacleMarkets(m) {
  const out = [{ key: 's;0;m', type: 'moneyline', period: 0, status: 'open', prices: [price(rand(1.4, 2.8), { designation: 'home' }), price(rand(1.4, 2.8), { designation: 'away' })] }];
  for (let k = 0; out.length < MARKETS / 3; k++) { const line = 20.5 + k; out.push({ key: `s;${m.map};ou;${line}`, type: 'total', period: m.map, status: 'open', prices: [price(rand(1.6, 2.3), { designation: 'over', points: line }), price(rand(1.6, 2.3), { designation: 'under', points: line })] }); }
  return out;
}
const books = new Map();
function event(source, m) {
  let b = books.get(source + m.i);
  if (!b) { b = { markets: source === 'astek' ? astekMarkets(m) : source === 'fonbet' ? fonbetMarkets(m) : pinnacleMarkets(m) }; books.set(source + m.i, b); }
  // ~20% of the markets move every tick, sometimes a market is suspended and reopened
  for (const mk of b.markets) {
    if (Math.random() < 0.2) mk.prices = mk.prices.map((p) => price(Math.max(1.01, p.decimal + rand(-0.08, 0.08)), { designation: p.designation, rawType: p.rawType, points: p.points }));
    if (Math.random() < 0.01) mk.status = mk.status === 'open' ? 'suspended' : 'open';
  }
  const id = source === 'astek' ? 900000 + m.i : source === 'fonbet' ? 70000000 + m.i : 1700000000 + m.i;
  const score = `${m.score[0]}:${m.score[1]}`;
  return { id: `${source}-${id}`, sourceEventId: String(id), source, provider: source, category: 'Counter Strike 2', league: m.league, leagueId: `${source}-${m.i % 6}`, team1: m.team1, team2: m.team2, startAt: m.startAt, marketKind: 'main', bestOf: 3, scoreText: score, seriesScore: [0, 0], mapScores: [[...m.score]], activeMap: m.map, inLive: true, odds: { team1: m.team1, team2: m.team2, updatedAt: Date.now(), stale: false, markets: b.markets.map((x) => ({ ...x, prices: x.prices.map((p) => ({ ...p })) })) } };
}
let ticks = 0;
async function tick() {
  ticks++;
  for (const m of matches) if (Math.random() < 0.05) { m.score[Math.random() < 0.5 ? 0 : 1]++; if (Math.max(...m.score) >= 13) { m.score = [0, 0]; m.map = (m.map % 3) + 1; } }
  await states.live.success(matches.map((m) => event('astek', m)));
  await states['fonbet-live'].success(matches.map((m) => event('fonbet', m)));
  await states['pinnacle-live'].success(matches.map((m) => event('pinnacle', m)));
}
const api = createApi({ authToken: TOKEN, userStore: new UserStore({ read: async () => ({ users: [] }), write: async () => {} }), accessMode: 'auto', liveState: states.live, prematchState: states.prematch, fonbetLiveState: states['fonbet-live'], fonbetPrematchState: states['fonbet-prematch'], pinnacleLiveState: states['pinnacle-live'], pinnaclePrematchState: states['pinnacle-prematch'], ggbetLiveState: states['ggbet-live'], prematchCollector: { status: () => ({}), catalog: [] }, fonbetCollector: { status: () => ({}) }, pinnacleCollector: { status: () => ({}), catalog: [] }, ggbetCollector: { status: () => ({ enabled: true }) }, resultsService: { status: () => ({}), days: new Map(), getRange: async () => ({ complete: true, events: [] }) }, startedAt: Date.now() });
await new Promise((r) => api.listen(PORT, '127.0.0.1', r));
// Slow requests (≥ 400 ms server time) with the event-loop stall around them: tells waiting-for-CPU from waiting-for-work.
const slow = [];
api.on('request', (req, res) => { const t = performance.now(), path = String(req.url || '').split('?')[0]; res.on('finish', () => { const ms = performance.now() - t; if (ms >= 400 && !path.includes('stream')) slow.push({ path, ms: Math.round(ms) }); }); });
let lastBeat = performance.now(); const stalls = [];
setInterval(() => { const now = performance.now(), gap = now - lastBeat - 50; lastBeat = now; if (gap > 150) stalls.push(Math.round(gap)); }, 50).unref();
setInterval(() => { if (slow.length || stalls.length) console.log(JSON.stringify({ slow: slow.splice(0).slice(0, 12), stalls: stalls.splice(0).slice(0, 20) })); }, 10000).unref();
const lag = monitorEventLoopDelay({ resolution: 10 }); lag.enable();
let lagMax = 0;
setInterval(() => tick().catch((e) => console.error('tick', e.message)), TICK_MS);
setInterval(() => {
  const m = process.memoryUsage();
  lagMax = Math.max(lagMax, lag.max / 1e6);
  console.log(JSON.stringify({ t: Math.round((Date.now() - now0) / 1000), ticks, lag: { p50: +(lag.percentile(50) / 1e6).toFixed(1), p99: +(lag.percentile(99) / 1e6).toFixed(1), max: +(lag.max / 1e6).toFixed(1) }, rssMB: Math.round(m.rss / 1048576), heapMB: Math.round(m.heapUsed / 1048576), externalMB: Math.round(m.external / 1048576), history: (({ submitted, dropped, errors, queueDepth, writer }) => ({ submitted, dropped, errors, queueDepth, oddsRows: writer?.oddsRows, scoreRows: writer?.scoreRows, writeErrors: writer?.writeErrors, droppedW: writer?.dropped }))(sqliteHistoryStatus()), revision: states.live.revision }));
  lag.reset();
}, 10000);
process.on('SIGTERM', async () => { await history?.stop?.(); process.exit(0); });
process.on('SIGINT', () => process.exit(0));
console.log(JSON.stringify({ ready: true, port: PORT, matches: MATCHES, dataDir: path.resolve(dataDir) }));
