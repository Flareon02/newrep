import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import zlib from 'node:zlib';
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { sanitize, registerSecret, clearRegisteredSecretsForTests, ForensicLog } from '../src/ggbet-forensics.js';
import { PricingGuard, guardConfig } from '../src/ggbet-pricing-guard.js';
import { GgbetSupervisor, jweMeta } from '../src/ggbet-supervisor.js';
import { NetnsConnectAgent } from '../src/egress.js';
import { createProxy, allowedTarget } from '../../tools/ggbet-egress-proxy.mjs';

const HOUR = 3600000, tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const TOKEN = `${b64({ alg: 'dir', enc: 'A256GCM', currency: 'EUR', locale: 'ru', isAuthorized: false, label: 'mo5n747' })}..${'x'.repeat(16)}.${'y'.repeat(200)}.${'z'.repeat(22)}`;
const WG_PRIVATE = 'oA9vKq3cT0dZJ2mN8pR5sU7wX1yB4eG6hL0iK2jM3nQ='; // shape of a WireGuard key (fake)
const API = 'api-token-0123456789abcdef0123456789abcdef';
const COOKIE = '__cf_bm=SECRETCOOKIEVALUE123456; uuid=abcdef-uuid-value';
const SECRETS = [TOKEN, TOKEN.slice(0, 40), WG_PRIVATE, API, 'SECRETCOOKIEVALUE123456', 'abcdef-uuid-value'];
const noSecrets = (text, what) => { for (const s of SECRETS) assert.ok(!String(text).includes(s), `${what} must not contain ${s.slice(0, 12)}…`); };

test('sanitize removes token/JWE, cookie values, Authorization, private keys and registered secrets before persistence', () => {
  clearRegisteredSecretsForTests(); registerSecret(API);
  const out = sanitize({ payload: { headers: { 'X-Auth-Token': TOKEN } }, cookie: COOKIE, setCookies: [COOKIE], Authorization: `Bearer ${API}`, note: `api ${API} jwe ${TOKEN} key ${WG_PRIVATE}`, PrivateKey: WG_PRIVATE,
    cookieNames: ['__cf_bm', 'uuid'], tokenExtraction: 'ok', nested: [{ widgetToken: TOKEN }] });
  noSecrets(JSON.stringify(out), 'sanitized record');
  assert.deepEqual(out.cookieNames, ['__cf_bm', 'uuid'], 'cookie NAMES are kept'); assert.equal(out.tokenExtraction, 'ok');
  assert.equal(out.payload.headers['X-Auth-Token'], '<redacted>'); assert.match(out.note, /<redacted>.*<redacted:jwt>.*<redacted:key>/);
  assert.deepEqual(jweMeta(TOKEN), { alg: 'dir', enc: 'A256GCM', currency: 'EUR', locale: 'ru', isAuthorized: false, label: 'mo5n747' }, 'only allow-listed header fields');
});

test('forensic log: hourly NDJSON 0600 in 0700 dirs, previous hour gzipped, 24 h retention, size cap, incidents sanitized', () => {
  const dir = tmp('ggbet-log-'); let t = Date.parse('2026-10-03T10:15:00Z');
  const log = new ForensicLog({ dir, now: () => t, maxBytes: 10 * 1024 ** 2, statfs: () => ({ bavail: 1e7, bsize: 4096 }) });
  log.write('session', { event: 'started', jwe: { label: 'x' }, cookie: COOKIE });
  const first = path.join(dir, 'events', '20261003T10.ndjson');
  assert.equal(fs.statSync(first).mode & 0o777, 0o600); assert.equal(fs.statSync(path.join(dir, 'events')).mode & 0o777, 0o700);
  noSecrets(fs.readFileSync(first, 'utf8'), 'event file');
  t += HOUR; log.write('ws', { event: 'connected' });
  assert.ok(fs.existsSync(first + '.gz') && !fs.existsSync(first), 'completed hour compressed');
  assert.match(zlib.gunzipSync(fs.readFileSync(first + '.gz')).toString(), /"kind":"session"/);
  const id = log.incident({ classification: 'PRICING_CONFIRMED', session: { token: TOKEN, cookies: COOKIE }, note: TOKEN });
  const inc = fs.readdirSync(path.join(dir, 'incidents')).find((n) => n.includes(id));
  assert.equal(fs.statSync(path.join(dir, 'incidents', inc)).mode & 0o777, 0o600); noSecrets(fs.readFileSync(path.join(dir, 'incidents', inc), 'utf8'), 'incident');
  t += 25 * HOUR; log.write('ws', { event: 'later' });
  assert.ok(!fs.existsSync(first + '.gz'), 'hours older than 24 h are deleted');
  assert.ok(fs.readdirSync(path.join(dir, 'incidents')).length >= 1, 'incidents outlive the 24 h event window');
});

