import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { GgbetLiveCollector } from '../src/ggbet.js';
import { BrowserGgbetSource, ipcGet, unavailableRow } from '../src/ggbet-browser-source.js';
import { serveIpc } from '../../tools/ggbet-browser/ipc.mjs';
import { compactUiRef } from '../src/ui-service.js';

// Hybrid GGBET source: the real Node collector over a fake GG.BET socket (30 LIVE events, light streams) plus the
// browser arbiter fed by a controllable worker feed (the IPC payload the Firefox worker serves).
const market = (id, typeId, odds, status = 'ACTIVE') => ({ id, name: `Market ${id}`, status, typeId, tags: [], specifiers: id.includes('m') ? [{ name: 'mapnr', value: id.split('m')[1] }] : [], meta: [], odds: odds.map(([oid, name, value], i) => ({ id: oid, name, value, isActive: true, status: 'NOT_RESULTED', competitorIds: typeId === 1 ? [i === 0 ? 'h' : 'a'] : [] })) });
const nodeMarkets = () => [market('1', 1, [['1', 'Home', '1.80'], ['2', 'Away', '1.95']]), market('96m1', 96, [['1', 'odd', '1.91'], ['2', 'even', '1.83']]), market('2', 2, [['1', 'Over 2.5', '1.70'], ['2', 'Under 2.5', '2.05']])];
const event = (n, markets = nodeMarkets()) => ({ id: `5:00000000-0000-4000-8000-${String(n).padStart(12, '0')}`, slug: `m-${n}`, disabled: false, betStop: false, version: 'v1', meta: [{ name: 'bo', value: '3' }],
  fixture: { score: '0:1', title: `Home ${n} vs Away ${n}`, status: 'LIVE', type: 'MATCH', startTime: '2026-10-03T10:00:00+00:00', sportId: 'esports_dota_2', sport: { id: 'esports_dota_2', name: 'Dota 2', slug: 'dota-2' }, tournament: { id: 't', name: 'League', slug: 'league', sportId: 'esports_dota_2' },
    competitors: [{ id: 'h', name: `Home ${n}`, homeAway: 'HOME', score: [{ type: 'total', points: '0', number: 0 }] }, { id: 'a', name: `Away ${n}`, homeAway: 'AWAY', score: [{ type: 'total', points: '1', number: 0 }] }] }, markets });
// What Firefox received through its own VPN: a different (raw, uncorrected) 96 price and the full "All" tree.
const browserRaw = (n, odd = '1.85', even = '1.85') => event(n, [...nodeMarkets().map((m) => (m.id === '96m1' ? market('96m1', 96, [['1', 'odd', odd], ['2', 'even', even]]) : m)), ...Array.from({ length: 40 }, (_, i) => market(`50${i}`, 500 + i, [['1', 'A', '1.90'], ['2', 'B', '1.90']]))]);
const top = (e) => ({ ...e, markets: e.markets.slice(0, 3) });

