import test from 'node:test';
import fs from 'node:fs';
import assert from 'node:assert/strict';
import {
  DatabetLiveCollector, parseDatabetLiveEvent, databetBootstrapFromHtml, databetTokenMetadata, normalizeDatabetWsUrl
} from '../src/databet.js';
import { parseGgbetLiveEvent } from '../src/ggbet.js';
import { SnapshotState } from '../src/state.js';
import { createApi } from '../src/api.js';
import { stopMatcher } from '../src/matcher-client.js';
import { resolveEvents } from '../src/entity-resolver.js';
import { config } from '../src/config.js';

const UUID = 'ff5d17fd-0559-457c-af17-22b0e403bc3f';
const odds = (a, b, pa, pb, extra = {}) => [
  { id: '1', name: a[0], value: a[1], probability: pa, isActive: true, status: 'NOT_RESULTED', competitorIds: a[2] || [], ...extra },
  { id: '2', name: b[0], value: b[1], probability: pb, isActive: true, status: 'NOT_RESULTED', competitorIds: b[2] || [], ...extra }
];
const market = (id, name, typeId, status, o, specifiers = []) => ({ id, name, status, typeId, priority: 1, tags: [], specifiers, meta: [{ name: 'provider_source', value: 'databet' }], odds: o });
const fixture = (score = '1:1', status = 'LIVE') => { const [home, away] = score.split(':'); return {
  score, title: 'Aurora Gaming vs Team Liquid', status, type: 'MATCH', startTime: '2026-10-01T15:22:54+00:00', sportId: 'esports_dota_2',
  sport: { id: 'esports_dota_2', name: 'Dota 2', tags: ['ESPORT', 'CYBER'], slug: 'dota-2' },
  tournament: { id: 'gin:ab00f106', name: 'BLAST Slam VIII', slug: 'blast-slam-viii', sportId: 'esports_dota_2', countryCode: '' },
  competitors: [
    { id: 'gt:home', name: 'Aurora Gaming', type: 'TEAM', homeAway: 'HOME', logo: 'cdn.gin.bet/team/a.png', score: [{ id: 's1', type: 'total', points: home, number: 0 }, { id: 's2', type: 'map', points: '20', number: 3 }] },
    { id: 'gt:away', name: 'Team Liquid', type: 'TEAM', homeAway: 'AWAY', logo: 'cdn.gin.bet/team/b.png', score: [{ id: 's3', type: 'total', points: away, number: 0 }, { id: 's4', type: 'map', points: '17', number: 3 }] }
  ]
}; };
const winner = () => market('1', 'Winner', 1, 'ACTIVE', odds(['Aurora Gaming', '1.30', ['gt:home']], ['Team Liquid', '3.35', ['gt:away']], '0.7377', '0.2623'));
const oddEven = () => market('96m3', 'Map 3 - Total kills odd/even', 96, 'ACTIVE', odds(['Odd', '1.70'], ['even', '2.07'], '0.5538', '0.4462'), [{ name: 'mapnr', value: '3' }]);
const suspendedMap = () => market('50m3', 'Map 3 - Winner', 50, 'SUSPENDED', odds(['Aurora Gaming', '1.79', ['gt:home']], ['Team Liquid', '1.96', ['gt:away']], '0.5248', '0.4752'), [{ name: 'mapnr', value: '3' }]);
const raw = (over = {}) => ({ id: `10:${UUID}`, disabled: false, providerId: '10', slug: 'aurora-gaming-vs-team-liquid-01-10', betStop: false, version: 'v1', meta: [{ name: 'bo', value: '3' }], fixture: fixture(), markets: [winner(), oddEven(), suspendedMap()], ...over });
const fullMarkets = () => [winner(), oddEven(), suspendedMap(),
  market('27m3x30', 'Map 3 - Kill maker', 27, 'ACTIVE', odds(['Aurora Gaming 30th', '1.72', ['gt:home']], ['Team Liquid 30th', '2.04', ['gt:away']], '0.5455', '0.4545'), [{ name: 'mapnr', value: '3' }, { name: 'xth', value: '30' }]),
  market('351m3t59_5', 'Map 3 - Total kills', 351, 'ACTIVE', odds(['Over 59.5', '1.87'], ['Under 59.5', '1.87'], '0.5000', '0.5000'), [{ name: 'mapnr', value: '3' }, { name: 'total', value: '59.5' }])];

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const token = `${b64({ alg: 'dir', currency: 'USD', enc: 'A256GCM', isAuthorized: false, label: 'cdrriyv', locale: 'en' })}..${'i'.repeat(16)}.${'c'.repeat(160)}.${'t'.repeat(22)}`;
const page = (tk = token, endpoint = '//sportsbook-gql.databet.cloud/graphql?label=cdrriyv') =>
  `<html><script>self.__next_f.push([1,"..."])</script><script data-cfasync="false">window.bettingOptions = {"token":"${tk}","isAuthorized":false,"locale":"en","currency":"USD","url":{"staticEndpoint":"https://spa.databet.cloud/v2/demo","gqlEndpoint":"${endpoint}"}}</script></html>`;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