test('forensic log: size cap deletes the oldest hours first; low disk turns raw logging off before anything else', () => {
  const dir = tmp('ggbet-cap-'); let t = Date.parse('2026-10-03T00:00:00Z'), free = 1e7;
  const log = new ForensicLog({ dir, now: () => t, maxBytes: 3000, raw: true, minFreeMiB: 4096, statfs: () => ({ bavail: free, bsize: 4096 }) });
  for (let h = 0; h < 6; h++) { for (let i = 0; i < 20; i++) log.write('pricing', { i, pad: randomBytes(60).toString('hex') }); t += HOUR; } // incompressible: gzip keeps the size
  log.write('ws', { event: 'x' });
  const st = log.maintain(true); assert.ok(st.bytes <= 3000 + 5000, 'cap enforced (current hour kept)');
  assert.ok(!fs.readdirSync(path.join(dir, 'events')).some((n) => n.startsWith('20261003T00')), 'oldest hour removed first');
  assert.equal(log.raw, true); assert.equal(log.write('raw', { a: 1 }), true);
  free = 100; log.maintain(true); assert.equal(log.raw, false); assert.equal(log.write('raw', { a: 1 }), false, 'raw off on low disk');
  assert.equal(log.write('transition', { a: 1 }), true, 'transitions are still written');
});

const mk = (odd, even, extra = {}) => ({ id: '96m1', typeId: 96, status: 'ACTIVE', specifiers: [{ name: 'mapnr', value: '1' }], odds: [{ id: '1', name: 'Нечет', value: String(odd), isActive: true }, { id: '2', name: 'Чёт', value: String(even), isActive: true }], ...extra });
function guardAt(env = {}) { let t = Date.parse('2026-10-03T12:00:00Z'); const events = [], incidents = []; const g = new PricingGuard({ config: guardConfig({ GGBET_PRICING_GUARD_MIN_SAMPLES: '3', GGBET_PRICING_GUARD_WINDOW_MS: '60000', ...env }), now: () => t, onTransition: (e) => events.push(e), onIncident: (i) => incidents.push(i) }); return { g, events, incidents, tick: (ms) => { t += ms; } }; }

test('pricing guard: odd != even once is only SUSPECT, never confirmed; a normal sample clears it', () => {
  const { g, events, incidents, tick } = guardAt();
  assert.equal(g.observe(mk(1.86, 1.86), { eventId: 'E1', eventVersion: 'v1' }).guardState, 'HEALTHY');
  tick(5000); const o = g.observe(mk(1.91, 1.83), { eventId: 'E1', eventVersion: 'v2' });
  assert.equal(o.unusual, true); assert.equal(g.state, 'SUSPECT'); assert.equal(incidents.length, 0);
  tick(5000); g.observe(mk(1.85, 1.85), { eventId: 'E1', eventVersion: 'v3' });
  assert.equal(g.state, 'HEALTHY'); assert.deepEqual(events.map((e) => e.to), ['SUSPECT', 'HEALTHY']);
});

test('pricing guard: persistent asymmetry over the window -> CONFIRMED incident (observe-only), then recovery', () => {
  const { g, incidents, tick } = guardAt();
  g.observe(mk(1.86, 1.86), { eventId: 'E1', eventVersion: 'v1' });
  for (let i = 0; i < 3; i++) { tick(20000); g.observe(mk((2.02 + i / 100).toFixed(2), (1.74 - i / 100).toFixed(2)), { eventId: 'E1', eventVersion: `b${i}` }); } // prices move: 3 samples
  assert.equal(g.state, 'SUSPECT', '3 samples within 40 s do not satisfy the 60 s window');
  tick(30000); g.observe(mk(2.03, 1.73), { eventId: 'E1', eventVersion: 'b9' });
  assert.equal(g.state, 'CONFIRMED'); assert.equal(incidents.length, 1);
  assert.equal(incidents[0].decision, 'observe-only: no egress or session change'); assert.equal(incidents[0].lastGood.odd.price, '1.86');
  tick(5000); g.observe(mk(1.86, 1.86), { eventId: 'E1', eventVersion: 'g1' }); assert.equal(g.state, 'CONFIRMED');
  tick(5000); g.observe(mk(1.87, 1.87), { eventId: 'E1', eventVersion: 'g2' }); assert.equal(g.state, 'HEALTHY');
});

