import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import vm from 'node:vm';
import { MarketStore, pageState, publish, config, DEFAULTS, Discovery, listRows, selectEvents, mergeRawEvent, TARGET_SPORTS } from '../../tools/ggbet-browser/core.mjs';
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

// ---- selection: provider ranking, CASE A-D, stability ------------------------------------------------------------------
const CS = 'esports_counter_strike', DOTA = 'esports_dota_2', LOL = 'esports_league_of_legends';
const cand = (sportId, n, extra = {}) => ({ eventId: `${sportId}#${n}`, slug: `${sportId}-${n}`, sportId, title: `${sportId} ${n}`, sportRank: n, globalRank: null, firstSeenAt: 0, ...extra });
const C = (spec) => new Map(Object.entries(spec).map(([s, n]) => [s, Array.from({ length: n }, (_, i) => cand(s, i + 1))]));
const T0 = 10 * 60000, cfgSel = { ...DEFAULTS };
const ids = (r) => r.add.map((c) => c.eventId);
const held = (list, at = 0) => list.map((c) => ({ eventId: c.eventId ?? c, sportId: String(c.eventId ?? c).split('#')[0], selectedAt: at }));

test('selection: target sports are the provider ids; max 3 by default', () => {
  assert.deepEqual(TARGET_SPORTS, [CS, DOTA, LOL]); assert.equal(DEFAULTS.maxPages, 3); assert.equal(config({}).maxPages, 3);
});
test('selection CASE A: LIVE in all three sports -> top CS + top Dota + top LoL', () => {
  const r = selectEvents({ candidates: C({ [CS]: 5, [DOTA]: 2, [LOL]: 2 }), now: T0, cfg: cfgSel });
  assert.deepEqual(ids(r).sort(), [`${CS}#1`, `${DOTA}#1`, `${LOL}#1`].sort()); assert.ok(r.add.every((c) => /top/.test(c.reason)));
});
test('selection CASE B: two sports -> one each, third = next most popular among them (provider global rank)', () => {
  const c = C({ [CS]: 4, [DOTA]: 3 }); c.get(DOTA)[1].globalRank = 2; c.get(CS)[1].globalRank = 7; c.get(CS)[0].globalRank = 1; c.get(DOTA)[0].globalRank = 4;
  const r = selectEvents({ candidates: c, now: T0, cfg: cfgSel });
  assert.deepEqual(ids(r), [`${CS}#1`, `${DOTA}#1`, `${DOTA}#2`]); assert.match(r.add[2].reason, /next most popular/);
});
test('selection never invents cross-sport popularity; it waits for the provider global list', () => {
  const candidates = C({ [CS]: 4, [DOTA]: 3 });
  const first = selectEvents({ candidates, now: T0, cfg: cfgSel });
  assert.deepEqual(ids(first), [`${CS}#1`, `${DOTA}#1`]);
  candidates.get(DOTA)[1].globalRank = 2; candidates.get(CS)[1].globalRank = 7;
  const next = selectEvents({ current: held(first.add), candidates, now: T0, cfg: cfgSel });
  assert.deepEqual(ids(next), [`${DOTA}#2`]); assert.equal(next.drop.length, 0);
});
test('selection CASE C: one sport -> its top 3; CASE D: fewer than 3 LIVE -> all of them', () => {
  assert.deepEqual(ids(selectEvents({ candidates: C({ [CS]: 6 }), now: T0, cfg: cfgSel })), [`${CS}#1`, `${CS}#2`, `${CS}#3`]);
  assert.deepEqual(ids(selectEvents({ candidates: C({ [LOL]: 1, [DOTA]: 1 }), now: T0, cfg: cfgSel })).sort(), [`${DOTA}#1`, `${LOL}#1`].sort());
  assert.deepEqual(ids(selectEvents({ candidates: C({}), now: T0, cfg: cfgSel })), []);
});
test('selection: an ended event is replaced (uncovered sport first), excluded events never selected', () => {
  const c = C({ [CS]: 4, [DOTA]: 1 }); c.get(CS).forEach((x, i) => x.globalRank = i + 1);
  const r = selectEvents({ current: held([`${CS}#2`, `${CS}#3`]), candidates: c, now: T0, cfg: cfgSel, excluded: new Set([`${CS}#1`]) });
  assert.deepEqual(ids(r), [`${DOTA}#1`], 'free slot: the uncovered sport, not CS#1 (excluded/ended)');
  const r2 = selectEvents({ current: held([`${DOTA}#1`, `${CS}#2`]), candidates: c, now: T0, cfg: cfgSel, excluded: new Set([`${CS}#1`]) });
  assert.deepEqual(ids(r2), [`${CS}#3`]);
});
test('selection: diversity - CS1,CS2,CS3 + Dota appears -> CS1,CS2,DOTA1; + LoL -> CS1,DOTA1,LOL1 (one swap per round)', () => {
  let cur = held([`${CS}#1`, `${CS}#2`, `${CS}#3`]);
  let r = selectEvents({ current: cur, candidates: C({ [CS]: 5, [DOTA]: 2 }), now: T0, cfg: cfgSel });
  assert.deepEqual(r.drop.map((d) => d.eventId), [`${CS}#3`]); assert.deepEqual(ids(r), [`${DOTA}#1`]);
  cur = [...r.keep, ...held(ids(r), T0 - 600000)];
  r = selectEvents({ current: cur, candidates: C({ [CS]: 5, [DOTA]: 2, [LOL]: 1 }), now: T0, cfg: cfgSel });
  assert.deepEqual(r.drop.map((d) => d.eventId), [`${CS}#2`]); assert.deepEqual(ids(r), [`${LOL}#1`]);
  assert.deepEqual([...r.keep, ...r.add].map((x) => x.eventId).sort(), [`${CS}#1`, `${DOTA}#1`, `${LOL}#1`].sort());
  const both = selectEvents({ current: held([`${CS}#1`, `${CS}#2`, `${CS}#3`]), candidates: C({ [CS]: 5, [DOTA]: 2, [LOL]: 2 }), now: T0, cfg: cfgSel });
  assert.equal(both.drop.length, 1, 'bounded: one diversity swap per round');
});
test('selection: no thrashing - rank changes never move a held tab; diversity waits for presence and hold time', () => {
  const c = C({ [CS]: 5 }); c.get(CS).reverse().forEach((x, i) => { x.sportRank = i + 1; }); // provider ranks flipped
  const r = selectEvents({ current: held([`${CS}#1`, `${CS}#2`, `${CS}#3`]), candidates: c, now: T0, cfg: cfgSel });
  assert.deepEqual([r.add.length, r.drop.length], [0, 0]);
  const fresh = C({ [CS]: 3, [DOTA]: 1 }); fresh.get(DOTA)[0].firstSeenAt = T0 - 10000;
  assert.equal(selectEvents({ current: held([`${CS}#1`, `${CS}#2`, `${CS}#3`]), candidates: fresh, now: T0, cfg: cfgSel }).drop.length, 0, 'Dota listed for 10 s only');
  assert.equal(selectEvents({ current: held([`${CS}#1`, `${CS}#2`, `${CS}#3`], T0 - 30000), candidates: C({ [CS]: 3, [DOTA]: 1 }), now: T0, cfg: cfgSel }).drop.length, 0, 'held tabs younger than diversityHoldMs stay');
  // repeated rounds with an unchanged world: nothing moves
  let cur = held([`${CS}#1`, `${DOTA}#1`, `${LOL}#1`]); for (let i = 0; i < 20; i++) { const x = selectEvents({ current: cur, candidates: C({ [CS]: 5, [DOTA]: 2, [LOL]: 2 }), now: T0 + i * 15000, cfg: cfgSel }); assert.deepEqual([x.add.length, x.drop.length], [0, 0]); }
});
test('discovery: provider list order -> ranks; global list -> cross-sport rank; gone/ended judged on the list clock', () => {
  const ev = (n, sportId, status = 'LIVE') => ({ id: `5:0000000${n}-aaaa-bbbb-cccc-000000000000`, slug: `s${n}`, version: `v${n}`, fixture: { sportId, status, title: `T${n}`, tournament: { name: 'L' } } });
  const list = (evs, count = evs.length) => ({ type: 'data', id: '9', payload: { data: { matches: { count, sportEvents: evs } } } });
  const d = new Discovery();
  d.applyList([CS], listRows(list([ev(1, CS), ev(2, CS, 'NOT_STARTED'), ev(3, CS)])), 1000);
  d.applyList(TARGET_SPORTS.concat(['football']), listRows(list([ev(9, 'football'), ev(3, CS), ev(1, CS)])), 1000);
  const c = d.candidates(2000, cfgSel).get(CS);
  assert.deepEqual(c.map((x) => [x.eventId.slice(2, 10), x.sportRank, x.globalRank]), [['0000000' + '1', 1, 3], ['0000000' + '3', 2, 2]], 'NOT_STARTED skipped; provider order kept');
  assert.equal(d.candidates(1000 + cfgSel.listFreshMs + 1, cfgSel).has(CS), false, 'a stale list offers nothing new');
  const page = { eventId: ev(1, CS).id, sportId: CS, openedAt: 0 };
  d.applyList([CS], listRows(list([ev(3, CS)])), 1000 + cfgSel.endedGraceMs + 5000);
  assert.equal(d.gone(page, 1000 + cfgSel.endedGraceMs + 6000, cfgSel), true, 'absent from a fresh list for the grace period');
  assert.equal(d.gone(page, 1000 + cfgSel.endedGraceMs + 6000 + cfgSel.listFreshMs, cfgSel), false, 'a silent discovery never ends anything');
  d.applyUpdate({ id: ev(3, CS).id, fixture: { status: 'ENDED' } }, 5000); assert.equal(d.ended(ev(3, CS).id), true);
});
test('discovery cannot expire a LIVE page just because it fell outside a truncated provider list', () => {
  const d = new Discovery(), page = { eventId: 'held', sportId: CS, openedAt: 1 };
  d.applyList([CS], { count: 50, rows: [{ eventId: 'other', sportId: CS, status: 'LIVE', slug: 'other' }] }, cfgSel.endedGraceMs + 1000);
  assert.equal(d.gone(page, cfgSel.endedGraceMs + 2000, cfgSel), false);
  d.applyList([CS], { count: 1, rows: [{ eventId: 'other', sportId: CS, status: 'LIVE', slug: 'other' }] }, cfgSel.endedGraceMs + 3000);
  assert.equal(d.gone(page, cfgSel.endedGraceMs + 4000, cfgSel), true);
});
test('raw event for the server: merged GraphQL event + "All" catalog markets (ACTIVE/SUSPENDED), raw values as received', () => {
  const s = new MarketStore(), id = EV(1);
  s.ingest({ type: 'data', id: '8', payload: { data: { matchBySlug: { id, slug: 'a', version: 'v1', fixture: { status: 'LIVE', title: 'A vs B', competitors: [{ id: 'h', name: 'A', score: [{ type: 'total', points: '0' }] }, { id: 'a', name: 'B' }] } } } } });
  s.ingest({ type: 'data', id: '15', payload: { data: { compiledMarketsTab: { sportEvent: { id }, marketIds: ['96m1', '1'] } } } }, { allTab: true });
  s.ingest({ type: 'data', id: '15', payload: { data: { compiledMarketsTab: { sportEvent: { id }, marketIds: ['popular-only'] } } } }, { allTab: false });
  s.ingest(push(EV(1), 'v2', [mk('96m1', 96, '1.85', '1.85'), mk('1', 1, '1.5', '2.5'), mk('77', 77, '1.1', '1.2', 'DEACTIVATED'), mk('extra', 5, '2', '2')], { competitors: [{ id: 'h', score: [{ type: 'total', points: '1' }] }] }));
  const raw = s.rawEvent(id);
  assert.equal(raw.id, id); assert.equal(raw.version, 'v2'); assert.equal(raw.slug, 'a');
  assert.deepEqual(raw.markets.map((m) => m.id).sort(), ['1', '96m1'], 'catalog of the All tab only; non-active statuses dropped');
  assert.deepEqual(raw.markets.find((m) => m.id === '96m1').odds.map((o) => o.value), ['1.85', '1.85'], 'raw provider value, never corrected');
  assert.equal(raw.fixture.competitors.find((c) => c.id === 'h').name, 'A', 'competitors merged by id'); assert.equal(raw.fixture.competitors.find((c) => c.id === 'h').score[0].points, '1');
  assert.deepEqual(mergeRawEvent(null, { id }), { id });
  s.reset(); assert.equal(s.rawEvent(id), null);
});