test('DataBet parser keeps upstream value and probability exactly, per outcome and market status', () => {
  const event = parseDatabetLiveEvent(raw(), { at: 123 });
  assert.equal(event.source, 'databet'); assert.equal(event.provider, 'DataBet'); assert.equal(event.id, `databet-${UUID}`); assert.equal(event.sourceEventId, UUID);
  assert.equal(event.upstreamEventId, `10:${UUID}`); assert.equal(event.category, 'Dota 2'); assert.equal(event.league, 'BLAST Slam VIII'); assert.equal(event.bestOf, 3);
  assert.deepEqual(event.seriesScore, [1, 1]); assert.deepEqual(event.mapScores, [[20, 17]]); assert.equal(event.url, 'https://demo.data.bet/en/esports/live/match/aurora-gaming-vs-team-liquid-01-10');
  assert.equal(event.odds.provider, 'DataBet'); assert.equal(event.odds.transport, 'graphql-ws');
  const oe = event.odds.markets.find((m) => m.key === 'databet:96m3');
  assert.equal(oe.status, 'open'); assert.equal(oe.period, 3); assert.equal(oe.rawTitle, 'Map 3 - Total kills odd/even'); assert.equal(oe.canonical.provider, 'databet');
  assert.deepEqual(oe.prices.map((p) => [p.designation, p.label, p.decimal, p.rawValue, p.probability]), [['odd', 'Нечёт', 1.7, '1.70', 0.5538], ['even', 'Чёт', 2.07, '2.07', 0.4462]]);
  // Asymmetric odd/even stays asymmetric: the collector never "corrects" upstream prices.
  assert.notEqual(oe.prices[0].decimal, oe.prices[1].decimal);
  const closed = event.odds.markets.find((m) => m.key === 'databet:50m3');
  assert.equal(closed.status, 'suspended');
  assert.deepEqual(closed.prices.map((p) => [p.designation, p.decimal, p.rawValue, p.probability]), [['home', null, '1.79', 0.5248], ['away', null, '1.96', 0.4752]]);
  const win = event.odds.markets.find((m) => m.key === 'databet:1');
  assert.deepEqual(win.prices.map((p) => [p.designation, p.decimal, p.probability]), [['home', 1.3, 0.7377], ['away', 3.35, 0.2623]]);
  assert.equal(parseDatabetLiveEvent(raw({ fixture: fixture('2:1', 'ENDED') })), null, 'finished events are not LIVE');
  assert.equal(parseDatabetLiveEvent(raw({ fixture: { ...fixture(), sport: { id: 'esports_fifa', name: 'FIFA', tags: ['ESPORT', 'PLASTIC'] } } })), null, 'virtual sports stay out like GGBET');
});

