import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { VpnPool, vpnId } from '../src/ggbet-vpn-pool.js';
import { GgbetSupervisor } from '../src/ggbet-supervisor.js';
import { GgbetLiveCollector } from '../src/ggbet.js';

const MIN = 60000, CONFIGS = ['de-ber-wg-102.conf', 'de-dus-wg-103.conf', 'ggbet-good.conf', 'hr-zag-wg-002.conf'];
const OK = { netns: true, wg: true, handshakeAgeS: 30, probeOk: true, serviceHealthy: true, serviceTransportFailures: 0 };
const DOWN = { netns: false, wg: false, handshakeAgeS: null, serviceHealthy: false };
function poolAt(state = {}, options = {}) { let t = Date.parse('2026-10-03T00:00:00Z'); const p = new VpnPool({ state, now: () => t, options }); p.discover(CONFIGS); return { p, tick: (ms) => { t += ms; }, at: () => t }; }
const fail = (p, tick, n = 3, h = DOWN) => { let d; for (let i = 0; i < n; i++) { tick(30000); d = p.tick(h); } return d; };

test('discovery: every *.conf becomes a pool member (UNTESTED); vanished configs are kept but marked missing', () => {
  const { p } = poolAt(); assert.deepEqual(Object.keys(p.vpns).sort(), CONFIGS.map(vpnId).sort()); assert.ok(Object.values(p.vpns).every((v) => v.state === 'UNTESTED'));
  p.discover(CONFIGS.slice(1)); assert.equal(p.vpns[vpnId(CONFIGS[0])].missing, true); assert.equal(p.candidate()?.configFile === CONFIGS[0], false);
  p.discover([...CONFIGS, 'se-sto-wg-001.conf']); assert.ok(p.vpns['mullvad:se-sto-wg-001']);
});

test('selection: preferred config first without history; then last-known-good / longest healthy run beat order or newness', () => {
  const { p, tick } = poolAt(); assert.equal(p.candidate().configFile, 'ggbet-good.conf');
  p.activated('mullvad:hr-zag-wg-002', { exitIp: '1.1.1.1' }); for (let i = 0; i < 20; i++) { tick(30000); p.tick(OK); }
  p.deactivated('mullvad:hr-zag-wg-002', 'test'); assert.equal(p.lastKnownGood(), 'mullvad:hr-zag-wg-002'); assert.equal(p.candidate().id, 'mullvad:hr-zag-wg-002');
});

test('a healthy egress is kept indefinitely (no scheduled rotation) and qualifies after 60 min of healthy runtime', () => {
  const { p, tick } = poolAt(); p.activated('mullvad:ggbet-good', { exitIp: '178.249.209.168', country: 'CZ', city: 'Prague' });
  for (let i = 0; i < 6 * 120; i++) { tick(30000); assert.equal(p.tick(OK).action, 'none'); }
  const v = p.vpns['mullvad:ggbet-good']; assert.equal(p.active, 'mullvad:ggbet-good'); assert.equal(v.state, 'HEALTHY'); assert.ok(v.longestHealthyRunMs >= 6 * 3600000 - 60000); assert.equal(p.switches.length, 0);
});

test('transport failure: retry budget, then ONE re-establish of the same VPN, then cooldown + switch to the next config', () => {
  const { p, tick } = poolAt(); p.activated('mullvad:ggbet-good', {});
  tick(30000); assert.equal(p.tick(DOWN).action, 'none'); tick(30000); assert.equal(p.tick(DOWN).action, 'none');
  tick(30000); assert.deepEqual([p.tick(DOWN).action, p.vpns['mullvad:ggbet-good'].reestablishes], ['reestablish', 1]);
  const d = fail(p, tick); assert.equal(d.action, 'switch'); assert.equal(d.from, 'mullvad:ggbet-good'); assert.notEqual(d.to, 'mullvad:ggbet-good');
  const v = p.vpns['mullvad:ggbet-good']; assert.equal(v.state, 'COOLDOWN'); assert.equal(v.networkFailures, 1); assert.ok(v.cooldownUntil > Date.parse(p.iso()));
  assert.equal(p.candidate(d.to)?.id === 'mullvad:ggbet-good', false, 'a VPN in cooldown is never selected again immediately');
});

test('a single failed check or a probe failure while the service is healthy never acts (no flapping)', () => {
  const { p, tick } = poolAt(); p.activated('mullvad:ggbet-good', {});
  for (let i = 0; i < 50; i++) { tick(30000); assert.equal(p.tick(i % 2 ? DOWN : OK).action, 'none'); }
  for (let i = 0; i < 50; i++) { tick(30000); assert.equal(p.tick({ ...OK, probeOk: false }).action, 'none', 'ipinfo down alone is not a transport failure'); }
  assert.equal(p.switches.length, 0);
});

