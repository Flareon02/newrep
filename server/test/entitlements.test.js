import test from 'node:test';
import assert from 'node:assert/strict';
import { createApi } from '../src/api.js';
import { SnapshotState } from '../src/state.js';
import { stopMatcher } from '../src/matcher-client.js';
import { UserStore, CAPABILITY_KEYS, routeRequirement } from '../src/entitlements.js';
import { setLogSink } from '../src/logger.js';

setLogSink(() => {});
const MASTER = 'master-token-0123456789abcdef';
const odds = (h, a) => ({ updatedAt: Date.now(), markets: [{ key: 'm', type: 'moneyline', title: 'Победитель', period: 0, status: 'open', prices: [{ designation: 'home', decimal: h }, { designation: 'away', decimal: a }] }, { key: 't', type: 'total', title: 'Тотал', period: 0, status: 'open', prices: [{ designation: 'over', decimal: 1.9 }, { designation: 'under', decimal: 1.9 }] }] });
const fixture = (source, id, h, a) => ({ id, source, sourceEventId: id, provider: source, category: 'Dota 2', league: 'Ent League', team1: 'Alpha Team', team2: 'Beta Team', startAt: Date.parse('2026-10-02T12:00:00Z'), marketKind: 'main', scoreText: '1:0', seriesScore: [1, 0], bestOf: 3, odds: odds(h, a) });