test('DataBet bootstrap reads the public page options and validates endpoint and label', () => {
  const boot = databetBootstrapFromHtml(page(), { origin: 'https://demo.data.bet', at: 5 });
  assert.equal(boot.token, token); assert.equal(boot.wsUrl, 'wss://sportsbook-gql.databet.cloud/graphql?label=cdrriyv');
  assert.deepEqual([boot.label, boot.locale, boot.currency, boot.isAuthorized, boot.origin], ['cdrriyv', 'en', 'USD', false, 'https://demo.data.bet']);
  assert.deepEqual(databetTokenMetadata(token), { label: 'cdrriyv', locale: 'en', currency: 'USD', isAuthorized: false });
  assert.throws(() => databetBootstrapFromHtml('<html></html>'), /bettingOptions/);
  assert.throws(() => databetBootstrapFromHtml(page('short')), /guest token/);
  assert.throws(() => databetBootstrapFromHtml(page(token, '//evil.example.com/graphql?label=cdrriyv')), /betting endpoint/);
  assert.throws(() => databetBootstrapFromHtml(page(token, '//sportsbook-gql.databet.cloud/graphql?label=other')), /label/);
  assert.throws(() => normalizeDatabetWsUrl('wss://sportsbook-gql.databet.cloud:8443/graphql'), /betting endpoint/);
  assert.equal(normalizeDatabetWsUrl('https://sportsbook-gql.databet.cloud/graphql/'), 'wss://sportsbook-gql.databet.cloud/graphql');
});

class FakeSocket {
  constructor(url, protocol, options = {}) {
    this.url = url; this.protocol = protocol; this.options = options; this.readyState = 0; this.listeners = new Map(); this.sent = [];
    FakeSocket.last = this; FakeSocket.all.push(this);
    queueMicrotask(() => { this.readyState = 1; this.emit('open', {}); });
  }
  addEventListener(name, fn) { if (!this.listeners.has(name)) this.listeners.set(name, []); this.listeners.get(name).push(fn); }
  emit(name, event) { for (const fn of this.listeners.get(name) || []) fn(event); }
  message(obj) { this.emit('message', { data: JSON.stringify(obj) }); }
  starts(op) { return this.sent.filter((m) => m.type === 'start' && m.payload?.operationName === op); }
  send(body) {
    const msg = JSON.parse(body); this.sent.push(msg);
    if (msg.type === 'connection_init') queueMicrotask(() => this.message({ type: 'connection_ack' }));
    else if (msg.type === 'stop') queueMicrotask(() => this.message({ id: msg.id, type: 'complete' }));
    else if (msg.payload?.operationName === 'DatabetLiveList') queueMicrotask(() => { this.message({ id: msg.id, type: 'data', payload: { data: { matches: { count: FakeSocket.list.length, sportEvents: FakeSocket.list.map((e) => JSON.parse(JSON.stringify(e))) } } } }); this.message({ id: msg.id, type: 'complete' }); });
    else if (msg.payload?.operationName === 'DatabetMarketTabs') queueMicrotask(() => { this.message({ id: msg.id, type: 'data', payload: { data: { compiledMarketsTabs: { tabs: [{ id: 'all', name: 'All', marketIds: fullMarkets().map((m) => m.id) }, { id: 'dota_kills_markets', name: 'Kills', marketIds: ['96m3', '27m3x30', '351m3t59_5'] }] } } } }); this.message({ id: msg.id, type: 'complete' }); });
    else if (msg.payload?.operationName === 'DatabetFullEvent' && FakeSocket.autoFull) queueMicrotask(() => this.message({ id: msg.id, type: 'data', payload: { data: { onUpdateSportEvent: { ...raw({ version: 'v-full' }), markets: fullMarkets() } } } }));
  }
  close(code = 1000, reason = '') { if (this.readyState === 3) return; this.readyState = 3; queueMicrotask(() => this.emit('close', { code, reason, target: this })); }
}
FakeSocket.all = []; FakeSocket.list = []; FakeSocket.autoFull = true;

function collector(state) {
  const c = new DatabetLiveCollector(state, { fetchImpl: async () => ({ ok: true, status: 200, text: async () => page() }), WebSocketImpl: FakeSocket });
  c.stopped = false; return c;
}
const rowsState = () => ({ rows: [], successes: 0, failures: [], async success(rows) { this.rows = rows; this.successes++; }, async failure(e) { this.failures.push(e.message); } });