test('switch budget per hour, then the last-resort proxy; all configs unavailable -> fallback; restore after the minimum time', () => {
  const { p, tick } = poolAt({}, { maxSwitchesPerHour: 2 }); p.activated('mullvad:ggbet-good', {});
  const sw = (from) => { fail(p, tick); const d = fail(p, tick); return d; }; // re-establish, then switch
  let d = sw(); assert.equal(d.action, 'switch'); p.activated(d.to, {});
  d = sw(); assert.equal(d.action, 'switch'); p.activated(d.to, {});
  d = sw(); assert.equal(d.action, 'fallback'); assert.match(d.reason, /switch budget exhausted/); assert.equal(p.mode, 'fallback'); assert.equal(p.active, null);
  tick(10 * MIN); assert.equal(p.tick(OK).action, 'none', 'minimum fallback time');
  tick(25 * MIN); const r = p.tick(OK); assert.equal(r.action, 'restore'); tick(MIN); assert.equal(p.tick(OK).action, 'none', 'one attempt per retry interval');
  const { p: q, tick: t2 } = poolAt(); for (const id of Object.keys(q.vpns)) q.networkFailure(id, 'test'); q.activated('mullvad:ggbet-good', {}); q.vpns['mullvad:ggbet-good'].lastReestablishAt = q.iso();
  const f = fail(q, t2); assert.equal(f.action, 'fallback'); assert.match(f.reason, /no usable Mullvad config/);
});

test('pricing anomalies and HTTP/region answers are NOT transport signals: the pool never sees them', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pool-sup-')); let t = Date.parse('2026-10-03T00:00:00Z');
  const sup = new GgbetSupervisor({ dir, mode: 'netns', statusFile: path.join(dir, 'none.json'), now: () => t });
  sup.bootstrap({ status: 403, reason: 'http-status', bodyKind: 'html' }, null); sup.bootstrap({ status: 200, reason: 'token-extraction' }, null);
  assert.equal(sup.transport.failures.length, 0, 'GGBET answers are not transport failures');
  sup.bootstrap({ status: 0, reason: 'network', detail: 'ECONNRESET' }, null); sup.wsFailed(Error('netns egress unavailable: ECONNREFUSED')); sup.wsFailed(Error('GGBET connection_init rejected: x'));
  assert.deepEqual(sup.transport.failures.map((f) => f.kind), ['bootstrap-network', 'ws-connect']);
});

test('fallback status switches the collector to the proxy agent at runtime; a Mullvad status uses the netns agent', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pool-mode-')), statusFile = path.join(dir, 'status.json');
  fs.writeFileSync(statusFile, JSON.stringify({ id: 'mullvad:ggbet-good', configFile: 'ggbet-good.conf', activatedAt: '2026-10-03T00:00:00Z' }));
  const sup = new GgbetSupervisor({ dir: path.join(dir, 'f'), mode: 'netns', statusFile }), c = new GgbetLiveCollector({ success() {}, failure() {} }, { observer: sup }); sup.attach(c);
  assert.equal(c.networkMode(), 'netns');
  fs.writeFileSync(statusFile, JSON.stringify({ kind: 'proxy-fallback', id: 'proxy:last-resort', fallbackReason: 'no usable Mullvad config', fallbackStartedAt: '2026-10-03T01:00:00Z', activatedAt: '2026-10-03T01:00:00Z' }));
  let resets = 0; c.resetForEgressChange = () => { resets++; }; sup.checkEgress();
  assert.equal(c.networkMode(), 'proxy'); assert.equal(resets, 1, 'clean session on the switch to the fallback');
  assert.equal(sup.stateSnapshot().egress.kind, 'proxy-fallback');
});

test('no session state crosses an egress change: token/agent dropped, new bootstrap = new session id', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pool-sess-')), statusFile = path.join(dir, 'status.json'); let t = Date.parse('2026-10-03T00:00:00Z');
  fs.writeFileSync(statusFile, JSON.stringify({ id: 'mullvad:ggbet-good', activatedAt: '2026-10-03T00:00:00Z' }));
  const sup = new GgbetSupervisor({ dir: path.join(dir, 'f'), mode: 'netns', statusFile, now: () => t }), c = new GgbetLiveCollector({ success() {}, failure() {} }, { observer: sup }); sup.attach(c);
  const tok = (l) => Buffer.from(JSON.stringify({ alg: 'dir', label: l })).toString('base64url') + '..' + 'x'.repeat(200);
  c.bootstrap = { token: tok('a') }; c.bootstrapAgent = {}; sup.bootstrap({ status: 200, reason: 'ok' }, c.bootstrap); assert.equal(sup.session.id, 'S1');
  fs.writeFileSync(statusFile, JSON.stringify({ id: 'mullvad:de-ber-wg-102', activatedAt: '2026-10-03T01:00:00Z' })); t += 3600000; sup.checkEgress();
  assert.equal(c.bootstrap, null); assert.equal(c.bootstrapAgent, null); assert.equal(sup.sessions[0].endReason, 'egress changed by operator');
  sup.bootstrap({ status: 200, reason: 'ok' }, { token: tok('b') }); assert.equal(sup.session.id, 'S2'); assert.equal(sup.session.egressId, 'mullvad:de-ber-wg-102');
});