test('pricing guard: duplicates are counted once; inactive/other markets ignored; enforce is ignored (observe only)', () => {
  const { g, tick } = guardAt({ GGBET_PRICING_GUARD_MODE: 'enforce' });
  assert.equal(g.config.mode, 'observe'); assert.equal(g.config.enforceIgnored, true);
  g.observe(mk(1.91, 1.83), { eventId: 'E', eventVersion: 'v' }); tick(100); assert.equal(g.observe(mk(1.91, 1.83), { eventId: 'E', eventVersion: 'v' }), null);
  assert.equal(g.observe({ ...mk(3.23, 1.32), typeId: 1 }, { eventId: 'E' }), null); assert.equal(g.observe(mk(3.23, 1.32, { status: 'SUSPENDED' }), { eventId: 'E' }), null);
  assert.equal(g.samples, 1);
});

function supervisorFixture() {
  const dir = tmp('ggbet-sup-'), run = tmp('ggbet-run-'), statusFile = path.join(run, 'status.json'); let t = Date.parse('2026-10-03T12:00:00Z');
  fs.writeFileSync(statusFile, JSON.stringify({ id: 'mullvad:ggbet-good', configFile: 'ggbet-good.conf', exitIp: '178.249.209.168', country: 'CZ', city: 'Prague', activatedAt: '2026-10-03T11:59:00.000Z' }));
  const resets = [], collector = { resetForEgressChange: (r) => resets.push(r), fullMarketStatus: () => ({ ggbetLightSubscriptions: 12, ggbetActiveFullMarketSubscriptions: 1, ggbetActiveFullMarketLeases: 1 }), lastAckAt: 1, ws: {}, lastMessageAt: t, reconnects: 0, failures: 0 };
  const sup = new GgbetSupervisor({ dir, mode: 'netns', statusFile, version: '4.10.0', now: () => t }).attach(collector);
  return { dir, statusFile, sup, resets, tick: (ms) => { t += ms; } };
}

test('supervisor: one bootstrap = one session (JWE header only), WS reconnects counted, RAW typeId 96 logged with ages', () => {
  const { dir, sup, tick } = supervisorFixture();
  sup.bootstrap({ via: 'netns', status: 200, reason: 'ok', finalHost: 'gg.bet', redirects: 0, setCookie: true, tokenExtraction: 'ok' }, { token: TOKEN });
  sup.wsConnected(); tick(60000); sup.wsClosed(1006, ''); sup.wsConnected();
  const payload = { data: { onUpdateSportEvent: { id: '5:efd696a5-9eae-4059-9e67-bbef3c0868bd', version: 'b57765a0', fixture: { status: 'NOT_STARTED', startTime: '2026-10-03T13:00:00+00:00' }, markets: [mk(1.86, 1.86)] } } };
  sup.message(JSON.stringify({ type: 'data', id: '7', payload }), { type: 'data', id: '7', payload });
  const s = sup.stateSnapshot().session;
  assert.equal(s.id, 'S1'); assert.equal(s.wsConnects, 2); assert.equal(s.reconnects, 1); assert.equal(s.jwe.label, 'mo5n747'); assert.ok(s.firstGoodAt);
  const obs = sup.guard.recent[0]; assert.equal(obs.eventId, '5:efd696a5-9eae-4059-9e67-bbef3c0868bd'); assert.equal(obs.eventVersion, 'b57765a0'); assert.equal(obs.sessionId, 'S1'); assert.equal(obs.egressId, 'mullvad:ggbet-good'); assert.ok(obs.sessionAgeMs >= 60000); assert.ok(obs.egressAgeMs >= 60000);
  sup.persist(); const files = [path.join(dir, 'state.json'), ...fs.readdirSync(path.join(dir, 'events')).map((n) => path.join(dir, 'events', n))];
  for (const f of files) noSecrets(fs.readFileSync(f, 'utf8'), path.basename(f));
});

