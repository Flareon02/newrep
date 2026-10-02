import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

// Two local mirrors for the detail tests; set before config.js is imported.
const listen = (handler) => new Promise((resolve) => { const s = http.createServer(handler); s.listen(0, '127.0.0.1', () => resolve(s)); });
const hits = { bad: 0, good: 0 }; let goodDown = false;
const game = { I: 900001, O1E: 'Alpha', O2E: 'Beta', GE: [{ G: 1, E: [[{ G: 1, T: 1, C: 1.8 }], [{ G: 1, T: 3, C: 2.0 }]] }] };
const bad = await listen((req, res) => { hits.bad++; res.statusCode = 503; res.end('down'); });
const good = await listen((req, res) => {
  hits.good++; if (goodDown) { res.statusCode = 503; return res.end('down'); }
  const id = Number(new URL(req.url, 'http://x').searchParams.get('id'));
  res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ Success: true, Value: { ...game, I: id } }));
});
process.env.ASTEK_ORIGINS = `http://127.0.0.1:${bad.address().port},http://127.0.0.1:${good.address().port}`;
const { PrematchCollector, ASTEK_ROW_LIMIT } = await import('../src/prematch.js');
const { OriginHealth } = await import('../src/astek-origins.js');
const detail = await import('../src/astek-detail.js');
test.after(() => { bad.close(); good.close(); });

// ---- Astek line: a mock that enforces the limits observed on the real API ----------------------------------------
// GetChampsZip catalog with GC per league; Get1x2_VZip answers at most 50 rows whatever `count` says, accepts count 50
// or 100 only (56 → HTTP 406); a `champs=` list of several leagues is HTTP 406 (on the real line almost every group
// contains a league that breaks it); without `champs` it is the global aggregate (the 50 soonest games). The league sizes are the staging catalog of 2026-10-02 (50 leagues, one with 54).
const GC = [54, 17, 12, 12, 8, 8, 7, 7, 7, 6, 6, 6, 5, 5, 5, 5, 4, 4, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1];
const T0 = 1_800_000_000;
// Big leagues play often, so the aggregate's 50 soonest games are mostly theirs and only a few small leagues are
// complete in it (on staging: 4 of 48 leagues), like the real line.
const startOf = (gc, i, k) => (gc === 1 && i % 4 === 0 ? T0 + i : T0 + i * 7 + Math.round((k + 0.5) * (259200 / gc)));
function upstream(sizes = GC) {
  const leagues = sizes.map((gc, i) => ({ id: 3000 + i, gc }));
  const games = leagues.flatMap((l, i) => Array.from({ length: l.gc }, (_, k) => ({ I: l.id * 1000 + k, LI: l.id, LE: `Counter-Strike 2. League ${i}`, O1E: `Team ${l.id}-${k}a`, O2E: `Team ${l.id}-${k}b`, S: startOf(l.gc, i, k) })));
  const calls = [];
  const reply = (Value) => ({ payload: { Success: true, Value }, status: 200 });
  const request = async (url) => {
    calls.push(url); const u = new URL(url);
    if (url.includes('GetChampsZip')) return reply(leagues.map((l, i) => ({ SI: 40, LI: l.id, L: `Counter-Strike 2. League ${i}`, GC: l.gc })));
    const count = Number(u.searchParams.get('count')), champs = u.searchParams.get('champs');
    if (![50, 100].includes(count)) throw Object.assign(new Error('HTTP 406'), { status: 406 });
    const ids = champs ? champs.split(',').map(Number) : null;
    if (ids && ids.length > 1) throw Object.assign(new Error('HTTP 406'), { status: 406 });
    return reply(games.filter((g) => !ids || ids.includes(g.LI)).sort((a, b) => a.S - b.S).slice(0, Math.min(count, ASTEK_ROW_LIMIT)));
  };
  return { leagues, games, calls, request };
}
const lineState = () => ({ events: [], async success(events) { this.events = events; }, async failure(e) { throw e; }, async partialFailure(e) { this.partial = e.message; } });
const ids = (events) => events.map((e) => e.id).sort();
const project = (events) => events.map((e) => JSON.stringify([e.id, e.sourceEventId, e.team1, e.team2, e.league, e.leagueId, e.startAt, e.status, e.url, e.odds?.markets?.length])).sort();

