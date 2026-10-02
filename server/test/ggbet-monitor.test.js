import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { GgbetLiveCollector } from '../src/ggbet.js';
import { GgbetSupervisor } from '../src/ggbet-supervisor.js';
import { VpnPool } from '../src/ggbet-vpn-pool.js';
import { config } from '../src/config.js';

const DOTA = (n) => ({ id: `5:0000000${n}-aaaa-bbbb-cccc-000000000000`, version: 'v' + n, fixture: { sportId: 'esports_dota_2', status: 'LIVE', score: '0:0' }, markets: [{ id: '1', typeId: 1, odds: [] }] });
const CS = { id: '5:99999999-aaaa-bbbb-cccc-000000000000', version: 'c', fixture: { sportId: 'esports_counter_strike', status: 'LIVE' }, markets: [{ id: '1', typeId: 1, odds: [] }] };
const odd96 = (id, o, e) => ({ id, typeId: 96, status: 'ACTIVE', specifiers: [{ name: 'mapnr', value: id.slice(-1) }], odds: [{ id: '1', name: 'odd', value: o, isActive: true }, { id: '2', name: 'even', value: e, isActive: true }] });
function collector(events, t0 = Date.parse('2026-10-03T00:00:00Z')) {
  let t = t0; const sent = [];
  const c = new GgbetLiveCollector({ success() {}, failure() {}, rows: [] }, { now: () => t });
  c.ws = { readyState: 1, send: (s) => sent.push(JSON.parse(s)), close() {} }; c.lastAckAt = 1;
  c.events = new Map(events.map((e) => [e.id, e])); for (const e of events) c.lightIds.set(e.id, e.markets.map((m) => m.id));
  c.publish = async () => {};
  return { c, sent, tick: (ms) => { t += ms; } };
}
const starts = (sent, id) => sent.filter((m) => m.type === 'start' && m.payload?.variables?.sportEventId === id);

test('observer: exactly one LIVE Dota event; its EXISTING light stream also carries 96m1..96m5 (no new WS/bootstrap)', () => {
  const { c, sent } = collector([CS, DOTA(1), DOTA(2)]);
  c.monitorTick();
  assert.equal(c.monitorStatus().state, 'monitoring'); assert.equal(c.monitor.eventId, DOTA(1).id, 'one event only');
  const s = starts(sent, DOTA(1).id); assert.equal(s.length, 1);
  assert.deepEqual(s[0].payload.variables.marketIds, ['1', '96m1', '96m2', '96m3', '96m4', '96m5']);
  assert.equal(starts(sent, DOTA(2).id).length, 0); assert.equal(starts(sent, CS.id).length, 0);
  assert.equal(c.subscriptions.size, 1, 'one subscription for the monitored event (same OnUpdateSportEvent stream)');
  for (let i = 0; i < 20; i++) { c.monitorTick(); c.syncLight(DOTA(1).id); }
  assert.equal(starts(sent, DOTA(1).id).length, 1, 'no re-subscribe storm while nothing changes');
});

test('observer: typeId 96 updates are counted, reach the supervisor raw, and never enter the public event row', async () => {
  const { c } = collector([DOTA(1)]); c.monitorTick();
  const before = c.events.get(DOTA(1).id).markets;
  await c.applyPush({ id: DOTA(1).id, version: 'v1b', markets: [odd96('96m1', '1.86', '1.86')] });
  assert.equal(c.monitor.samples, 1); assert.deepEqual(c.events.get(DOTA(1).id).markets, before, 'UI row unchanged');
  await c.applyPush({ id: DOTA(1).id, version: 'v1c', markets: [{ id: '1', typeId: 1, odds: [{ id: '1', value: '1.5' }] }, odd96('96m2', '1.87', '1.87')] });
  assert.deepEqual(c.events.get(DOTA(1).id).markets.map((m) => m.id), ['1'], 'main markets still update; 96 stripped');
});

test('observer: a user full lease on the monitored event is not duplicated; release restores the observer stream', () => {
  const { c, sent } = collector([DOTA(1), DOTA(2)]); c.fullEvents.add(DOTA(1).id); c.monitorTick();
  assert.equal(c.monitor.eventId, DOTA(2).id, 'a fully leased event already has every market: the observer takes another one');
  c.fullEvents.add(DOTA(2).id); const n = sent.length; c.syncLight(DOTA(2).id); assert.equal(sent.length, n, 'no light/monitor subscription next to a full one');
});

test('observer: clean end when the event leaves LIVE; an event without typeId 96 is skipped; waits when none is eligible', () => {
  const { c, tick } = collector([DOTA(1), DOTA(2)]); c.monitorTick();
  tick(config.ggbetPricingMonitorNoDataMs + 1000); c.monitorTick();
  assert.equal(c.monitorEnded.reason, 'no typeId 96 in its stream'); assert.equal(c.monitor.eventId, DOTA(2).id);
  c.events.delete(DOTA(2).id); c.forgetEvent(DOTA(2).id); c.monitorTick();
  assert.equal(c.monitorEnded.reason, 'event left LIVE'); assert.equal(c.monitorStatus().state, 'waiting-for-eligible-event', 'DOTA(1) is skipped for 2 h');
  const { c: e } = collector([CS]); e.monitorTick(); assert.equal(e.monitorStatus().state, 'waiting-for-eligible-event');
});