test('freshness: after VPN loss or browser loss every market is stale/unavailable (old prices never served as fresh)', () => {
  const c = clock(), s = new MarketStore({ now: c.now }), pages = [{ pageId: 'P1', eventId: EV(1), openedAt: c.now(), lastWsFrameAt: c.now() }];
  s.ingest(push(EV(1), 'v1', [mk('96m1', 96, '1.85', '1.85')])); c.tick(2000);
  const ok = publish(s, pages, { now: c.now() })[0]; assert.equal(ok.fresh, true); assert.equal(ok.markets[0].stale, false); assert.equal(ok.markets[0].ageMs, 2000);
  for (const opts of [{ vpnState: 'VPN_DOWN' }, { browserUp: false }]) { const p = publish(s, pages, { ...opts, now: c.now() })[0]; assert.equal(p.state, 'UNAVAILABLE'); assert.equal(p.fresh, false); assert.ok(p.markets.every((m) => m.stale)); }
  s.reset(); const reopened = { pageId: 'P9', eventId: EV(1), openedAt: c.now(), lastWsFrameAt: c.now() };
  assert.equal(publish(s, [reopened], { now: c.now() })[0].state, 'RECOVERING', 'after a session ends, pre-outage data is gone: a reopened page waits for new data');
  assert.equal(publish(s, [reopened], { now: c.now() })[0].markets.length, 0);
  assert.equal(config({ GGBET_BROWSER_MAX_PAGES: '5', GGBET_BROWSER_EVENT_STALE_MS: '60000' }).maxPages, 3);
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