// The pre-change cycle, request for request: catalog, aggregate, then one `champs=` request per league the
// aggregate did not complete, with count = max(50, GC+1) (HTTP 406 for the 54-game league).
async function oldCycle(up) {
  const champs = (await up.request('https://a/service-api/LineFeed/GetChampsZip?sport=40')).payload.Value;
  const agg = (await up.request('https://a/service-api/LineFeed/Get1x2_VZip?sports=40&count=50')).payload.Value;
  const got = new Map(); for (const g of agg) got.set(g.LI, (got.get(g.LI) || 0) + 1);
  const ok = []; let errors = 0;
  for (const c of champs.filter((c) => (got.get(c.LI) || 0) < c.GC)) {
    try { const rows = (await up.request(`https://a/service-api/LineFeed/Get1x2_VZip?sports=40&champs=${c.LI}&count=${Math.max(50, c.GC + 1)}`)).payload.Value; if (rows.length < Math.max(50, c.GC + 1)) ok.push(c.LI); } catch { errors++; }
  }
  return { requests: up.calls.length, errors, completeLeagues: ok.length + champs.filter((c) => (got.get(c.LI) || 0) >= c.GC).length };
}

const collector = (up, opts = {}) => { const state = lineState(); const c = new PrematchCollector(state, { request: up.request, sleep: async () => {}, persist: async () => {}, origins: new OriginHealth({ origins: () => ['https://a.example'] }), ...opts }); return { c, state }; };
const lineCalls = (up) => up.calls.filter((u) => u.includes('Get1x2_VZip') && new URL(u).searchParams.get('champs'));

test('Astek line: one request per league the aggregate misses, count=50 always, never a grouped request, no 406', async () => {
  const before = await oldCycle(upstream());
  const up = upstream(), { c, state } = collector(up);
  const cycles = [];
  for (let i = 0; i < 3; i++) { const n = up.calls.length; await c.poll(); cycles.push(up.calls.length - n); }
  console.log(`Astek line cycle: before ${before.requests} requests (${before.errors} HTTP 406); now ${cycles.join(', ')} requests per cycle`);
  assert.ok(cycles.every((n) => n === before.requests), `${cycles} vs ${before.requests}`);
  assert.equal(before.errors, 1, 'the old count=GC+1 request for the 54-game league');
  assert.equal(c.failures.length, 0); assert.equal(state.partial, undefined);
  for (const url of lineCalls(up)) { const q = new URL(url).searchParams; assert.equal(q.get('count'), '50', url); assert.ok(!q.get('champs').includes(','), url); }
  // Every game of every league that fits the row window.
  const fits = new Set(up.leagues.filter((l) => l.gc < ASTEK_ROW_LIMIT).map((l) => String(l.id)));
  assert.deepEqual(ids(state.events.filter((e) => fits.has(e.leagueId))), up.games.filter((g) => fits.has(String(g.LI))).map((g) => String(g.I)).sort());
  assert.equal(state.events.filter((e) => !fits.has(e.leagueId)).length, ASTEK_ROW_LIMIT, 'the 54-game league: its 50-row window');
  // The same rows as the path without the aggregate (one request per league).
  const up2 = upstream(), single = collector(up2);
  single.c.batchSupported = false; single.c.batchRetryAt = Number.MAX_SAFE_INTEGER;
  await single.c.poll();
  assert.deepEqual(project(state.events), project(single.state.events));
});