class LineSocket {
  static all = [];
  constructor() { this.readyState = 0; this.listeners = new Map(); this.sent = []; this.running = new Map(); LineSocket.all.push(this); queueMicrotask(() => { this.readyState = 1; this.emit('open', {}); }); }
  addEventListener(n, fn) { if (!this.listeners.has(n)) this.listeners.set(n, []); this.listeners.get(n).push(fn); }
  emit(n, e) { for (const fn of this.listeners.get(n) || []) fn(e); }
  message(o) { this.emit('message', { data: JSON.stringify(o) }); }
  send(body) {
    const msg = JSON.parse(body); this.sent.push(msg);
    if (msg.type === 'connection_init') return queueMicrotask(() => this.message({ type: 'connection_ack' }));
    if (msg.type === 'stop') { this.running.delete(msg.id); return; }
    const op = msg.payload?.operationName, v = msg.payload?.variables || {};
    if (op === 'GetSportEventListByFilters') return queueMicrotask(() => { this.message({ id: msg.id, type: 'data', payload: { data: { matches: { sportEvents: LineSocket.line.map(top) } } } }); this.message({ id: msg.id, type: 'complete' }); });
    if (op === 'GetMarketsTabs') return queueMicrotask(() => { this.message({ id: msg.id, type: 'data', payload: { data: { compiledMarketsTabs: { tabs: [{ id: 'all', name: 'All' }] } } } }); this.message({ id: msg.id, type: 'complete' }); });
    if (op === 'GetMarketsTab') return queueMicrotask(() => { const e = LineSocket.line.find((x) => x.id === v.sportEventID); this.message({ id: msg.id, type: 'data', payload: { data: { compiledMarketsTab: { sportEvent: { id: e.id }, marketIds: e.markets.map((m) => m.id) } } } }); this.message({ id: msg.id, type: 'complete' }); });
    this.running.set(msg.id, { op, variables: v });
  }
  close(code = 1000, reason = '') { if (this.readyState === 3) return; this.readyState = 3; queueMicrotask(() => this.emit('close', { code, reason, target: this })); }
  full() { return [...this.running.values()].filter((s) => s.op === 'OnUpdateSportEvent' && s.variables.marketIds.length > 3).length; }
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const html = `<script>"bettingClientOptions":{"token":"${'t'.repeat(389)}","endpoint":"//gg-b-gql.gg.bet"}</script>`;
const ID = (n) => event(n).id, SID = (n) => ID(n).replace(/^\d+:/, ''), ROW = (n) => `ggbet-${SID(n)}`;

async function hybrid({ stateFile = null, clock = { t: Date.now() } } = {}) {
  LineSocket.line = Array.from({ length: 30 }, (_, i) => event(i + 1)); LineSocket.all = [];
  const now = () => clock.t, w = { feed: null, fail: false, reads: [] };
  const src = new BrowserGgbetSource({ now, ipcStaleMs: 5000, stateFile, request: async (_sock, p) => { w.reads.push(p); if (w.fail) throw Error('connect ECONNREFUSED'); return w.feed; } });
  const state = { rows: [], async success(rows) { this.rows = rows; }, async failure() {} };
  const c = new GgbetLiveCollector(state, { fetchImpl: async () => ({ ok: true, status: 200, text: async () => html }), WebSocketImpl: LineSocket, now, browser: src });
  c.stopped = false; await c.connect(); await wait(30);
  const sync = async () => { await src.poll(); await c.publish(); };
  return { c, src, state, w, clock, sync, ws: () => LineSocket.all.at(-1), row: (n) => state.rows.find((r) => r.id === ROW(n)) };
}
const sel = (n, extra = {}) => ({ eventId: ID(n), sportId: 'esports_dota_2', sport: 'Dota 2', slug: `m-${n}`, title: `Home ${n} vs Away ${n}`, state: 'HEALTHY', fresh: true, ready: true, allLoaded: true, identity: true, marketCount: 43, seq: 1, pageId: `P${n}`, catalogComplete: true, validatedAt: new Date().toISOString(), dataFreshMs: 180000, sportRank: 1, globalRank: 3, reason: 'top Dota 2 (provider rank 1)', lastUpdateAt: new Date().toISOString(), ...extra });
const feed = ({ worker = 'W1', seq = 1, selected = [], retiring = [], events = {}, vpnState = 'UP', browserRunning = true, selectionReady = vpnState === 'UP' && browserRunning } = {}) => ({ at: new Date().toISOString(), worker, seq, sessionId: 'B1', vpnState, browserRunning, selectionReady, vpnExit: { ip: '154.47.29.18', city: 'Zagreb', hostname: 'hr-zag-wg-002' }, maxPages: 3, selected, retiring, events });
const price96 = (row) => row.odds.markets.find((m) => m.rawType === 96).prices.map((p) => p.decimal);

test('selected + ready = browser (raw browser values, full tree); every other event = node; one row per event', async () => {
  const h = await hybrid();
  try {
    h.w.feed = feed({ selected: [sel(1), sel(2)], events: { [ID(1)]: browserRaw(1), [ID(2)]: browserRaw(2, '1.74', '1.74') } }); await h.sync();
    assert.equal(h.state.rows.length, 30, 'no duplicate and no missing event');
    assert.equal(new Set(h.state.rows.map((r) => r.id)).size, 30);
    assert.deepEqual(price96(h.row(1)), [1.85, 1.85], 'browser raw value as received - not corrected, not Node');
    assert.deepEqual(price96(h.row(2)), [1.74, 1.74], 'any received value is published as is');
    assert.deepEqual(price96(h.row(3)), [1.91, 1.83], 'non-selected event: Node');
    assert.equal(h.row(1).odds.markets.length, 43, 'selected event: the whole browser "All" tree, not Node top markets');
    assert.equal(h.row(3).odds.markets.length, 3);
    assert.equal(h.src.mode(ID(1)), 'browser'); assert.equal(h.src.mode(ID(3)), 'node');
    const s = h.c.browserSummary(); assert.equal(s.browserBackedEvents, 2); assert.equal(s.node.eventCount, 28); assert.equal(s.node.source, 'node-proxy');
  } finally { await h.c.stop(); }
});

test('handoff node -> browser only when ready (no empty transition), then atomic', async () => {
  const h = await hybrid();
  try {
    h.w.feed = feed({ selected: [sel(1, { ready: false, state: 'RECOVERING', allLoaded: false })], events: {} }); await h.sync();
    assert.deepEqual(price96(h.row(1)), [1.91, 1.83], 'not ready: the Node event stays');
    assert.equal(h.src.mode(ID(1)), 'node');
    h.w.feed = feed({ seq: 2, selected: [sel(1)], events: { [ID(1)]: browserRaw(1) } }); await h.sync();
    assert.equal(h.state.rows.filter((r) => r.id === ROW(1)).length, 1, 'exactly one row for the event');
    assert.deepEqual(price96(h.row(1)), [1.85, 1.85]);
    assert.ok(h.src.history.some((x) => x.eventId === ID(1) && x.from === 'node' && x.to === 'browser'));
  } finally { await h.c.stop(); }
});

test('browser stale / VPN_DOWN / browser down / IPC loss: no silent Node substitution, prices removed and odds.stale', async () => {
  for (const fault of ['stale', 'vpn', 'browser', 'ipc']) {
    const h = await hybrid();
    try {
      h.w.feed = feed({ selected: [sel(1)], events: { [ID(1)]: browserRaw(1) } }); await h.sync();
      if (fault === 'stale') h.w.feed = feed({ seq: 2, selected: [sel(1, { state: 'STALE', fresh: false, ready: false })] });
      if (fault === 'vpn') h.w.feed = feed({ seq: 2, vpnState: 'VPN_DOWN', browserRunning: false, selected: [] }); // the worker drops every page on VPN loss
      if (fault === 'browser') h.w.feed = feed({ seq: 2, browserRunning: false, selected: [sel(1, { state: 'UNAVAILABLE', fresh: false, ready: false })] });
      if (fault === 'ipc') { h.w.fail = true; h.clock.t += 6000; }
      await h.sync();
      const r = h.row(1);
      assert.ok(r, `${fault}: the event stays visible`); assert.equal(h.src.mode(ID(1)), 'browser-unavailable', fault);
      assert.equal(r.odds.stale, true, fault); assert.ok(r.odds.markets.every((m) => m.status === 'suspended' && m.prices.every((p) => p.decimal === null)), `${fault}: no price is served`);
      assert.notDeepEqual(price96(r), [1.91, 1.83], `${fault}: never the Node price`);
      assert.deepEqual(price96(h.row(3)), [1.91, 1.83], `${fault}: other events keep Node`);
      // recovery: the browser is authoritative again
      h.w.fail = false; h.w.feed = feed({ worker: 'W1', seq: 3, selected: [sel(1)], events: { [ID(1)]: browserRaw(1, '1.80', '1.80') } }); h.w.feed.at = new Date(h.clock.t).toISOString(); await h.sync();
      assert.equal(h.src.mode(ID(1)), 'browser', `${fault}: recovered`); assert.deepEqual(price96(h.row(1)), [1.8, 1.8]);
    } finally { await h.c.stop(); }
  }
});

test('deselection: browser -> node only once the Node event is fresh, atomically', async () => {
  const h = await hybrid();
  try {
    h.w.feed = feed({ selected: [sel(1)], events: { [ID(1)]: browserRaw(1) } }); await h.sync();
    h.c.lastSnapshotAt = h.clock.t - 10 * 60000; // Node's view is old
    h.w.feed = feed({ seq: 2, selected: [] }); await h.sync();
    assert.equal(h.src.mode(ID(1)), 'browser-unavailable', 'Node not fresh yet: no handback'); assert.equal(h.row(1).odds.stale, true);
    h.c.lastSnapshotAt = h.clock.t; await h.c.publish();
    assert.equal(h.src.mode(ID(1)), 'node'); assert.deepEqual(price96(h.row(1)), [1.91, 1.83]);
    assert.equal(h.state.rows.filter((r) => r.id === ROW(1)).length, 1);
    assert.ok(h.src.history.some((x) => x.eventId === ID(1) && x.from === 'browser-unavailable' && x.to === 'node'));
  } finally { await h.c.stop(); }
});

test('full markets: a browser-owned event never gets a Node full-market subscription; detail = browser tree', async () => {
  const h = await hybrid();
  try {
    // A Node lease taken before the handoff ends with it.
    const full = () => [...h.c.subscriptions.values()].filter((x) => x.mode === 'full').length;
    assert.equal(h.c.lease('lease-aaaaaaaa', SID(1)).ok, true); await wait(20); assert.equal(full(), 1);
    h.w.feed = feed({ selected: [sel(1)], events: { [ID(1)]: browserRaw(1) } }); await h.sync(); await wait(20);
    assert.equal(full(), 0, 'Node full stream stopped at handoff'); assert.equal(h.c.fullEvents.size, 0);
    const r = h.c.lease('lease-bbbbbbbb', SID(1)); assert.deepEqual(r, { ok: true, browser: true }); await wait(20);
    assert.equal(full(), 0, 'lease on a browser event: no Node full subscription');
    const d = await h.c.detail(SID(1), { full: true }); assert.equal(d.odds.markets.length, 43); assert.deepEqual(price96(d), [1.85, 1.85]);
    assert.equal(h.c.lease('lease-cccccccc', SID(4)).ok, true, 'other events: Node lease mechanism unchanged'); await wait(20); assert.equal(full(), 1);
  } finally { await h.c.stop(); }
});

test('server restart: a browser-owned event stays fail-closed until the browser is ready again', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ggbr-arb-')), stateFile = path.join(dir, 'arbiter.json');
  const a = await hybrid({ stateFile });
  try { a.w.feed = feed({ selected: [sel(1)], events: { [ID(1)]: browserRaw(1) } }); await a.sync(); } finally { await a.c.stop(); }
  const b = await hybrid({ stateFile });
  try {
    b.w.feed = feed({ worker: 'W2', selectionReady: false, selected: [] }); await b.sync();
    assert.equal(b.src.mode(ID(1)), 'browser-unavailable', 'browser still warming up: no Node substitution'); assert.ok(b.row(1).odds.markets.every((m) => m.prices.every((p) => p.decimal === null)));
    b.w.feed = feed({ worker: 'W2', selected: [sel(1, { ready: false, state: 'RECOVERING' })] }); await b.sync();
    assert.equal(b.src.mode(ID(1)), 'browser-unavailable'); assert.equal(b.row(1).odds.stale, true, 'no Node prices for a browser-owned event after restart');
    b.w.feed = feed({ worker: 'W2', seq: 2, selected: [sel(1)], events: { [ID(1)]: browserRaw(1) } }); await b.sync();
    assert.equal(b.src.mode(ID(1)), 'browser');
  } finally { await b.c.stop(); }
});

