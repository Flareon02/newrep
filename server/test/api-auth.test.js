import test from 'node:test';
import assert from 'node:assert/strict';
import { startApi, postJson } from './helpers/api-harness.js';
import { createAuthorizer, isLoopback, requiresToken, extractToken } from '../src/auth.js';
import { setLogSink } from '../src/logger.js';

setLogSink(() => {});

test('with API_TOKEN set, write/compute endpoints need the token; reads and health stay open', async () => {
  const token = 'unit-test-token-0123456789';
  const api = await startApi({ api: { authToken: token, authTrustLoopback: false } });
  try {
    const manual = { names: ['A', 'B'] };
    let res = await postJson(api.base, '/api/odds/manual', manual);
    assert.equal(res.status, 401);
    assert.match(res.headers.get('www-authenticate') || '', /Bearer/);
    assert.equal((await res.json()).code, 'unauthorized');

    res = await postJson(api.base, '/api/odds/manual', manual, { Authorization: 'Bearer wrong-token-000000000000' });
    assert.equal(res.status, 401);

    res = await postJson(api.base, '/api/odds/manual', manual, { Authorization: 'Bearer ' + token });
    assert.notEqual(res.status, 401);
    res = await postJson(api.base, '/api/ui/odds-watch', { ids: [] }, { 'X-API-Token': token });
    assert.equal(res.status, 200);

    assert.equal((await fetch(api.base + '/api/league-links/challenge')).status, 401);
    assert.equal((await fetch(api.base + '/api/league-links/challenge', { headers: { Authorization: 'Bearer ' + token } })).status, 200);
    assert.equal((await fetch(api.base + '/api/hltv/search?q=navi')).status, 401);
    assert.equal((await postJson(api.base, '/api/league-links/publish', { nonce: 'x' })).status, 401);

    assert.equal((await fetch(api.base + '/health')).status, 200);
    assert.equal((await fetch(api.base + '/api/hltv/data')).status, 200);
    assert.equal((await fetch(api.base + '/api/status')).status, 200);
    const health = await (await fetch(api.base + '/health')).json();
    assert.equal(health.security.writeAuth, 'token');
    assert.ok(!JSON.stringify(health).includes(token));

    const preflight = await fetch(api.base + '/api/odds/manual', { method: 'OPTIONS', headers: { Origin: 'chrome-extension://' + 'a'.repeat(32) } });
    assert.equal(preflight.status, 204);
    assert.match(preflight.headers.get('access-control-allow-headers'), /Authorization/);
  } finally { await api.close(); }
});

test('without API_TOKEN behaviour is unchanged (open)', async () => {
  const api = await startApi({ api: { authToken: '' } });
  try {
    assert.equal((await postJson(api.base, '/api/ui/odds-watch', { ids: [] })).status, 200);
    assert.equal((await fetch(api.base + '/api/league-links/challenge')).status, 200);
    const health = await (await fetch(api.base + '/health')).json();
    assert.equal(health.security.writeAuth, 'open');
  } finally { await api.close(); }
});

test('authorizer unit rules: short tokens refused, loopback trusted, header forms', () => {
  assert.throws(() => createAuthorizer('short'), /at least/);
  assert.equal(createAuthorizer('').enabled, false);
  const auth = createAuthorizer('unit-test-token-0123456789');
  const req = (method, address, headers = {}) => ({ method, headers, socket: { remoteAddress: address } });
  assert.equal(auth.allows(req('POST', '172.17.0.1'), '/api/odds/manual'), false);
  assert.equal(auth.allows(req('POST', '127.0.0.1'), '/api/odds/manual'), true);
  assert.equal(auth.allows(req('POST', '::ffff:127.0.0.1'), '/api/odds/manual'), true);
  assert.equal(auth.allows(req('GET', '172.17.0.1'), '/api/live'), true);
  assert.equal(auth.allows(req('OPTIONS', '172.17.0.1'), '/api/odds/manual'), true);
  assert.equal(auth.allows(req('POST', '172.17.0.1', { authorization: 'bearer unit-test-token-0123456789' }), '/x'), true);
  assert.equal(extractToken({ 'x-api-token': ' abc ' }), 'abc');
  assert.equal(isLoopback('10.0.0.5'), false);
  assert.equal(requiresToken('GET', '/api/hltv/team'), true);
  assert.equal(requiresToken('GET', '/api/hltv/data'), false);
});