test('collector: plain-query snapshot, light subscriptions, absolute pushes, wrong-event and finished events', async () => {
  const oldDebounce = config.databetPublishDebounceMs; config.databetPublishDebounceMs = 1;
  FakeSocket.list = [raw()];
  const state = rowsState(), c = collector(state);
  try {
    await c.connect(); await wait(20);
    const ws = FakeSocket.last;
    assert.equal(ws.url, 'wss://sportsbook-gql.databet.cloud/graphql?label=cdrriyv'); assert.equal(ws.protocol, 'graphql-ws');
    assert.equal(ws.options.headers.Origin, 'https://demo.data.bet'); assert.equal(ws.options.perMessageDeflate, false);
    assert.equal(ws.sent[0].payload.headers['X-Auth-Token'], token);
    const [list] = ws.starts('DatabetLiveList');
    assert.ok(list.payload.query.includes('sportEventListByFilters')); assert.equal(list.payload.extensions, undefined, 'DataBet has no GGBET persisted hashes');
    assert.ok(list.payload.variables.sportIds.includes('esports_dota_2'));
    assert.equal(state.rows.length, 1); assert.equal(state.rows[0].source, 'databet'); assert.equal(state.rows[0].odds.markets.length, 3);
    const [light] = ws.starts('DatabetLiveEvent');
    assert.equal(light.payload.variables.sportEventId, `10:${UUID}`); assert.equal(light.payload.variables.marketLimit, 3); assert.ok(!light.payload.query.includes('persistedQuery'));
    // A push is the absolute state of the subscribed market set: it replaces it, it is never added on top.
    ws.message({ id: light.id, type: 'data', payload: { data: { onUpdateSportEvent: { ...raw({ version: 'v2', fixture: fixture('2:1') }), markets: [winner()] } } } });
    await wait(15);
    assert.equal(state.rows[0].odds.markets.length, 1); assert.deepEqual(state.rows[0].seriesScore, [2, 1]); assert.equal(c.status().pushes, 1);
    // An update that names another event is never applied to this subscription's event.
    ws.message({ id: light.id, type: 'data', payload: { data: { onUpdateSportEvent: { ...raw({ id: '10:00000000-0000-0000-0000-000000000000', fixture: fixture('0:2') }) } } } });
    await wait(15);
    assert.deepEqual(state.rows[0].seriesScore, [2, 1]); assert.equal(c.status().mismatchedPushes, 1);
    // A finished event leaves the feed and its subscription is stopped.
    ws.message({ id: light.id, type: 'data', payload: { data: { onUpdateSportEvent: { ...raw({ fixture: fixture('2:1', 'ENDED') }) } } } });
    await wait(15);
    assert.equal(state.rows.length, 0); assert.ok(ws.sent.some((m) => m.type === 'stop' && m.id === light.id)); assert.equal(c.status().finishedEvents, 1);
  } finally { config.databetPublishDebounceMs = oldDebounce; await c.stop(); }
});