test('browser (worker) restart: a new worker id re-reads everything from seq 0; old data never reused', async () => {
  const h = await hybrid();
  try {
    h.w.feed = feed({ worker: 'W1', seq: 500, selected: [sel(1)], events: { [ID(1)]: browserRaw(1) } }); await h.sync();
    h.w.reads.length = 0; h.w.feed = feed({ worker: 'W9', seq: 3, selected: [sel(1, { ready: false, state: 'RECOVERING' })] }); await h.sync();
    assert.deepEqual(h.w.reads, ['/feed?since=500', '/feed?since=0']); assert.equal(h.src.raws.size, 0, 'the old session raw is gone');
    assert.equal(h.src.mode(ID(1)), 'browser-unavailable');
  } finally { await h.c.stop(); }
});

test('event left LIVE everywhere: removed, no stale ghost; schema of a browser row = a Node row', async () => {
  const h = await hybrid();
  try {
    h.w.feed = feed({ selected: [sel(1)], events: { [ID(1)]: browserRaw(1) } }); await h.sync();
    const b = h.row(1), n = h.row(2), keys = (o) => Object.keys(o).sort();
    assert.deepEqual(keys(b), keys(n)); assert.deepEqual(keys(b.odds), keys(n.odds)); assert.deepEqual(keys(b.odds.markets[0]), keys(n.odds.markets[0])); assert.deepEqual(keys(b.odds.markets[0].prices[0]), keys(n.odds.markets[0].prices[0]));
    assert.equal(b.source, 'ggbet'); assert.equal(b.provider, 'GGBET'); assert.equal(b.id, ROW(1));
    const u = unavailableRow(b, 1); assert.deepEqual(keys(u.odds).filter((k) => !['unavailableSince'].includes(k)), keys(b.odds));
    LineSocket.line = LineSocket.line.filter((e) => e.id !== ID(1)); await h.c.applySnapshot(LineSocket.line.map(top));
    h.w.feed = feed({ seq: 2, selected: [] }); await h.sync();
    assert.equal(h.row(1), undefined); assert.equal(h.src.mode(ID(1)), 'node'); assert.equal(h.state.rows.length, 29);
  } finally { await h.c.stop(); }
});