test('Astek line: a league over the 50-row cap keeps later games, and an old id re-issued as a new id is dropped', async () => {
  const up = upstream([54, 3, 2]), { c, state } = collector(up);
  await c.poll();
  const big = String(up.leagues[0].id), first = state.events.filter((e) => e.leagueId === big);
  assert.equal(first.length, 50); assert.equal(c.failures.length, 0); assert.equal(state.partial, undefined);
  assert.ok(!up.calls.some((u) => /count=(?!50\b)/.test(u)), 'never a count the API rejects');
  assert.equal(up.calls.filter((u) => new URL(u).searchParams.get('champs') === big).length, 1);
  // Games beyond the window that were known before stay.
  const later = up.games.filter((g) => String(g.LI) === big).sort((a, b) => a.S - b.S).slice(50);
  const asEvent = (g) => ({ ...first[0], id: String(g.I), sourceEventId: String(g.I), team1: g.O1E, team2: g.O2E, startAt: g.S * 1000 });
  // (all but the last one: the slot beyond the window is bounded by GC − 50, and the case below takes it)
  c.champCache[big].events.push(...later.slice(0, -1).map(asEvent));
  // A fixture Astek re-issued: the old id is cached, the fresh answer has the same teams and start under a new id.
  const edgeGame = up.games.filter((g) => String(g.LI) === big).sort((a, b) => a.S - b.S)[49];
  c.champCache[big].events.push({ ...asEvent(edgeGame), id: '777000001', sourceEventId: '777000001' });
  // Same teams but another start time is another match and stays.
  c.champCache[big].events.push({ ...asEvent(edgeGame), id: '777000002', sourceEventId: '777000002', startAt: edgeGame.S * 1000 + 3600_000 });
  await c.poll();
  const now = state.events.filter((e) => e.leagueId === big).map((e) => e.id);
  assert.ok(!now.includes('777000001'), 'stale duplicate removed');
  assert.ok(now.includes(String(edgeGame.I)));
  assert.ok(now.includes('777000002'), 'same teams, other start time: kept');
  assert.deepEqual(now.filter((id) => id !== '777000002').sort(), up.games.filter((g) => String(g.LI) === big).map((g) => String(g.I)).filter((id) => id !== String(later.at(-1).I)).sort());
  assert.equal(c.status().staleReplaced, 1);
});

test('Astek line: HTTP 406 or an invalid answer for a league request does not move the collector to another mirror', async () => {
  for (const fault of [Object.assign(new Error('HTTP 406'), { status: 406 }), 'invalid']) {
    const up = upstream([3, 2, 1]);
    const request = async (url) => { if (new URL(url).searchParams.get('champs')) { if (fault === 'invalid') return { payload: { Success: true, Value: 'x' }, status: 200 }; throw fault; } return up.request(url); };
    const origins = new OriginHealth({ origins: () => ['https://astekbet-0021.example', 'https://astekbet.example'] }); origins.ok('https://astekbet.example');
    const state = lineState(), c = new PrematchCollector(state, { request, sleep: async () => {}, persist: async () => {}, origins });
    c.batchSupported = false; c.batchRetryAt = Number.MAX_SAFE_INTEGER;
    await c.poll();
    assert.ok(state.partial, String(fault));
    assert.equal(origins.order()[0], 'https://astekbet.example', String(fault)); assert.deepEqual(origins.status().coolingDown, [], String(fault));
  }
});