test('collector: detail upgrades one event to the full market tree with native tabs, keeps it across snapshots, downgrades after TTL', async () => {
  const oldDebounce = config.databetPublishDebounceMs; config.databetPublishDebounceMs = 1;
  FakeSocket.list = [raw()]; FakeSocket.autoFull = true;
  const state = rowsState(), c = collector(state);
  try {
    await c.connect(); await wait(20);
    const ws = FakeSocket.last, [light] = ws.starts('DatabetLiveEvent');
    const detail = await c.detail(UUID, { timeoutMs: 1000 });
    assert.ok(ws.sent.some((m) => m.type === 'stop' && m.id === light.id), 'light subscription is replaced, not duplicated');
    const [full] = ws.starts('DatabetFullEvent');
    assert.ok(full); assert.equal(full.payload.variables.marketLimit, undefined); assert.ok(!/markets\(top:true/.test(full.payload.query));
    assert.equal(detail.odds.markets.length, 5);
    assert.deepEqual(detail.odds.providerTabs.map((t) => [t.id, t.count]), [['all', 5], ['dota_kills_markets', 3]]);
    assert.deepEqual(detail.odds.markets.find((m) => m.key === 'databet:96m3').providerTabs, ['all', 'dota_kills_markets']);
    assert.equal(c.status().fullMarketEvents, 1); assert.equal(c.status().lightEvents, 0);
    // The periodic top-markets snapshot never overwrites a delivered full market tree.
    c.lastSnapshotAt = 0; c.requestSnapshot(); await wait(20);
    assert.equal(state.rows[0].odds.markets.length, 5);
    // TTL expiry: back to fixture + top markets.
    c.fullMarkets.set(`10:${UUID}`, { until: Date.now() - 1, requestedAt: 0 }); c.maintenance(); await wait(10);
    assert.ok(ws.sent.some((m) => m.type === 'stop' && m.id === full.id)); assert.equal(ws.starts('DatabetLiveEvent').length, 2); assert.equal(c.status().fullMarketEvents, 0);
  } finally { config.databetPublishDebounceMs = oldDebounce; await c.stop(); }
});

test('collector: reconnect drops stale full markets until the new session delivers, and never exposes the token', async () => {
  const oldDebounce = config.databetPublishDebounceMs; config.databetPublishDebounceMs = 1;
  FakeSocket.list = [raw()]; FakeSocket.autoFull = true;
  const state = rowsState(), c = collector(state);
  try {
    await c.connect(); await wait(20);
    await c.detail(UUID, { timeoutMs: 1000 }); await wait(10);
    assert.equal(state.rows[0].odds.markets.length, 5);
    FakeSocket.autoFull = false; // the next session has not pushed the full tree yet
    c.handleClose({ code: 1006, reason: 'network', target: c.ws });
    assert.equal(c.status().subscriptions, 0); assert.equal(c.ws, null);
    c.stopped = false; clearTimeout(c.reconnectTimer); c.reconnectTimer = null;
    await c.connect(); await wait(20);
    assert.equal(state.rows[0].odds.markets.length, 3, 'snapshot rows replace the previous session full tree');
    assert.equal(FakeSocket.last.starts('DatabetFullEvent').length, 1, 'the open odds dialog keeps its full subscription after reconnect');
    const status = JSON.stringify(c.status());
    assert.equal(status.includes(token), false); assert.equal('token' in c.status(), false);
    assert.deepEqual([c.status().label, c.status().locale, c.status().currency, c.status().connectionState], ['cdrriyv', 'en', 'USD', 'connected']);
    c.handleClose({ code: 4401, reason: 'token expired', target: c.ws });
    assert.equal(c.bootstrap, null); assert.ok(c.status().authRefreshes >= 1);
  } finally { FakeSocket.autoFull = true; config.databetPublishDebounceMs = oldDebounce; await c.stop(); }
});

test('collector: detail refuses to serve stale data while disconnected', async () => {
  const c = new DatabetLiveCollector(rowsState(), { fetchImpl: async () => ({ ok: true, text: async () => page() }), WebSocketImpl: FakeSocket });
  c.events.set(`10:${UUID}`, raw());
  await assert.rejects(() => c.detail(UUID), /DataBet временно недоступен/);
  assert.equal(await c.detail('missing'), null);
});

test('DataBet attaches as an extra LIVE provider without changing the Astek/Fonbet core', () => {
  const start = Date.parse('2026-10-01T15:22:54Z'), base = { category: 'Dota 2', league: 'BLAST Slam VIII', team1: 'Aurora Gaming', team2: 'Team Liquid', startAt: start, marketKind: 'main' };
  const rows = [
    { ...base, id: 'a', source: 'astek', sourceEventId: 'a', provider: 'AstekBet' },
    { ...base, id: 'f', source: 'fonbet', sourceEventId: 'f', provider: 'Fonbet', startAt: start + 1000 },
    { ...base, id: 'd', source: 'databet', sourceEventId: 'd', provider: 'DataBet', startAt: start + 3000 }
  ];
  const merged = resolveEvents(rows, { mode: 'live' });
  assert.equal(merged.length, 1); assert.deepEqual(new Set(merged[0].sourceRefs.map((r) => r.source)), new Set(['astek', 'fonbet', 'databet']));
  const core = resolveEvents(rows.slice(0, 2), { mode: 'live' });
  assert.equal(core.length, 1); assert.deepEqual(new Set(core[0].sourceRefs.map((r) => r.source)), new Set(['astek', 'fonbet']));
});

const ggbetRaw = () => ({ ...raw(), id: `5:${UUID}`, markets: [market('1', 'Zwycięzca', 1, 'ACTIVE', odds(['Aurora Gaming', '1.32', ['gt:home']], ['Team Liquid', '3.25', ['gt:away']]))] });

async function apiWith({ databetCollector } = {}) {
  const names = ['test-astek-live', 'test-prematch', 'test-fonbet-live', 'test-fonbet-prematch', 'test-pinnacle-prematch', 'test-pinnacle-live', 'test-ggbet-live', 'test-databet-live'];
  const states = names.map((n) => new SnapshotState(n, 60000)); for (const s of states) s.persist = async () => {};
  const astek = { id: 'a1', source: 'astek', sourceEventId: 'a1', provider: 'AstekBet', category: 'Dota 2', league: 'BLAST Slam VIII', team1: 'Aurora Gaming', team2: 'Team Liquid', startAt: Date.parse('2026-10-01T15:22:54Z'), marketKind: 'main', scoreText: '1:1' };
  await states[0].success([astek]);
  await states[6].success([parseGgbetLiveEvent(ggbetRaw(), { at: Date.now() })]);
  await states[7].success([parseDatabetLiveEvent(raw(), { at: Date.now() })]);
  const server = createApi({
    liveState: states[0], prematchState: states[1], fonbetLiveState: states[2], fonbetPrematchState: states[3], pinnaclePrematchState: states[4], pinnacleLiveState: states[5],
    ggbetLiveState: states[6], databetLiveState: states[7],
    prematchCollector: { status: () => ({}), catalog: [] }, fonbetCollector: { status: () => ({}) }, pinnacleCollector: { status: () => ({}), catalog: [] },
    ggbetCollector: { status: () => ({ enabled: true, connected: true, acknowledged: true, transport: 'graphql-ws' }) },
    databetCollector: databetCollector || { status: () => ({ enabled: true, connectionState: 'connected', connected: true, acknowledged: true, lastError: '' }) },
    resultsService: { status: () => ({}), days: new Map() }, startedAt: Date.now()
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = 'http://127.0.0.1:' + server.address().port;
  return { server, states, base, close: async () => { await new Promise((r) => server.close(r)); } };
}
const sourcesOf = (payload) => payload.events.flatMap((e) => (e.sourceRefs?.length ? e.sourceRefs : [e]).map((r) => r.source));

test('API: LIVE odds provider is selected per request; default stays GGBET; providers never mix', async () => {
  const api = await apiWith();
  const get = async (path, status = 200) => { const res = await fetch(api.base + path); assert.equal(res.status, status, path); return res.json(); };
  try {
    const legacy = await get('/api/ui/live?thin=1&compact=1');
    assert.ok(sourcesOf(legacy).includes('ggbet')); assert.ok(!sourcesOf(legacy).includes('databet')); assert.equal(legacy.liveOddsProvider, 'ggbet');
    const gg = await get('/api/ui/live?thin=1&compact=1&provider=ggbet');
    assert.equal(gg.revision, legacy.revision);
    const db = await get('/api/ui/live?thin=1&compact=1&provider=databet');
    assert.ok(sourcesOf(db).includes('databet')); assert.ok(!sourcesOf(db).includes('ggbet')); assert.ok(sourcesOf(db).includes('astek'));
    assert.equal(db.liveOddsProvider, 'databet'); assert.match(db.revision, /~databet$/); assert.notEqual(db.revision, gg.revision);
    assert.equal(db.providers.databet.oddsProvider.connectionState, 'connected'); assert.equal(db.providers.databet.oddsProvider.events, 1); assert.equal(db.providers.ggbet, undefined);
    const meta = await get('/api/ui/live?meta=1&thin=1&provider=databet');
    assert.equal(meta.revision, db.revision); assert.equal(meta.events, undefined);
    const bad = await get('/api/ui/live?provider=betfair', 400); assert.match(bad.error, /источник/i);
    const plainLive = await get('/api/live?compact=1'); assert.ok(!sourcesOf(plainLive).includes('databet'));
    const plainDb = await get('/api/live?compact=1&provider=databet'); assert.ok(sourcesOf(plainDb).includes('databet')); assert.ok(!sourcesOf(plainDb).includes('ggbet'));
    const direct = await get('/api/live/databet?compact=1'); assert.equal(direct.events[0].source, 'databet');
    const health = await get('/health');
    assert.equal(health.live.databet.count, 1); assert.equal(health.databetCollector.connectionState, 'connected');
    assert.deepEqual(Object.keys(health.oddsProviders), ['ggbet', 'databet']); assert.equal(health.oddsProviders.databet.events, 1); assert.equal(health.oddsProviders.databet.markets, 3);
    const providers = await get('/api/ui/odds-providers'); assert.equal(providers.defaultProvider, 'ggbet'); assert.equal(providers.providers.databet.name, 'DataBet');
  } finally { await api.close(); await stopMatcher(); }
});

test('API: DataBet event detail is hydrated by the DataBet collector; GGBET detail is never consulted', async () => {
  let databetCalls = 0, ggbetCalls = 0;
  const full = parseDatabetLiveEvent({ ...raw(), markets: fullMarkets() }, { at: Date.now() });
  const api = await apiWith({ databetCollector: { status: () => ({ enabled: true, connectionState: 'connected' }), detail: async (id) => { databetCalls++; assert.equal(id, UUID); return full; } } });
  try {
    const live = await (await fetch(api.base + '/api/ui/live?provider=databet')).json();
    const event = live.events.find((e) => (e.sourceRefs || [e]).some((r) => r.source === 'databet'));
    const res = await fetch(`${api.base}/api/ui/event-detail?view=live&provider=databet&id=${encodeURIComponent(event.id)}`);
    assert.equal(res.status, 200); const body = await res.json();
    assert.equal(body.liveOddsProvider, 'databet'); assert.equal(databetCalls, 1); assert.equal(ggbetCalls, 0);
    const ref = body.event.sourceRefs.find((r) => r.source === 'databet');
    assert.equal(ref.odds.markets.length, 5); assert.equal(body.event.sourceRefs.some((r) => r.source === 'ggbet'), false);
    const oe = ref.odds.markets.find((m) => m.key === 'databet:96m3');
    assert.deepEqual(oe.prices.map((p) => [p.decimal, p.probability]), [[1.7, 0.5538], [2.07, 0.4462]]);
  } finally { await api.close(); await stopMatcher(); }
});

async function readSse(url, { until, timeoutMs = 4000 }) {
  const ctrl = new AbortController(), events = [];
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctrl.signal }); const reader = res.body.getReader(), decoder = new TextDecoder(); let buffer = '';
    while (true) {
      const { value, done } = await reader.read(); if (done) break; buffer += decoder.decode(value, { stream: true });
      let i; while ((i = buffer.indexOf('\n\n')) >= 0) {
        const block = buffer.slice(0, i); buffer = buffer.slice(i + 2);
        const type = /^event: (.*)$/m.exec(block)?.[1], data = /^data: (.*)$/m.exec(block)?.[1];
        if (type && data) { events.push({ type, data: JSON.parse(data) }); if (until(events)) return events; }
      }
    }
  } catch (error) { if (error.name !== 'AbortError') throw error; } finally { clearTimeout(timer); ctrl.abort(); }
  return events;
}