test('UI/SSE projection: a browser event is projected like a Node event; unavailable = stale with no price', async () => {
  const h = await hybrid();
  try {
    h.w.feed = feed({ selected: [sel(1)], events: { [ID(1)]: browserRaw(1, '1.85', '1.85') } }); await h.sync();
    const b = compactUiRef(h.row(1)), n = compactUiRef(h.row(2));
    assert.deepEqual(Object.keys(b).sort(), Object.keys(n).sort());
    assert.equal(b.quote.h, 1.8); assert.equal(b.quote.a, 1.95); assert.equal(b.quote.stale, undefined);
    h.w.feed = feed({ seq: 2, selected: [sel(1, { state: 'STALE', fresh: false, ready: false })] }); await h.sync();
    const u = compactUiRef(h.row(1)); assert.equal(u.quote.stale, 1); assert.equal(u.quote.h, null); assert.equal(u.quote.a, null);
  } finally { await h.c.stop(); }
});

test('IPC client: real Unix socket, JSON only, timeouts surface as errors', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ggbr-ipc-')), sock = path.join(dir, 's.sock');
  const srv = serveIpc({ socketPath: sock, handle: ({ url }) => url.pathname === '/feed' ? { body: feed() } : { status: 404 } }); await new Promise((r) => srv.on('listening', r));
  assert.equal(fs.statSync(sock).mode & 0o777, 0o660);
  assert.equal(fs.statSync(dir).mode & 0o777, 0o750);
  assert.equal(srv.address(), sock, 'Unix socket only');
  try {
    assert.equal((await ipcGet(sock, '/feed?since=0')).worker, 'W1');
    await assert.rejects(ipcGet(sock, '/nope'), /HTTP 404/);
    await assert.rejects(ipcGet(path.join(dir, 'missing.sock'), '/feed'), /ENOENT/);
  } finally { srv.close(); }
});

