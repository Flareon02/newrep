import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import vm from 'node:vm';
import { MarketStore, pageState, planPages, liveDotaCandidates, publish, config, DEFAULTS, pruneCandidates, goneFromList } from '../../tools/ggbet-browser/core.mjs';
import { PRELOAD } from '../../tools/ggbet-browser/preload.mjs';
import { ForensicLog } from '../src/ggbet-forensics.js';

const EV = (n) => `5:0000000${n}-aaaa-bbbb-cccc-000000000000`;
const mk = (id, typeId, o, e, status = 'ACTIVE') => ({ id, typeId, name: `M ${id}`, status, specifiers: id.includes('m') ? [{ name: 'mapnr', value: id.split('m')[1].slice(0, 1) }] : [], odds: [{ id: '1', name: 'odd', value: o, isActive: true }, { id: '2', name: 'even', value: e, isActive: true }] });
const push = (ev, version, markets, fixture = {}) => ({ type: 'data', id: '17', payload: { data: { onUpdateSportEvent: { id: ev, version, fixture: { status: 'LIVE', score: '0:1', sportId: 'esports_dota_2', title: 'A vs B', tournament: { name: 'L' }, ...fixture }, markets } } } });
function clock(t0 = Date.parse('2026-10-03T08:00:00Z')) { let t = t0; return { now: () => t, tick: (ms) => { t += ms; } }; }
const cfg = { ...DEFAULTS };

test('market parsing: full All tree, typeId 96 ids/outcomes, original names kept, duplicates and suspensions', () => {
  const c = clock(), s = new MarketStore({ now: c.now });
  s.ingest(push(EV(1), 'v1', [mk('96m1', 96, '1.85', '1.85'), mk('1', 1, '1.5', '2.5'), mk('50m1', 50, '1.7', '2.0')]), { pageId: 'P1' });
  const e = s.events.get(EV(1)); assert.equal(e.markets.size, 3); assert.equal(e.meta.eventName, 'A vs B'); assert.equal(e.meta.league, 'L');
  const m96 = s.typeId96(EV(1))[0]; assert.equal(m96.marketId, '96m1'); assert.equal(m96.mapnr, '1'); assert.deepEqual(m96.outcomes.map((o) => [o.outcomeId, o.outcomeName, o.rawPrice]), [['1', 'odd', '1.85'], ['2', 'even', '1.85']]); assert.equal(m96.source, 'firefox-browser');
  c.tick(1000); assert.equal(s.ingest(push(EV(1), 'v2', [mk('96m1', 96, '1.85', '1.85')])).changed.length, 0, 'duplicate push: nothing changed');
  assert.equal(s.stats.duplicates, 1, 'same prices again = duplicate, not a price change'); assert.equal(e.version, 'v2');
  c.tick(1000); s.ingest(push(EV(1), 'v3', [mk('96m1', 96, '1.74', '1.74', 'SUSPENDED')]));
  assert.equal(s.ingest(push(EV(1), 'v4', [mk('96m1', 96, '1.74', '2.10')])).changed[0].marketId, '96m1', 'price change reported');
  assert.equal(e.markets.get('96m1').outcomes[1].rawPrice, '2.10'); c.tick(1000); s.ingest(push(EV(1), 'v5', [mk('96m1', 96, '1.74', '1.74', 'SUSPENDED')]));
  assert.equal(e.markets.get('96m1').marketStatus, 'SUSPENDED'); assert.equal(s.stats.priceChanges, 3);
});

test('liveness: unchanged price with live event data is QUIET (healthy), not stale', () => {
  const c = clock(), s = new MarketStore({ now: c.now }), page = { pageId: 'P1', eventId: EV(1), openedAt: c.now(), lastWsFrameAt: c.now() };
  s.ingest(push(EV(1), 'v1', [mk('96m1', 96, '1.85', '1.85')]));
  for (let i = 0; i < 20; i++) { c.tick(30000); page.lastWsFrameAt = c.now(); s.ingest(push(EV(1), `v${i + 2}`, [], { score: `0:${i}` })); }
  const st = pageState(page, s.events.get(EV(1)), cfg, c.now());
  assert.equal(st, 'QUIET', '10 min without a price change but score/version updates: QUIET'); assert.ok(c.now() - s.events.get(EV(1)).lastPriceChangeAt > 9 * 60000);
});