test('API: a feed stream receives the LIVE patches of its own odds provider only', async () => {
  const api = await apiWith();
  try {
    const url = `${api.base}/api/feed-stream?modes=live&thin=1&provider=databet`;
    const pending = readSse(url, { until: (events) => events.some((e) => e.type === 'patch' && e.data.provider === 'databet') });
    await wait(150);
    const [ggbetState, databetState] = [api.states[6], api.states[7]];
    await ggbetState.success([parseGgbetLiveEvent({ ...ggbetRaw(), fixture: fixture('2:1') }, { at: Date.now() })]);
    await databetState.success([parseDatabetLiveEvent({ ...raw(), fixture: fixture('2:1') }, { at: Date.now() })]);
    const events = await pending;
    const hello = events.find((e) => e.type === 'hello');
    assert.equal(hello.data.liveOddsProvider, 'databet'); assert.match(hello.data.feeds.live.revision, /~databet$/);
    const patches = events.filter((e) => e.type === 'patch');
    assert.ok(patches.some((e) => e.data.provider === 'databet' && e.data.patches.some((p) => p.source === 'databet')));
    assert.equal(patches.some((e) => e.data.provider === 'ggbet'), false, 'GGBET patches never reach a DataBet stream');
    const bad = await fetch(`${api.base}/api/feed-stream?modes=live&provider=x`); assert.equal(bad.status, 400);
  } finally { await api.close(); await stopMatcher(); }
});