test('readiness evidence is checked independently; QUIET with a fresh version confirmation remains valid', async () => {
  const h = await hybrid();
  try {
    for (const bad of [{ identity: false }, { allLoaded: false }, { catalogComplete: false }, { fresh: false }, { state: 'STALE' }, { validatedAt: new Date(h.clock.t - 180001).toISOString() }, { lastUpdateAt: new Date(h.clock.t + 3000).toISOString() }, { sportId: 'esports_counter_strike' }]) {
      h.w.feed = feed({ selected: [sel(1, bad)], events: { [ID(1)]: browserRaw(1) } }); await h.sync();
      assert.equal(h.src.mode(ID(1)), 'node', JSON.stringify(bad));
    }
    h.w.feed = feed({ selected: [sel(1, { state: 'QUIET', lastUpdateAt: new Date(h.clock.t - 600000).toISOString(), validatedAt: new Date(h.clock.t).toISOString() })], events: { [ID(1)]: browserRaw(1) } }); await h.sync();
    assert.equal(h.src.mode(ID(1)), 'browser'); assert.deepEqual(price96(h.row(1)), [1.85, 1.85]);
  } finally { await h.c.stop(); }
});

test('a responsive IPC serving old timestamps is stale; detail fails closed before the next publish', async () => {
  const h = await hybrid();
  try {
    h.w.feed = feed({ selected: [sel(1)], events: { [ID(1)]: browserRaw(1) } }); await h.sync();
    h.clock.t += 6000;
    assert.equal((await h.c.detail(SID(1))).odds.stale, true, 'expiry is checked at detail read time');
    await h.sync(); assert.equal(h.src.ipc.ok, true); assert.equal(h.src.ipcFresh(), false);
    assert.equal(h.src.mode(ID(1)), 'browser-unavailable'); assert.deepEqual(price96(h.row(1)), [null, null]);
    h.w.feed.at = new Date(h.clock.t).toISOString(); await h.sync(); assert.equal(h.src.mode(ID(1)), 'browser');
    // Socket reconnect reads the missing raw deltas from the last acknowledged sequence.
    h.w.fail = true; await h.sync(); assert.equal(h.src.mode(ID(1)), 'browser-unavailable');
    h.w.fail = false; await h.sync(); assert.equal(h.src.mode(ID(1)), 'browser');
  } finally { await h.c.stop(); }
});