test('supervisor: only an operator egress change resets the session (clean bootstrap); pricing never does', () => {
  const { statusFile, sup, resets, tick } = supervisorFixture();
  sup.bootstrap({ status: 200, reason: 'ok' }, { token: TOKEN });
  for (let i = 0; i < 6; i++) { tick(30000); const payload = { data: { x: { id: '5:efd696a5-9eae-4059-9e67-bbef3c0868bd', version: `v${i}`, markets: [mk(3.23, 1.32)] } } }; sup.message(JSON.stringify({ type: 'data', payload }), { type: 'data', payload }); }
  assert.equal(sup.guard.state, 'CONFIRMED'); assert.equal(resets.length, 0, 'a confirmed pricing anomaly never resets anything');
  assert.equal(fs.readdirSync(path.join(sup.dir, 'incidents')).length, 1);
  assert.equal(sup.checkEgress(), false, 'unchanged status: nothing happens');
  fs.writeFileSync(statusFile, JSON.stringify({ id: 'mullvad:de-ber-wg-102', configFile: 'de-ber-wg-102.conf', exitIp: '1.2.3.4', country: 'DE', city: 'Berlin', activatedAt: '2026-10-03T12:10:00.000Z' }));
  assert.equal(sup.checkEgress(), true); assert.equal(resets.length, 1);
  const st = sup.stateSnapshot(); assert.equal(st.egress.id, 'mullvad:de-ber-wg-102'); assert.equal(st.sessions[0].endReason, 'egress changed by operator');
  assert.equal(st.history.at(-1).from, 'mullvad:ggbet-good'); assert.equal(st.history.at(-1).reason, 'operator selected another egress');
  assert.equal(st.egresses['mullvad:ggbet-good'].pricingConfirmed, 1);
});

test('egress proxy: CONNECT only to the allow-list on 443; agent fails cleanly on a refused CONNECT', async () => {
  assert.ok(allowedTarget('gg-b-gql.gg.bet:443')); assert.ok(allowedTarget('gg.bet:443')); assert.ok(allowedTarget('score-board.databet.cloud:443'));
  assert.equal(allowedTarget('gg.bet:80'), null); assert.equal(allowedTarget('evil.example:443'), null); assert.equal(allowedTarget('gg.bet.evil.example:443'), null);
  const dir = tmp('ggbet-px-'), sock = path.join(dir, 'c.sock');
  const echo = net.createServer((s) => s.pipe(s)); await new Promise((r) => echo.listen(0, '127.0.0.1', r));
  const proxy = createProxy({ connect: () => net.connect({ host: '127.0.0.1', port: echo.address().port }) }); await new Promise((r) => proxy.listen(sock, r));
  const talk = (line) => new Promise((resolve) => { const c = net.connect({ path: sock }); let buf = ''; c.on('data', (d) => { buf += d; if (buf.includes('\r\n\r\n')) { if (buf.startsWith('HTTP/1.1 200')) { c.write('ping'); if (buf.endsWith('ping')) { c.end(); resolve(buf); } } else { c.end(); resolve(buf); } } }); c.on('close', () => resolve(buf)); c.write(line); });
  assert.match(await talk('CONNECT evil.example:443 HTTP/1.1\r\nHost: x\r\n\r\n'), /^HTTP\/1.1 403/);
  assert.match(await talk('CONNECT gg.bet:443 HTTP/1.1\r\nHost: gg.bet:443\r\n\r\n'), /^HTTP\/1.1 200[\s\S]*ping$/);
  const agent = new NetnsConnectAgent(sock); const err = await new Promise((resolve) => agent.createConnection({ host: 'evil.example', port: 443 }, (e) => resolve(e)));
  assert.match(String(err?.message), /refused \(403\)/);
  const missing = await new Promise((resolve) => new NetnsConnectAgent(path.join(dir, 'none.sock')).createConnection({ host: 'gg.bet', port: 443 }, (e) => resolve(e)));
  assert.match(String(missing?.message), /netns egress unavailable/);
  proxy.close(); echo.close();
});

