import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import zlib from 'node:zlib';
import { WebSocketServer, WebSocket } from 'ws';
import { config } from '../src/config.js';
import { GgbetLiveCollector } from '../src/ggbet.js';
import { DatabetLiveCollector } from '../src/databet.js';
import { SnapshotState } from '../src/state.js';
import { createApi } from '../src/api.js';
import { stopMatcher } from '../src/matcher-client.js';
import { checkProxyEgress, explicitNetworkMode, proxyAgent, proxyDiagnostics, proxyFetch, redact, resetEgressForTests } from '../src/egress.js';

// Credentials with characters that need URL encoding; they must reach the proxy intact and nowhere else.
const USER = 'cz-user_sid-StickY42abc';
const PASS = 'Pw$ecret:with@chars/Q9';
const BASIC = 'Basic ' + Buffer.from(`${USER}:${PASS}`).toString('base64');
const SECRETS = [USER, PASS, encodeURIComponent(USER), encodeURIComponent(PASS), Buffer.from(`${USER}:${PASS}`).toString('base64')];
const leaks = (text) => SECRETS.filter((secret) => String(text).includes(secret));

// HTTP CONNECT proxy for tests. Records every tunnel request; `tunnel` maps "host:port" to a local port to pipe to,
// anything else is refused (status `refuse`) after being recorded, so nothing leaves the machine.
async function fakeProxy({ tunnel = {}, refuse = 502, requireAuth = true } = {}) {
  const connects = [];
  const server = http.createServer((req, res) => { res.writeHead(400); res.end(); });
  server.on('connect', (req, socket, head) => {
    connects.push({ target: req.url, auth: req.headers['proxy-authorization'] || '' });
    if (requireAuth && req.headers['proxy-authorization'] !== BASIC) { socket.end('HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm="t"\r\nContent-Length: 0\r\n\r\n'); return; }
    const port = tunnel[req.url];
    if (!port) { socket.end(`HTTP/1.1 ${refuse} Refused By Test Proxy\r\nContent-Length: 0\r\n\r\n`); return; }
    const upstream = net.connect(port, '127.0.0.1', () => { socket.write('HTTP/1.1 200 Connection Established\r\n\r\n'); if (head?.length) upstream.write(head); upstream.pipe(socket); socket.pipe(upstream); });
    upstream.on('error', () => socket.destroy()); socket.on('error', () => upstream.destroy());
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { connects, port: server.address().port, close: () => new Promise((resolve) => { server.closeAllConnections?.(); server.close(resolve); }) };
}

function useProxy(port, { enabled = '1' } = {}) {
  const old = Object.fromEntries(['CZECH_PROXY_ENABLED', 'CZECH_PROXY_HOST', 'CZECH_PROXY_PORT', 'CZECH_PROXY_USERNAME', 'CZECH_PROXY_PASSWORD'].map((k) => [k, process.env[k]]));
  Object.assign(process.env, { CZECH_PROXY_ENABLED: enabled, CZECH_PROXY_HOST: '127.0.0.1', CZECH_PROXY_PORT: String(port), CZECH_PROXY_USERNAME: USER, CZECH_PROXY_PASSWORD: PASS });
  resetEgressForTests();
  return () => { for (const [k, v] of Object.entries(old)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } resetEgressForTests(); };
}
function useModes({ ggbet, databet }) {
  const old = { g: config.ggbetNetworkModeSetting, d: config.databetNetworkMode, origins: config.ggbetOrigins, timeoutG: config.ggbetRequestTimeoutMs, timeoutD: config.databetRequestTimeoutMs };
  if (ggbet !== undefined) config.ggbetNetworkModeSetting = ggbet;
  if (databet !== undefined) config.databetNetworkMode = databet;
  config.ggbetOrigins = ['https://gg.bet']; config.ggbetRequestTimeoutMs = 4000; config.databetRequestTimeoutMs = 4000;
  return () => { config.ggbetNetworkModeSetting = old.g; config.databetNetworkMode = old.d; config.ggbetOrigins = old.origins; config.ggbetRequestTimeoutMs = old.timeoutG; config.databetRequestTimeoutMs = old.timeoutD; };
}
const quietState = (name) => { const state = new SnapshotState(name, 60000); state.persist = async () => {}; return state; };
const noDirect = () => { const calls = { n: 0 }; return { calls, fetchImpl: async () => { calls.n++; throw Error('direct fetch must not run in proxy mode'); } }; };
const GGBET_TOKEN = 'g'.repeat(140);
const DATABET_TOKEN = 'd'.repeat(220);

test('network modes: explicit values win, GGBET without a mode keeps relay/direct, DataBet defaults to direct', () => {
  assert.equal(explicitNetworkMode('ggbet', { GGBET_NETWORK_MODE: 'proxy' }), 'proxy');
  assert.equal(explicitNetworkMode('ggbet', { GGBET_NETWORK_MODE: 'Relay' }), 'relay');
  assert.equal(explicitNetworkMode('ggbet', { GGBET_NETWORK_MODE: 'socks' }), '');
  assert.equal(explicitNetworkMode('databet', { DATABET_NETWORK_MODE: 'relay' }), '', 'DataBet has no relay');
  const old = { s: config.ggbetNetworkModeSetting, url: config.ggbetBootstrapRelayUrl };
  try {
    config.ggbetNetworkModeSetting = ''; config.ggbetBootstrapRelayUrl = 'https://relay.invalid/v1/ggbet/bootstrap'; assert.equal(config.ggbetNetworkMode, 'relay');
    config.ggbetBootstrapRelayUrl = ''; assert.equal(config.ggbetNetworkMode, 'direct');
    config.ggbetNetworkModeSetting = 'proxy'; config.ggbetBootstrapRelayUrl = 'https://relay.invalid/v1/ggbet/bootstrap'; assert.equal(config.ggbetNetworkMode, 'proxy', 'proxy overrides a configured relay');
  } finally { config.ggbetNetworkModeSetting = old.s; config.ggbetBootstrapRelayUrl = old.url; }
});

test('A: GGBET proxy mode fetches the bootstrap page through the CONNECT proxy, never direct and never via the relay', async () => {
  const proxy = await fakeProxy(); const restoreEnv = useProxy(proxy.port), restoreModes = useModes({ ggbet: 'proxy' });
  const oldRelay = config.ggbetBootstrapRelayUrl; config.ggbetBootstrapRelayUrl = 'https://relay.invalid/v1/ggbet/bootstrap';
  let relayCalls = 0; const direct = noDirect();
  const collector = new GgbetLiveCollector(quietState('t-proxy-gg-a'), { fetchImpl: direct.fetchImpl, relayRequestImpl: async () => { relayCalls++; throw Error('relay must not run'); } });
  try {
    await assert.rejects(() => collector.fetchBootstrap(true), /502|bootstrap/);
    assert.deepEqual(proxy.connects.map((c) => c.target), ['gg.bet:443']);
    assert.equal(proxy.connects[0].auth, BASIC, 'proxy credentials are sent as given (sticky session username unchanged)');
    assert.equal(direct.calls.n, 0); assert.equal(relayCalls, 0);
    const status = collector.status();
    assert.equal(status.networkMode, 'proxy'); assert.equal(status.relayInUse, false); assert.equal(status.relayFetches, 0);
    assert.equal(status.proxyHost, '127.0.0.1'); assert.equal(status.proxyPort, proxy.port);
  } finally { config.ggbetBootstrapRelayUrl = oldRelay; await collector.stop(); restoreModes(); restoreEnv(); await proxy.close(); }
});

test('B: GGBET WebSocket of the session goes through the same proxy with the same credentials (reconnect too)', async () => {
  const proxy = await fakeProxy(); const restoreEnv = useProxy(proxy.port), restoreModes = useModes({ ggbet: 'proxy' });
  const direct = noDirect(); const collector = new GgbetLiveCollector(quietState('t-proxy-gg-b'), { fetchImpl: direct.fetchImpl });
  try {
    collector.stopped = false;
    collector.bootstrap = { token: GGBET_TOKEN, wsUrl: 'wss://gg-b-gql.gg.bet/graphql', origin: 'https://gg.bet', at: Date.now(), source: 'html' };
    await assert.rejects(() => collector.connect());
    clearTimeout(collector.reconnectTimer); collector.reconnectTimer = null;
    collector.bootstrap = { token: GGBET_TOKEN, wsUrl: 'wss://gg-b-gql.gg.bet/graphql', origin: 'https://gg.bet', at: Date.now(), source: 'html' };
    await assert.rejects(() => collector.connect());
    assert.ok(proxy.connects.length >= 2);
    assert.ok(proxy.connects.every((c) => c.target === 'gg-b-gql.gg.bet:443'), 'only the WebSocket host is tunneled: the cached bootstrap is not refetched');
    assert.ok(proxy.connects.every((c) => c.auth === BASIC), 'every tunnel of the session uses the same proxy session credentials');
    assert.equal(direct.calls.n, 0);
  } finally { await collector.stop(); restoreModes(); restoreEnv(); await proxy.close(); }
});

test('C: DataBet bootstrap page goes through the proxy', async () => {
  const proxy = await fakeProxy(); const restoreEnv = useProxy(proxy.port), restoreModes = useModes({ databet: 'proxy' });
  const direct = noDirect(); const collector = new DatabetLiveCollector(quietState('t-proxy-db-c'), { fetchImpl: direct.fetchImpl });
  try {
    await assert.rejects(() => collector.fetchBootstrap(true));
    assert.deepEqual(proxy.connects.map((c) => c.target), [new URL(config.databetOrigin).hostname + ':443']);
    assert.equal(proxy.connects[0].auth, BASIC); assert.equal(direct.calls.n, 0);
    assert.equal(collector.status().networkMode, 'proxy');
  } finally { await collector.stop(); restoreModes(); restoreEnv(); await proxy.close(); }
});

test('D: DataBet WebSocket goes through the same proxy', async () => {
  const proxy = await fakeProxy(); const restoreEnv = useProxy(proxy.port), restoreModes = useModes({ databet: 'proxy' });
  const direct = noDirect(); const collector = new DatabetLiveCollector(quietState('t-proxy-db-d'), { fetchImpl: direct.fetchImpl });
  try {
    collector.stopped = false;
    collector.bootstrap = { token: DATABET_TOKEN, wsUrl: 'wss://sportsbook-gql.databet.cloud/graphql?label=cdrriyv', origin: config.databetOrigin, at: Date.now(), label: 'cdrriyv' };
    await assert.rejects(() => collector.connect());
    assert.deepEqual(proxy.connects.map((c) => c.target), ['sportsbook-gql.databet.cloud:443']);
    assert.equal(proxy.connects[0].auth, BASIC); assert.equal(direct.calls.n, 0);
  } finally { await collector.stop(); restoreModes(); restoreEnv(); await proxy.close(); }
});

test('proxy mode fails closed: with the proxy disabled nothing is fetched or opened directly', async () => {
  const proxy = await fakeProxy(); const restoreEnv = useProxy(proxy.port, { enabled: '0' }), restoreModes = useModes({ ggbet: 'proxy', databet: 'proxy' });
  const direct = noDirect();
  const gg = new GgbetLiveCollector(quietState('t-proxy-off-g'), { fetchImpl: direct.fetchImpl, WebSocketImpl: class { constructor() { throw Error('no WebSocket may open'); } } });
  const db = new DatabetLiveCollector(quietState('t-proxy-off-d'), { fetchImpl: direct.fetchImpl, WebSocketImpl: class { constructor() { throw Error('no WebSocket may open'); } } });
  try {
    await assert.rejects(() => gg.fetchBootstrap(true), /Czech proxy disabled/);
    await assert.rejects(() => db.fetchBootstrap(true), /Czech proxy disabled/);
    gg.stopped = false; gg.bootstrap = { token: GGBET_TOKEN, wsUrl: 'wss://gg-b-gql.gg.bet/graphql', origin: 'https://gg.bet', at: Date.now() };
    await assert.rejects(() => gg.connect(), /Czech proxy disabled/);
    assert.equal(direct.calls.n, 0); assert.equal(proxy.connects.length, 0);
  } finally { await gg.stop(); await db.stop(); restoreModes(); restoreEnv(); await proxy.close(); }
});

test('the proxy agent carries HTTP (redirects, gzip) and WebSocket traffic end to end through CONNECT tunnels', async () => {
  const target = http.createServer((req, res) => {
    if (req.url === '/start') { res.writeHead(302, { location: '/page' }); res.end(); return; }
    res.writeHead(200, { 'content-type': 'text/html', 'content-encoding': 'gzip' }); res.end(zlib.gzipSync('<html>window.bettingOptions = {"ok":true}</html>'));
  });
  const wss = new WebSocketServer({ server: target }); wss.on('connection', (ws) => ws.on('message', (m) => ws.send('echo:' + m)));
  await new Promise((resolve) => target.listen(0, '127.0.0.1', resolve));
  const hostPort = `127.0.0.1:${target.address().port}`;
  const proxy = await fakeProxy({ tunnel: { [hostPort]: target.address().port } }); const restoreEnv = useProxy(proxy.port);
  try {
    const res = await proxyFetch(`http://${hostPort}/start`, { timeoutMs: 4000 });
    assert.equal(res.status, 200); assert.match(await res.text(), /bettingOptions/);
    const echoed = await new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://${hostPort}/graphql`, 'graphql-ws', { agent: proxyAgent() });
      ws.on('open', () => ws.send('ping')); ws.on('message', (m) => { resolve(String(m)); ws.close(); }); ws.on('error', reject);
    });
    assert.equal(echoed, 'echo:ping');
    assert.deepEqual(proxy.connects.map((c) => c.target), [hostPort, hostPort, hostPort], 'redirect hop and WebSocket each open a tunnel');
    assert.ok(proxy.connects.every((c) => c.auth === BASIC));
  } finally { restoreEnv(); await proxy.close(); wss.close(); await new Promise((resolve) => target.close(resolve)); }
});