test('fresh browser updates do not renew freshness for disconnected Node events', async () => {
  const h = await hybrid();
  try {
    h.w.feed = feed({ selected: [sel(1)], events: { [ID(1)]: browserRaw(1) } }); await h.sync();
    h.c.lastSnapshotAt = h.clock.t - 600000; await h.c.publish();
    assert.equal(h.row(1).odds.stale, false); assert.equal(h.row(2).odds.stale, true);
    assert.deepEqual(price96(h.row(2)), [null, null]);
    h.c.lastSnapshotAt = h.clock.t; await h.c.publish(); assert.equal(h.row(2).odds.stale, false);
  } finally { await h.c.stop(); }
});

test('browser session change within the same worker clears raw snapshots; unavailable detail never falls through to Node', async () => {
  const h = await hybrid();
  try {
    h.w.feed = feed({ selected: [sel(1)], events: { [ID(1)]: browserRaw(1) } }); await h.sync();
    h.w.reads.length = 0;
    h.w.feed = { ...feed({ seq: 2, selected: [sel(1)] }), sessionId: 'B2' }; await h.sync();
    assert.deepEqual(h.w.reads, ['/feed?since=1', '/feed?since=0']); assert.equal(h.src.raws.size, 0);
    assert.equal(h.src.mode(ID(1)), 'browser-unavailable');
    h.src.published.clear(); assert.equal(await h.c.detail(SID(1)), null, 'no Node detail fallback for an owned event');
    LineSocket.line = []; await h.c.applySnapshot([]); h.w.fail = true; await h.sync();
    assert.equal(h.src.mode(ID(1)), 'browser-unavailable', 'IPC failure and missing Node data cannot relinquish browser authority');
  } finally { await h.c.stop(); }
});

