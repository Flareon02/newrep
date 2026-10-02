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
const { PrematchCollector, packLeagueGroups, ASTEK_ROW_LIMIT } = await import('../src/prematch.js');
const detail = await import('../src/astek-detail.js');
test.after(() => { bad.close(); good.close(); });

// ---- Astek line: a mock that enforces the limits observed on the real API ----------------------------------------
// GetChampsZip catalog with GC per league; Get1x2_VZip answers at most 50 rows whatever `count` says, accepts count 50
// or 100 only (56 → HTTP 406) and at most 4 ids in `champs` (5+ → HTTP 406); without `champs` it is the global
// aggregate (the 50 soonest games). The league sizes are the staging catalog of 2026-10-02 (50 leagues, one with 54).
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
    if (ids && ids.length > 4) throw Object.assign(new Error('HTTP 406'), { status: 406 });
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

test('Astek line: grouped champs= requests cut a cycle from ~46 to ~15 requests with the same events', async () => {
  const before = await oldCycle(upstream());
  const up = upstream(), state = lineState();
  const c = new PrematchCollector(state, { request: up.request, sleep: async () => {}, persist: async () => {} });
  await c.poll();
  console.log(`Astek line cycle: before ${before.requests} requests (${before.errors} HTTP 406), after ${c.requestsInCycle} requests (${c.groupedRequests} grouped)`);
  assert.ok(before.requests >= 45, `before ${before.requests}`);
  assert.ok(c.requestsInCycle <= 16, `after ${c.requestsInCycle}`);
  assert.equal(c.failures.length, 0); assert.equal(state.partial, undefined); assert.equal(c.groupFallbacks, 0);
  for (const url of up.calls.filter((u) => u.includes('Get1x2_VZip'))) {
    const q = new URL(url).searchParams;
    assert.equal(q.get('count'), '50', url);
    assert.ok((q.get('champs') || '').split(',').length <= 4, url);
  }
  // Every game of every league that fits the row window, i.e. what the one-league path returns.
  const fits = new Set(up.leagues.filter((l) => l.gc < ASTEK_ROW_LIMIT).map((l) => String(l.id)));
  assert.deepEqual(ids(state.events.filter((e) => fits.has(e.leagueId))), up.games.filter((g) => fits.has(String(g.LI))).map((g) => String(g.I)).sort());

  // Same output as the one-league path on the same upstream (grouping disabled).
  const up2 = upstream(), single = lineState();
  const s = new PrematchCollector(single, { request: up2.request, sleep: async () => {}, persist: async () => {} });
  s.groupRetryAt = Number.MAX_SAFE_INTEGER;
  await s.poll();
  assert.equal(s.groupedRequests, 0);
  assert.ok(s.requestsInCycle > c.requestsInCycle + 25, `single ${s.requestsInCycle} vs grouped ${c.requestsInCycle}`);
  assert.deepEqual(project(state.events), project(single.events));
});

test('Astek line: a league over the 50-row cap is read with count=50 once and keeps its later games', async () => {
  const up = upstream([54, 3, 2]), state = lineState();
  const c = new PrematchCollector(state, { request: up.request, sleep: async () => {}, persist: async () => {} });
  await c.poll();
  const big = String(up.leagues[0].id), first = state.events.filter((e) => e.leagueId === big);
  assert.equal(first.length, 50); assert.equal(c.failures.length, 0); assert.equal(state.partial, undefined);
  assert.ok(!up.calls.some((u) => /count=(?!50\b)/.test(u)), 'never a count the API rejects');
  assert.equal(up.calls.filter((u) => new URL(u).searchParams.get('champs') === big).length, 1);
  // Games beyond the window that were known before stay; games inside the window come from the fresh answer.
  const later = up.games.filter((g) => String(g.LI) === big).sort((a, b) => a.S - b.S).slice(50);
  c.champCache[big].events.push(...later.map((g) => ({ ...first[0], id: String(g.I), sourceEventId: String(g.I), startAt: g.S * 1000 })));
  await c.poll();
  assert.deepEqual(ids(state.events.filter((e) => e.leagueId === big)), up.games.filter((g) => String(g.LI) === big).map((g) => String(g.I)).sort());
  assert.equal(c.failures.length, 0);
});

test('Astek line: an incomplete or rejected group falls back to one league per request in the same cycle', async () => {
  // Incomplete group answer (the catalog promised more games than the group returned): retried league by league.
  const up = upstream([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20]);
  let dropped = false;
  const request = async (url) => {
    const r = await up.request(url); const champs = new URL(url).searchParams.get('champs');
    if (champs?.includes(',') && !dropped) { dropped = true; return { ...r, payload: { ...r.payload, Value: r.payload.Value.slice(1) } }; }
    return r;
  };
  const state = lineState(), c = new PrematchCollector(state, { request, sleep: async () => {}, persist: async () => {} });
  await c.poll();
  assert.equal(c.groupFallbacks, 1); assert.equal(c.failures.length, 0); assert.equal(c.groupRetryAt, 0);
  assert.deepEqual(ids(state.events), up.games.map((g) => String(g.I)).sort());

  // HTTP 406 for grouped ids (a changed upstream rule): singles now, no grouping until the retry window passes.
  const up2 = upstream([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20]);
  let t = 1_000_000;
  const strict = async (url) => { if (new URL(url).searchParams.get('champs')?.includes(',')) { up2.calls.push(url); throw Object.assign(new Error('HTTP 406'), { status: 406 }); } return up2.request(url); };
  const s2 = lineState(), c2 = new PrematchCollector(s2, { request: strict, sleep: async () => {}, persist: async () => {}, now: () => t });
  await c2.poll();
  assert.equal(c2.groupFallbacks, 1); assert.ok(c2.groupRetryAt > t); assert.equal(c2.failures.length, 0);
  assert.deepEqual(ids(s2.events), up2.games.map((g) => String(g.I)).sort());
  const groupedBefore = c2.groupedRequests; t += 60_000; await c2.poll();
  assert.equal(c2.groupedRequests, groupedBefore, 'no grouped request during the retry window');
  assert.equal(c2.cooldownUntil, 0);
});

test('Astek line: groups never exceed 4 leagues or 49 expected games and keep the stalest-first order', () => {
  const leagues = GC.map((gc, i) => ({ champId: String(i), gameCount: gc }));
  const groups = packLeagueGroups(leagues);
  assert.deepEqual(groups.flat().map((c) => c.champId).sort(), leagues.map((c) => c.champId).sort());
  for (const g of groups) { assert.ok(g.length <= 4); if (g.length > 1) assert.ok(g.reduce((n, c) => n + c.gameCount, 0) < 50); }
  assert.deepEqual(groups.find((g) => g.some((c) => c.gameCount === 54)).length, 1);
  assert.equal(groups[0][0].champId, '0');
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