test('Astek line: an unreachable mirror cools down and the cycle continues on the other one', async () => {
  let t = 9_000_000;
  const origins = new OriginHealth({ origins: () => ['https://astekbet-0021.example', 'https://astekbet.example'], now: () => t });
  const up = upstream([3, 2, 1]), hosts = [];
  const request = async (url, ...rest) => { const host = new URL(url).hostname; hosts.push(host); if (host.startsWith('astekbet-0021')) throw new Error('fetch failed'); return up.request(url, ...rest); };
  const { c, state } = collector(up, { request, origins, now: () => t });
  await c.poll();
  assert.deepEqual(hosts.slice(0, 2), ['astekbet-0021.example', 'astekbet.example'], 'nothing known: old first choice, then the fallback in the same cycle');
  assert.equal(state.events.length, 6); assert.equal(c.status().origin, 'https://astekbet.example');
  assert.deepEqual(origins.status().coolingDown.map((x) => x.origin), ['https://astekbet-0021.example']);
  hosts.length = 0; t += 60_000; await c.poll();
  assert.ok(hosts.every((h) => h === 'astekbet.example'), 'the failed mirror is not tried while the other works');
  // The working mirror goes down during a cycle: it cools down, the cycle pauses, the next one starts elsewhere.
  const down = async (url) => { const host = new URL(url).hostname; hosts.push(host); if (host === 'astekbet.example' && url.includes('Get1x2_VZip')) throw new Error('fetch failed'); return up.request(url); };
  c.request = down; c.champCache = {}; t += 6 * 60_000; await c.poll();
  assert.ok(c.cooldownUntil > t); assert.equal(origins.order(t)[0], 'https://astekbet-0021.example');
});

// ---- Astek LIVE detail mirrors ------------------------------------------------------------------------------------
test('Astek detail: the mirror that answered goes first; a failed mirror cools down and stays the last fallback', async () => {
  const [badOrigin, goodOrigin] = process.env.ASTEK_ORIGINS.split(',');
  detail.resetAstekDetailOrigins();
  const ref = (id) => ({ source: 'astek', sourceEventId: String(id), activeMap: 1, seriesScore: [0, 0], mapScores: [[0, 0]], lastSeenAt: Date.now() });
  hits.bad = 0; hits.good = 0;
  assert.ok(await detail.astekLiveDetail(ref(900101)));
  assert.deepEqual(hits, { bad: 1, good: 1 }, 'first read: configured order, falls back to the working mirror');
  const status = detail.astekDetailOriginStatus();
  assert.equal(status.lastGood, goodOrigin); assert.deepEqual(status.coolingDown.map((x) => x.origin), [badOrigin]);
  for (let i = 0; i < 5; i++) assert.ok(await detail.astekLiveDetail(ref(900200 + i)));
  assert.deepEqual(hits, { bad: 1, good: 6 }, 'later reads: one request each, the failed mirror is not retried');
  // After the cooldown the last good mirror is still first.
  assert.deepEqual(detail.astekDetailOrigins(Date.now() + detail.ORIGIN_COOLDOWN_MS + 1), [goodOrigin, badOrigin]);
  // When the good mirror fails too, the cooled-down one is still tried (fallback kept), and the read fails cleanly.
  goodDown = true; hits.bad = 0; hits.good = 0;
  await assert.rejects(detail.astekLiveDetail(ref(900300)), /HTTP 503/);
  assert.deepEqual(hits, { bad: 1, good: 1 });
  goodDown = false; detail.resetAstekDetailOrigins();
});

test('Astek detail: a reply without the match does not cool the mirror down', async () => {
  detail.resetAstekDetailOrigins();
  const [, goodOrigin] = process.env.ASTEK_ORIGINS.split(',');
  const empty = await listen((req, res) => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ Success: true, Value: {} })); });
  const old = process.env.ASTEK_ORIGINS;
  const { config } = await import('../src/config.js'); const saved = config.origins;
  config.origins = [`http://127.0.0.1:${empty.address().port}`, goodOrigin];
  try {
    assert.ok(await detail.astekLiveDetail({ source: 'astek', sourceEventId: '900400', activeMap: 1, seriesScore: [0, 0], mapScores: [[0, 0]] }));
    assert.deepEqual(detail.astekDetailOriginStatus().coolingDown, []);
  } finally { config.origins = saved; process.env.ASTEK_ORIGINS = old; empty.close(); detail.resetAstekDetailOrigins(); }
});