function supervisorWith(collectorStub) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mon-sup-')); let t = Date.parse('2026-10-03T00:00:00Z');
  const sup = new GgbetSupervisor({ dir, mode: 'direct', now: () => t }).attach(collectorStub);
  const tok = (l) => Buffer.from(JSON.stringify({ alg: 'dir', label: l })).toString('base64url') + '..' + 'q'.repeat(220);
  const feed = (o, e, v) => { const payload = { data: { onUpdateSportEvent: { id: DOTA(1).id, version: v, markets: [odd96('96m1', o, e)] } } }; sup.message(JSON.stringify({ type: 'data', payload }), { type: 'data', payload }); };
  return { dir, sup, tok, feed, tick: (ms) => { t += ms; } };
}

test('operator reset-session: clean session on the SAME egress; healthy fresh samples => SESSION_DEGRADED; nothing switches', () => {
  let resets = 0; const { dir, sup, tok, feed, tick } = supervisorWith({ resetForEgressChange: () => { resets++; } });
  sup.bootstrap({ status: 200, reason: 'ok' }, { token: tok('old') });
  for (let i = 0; i < 6; i++) { tick(30000); feed((2.02 + i / 100).toFixed(2), (1.74 - i / 100).toFixed(2), 'b' + i); }
  assert.equal(sup.guard.state, 'CONFIRMED'); assert.equal(resets, 0, 'a confirmed anomaly alone never resets anything');
  const inc = JSON.parse(fs.readFileSync(path.join(dir, 'incidents', fs.readdirSync(path.join(dir, 'incidents'))[0]), 'utf8')); assert.match(inc.operatorHint, /reset-session/);
  fs.writeFileSync(path.join(dir, 'control', 'reset-session.json'), JSON.stringify({ reason: 'test' })); sup.checkControl();
  assert.equal(resets, 1); assert.equal(sup.sessions[0].endReason, 'operator reset: test'); assert.ok(sup.verification);
  sup.bootstrap({ status: 200, reason: 'ok' }, { token: tok('new') }); assert.equal(sup.session.id, 'S2'); assert.equal(sup.guard.samples, 0, 'fresh samples only');
  for (let i = 0; i < 6; i++) { tick(30000); const p = i % 2 ? '1.86' : '1.87'; feed(p, p, 'g' + i); }
  const v = sup.checkVerification(); assert.equal(v.result, 'SESSION_DEGRADED'); assert.equal(v.oldSessionId, 'S1'); assert.equal(v.newSessionId, 'S2'); assert.equal(v.action, 'none (observe-only; operator decides)');
  assert.equal(sup.egresses.direct.sessionDegradations, 1); assert.equal(resets, 1, 'no further resets');
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'incidents', fs.readdirSync(path.join(dir, 'incidents'))[0]), 'utf8')).verification.result, 'SESSION_DEGRADED');
});

test('operator reset-session: anomaly confirmed again on the fresh session => EGRESS_SUSPECT; too few samples => INCONCLUSIVE', () => {
  const a = supervisorWith({ resetForEgressChange() {} }); a.sup.bootstrap({ status: 200, reason: 'ok' }, { token: a.tok('o') }); a.sup.operatorReset('t');
  a.sup.bootstrap({ status: 200, reason: 'ok' }, { token: a.tok('n') }); for (let i = 0; i < 6; i++) { a.tick(30000); a.feed((3.23 + i / 100).toFixed(2), '1.32', 'x' + i); }
  assert.equal(a.sup.checkVerification().result, 'EGRESS_SUSPECT'); assert.equal(a.sup.egresses.direct.state, 'EGRESS_SUSPECT');
  const b = supervisorWith({ resetForEgressChange() {} }); b.sup.bootstrap({ status: 200, reason: 'ok' }, { token: b.tok('o') }); b.sup.operatorReset('t');
  b.sup.bootstrap({ status: 200, reason: 'ok' }, { token: b.tok('n') }); b.tick(30000); b.feed('1.86', '1.86', 'y');
  assert.equal(b.sup.checkVerification(), null, 'still collecting'); b.tick(16 * 60000);
  assert.equal(b.sup.checkVerification().result, 'INCONCLUSIVE');
});