test('incident keeps 10 min of context before and appends the 5 min after; one unusual sample creates nothing', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pool-inc-')); let t = Date.parse('2026-10-03T00:00:00Z');
  const sup = new GgbetSupervisor({ dir, mode: 'direct', now: () => t }); sup.bootstrap({ status: 200, reason: 'ok' }, { token: 'eyJhbGciOiJkaXIifQ..' + 'x'.repeat(200) });
  const send = (o, e, v) => { const payload = { data: { x: { id: '5:efd696a5-9eae-4059-9e67-bbef3c0868bd', version: v, markets: [{ id: '96m1', typeId: 96, status: 'ACTIVE', odds: [{ id: '1', value: o }, { id: '2', value: e }] }] } } }; sup.message(JSON.stringify({ type: 'data', payload }), { type: 'data', payload }); };
  for (let i = 0; i < 30; i++) { t += 30000; const p = i % 2 ? '1.86' : '1.87'; send(p, p, 'h' + i); } // a moving, healthy market
  t += 30000; send('1.91', '1.83', 'x'); t += 30000; send('1.86', '1.86', 'y');
  assert.equal(fs.readdirSync(path.join(dir, 'incidents')).length, 0, 'a single unusual sample: no incident');
  for (let i = 0; i < 5; i++) { t += 30000; send((2.02 + i / 100).toFixed(2), (1.74 - i / 100).toFixed(2), 'b' + i); }
  const files = fs.readdirSync(path.join(dir, 'incidents')); assert.equal(files.length, 1);
  const before = JSON.parse(fs.readFileSync(path.join(dir, 'incidents', files[0]), 'utf8'));
  assert.ok(before.timelineBefore.length >= 15 && before.timelineBefore.length <= 25, 'about 10 minutes of pricing context');
  for (let i = 0; i < 12; i++) { t += 30000; const p = i % 2 ? '1.86' : '1.87'; send(p, p, 'a' + i); } sup.completeIncidents();
  const after = JSON.parse(fs.readFileSync(path.join(dir, 'incidents', files[0]), 'utf8'));
  assert.ok(after.timelineAfter.length >= 10); assert.ok(after.afterCompletedAt); assert.ok(!JSON.stringify(after).includes('x'.repeat(50)), 'no token');
});

test('CLI: vpns/switches/qualification/status read the controller pool (no secrets, --json)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pool-cli-')), conf = path.join(dir, 'conf'); fs.mkdirSync(conf);
  for (const f of CONFIGS) fs.writeFileSync(path.join(conf, f), 'PrivateKey = oA9vKq3cT0dZJ2mN8pR5sU7wX1yB4eG6hL0iK2jM3nQ=\n', { mode: 0o600 });
  const { p, tick } = poolAt(); p.activated('mullvad:ggbet-good', { exitIp: '178.249.209.168', country: 'CZ', city: 'Prague' }); for (let i = 0; i < 10; i++) { tick(30000); p.tick(OK); }
  fs.writeFileSync(path.join(dir, 'pool.json'), JSON.stringify(p.snapshot()));
  const sup = new GgbetSupervisor({ dir: path.join(dir, 'f'), mode: 'netns', statusFile: path.join(dir, 'st.json') }); sup.persist();
  const cli = (...a) => execFileSync(process.execPath, [new URL('../../tools/ggbet-cli.mjs', import.meta.url).pathname, ...a, '--dir', path.join(dir, 'f'), '--configs', conf, '--pool', path.join(dir, 'pool.json')], { encoding: 'utf8' });
  for (const c of ['status', 'vpns', 'switches', 'qualification']) { const out = cli(c) + cli(c, '--json'); assert.ok(!out.includes('oA9vKq3c'), c); }
  const v = JSON.parse(cli('vpns', '--json')).find((r) => r.id === 'mullvad:ggbet-good'); assert.equal(v.current, true); assert.equal(v.exitIp, '178.249.209.168'); assert.ok(v.currentHealthyRunMs > 0);
  assert.match(cli('status'), /Egress type: .*controller: mullvad/);
});