test('API without DataBet keeps the GGBET LIVE cache: the idle-variant cleanup never touches the default variant', async () => {
  const names = ['t-astek-live', 't-prematch', 't-fonbet-live', 't-fonbet-prematch'];
  const states = names.map((n) => new SnapshotState(n, 60000)); for (const s of states) s.persist = async () => {};
  const server = createApi({ liveState: states[0], prematchState: states[1], fonbetLiveState: states[2], fonbetPrematchState: states[3], prematchCollector: { status: () => ({}), catalog: [] }, fonbetCollector: { status: () => ({}) }, resultsService: { status: () => ({}), days: new Map() }, startedAt: Date.now() });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = 'http://127.0.0.1:' + server.address().port;
  try {
    const first = await (await fetch(base + '/api/ui/live')).json();
    assert.equal(first.liveOddsProvider, 'ggbet');
    const missing = await fetch(base + '/api/ui/live?provider=databet'); assert.equal(missing.status, 503);
    assert.match((await missing.json()).error, /DataBet не подключён/);
    const api = fs.readFileSync(new URL('../src/api.js', import.meta.url), 'utf8');
    assert.match(api, /provider!=='ggbet'&&liveOddsStates\[provider\]&&!active\.includes\(provider\)\)combinedCache\.delete/);
  } finally { await new Promise((r) => server.close(r)); await stopMatcher(); }
});

test('collector: scheduled session refresh drops the in-memory guest token and reconnects with a fresh one', async () => {
  const oldRefresh = config.databetSessionRefreshMs; config.databetSessionRefreshMs = 1;
  FakeSocket.list = [raw()];
  let pageFetches = 0;
  const c = new DatabetLiveCollector(rowsState(), { fetchImpl: async () => { pageFetches++; return { ok: true, status: 200, text: async () => page() }; }, WebSocketImpl: FakeSocket });
  c.stopped = false;
  try {
    await c.connect(); await wait(20);
    assert.equal(pageFetches, 1);
    c.lastConnectAt = Date.now() - 100; c.maintenance(); await wait(10);
    assert.equal(c.bootstrap, null); assert.equal(c.status().scheduledRefreshes, 1); assert.match(c.lastClose, /4001 scheduled-token-refresh/);
    clearTimeout(c.reconnectTimer); c.reconnectTimer = null;
    await c.connect(); await wait(20);
    assert.equal(pageFetches, 2, 'the next session reads a fresh guest token from the page');
    assert.equal(c.status().connectionState, 'connected'); assert.equal(c.status().reconnects, 1);
  } finally { config.databetSessionRefreshMs = oldRefresh; await c.stop(); }
});