test('cosmetic: a deactivated egress is no longer shown ACTIVE (and not after a restart either)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mon-cos-')), st = path.join(dir, 'st.json');
  fs.writeFileSync(st, JSON.stringify({ kind: 'proxy-fallback', id: 'proxy:last-resort', activatedAt: '2026-10-03T00:00:00Z' }));
  const sup = new GgbetSupervisor({ dir: path.join(dir, 'f'), mode: 'netns', statusFile: st });
  fs.writeFileSync(st, JSON.stringify({ id: 'mullvad:ggbet-good', activatedAt: '2026-10-03T01:00:00Z' })); sup.checkEgress();
  assert.equal(sup.egresses['proxy:last-resort'].state, 'INACTIVE'); assert.equal(sup.egresses['mullvad:ggbet-good'].state, 'ACTIVE'); sup.persist();
  const again = new GgbetSupervisor({ dir: path.join(dir, 'f'), mode: 'netns', statusFile: st });
  assert.equal(again.egresses['proxy:last-resort'].state, 'INACTIVE'); assert.equal(again.egresses['mullvad:ggbet-good'].state, 'ACTIVE');
});

test('pool: transport qualification never touches the active egress; a failed check keeps a config out of selection', () => {
  let t = Date.parse('2026-10-03T00:00:00Z'); const p = new VpnPool({ now: () => t }); p.discover(['a.conf', 'b.conf', 'ggbet-good.conf']); p.activated('mullvad:ggbet-good', {});
  assert.notEqual(p.nextTransportCheck().id, 'mullvad:ggbet-good');
  p.transportChecked('mullvad:a', { ok: false, error: 'no handshake' }); p.transportChecked('mullvad:b', { ok: true, exitIp: '1.2.3.4', country: 'DE', city: 'Berlin' });
  assert.equal(p.candidate('mullvad:ggbet-good').id, 'mullvad:b'); assert.equal(p.nextTransportCheck(), null);
  t += 7 * 3600000; assert.ok(p.available().some((v) => v.id === 'mullvad:a'), 'eligible again after 6 h');
});

test('end to end: a frame of the monitored stream gives the guard a RAW typeId 96 sample (ids 1/2) and leaves the row alone', async () => {
  const { c, sent } = collector([DOTA(1)]); const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mon-e2e-'));
  const sup = new GgbetSupervisor({ dir, mode: 'direct' }).attach(c); c.observer = sup;
  sup.bootstrap({ status: 200, reason: 'ok' }, { token: Buffer.from('{"alg":"dir"}').toString('base64url') + '..' + 'z'.repeat(220) });
  c.monitorTick(); const subId = starts(sent, DOTA(1).id)[0].id, before = c.events.get(DOTA(1).id).markets;
  // Score 0:0 -> map 1 is being played: 96m1 is in-play (recorded, excluded), 96m2 (next map) is a guard sample.
  await c.onMessage(JSON.stringify({ id: subId, type: 'data', payload: { data: { onUpdateSportEvent: { id: DOTA(1).id, version: 'v9', markets: [odd96('96m1', '3.23', '1.32'), odd96('96m2', '1.86', '1.86')] } } } }));
  assert.equal(sup.guard.inPlaySamples, 1); assert.equal(sup.guard.state, 'HEALTHY', 'in-play asymmetry never moves the guard'); assert.equal(sup.guard.recent.find((o) => o.marketId === '96m1').excluded, 'in-play map');
  sup.guard.recent = sup.guard.recent.filter((o) => o.marketId === '96m2'); assert.equal(sup.guard.samples, 1); assert.equal(sup.guard.recent[0].odd.id, '1'); assert.equal(sup.guard.recent[0].even.price, '1.86'); assert.equal(sup.guard.recent[0].eventId, DOTA(1).id);
  assert.deepEqual(c.events.get(DOTA(1).id).markets, before); assert.equal(c.monitorStatus().samples, 2);
});

test('guard: the map being played never counts (LIVE, mapnr <= current map, or unknown score); identical prices count once per 60 s', async () => {
  const { PricingGuard, guardConfig } = await import('../src/ggbet-pricing-guard.js');
  let t = Date.parse('2026-10-03T00:00:00Z'); const g = new PricingGuard({ config: guardConfig({}), now: () => t });
  for (let i = 0; i < 20; i++) { t += 30000; g.observe(odd96('96m2', (3.23 + i / 100).toFixed(2), '1.32'), { eventId: 'E', eventStatus: 'LIVE', liveMap: 2 }); }
  for (let i = 0; i < 20; i++) { t += 30000; g.observe(odd96('96m3', (2.02 + i / 100).toFixed(2), '1.74'), { eventId: 'E', eventStatus: 'LIVE', liveMap: null }); }
  assert.equal(g.state, 'HEALTHY'); assert.equal(g.samples, 0); assert.equal(g.inPlaySamples, 40);
  for (let i = 0; i < 10; i++) { t += 5000; g.observe(odd96('96m3', '1.86', '1.86'), { eventId: 'E', eventStatus: 'LIVE', liveMap: 2 }); }
  assert.equal(g.samples, 1, '10 pushes with the same prices within 50 s = one sample');
});