test('liveness: keep-alives only (subscription silent) -> SUSPECT_STALE -> STALE; transport dead -> STALE; recovery', () => {
  const c = clock(), s = new MarketStore({ now: c.now }), page = { pageId: 'P1', eventId: EV(1), openedAt: c.now(), lastWsFrameAt: c.now() };
  s.ingest(push(EV(1), 'v1', [mk('96m1', 96, '1.85', '1.85')]));
  c.tick(cfg.eventStaleMs + 1000); page.lastWsFrameAt = c.now(); // ka frames keep coming
  assert.equal(pageState(page, s.events.get(EV(1)), cfg, c.now()), 'SUSPECT_STALE');
  c.tick(cfg.eventStaleMs); page.lastWsFrameAt = c.now() - cfg.wsStaleMs - 1000; // ... and then the transport stops too
  assert.equal(pageState(page, s.events.get(EV(1)), cfg, c.now()), 'STALE');
  const p2 = { ...page, lastWsFrameAt: c.now() }; c.tick(cfg.pageStaleMs); p2.lastWsFrameAt = c.now();
  assert.equal(pageState(p2, s.events.get(EV(1)), cfg, c.now()), 'STALE', 'keep-alives alone never keep a page alive beyond pageStaleMs');
  const rec = { ...page, recovering: true, recoveringSince: c.now() }; c.tick(5000);
  assert.equal(pageState(rec, s.events.get(EV(1)), cfg, c.now()), 'RECOVERING'); s.ingest(push(EV(1), 'v9', [mk('96m1', 96, '1.85', '1.85')]));
  rec.recovering = false; assert.equal(pageState(rec, s.events.get(EV(1)), cfg, c.now()), 'QUIET');
  const fresh = { pageId: 'P2', eventId: EV(2), openedAt: c.now(), lastWsFrameAt: c.now() };
  assert.equal(pageState(fresh, undefined, cfg, c.now()), 'RECOVERING', 'a loading tab with no event data is never HEALTHY');
  c.tick(cfg.eventStaleMs + 1); assert.equal(pageState(fresh, undefined, cfg, c.now()), 'STALE');
});

test('liveness reference: same version as a fresh discovery list = QUIET (source quiet); list ahead of the page = STALE at once', () => {
  const c = clock(), s = new MarketStore({ now: c.now }), page = { pageId: 'P1', eventId: EV(1), openedAt: c.now(), lastWsFrameAt: c.now() };
  s.ingest(push(EV(1), 'v1', [mk('96m1', 96, '1.85', '1.85')])); c.tick(cfg.eventStaleMs * 2); page.lastWsFrameAt = c.now();
  const e = s.events.get(EV(1));
  assert.equal(pageState(page, e, cfg, c.now()), 'SUSPECT_STALE', 'without a reference: suspect');
  assert.equal(pageState(page, e, cfg, c.now(), { version: 'v1', versionAt: c.now() - 5000 }), 'QUIET', 'list confirms the page holds the current version');
  assert.equal(pageState(page, e, cfg, c.now(), { version: 'v1', versionAt: c.now() - cfg.eventStaleMs - 1 }), 'SUSPECT_STALE', 'an old list proves nothing');
  assert.equal(pageState(page, e, cfg, c.now(), { version: 'v2', versionAt: c.now() }), 'STALE', 'list has a version the page never got');
  s.ingest(push(EV(1), 'v2', [])); s.ingest(push(EV(1), 'v3', []));
  assert.equal(pageState(page, e, cfg, c.now(), { version: 'v2', versionAt: c.now() }), 'QUIET', 'page ahead of the list is not lagging');
  const dead = { ...page, lastWsFrameAt: c.now() - cfg.wsStaleMs - 1 }; c.tick(cfg.eventStaleMs + 1);
  assert.equal(pageState(dead, e, cfg, c.now(), { version: 'v3', versionAt: c.now() }), 'STALE', 'source quiet but the page transport is dead');
});