test('CLI: status/vpns/sessions/history/incidents (+ --json) from the state; configs listed by name only', () => {
  const { dir, sup, tick } = supervisorFixture(); sup.bootstrap({ status: 200, reason: 'ok' }, { token: TOKEN }); sup.wsConnected(); tick(1000);
  sup.incident({ classification: 'PRICING_CONFIRMED', decision: 'observe-only: no egress or session change', note: TOKEN }); sup.persist();
  const conf = tmp('ggbet-conf-'); fs.writeFileSync(path.join(conf, 'ggbet-good.conf'), `[Interface]\nPrivateKey = ${WG_PRIVATE}\n`, { mode: 0o600 }); fs.writeFileSync(path.join(conf, 'hr-zag-wg-002.conf'), `PrivateKey = ${WG_PRIVATE}\n`, { mode: 0o600 });
  const cli = (...a) => execFileSync(process.execPath, [new URL('../../tools/ggbet-cli.mjs', import.meta.url).pathname, ...a, '--dir', dir, '--configs', conf, '--pool', path.join(dir, 'no-pool.json')], { encoding: 'utf8' });
  for (const c of ['status', 'vpns', 'sessions', 'history', 'incidents', 'tail']) { const text = cli(c), js = cli(c, '--json'); noSecrets(text + js, `cli ${c}`); JSON.parse(js); }
  assert.match(cli('status'), /Current egress: mullvad:ggbet-good[\s\S]*Exit: 178\.249\.209\.168 CZ Prague[\s\S]*Session: S1/);
  const vpns = JSON.parse(cli('vpns', '--json')); assert.deepEqual(vpns.map((v) => [v.configFile, v.state]), [['ggbet-good.conf', 'ACTIVE'], ['hr-zag-wg-002.conf', 'UNTESTED']]);
  assert.equal(JSON.parse(cli('incidents', '--json'))[0].classification, 'PRICING_CONFIRMED');
});

test('admin API: /api/admin/ggbet-forensics is admin-only and carries no secret; anonymous /health stays bare', async () => {
  const { startApi } = await import('./helpers/api-harness.js');
  const { sup } = supervisorFixture(); sup.bootstrap({ status: 200, reason: 'ok' }, { token: TOKEN }); sup.wsConnected();
  const admin = 'admin-token-0123456789abcdef', api = await startApi({ api: { authToken: admin, ggbetSupervisor: sup } });
  try {
    assert.equal((await fetch(api.base + '/api/admin/ggbet-forensics')).status, 401);
    const res = await fetch(api.base + '/api/admin/ggbet-forensics', { headers: { authorization: 'Bearer ' + admin } }); assert.equal(res.status, 200);
    const text = await res.text(), body = JSON.parse(text); noSecrets(text, 'admin endpoint');
    assert.equal(body.egress.id, 'mullvad:ggbet-good'); assert.equal(body.session.id, 'S1'); assert.equal(body.guard.mode, 'observe');
    assert.deepEqual(Object.keys(await (await fetch(api.base + '/health')).json()).sort(), ['ok', 'service', 'version']);
  } finally { await api.close(); }
});

test('collector hooks: observer errors never reach the collector; operator egress change drops token + WebSocket', async () => {
  const { GgbetLiveCollector } = await import('../src/ggbet.js');
  const calls = [], c = new GgbetLiveCollector({ success() {}, failure() {} }, { observer: { message: () => { throw Error('observer bug'); }, wsClosed: (...a) => calls.push(['wsClosed', ...a]) } });
  await c.onMessage(JSON.stringify({ type: 'ka' }));
  let closed = null; c.bootstrap = { token: TOKEN }; c.bootstrapAgent = {}; c.ws = { close: (code, reason) => { closed = [code, reason]; } };
  c.resetForEgressChange('egress A -> B');
  assert.equal(c.bootstrap, null); assert.equal(c.bootstrapAgent, null); assert.deepEqual(closed, [4000, 'egress A -> B']);
  c.stopped = true; c.handleClose({ code: 4000, reason: 'egress A -> B', target: c.ws }); assert.deepEqual(calls[0], ['wsClosed', 4000, 'egress A -> B']);
});

test('egress proxy starts as a program when launched through a symlinked release path (current -> releases/x)', async () => {
  const dir = tmp('ggbet-px-link-'), rel = path.join(dir, 'releases', 'x', 'tools'), sock = path.join(dir, 'p.sock');
  fs.mkdirSync(rel, { recursive: true }); fs.copyFileSync(new URL('../../tools/ggbet-egress-proxy.mjs', import.meta.url), path.join(rel, 'ggbet-egress-proxy.mjs'));
  fs.symlinkSync(path.join(dir, 'releases', 'x'), path.join(dir, 'current'));
  const { spawn } = await import('node:child_process'); const child = spawn(process.execPath, [path.join(dir, 'current', 'tools', 'ggbet-egress-proxy.mjs'), '--socket', sock], { stdio: 'ignore' });
  try { for (let i = 0; i < 50 && !fs.existsSync(sock); i++) await new Promise((r) => setTimeout(r, 100)); assert.ok(fs.existsSync(sock), 'listening on the socket'); assert.equal(fs.statSync(sock).mode & 0o777, 0o600); }
  finally { child.kill(); }
});