async function start() {
  const states = Array.from({ length: 7 }, (_, i) => new SnapshotState('ent-' + i, 60000)); for (const s of states) s.persist = async () => {};
  await states[0].success([fixture('astek', 'a1', 1.8, 2.05)]);
  await states[6].success([fixture('ggbet', 'g1', 1.85, 2.0)]);
  const users = new UserStore({ read: async () => ({ users: [] }), write: async () => {} });
  const ggbetCollector = { status: () => ({ enabled: true }), lease: () => ({ ok: true }), releaseLease: () => true, detail: async () => null };
  const server = createApi({ authToken: MASTER, userStore: users, accessMode: 'auto', liveState: states[0], prematchState: states[1], fonbetLiveState: states[2], fonbetPrematchState: states[3], pinnaclePrematchState: states[4], pinnacleLiveState: states[5], ggbetLiveState: states[6], prematchCollector: { status: () => ({}), catalog: [] }, fonbetCollector: { status: () => ({}) }, pinnacleCollector: { status: () => ({}), catalog: [] }, ggbetCollector, resultsService: { status: () => ({}), days: new Map() }, startedAt: Date.now() });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = 'http://127.0.0.1:' + server.address().port;
  const call = async (path, token, body) => { const res = await fetch(base + path, { method: body ? 'POST' : 'GET', headers: { ...(token ? { authorization: 'Bearer ' + token } : {}), ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined }); let json = null; try { json = await res.json(); } catch {} return { status: res.status, json }; };
  return { base, call, states, users, close: async () => { await new Promise((r) => { server.closeAllConnections?.(); server.close(r); }); await stopMatcher(); } };
}

test('a new user has every capability off; granted ones open their section; the client cannot widen them', async () => {
  const api = await start();
  try {
    const created = await api.call('/api/admin/users', MASTER, { name: 'Tester' });
    assert.equal(created.status, 200); assert.match(created.json.token, /^emu_[0-9a-f]{48}$/);
    assert.deepEqual(created.json.user.capabilities, [], 'explicit allow: nothing granted');
    const token = created.json.token, id = created.json.user.id;
    assert.deepEqual((await api.call('/api/me', token)).json.capabilities, []);
    for (const path of ['/api/ui/live', '/api/ui/prematch', '/api/ui/results', '/api/ui/history', '/api/live/ggbet']) assert.equal((await api.call(path, token)).status, 403, path);
    // A capability list sent by the client is not trusted.
    assert.equal((await api.call('/api/ui/live?capabilities=live.view', token)).status, 403);
    await api.call('/api/admin/users/' + id, MASTER, { capabilities: ['live.view', 'provider.astek', 'odds.live', 'nonsense.cap'] });
    assert.deepEqual((await api.call('/api/me', token)).json.capabilities, ['live.view', 'odds.live', 'provider.astek'], 'unknown keys are dropped');
    assert.equal((await api.call('/api/ui/live', token)).status, 200);
    assert.equal((await api.call('/api/ui/prematch', token)).status, 403, 'prematch still off');
    // Disabling the user takes effect on the next request (no reinstall).
    await api.call('/api/admin/users/' + id, MASTER, { disabled: true });
    assert.equal((await api.call('/api/ui/live', token)).status, 401);
  } finally { await api.close(); }
});

test('bookmaker data a user may not see never leaves the server (REST and full markets)', async () => {
  const api = await start();
  try {
    const { json } = await api.call('/api/admin/users', MASTER, { name: 'Astek only', capabilities: ['live.view', 'provider.astek', 'odds.live'] });
    const token = json.token;
    const admin = (await api.call('/api/ui/live?provider=ggbet', MASTER)).json;
    const sources = (j) => [...new Set((j.events || []).flatMap((e) => (e.sourceRefs || [e]).map((r) => r.source)))].sort();
    assert.deepEqual(sources(admin), ['astek', 'ggbet'], 'the administrator sees both');
    const live = (await api.call('/api/ui/live?provider=ggbet', token)).json;
    assert.deepEqual(sources(live), ['astek'], 'GGBET refs removed for this user');
    // liveOddsProvider echoes the feed variant the client asked for; everything else must be free of GGBET data
    { const t = JSON.stringify({ ...live, liveOddsProvider: undefined }); let i = t.indexOf('"ggbet"'); const ctx = []; while (i >= 0 && ctx.length < 5) { ctx.push(t.slice(Math.max(0, i - 80), i + 30)); i = t.indexOf('"ggbet"', i + 1); } assert.ok(!ctx.length, 'no GGBET trace in the payload: ' + ctx.join(' || ')); }
    assert.equal((await api.call('/api/live/ggbet', token)).status, 403);
    assert.equal((await api.call('/api/ui/full-markets', token, { lease: 'lease-12345678', action: 'acquire', id: 'x' })).status, 403, 'no full markets capability');
    assert.equal((await api.call('/api/astek/markets?id=1', token)).status, 403);
    // Without odds rights the prices are stripped, the fixture stays.
    await api.call('/api/admin/users/' + json.user.id, MASTER, { capabilities: ['live.view', 'provider.astek'] });
    const noOdds = (await api.call('/api/ui/live?provider=ggbet', token)).json;
    assert.equal(noOdds.events.length, 1);
    { const t = JSON.stringify(noOdds), i = Math.max(t.indexOf('"quote"'), t.indexOf('"decimal"')); assert.ok(i < 0, 'prices left: ' + t.slice(Math.max(0, i - 200), i + 60)); }
  } finally { await api.close(); }
});

test('disabled comparison/tools endpoints are refused; admin endpoints only for administrators', async () => {
  const api = await start();
  try {
    const { json } = await api.call('/api/admin/users', MASTER, { name: 'Viewer', capabilities: ['live.view', 'compare.view', 'provider.astek'] });
    const token = json.token;
    assert.equal((await api.call('/api/prematch/compare', token, { events: [] })).status, 403, 'schedule comparison is a separate capability');
    assert.equal((await api.call('/api/odds/manual', token, { names: ['A', 'B'] })).status, 403);
    for (const path of ['/api/admin/users', '/api/admin/capabilities', '/api/admin/ggbet-bootstrap', '/api/admin/ggbet-browser', '/api/status']) {
      assert.equal((await api.call(path, token)).status, 403, path);
      assert.equal((await api.call(path, '')).status, 401, path + ' anonymous');
    }
    assert.equal((await api.call('/api/admin/users', token, { name: 'x' })).status, 403);
    const health = (await api.call('/health', token)).json;
    assert.equal(health.ok, true); assert.equal(health.ggbetCollector, undefined, 'no server internals for a user');
    const caps = (await api.call('/api/admin/capabilities', MASTER)).json;
    assert.deepEqual(caps.capabilities.map((c) => c.key), CAPABILITY_KEYS);
  } finally { await api.close(); }
});

test('administrators: an admin user has everything; nobody can lock themselves out', async () => {
  const api = await start();
  try {
    const { json } = await api.call('/api/admin/users', MASTER, { name: 'Second admin', role: 'admin' });
    const token = json.token, id = json.user.id;
    assert.ok((await api.call('/api/me', token)).json.capabilities.includes('admin.users'));
    assert.equal((await api.call('/api/admin/users/' + id, token, { disabled: true })).status, 409);
    assert.equal((await api.call('/api/admin/users/' + id, token, { role: 'user' })).status, 409);
    assert.equal((await api.call('/api/admin/users/' + id + '/delete', token, {})).status, 409);
    const other = (await api.call('/api/admin/users', token, { name: 'Managed' })).json;
    assert.equal((await api.call('/api/admin/users/' + other.user.id + '/delete', token, {})).status, 200, 'it can manage others');
    // A rotated token replaces the old one at once.
    const rotated = (await api.call('/api/admin/users/' + id + '/token', MASTER, {})).json.token;
    assert.equal((await api.call('/api/me', token)).json.principal.anonymous, true);
    assert.equal((await api.call('/api/me', rotated)).json.principal.role, 'admin');
  } finally { await api.close(); }
});

test('SSE: a user never receives patches of a bookmaker they may not see', async () => {
  const api = await start();
  try {
    const { json } = await api.call('/api/admin/users', MASTER, { name: 'Stream', capabilities: ['live.view', 'provider.astek', 'odds.live'] });
    const ctrl = new AbortController(), res = await fetch(api.base + '/api/feed-stream?modes=live&thin=1&provider=ggbet', { headers: { authorization: 'Bearer ' + json.token }, signal: ctrl.signal });
    assert.equal(res.status, 200);
    let text = ''; const reader = res.body.getReader(), dec = new TextDecoder();
    const pump = (async () => { try { for (;;) { const { value, done } = await reader.read(); if (done) break; text += dec.decode(value); } } catch {} })();
    await new Promise((r) => setTimeout(r, 300));
    await api.states[6].success([{ ...fixture('ggbet', 'g1', 2.4, 1.5), scoreText: '2:0', seriesScore: [2, 0] }]);
    await api.states[0].success([{ ...fixture('astek', 'a1', 1.7, 2.2), scoreText: '2:0', seriesScore: [2, 0] }]);
    await new Promise((r) => setTimeout(r, 800)); ctrl.abort(); await pump;
    assert.match(text, /"source":"astek"/, 'own bookmaker patches arrive');
    assert.doesNotMatch(text, /"ggbet":\{/, 'no GGBET feed status either');
    { const i = text.indexOf('"source":"ggbet"'); assert.ok(i < 0, 'no GGBET patch for this user: ' + text.slice(Math.max(0, i - 300), i + 100)); }
    const anon = await fetch(api.base + '/api/feed-stream?modes=live&thin=1');
    assert.equal(anon.status, 401);
  } finally { await api.close(); }
});

test('route table: every API route has a requirement; unknown routes are closed', () => {
  for (const path of ['/api/ui/live', '/api/ui/prematch', '/api/ui/results', '/api/ui/history', '/api/prematch/compare', '/api/ui/full-markets', '/api/odds/timeline', '/api/score-history', '/api/statistics/match', '/api/live-generator', '/api/league-links/publish'])
    assert.ok(routeRequirement('GET', path)?.length, path);
  assert.equal(routeRequirement('GET', '/health'), null);
  assert.deepEqual(routeRequirement('GET', '/api/something-new'), ['admin.diagnostics']);
});