test('page registry: up to 10 LIVE pages, deterministic, no rotation of open pages, ended pages closed, new LIVE opened', () => {
  const cands = Array.from({ length: 14 }, (_, i) => ({ eventId: EV(String(i).padStart(2, '0')), slug: `m${i}`, status: 'LIVE', scheduledAt: `2026-10-03T0${(i % 9)}:00:00Z` }));
  const first = planPages({ open: [], candidates: cands, maxPages: 10 }); assert.equal(first.add.length, 10); assert.deepEqual(planPages({ open: [], candidates: [...cands].reverse(), maxPages: 10 }).add.map((c) => c.eventId), first.add.map((c) => c.eventId), 'deterministic');
  const open = first.add.map((c) => ({ eventId: c.eventId, ended: false })); assert.equal(planPages({ open, candidates: cands, maxPages: 10 }).add.length, 0, 'full: nothing rotates');
  open[3].ended = true; const next = planPages({ open, candidates: cands, maxPages: 10 });
  assert.deepEqual(next.close.map((p) => p.eventId), [open[3].eventId]); assert.equal(next.add.length, 1); assert.ok(!open.some((p) => p.eventId === next.add[0].eventId));
  assert.equal(planPages({ open: open.filter((p) => !p.ended), candidates: cands, maxPages: 10, exclude: [open[3].eventId] }).add.some((c) => c.eventId === open[3].eventId), false, 'ended event never reopened while the list lags');
  assert.equal(planPages({ open: [], candidates: cands.slice(0, 2), maxPages: 10 }).add.length, 2, 'fewer LIVE matches: as many as exist');
  const mixed = [{ eventId: EV(90), slug: 'p', status: 'NOT_STARTED', scheduledAt: '2026-10-03T00:00:00Z' }, cands[0]];
  assert.deepEqual(planPages({ open: [], candidates: mixed, maxPages: 10 }).add.map((c) => c.eventId), [cands[0].eventId], 'prematch never opened by default');
  assert.deepEqual(planPages({ open: [], candidates: mixed, maxPages: 10, allowPrematch: true }).add.map((c) => c.eventId), [cands[0].eventId, EV(90)], 'capacity fill: LIVE first');
  assert.deepEqual(liveDotaCandidates({ type: 'data', payload: { data: { matches: { sportEvents: [{ id: EV(1), slug: 'a', version: 'x', fixture: { sportId: 'esports_dota_2', status: 'LIVE' } }, { id: EV(2), slug: 'b', fixture: { sportId: 'esports_dota_2', status: 'NOT_STARTED' } }, { id: EV(3), slug: 'c', fixture: { sportId: 'esports_counter_strike', status: 'LIVE' } }] } } } }).map((c) => c.eventId), [EV(1)]);
});

test('ended detection: absence counts only against a fresh list; an unreachable GG.BET never ends pages', () => {
  const c = clock(), t0 = c.now(), page = { eventId: EV(1), openedAt: t0 }, cands = new Map([[EV(1), { eventId: EV(1), seenAt: t0 }], [EV(2), { eventId: EV(2), seenAt: t0 }]]);
  c.tick(cfg.endedGraceMs * 3); // list received nothing since t0 (blocked)
  pruneCandidates(cands, t0, cfg); assert.equal(cands.size, 2, 'no candidate expires while the list is silent');
  assert.equal(goneFromList(page, cands, t0, cfg, c.now()), false);
  cands.delete(EV(1)); assert.equal(goneFromList(page, cands, t0, cfg, c.now()), false, 'a stale list proves nothing');
  const listAt = c.now() - 1000; cands.set(EV(2), { eventId: EV(2), seenAt: listAt }); pruneCandidates(cands, listAt, cfg);
  assert.equal(goneFromList(page, cands, listAt, cfg, c.now()), true, 'fresh list without the event, long after the page opened: ended');
  assert.equal(goneFromList({ eventId: EV(1), openedAt: c.now() - 5000 }, cands, listAt, cfg, c.now()), false, 'a just-opened page gets the grace period');
});