test('a LIVE retiring page is kept browser-backed until a fresh Node copy is published; acknowledgement follows publication', async () => {
  const h = await hybrid();
  try {
    h.w.feed = feed({ selected: [sel(1)], events: { [ID(1)]: browserRaw(1) } }); await h.sync();
    const request = h.src.request, acknowledgements = [];
    h.src.request = async (...args) => { if (args[1] === '/handoff') { assert.deepEqual(price96(h.row(1)), [1.91, 1.83], 'fresh Node data already visible'); acknowledgements.push(args[3]); return { ok: true }; } return request(...args); };
    h.c.lastSnapshotAt = h.clock.t - 600000;
    h.w.feed = feed({ seq: 2, retiring: [sel(1, { retiring: 'diversity' })], events: { [ID(1)]: browserRaw(1) } }); await h.sync();
    assert.equal(h.src.mode(ID(1)), 'browser'); assert.deepEqual(price96(h.row(1)), [1.85, 1.85]); assert.equal(acknowledgements.length, 0);
    // A newly connected socket with an old retained event is not enough to hand back.
    h.c.lastSnapshotAt = h.clock.t; h.c.events.get(ID(1)).__receivedAt = h.clock.t - 600000; await h.c.publish();
    assert.equal(acknowledgements.length, 0); assert.equal(h.src.mode(ID(1)), 'browser');
    h.c.events.get(ID(1)).__receivedAt = h.clock.t; await h.c.publish();
    assert.equal(h.src.mode(ID(1)), 'node'); assert.equal(h.state.rows.filter((r) => r.id === ROW(1)).length, 1);
    assert.deepEqual(acknowledgements, [{ worker: 'W1', sessionId: 'B1', eventId: ID(1), pageId: 'P1' }]);
  } finally { await h.c.stop(); }
});

test('a failed publication cannot acknowledge page closure; acknowledgement failures can be retried', async () => {
  const h = await hybrid();
  try {
    h.w.feed = feed({ selected: [sel(1)], events: { [ID(1)]: browserRaw(1) } }); await h.sync();
    const request = h.src.request; let acks = 0, failAck = true;
    h.src.request = async (...args) => { if (args[1] === '/handoff') { acks++; if (failAck) throw Error('IPC lost'); return { ok: true }; } return request(...args); };
    h.w.feed = feed({ seq: 2, retiring: [sel(1, { retiring: 'diversity' })] }); await h.src.poll();
    const success = h.state.success; h.state.success = async () => { throw Error('publish failure'); };
    await assert.rejects(h.c.publish(), /publish failure/); assert.equal(acks, 0);
    h.state.success = success; await h.c.publish(); assert.equal(acks, 1);
    failAck = false; await h.src.poll(); await h.c.publish(); assert.equal(acks, 2);
  } finally { await h.c.stop(); }
});

test('real IPC POST handoff supports bounded JSON, epoch rejection, timeout and malformed replies', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ggbr-ipc-')), sock = path.join(dir, 's.sock');
  const srv = serveIpc({ socketPath: sock, handle: async ({ url, body }) => {
    if (url.pathname === '/slow') { await wait(100); return { body: {} }; }
    return body?.worker === 'current' ? { body: { ok: true } } : { status: 409, body: { ok: false } };
  } }); await new Promise((r) => srv.on('listening', r));
  try {
    assert.deepEqual(await ipcGet(sock, '/handoff', 1000, { worker: 'current' }), { ok: true });
    await assert.rejects(ipcGet(sock, '/handoff', 1000, { worker: 'old' }), /HTTP 409/);
    await assert.rejects(ipcGet(sock, '/handoff', 1000, { worker: 'x'.repeat(9000) }), /HTTP 413/);
    await assert.rejects(ipcGet(sock, '/slow', 10), /timeout/);
  } finally { await new Promise((r) => srv.close(r)); }
});