test('E: proxy credentials never appear in errors, collector status, /health or logs', async () => {
  const proxy = await fakeProxy({ requireAuth: true }); const restoreEnv = useProxy(proxy.port), restoreModes = useModes({ ggbet: 'proxy', databet: 'proxy' });
  // Make the proxy reject the credentials (407) so every error path runs.
  process.env.CZECH_PROXY_PASSWORD = PASS + 'x'; resetEgressForTests();
  const output = []; const write = { out: process.stdout.write, err: process.stderr.write };
  process.stdout.write = function (chunk, ...rest) { output.push(String(chunk)); return write.out.call(this, chunk, ...rest); };
  process.stderr.write = function (chunk, ...rest) { output.push(String(chunk)); return write.err.call(this, chunk, ...rest); };
  const states = Array.from({ length: 8 }, (_, i) => quietState('t-proxy-e-' + i));
  const gg = new GgbetLiveCollector(states[6], { fetchImpl: noDirect().fetchImpl }), db = new DatabetLiveCollector(states[7], { fetchImpl: noDirect().fetchImpl });
  let server;
  try {
    const errors = [];
    for (const run of [() => gg.fetchBootstrap(true), () => db.fetchBootstrap(true), () => proxyFetch('https://ipinfo.io/json', { timeoutMs: 3000 })]) { try { const res = await run(); errors.push(`status ${res?.status} ${await res?.text?.()}`); } catch (error) { errors.push(String(error?.message) + String(error?.stack)); } }
    gg.stopped = false; gg.bootstrap = { token: GGBET_TOKEN, wsUrl: 'wss://gg-b-gql.gg.bet/graphql', origin: 'https://gg.bet', at: Date.now() };
    db.stopped = false; db.bootstrap = { token: DATABET_TOKEN, wsUrl: 'wss://sportsbook-gql.databet.cloud/graphql?label=cdrriyv', origin: config.databetOrigin, at: Date.now() };
    for (const c of [gg, db]) { try { await c.connect(); } catch (error) { errors.push(String(error?.message) + String(error?.stack)); } clearTimeout(c.reconnectTimer); c.reconnectTimer = null; }
    assert.ok(proxy.connects.length >= 5, 'every path really talked to the proxy');
    assert.ok(errors.length >= 4, 'GGBET/DataBet bootstrap and WebSocket all failed (the proxy fetch itself resolves with the 407)');
    const egress = await checkProxyEgress({ url: 'https://ipinfo.io/json' });
    server = createApi({ liveState: states[0], prematchState: states[1], fonbetLiveState: states[2], fonbetPrematchState: states[3], pinnaclePrematchState: states[4], pinnacleLiveState: states[5], ggbetLiveState: states[6], databetLiveState: states[7], ggbetCollector: gg, databetCollector: db, prematchCollector: { status: () => ({}), catalog: [] }, fonbetCollector: { status: () => ({}) }, pinnacleCollector: { status: () => ({}), catalog: [] }, resultsService: { status: () => ({}), days: new Map() }, startedAt: Date.now() });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const base = 'http://127.0.0.1:' + server.address().port;
    const health = await (await fetch(base + '/health')).text(), status = await (await fetch(base + '/api/status')).text(), providers = await (await fetch(base + '/api/ui/odds-providers')).text();
    const parsed = JSON.parse(health);
    assert.equal(parsed.network.ggbet.networkMode, 'proxy'); assert.equal(parsed.network.databet.networkMode, 'proxy');
    assert.equal(parsed.network.proxy.proxyHost, '127.0.0.1'); assert.equal(parsed.network.proxy.credentials, 'set');
    assert.equal(parsed.oddsProviders.ggbet.networkMode, 'proxy'); assert.equal(parsed.ggbetCollector.relayInUse, false);
    const everything = [errors.join('\n'), JSON.stringify(gg.status()), JSON.stringify(db.status()), states[6].lastError, states[7].lastError, health, status, providers, JSON.stringify(egress), JSON.stringify(proxyDiagnostics()), output.join('')].join('\n');
    assert.deepEqual(leaks(everything), []);
    assert.doesNotMatch(everything, /Proxy-Authorization|Q9x/i);
    assert.equal(everything.includes(Buffer.from(`${USER}:${PASS}x`).toString('base64')), false);
    assert.equal(redact(`http://${encodeURIComponent(USER)}:${encodeURIComponent(PASS + 'x')}@127.0.0.1:1 ${USER} ${PASS}x`).includes(USER), false);
  } finally {
    process.stdout.write = write.out; process.stderr.write = write.err;
    if (server) await new Promise((resolve) => server.close(resolve));
    await gg.stop(); await db.stop(); await stopMatcher(); restoreModes(); restoreEnv(); await proxy.close();
  }
});