test('freshness: after VPN loss or browser loss every market is stale/unavailable (old prices never served as fresh)', () => {
  const c = clock(), s = new MarketStore({ now: c.now }), pages = [{ pageId: 'P1', eventId: EV(1), openedAt: c.now(), lastWsFrameAt: c.now() }];
  s.ingest(push(EV(1), 'v1', [mk('96m1', 96, '1.85', '1.85')])); c.tick(2000);
  const ok = publish(s, pages, { now: c.now() })[0]; assert.equal(ok.fresh, true); assert.equal(ok.markets[0].stale, false); assert.equal(ok.markets[0].ageMs, 2000);
  for (const opts of [{ vpnState: 'VPN_DOWN' }, { browserUp: false }]) { const p = publish(s, pages, { ...opts, now: c.now() })[0]; assert.equal(p.state, 'UNAVAILABLE'); assert.equal(p.fresh, false); assert.ok(p.markets.every((m) => m.stale)); }
  s.reset(); const reopened = { pageId: 'P9', eventId: EV(1), openedAt: c.now(), lastWsFrameAt: c.now() };
  assert.equal(publish(s, [reopened], { now: c.now() })[0].state, 'RECOVERING', 'after a session ends, pre-outage data is gone: a reopened page waits for new data');
  assert.equal(publish(s, [reopened], { now: c.now() })[0].markets.length, 0);
  assert.equal(config({ GGBET_BROWSER_MAX_PAGES: '5', GGBET_BROWSER_EVENT_STALE_MS: '60000' }).maxPages, 5);
});

test('preload: only gg-b-gql sockets observed; connection_init never forwarded; native socket and prototype kept', () => {
  const sent = [], made = [];
  class FakeWS { constructor(url) { this.url = url; this.l = {}; made.push(this); } addEventListener(t, f) { (this.l[t] ||= []).push(f); } send(d) { this.lastSent = d; } }
  const window = { WebSocket: FakeWS }; vm.runInNewContext(`(${PRELOAD})(send)`, { window, send: (s) => sent.push(JSON.parse(s)), Date, Math, JSON, String, RegExp });
  const other = new window.WebSocket('wss://score-board.databet.cloud/graphql'); assert.equal(sent.length, 0); assert.ok(other instanceof FakeWS);
  const ws = new window.WebSocket('wss://gg-b-gql.gg.bet/graphql', 'graphql-ws'); assert.ok(ws instanceof FakeWS); assert.equal(sent[0].k, 'open');
  ws.send(JSON.stringify({ type: 'connection_init', payload: { headers: { 'X-Auth-Token': 'eyJSECRET' } } })); assert.match(ws.lastSent, /connection_init/, 'still sent by the page');
  ws.send(JSON.stringify({ id: '5', type: 'start', payload: { operationName: 'GetMarketsTab', variables: { marketTabID: 'all' } } }));
  ws.l.message.forEach((f) => f({ data: '{"type":"ka"}' }));
  assert.deepEqual(sent.map((x) => x.k), ['open', 'out', 'in']); assert.ok(!JSON.stringify(sent).includes('eyJSECRET'), 'token never forwarded');
});

test('IPC socket is local-only with restrictive permissions; worker logs carry no secrets', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ggbr-')), sock = path.join(dir, 'data.sock');
  const srv = http.createServer((q, r) => r.end('{}')); await new Promise((r) => srv.listen(sock, r)); fs.chmodSync(sock, 0o660);
  assert.equal(fs.statSync(sock).mode & 0o777, 0o660); assert.ok(fs.statSync(sock).isSocket()); srv.close();
  const log = new ForensicLog({ dir: path.join(dir, 'log'), statfs: () => ({ bavail: 1e7, bsize: 4096 }) });
  log.write('ws', { event: 'open', note: 'token eyJhbGciOiJkaXIifQ..abcdefghijklmnopqrstuv', headers: { cookie: '__cf_bm=SECRETVALUE', Authorization: 'Bearer XYZXYZXYZXYZXYZ' } });
  const text = fs.readFileSync(path.join(dir, 'log', 'events', fs.readdirSync(path.join(dir, 'log', 'events'))[0]), 'utf8');
  for (const s of ['eyJhbGciOiJkaXIifQ', 'SECRETVALUE', 'XYZXYZXYZXYZ']) assert.ok(!text.includes(s), s);
});
