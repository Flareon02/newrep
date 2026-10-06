// Auth + permissions + per-user settings: two users with different keys, rights and settings; key rotation; a
// permission change while a stream is open; settings across a server restart; the league catalog for non-admins.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createApi } from '../src/api.js';
import { SnapshotState } from '../src/state.js';
import { stopMatcher } from '../src/matcher-client.js';
import { UserStore } from '../src/entitlements.js';
import { UserSettingsStore } from '../src/user-settings.js';
import { setLogSink } from '../src/logger.js';
import { leagueStore } from '../src/league-store.js';

setLogSink(() => {});
const MASTER = 'master-token-0123456789abcdef';
const fixture = (source, id) => ({ id, source, sourceEventId: id, provider: source, category: 'Counter Strike 2', league: 'League ' + source, team1: 'Alpha Team', team2: 'Beta Team', startAt: Date.parse('2026-10-02T12:00:00Z'), marketKind: 'main', scoreText: '0:0', seriesScore: [0, 0], bestOf: 3 });

async function start({ settings = new UserSettingsStore({}) } = {}) {
  const states = Array.from({ length: 7 }, (_, i) => new SnapshotState('acc-' + i, 60000)); for (const s of states) s.persist = async () => {};
  await states[0].success([fixture('astek', 'a1')]);
  await states[5].success([fixture('pinnacle', 'p1')]);
  const users = new UserStore({ read: async () => ({ users: [] }), write: async () => {} });
  const server = createApi({ authToken: MASTER, userStore: users, settingsStore: settings, accessMode: 'auto', liveState: states[0], prematchState: states[1], fonbetLiveState: states[2], fonbetPrematchState: states[3], pinnaclePrematchState: states[4], pinnacleLiveState: states[5], ggbetLiveState: states[6], prematchCollector: { status: () => ({}), catalog: [] }, fonbetCollector: { status: () => ({}) }, pinnacleCollector: { status: () => ({}), catalog: [] }, ggbetCollector: { status: () => ({ enabled: true }) }, resultsService: { status: () => ({}), days: new Map() }, startedAt: Date.now() });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = 'http://127.0.0.1:' + server.address().port;
  const call = async (p, token, body, headers = {}) => { const res = await fetch(base + p, { method: body ? 'POST' : 'GET', headers: { ...(token ? { authorization: 'Bearer ' + token } : {}), ...(body ? { 'content-type': 'application/json' } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined }); let json = null; try { json = await res.json(); } catch {} return { status: res.status, json }; };
  const user = async (name, capabilities) => { const r = await call('/api/admin/users', MASTER, { name, capabilities }); return { id: r.json.user.id, token: r.json.token }; };
  return { base, call, user, settings, close: async () => { await new Promise((r) => { server.closeAllConnections?.(); server.close(r); }); await stopMatcher(); } };
}
const VIEW = ['live.view', 'prematch.view', 'odds.live', 'scores.history', 'odds.history'];

test('user A and user B: different rights, different league access, separate settings', async () => {
  const api = await start();
  try {
    const A = await api.user('A', [...VIEW, 'provider.astek', 'provider.pinnacle', 'leagues.manage']);
    const B = await api.user('B', [...VIEW, 'provider.astek']);
    await leagueStore.remember([{ source: 'astek', league: 'League astek', category: 'Counter Strike 2' }, { source: 'pinnacle', league: 'League pinnacle', category: 'Counter Strike 2' }]);
    const meA = (await api.call('/api/me', A.token)).json, meB = (await api.call('/api/me', B.token)).json;
    assert.ok(meA.keyId && meB.keyId && meA.keyId !== meB.keyId, 'each key has its own id');
    assert.ok(meA.capabilities.includes('leagues.manage') && !meB.capabilities.includes('leagues.manage'));
    // Root cause regression: the catalog lists stay arrays for a user without admin.diagnostics.
    const catA = (await api.call('/api/leagues', A.token)).json;
    assert.ok(Array.isArray(catA.providers.astek) && Array.isArray(catA.providers.pinnacle), JSON.stringify(catA.providers).slice(0, 120));
    assert.ok(catA.providers.pinnacle.some((r) => r.league === 'League pinnacle'));
    const catB = (await api.call('/api/leagues', B.token)).json;
    assert.ok(Array.isArray(catB.providers.astek));
    assert.equal(catB.providers.pinnacle, undefined, 'B has no Pinnacle: its leagues are not sent');
    assert.equal((await api.call('/api/league-links/challenge', A.token)).status, 200, 'A may publish links');
    assert.equal((await api.call('/api/league-links/challenge', B.token)).status, 403, 'B may not');
    // settings
    const empty = (await api.call('/api/me/settings?ns=ui', A.token)).json;
    assert.equal(empty.version, 0); assert.equal(empty.payload, null);
    const savedA = await api.call('/api/me/settings', A.token, { namespace: 'ui', baseVersion: 0, payload: { theme: 'light', favorites: ['x'] } });
    assert.equal(savedA.status, 200); assert.equal(savedA.json.version, 1);
    await api.call('/api/me/settings', B.token, { namespace: 'ui', baseVersion: 0, payload: { theme: 'dark', favorites: [] } });
    assert.deepEqual((await api.call('/api/me/settings', A.token)).json.payload, { theme: 'light', favorites: ['x'] });
    assert.deepEqual((await api.call('/api/me/settings', B.token)).json.payload, { theme: 'dark', favorites: [] }, 'B never sees A');
    // a stale write is refused with the current row (two devices)
    const stale = await api.call('/api/me/settings', A.token, { namespace: 'ui', baseVersion: 0, payload: { theme: 'dark' } });
    assert.equal(stale.status, 409); assert.equal(stale.json.current.version, 1);
    // without a key: no settings, no history
    assert.equal((await api.call('/api/me/settings')).status, 401);
    assert.equal((await api.call('/api/score-history?ids=astek:a1')).status, 401, 'score history needs the key');
    assert.equal((await api.call('/api/score-history?ids=astek:a1', A.token)).status, 200, 'and works with it');
    assert.equal((await api.call('/api/events/astek:a1/history', A.token)).status, 200);
  } finally { await api.close(); }
});

test('key rotation: the new key gets its own settings row, starting from the same user\'s settings; the old key dies', async () => {
  const api = await start();
  try {
    const A = await api.user('A', VIEW);
    await api.call('/api/me/settings', A.token, { namespace: 'ui', baseVersion: 0, payload: { theme: 'light' } });
    const oldKey = (await api.call('/api/me', A.token)).json.keyId;
    const rotated = await api.call(`/api/admin/users/${A.id}/token`, MASTER, {});
    const token2 = rotated.json.token;
    assert.equal((await api.call('/api/me/settings', A.token)).status, 401, 'old key no longer works');
    const me2 = (await api.call('/api/me', token2)).json;
    assert.notEqual(me2.keyId, oldKey);
    const inherited = (await api.call('/api/me/settings', token2)).json;
    assert.equal(inherited.version, 0); assert.deepEqual(inherited.payload, { theme: 'light' }); assert.equal(inherited.inheritedFrom.keyId, oldKey);
    const B = await api.user('B', VIEW);
    assert.equal((await api.call('/api/me/settings', B.token)).json.payload, null, 'another user never inherits');
  } finally { await api.close(); }
});

test('the web gateway (server token) reads/writes settings only on behalf of a named user', async () => {
  const api = await start();
  try {
    const A = await api.user('A', VIEW), keyId = (await api.call('/api/me', A.token)).json.keyId;
    await api.call('/api/me/settings', A.token, { namespace: 'ui', baseVersion: 0, payload: { theme: 'light' } });
    const viaGateway = await api.call('/api/me/settings', MASTER, null, { 'x-esm-on-behalf-user': A.id, 'x-esm-on-behalf-key': keyId });
    assert.deepEqual(viaGateway.json.payload, { theme: 'light' });
    // a normal user cannot impersonate
    const B = await api.user('B', VIEW);
    const spoof = await api.call('/api/me/settings', B.token, null, { 'x-esm-on-behalf-user': A.id, 'x-esm-on-behalf-key': keyId });
    assert.equal(spoof.json.payload, null);
  } finally { await api.close(); }
});

test('permission change while a stream is open: the stream gets `entitlements` and closes; reconnect uses new rights', async () => {
  const api = await start();
  try {
    const A = await api.user('A', ['live.view', 'provider.astek']);
    const controller = new AbortController();
    const res = await fetch(api.base + '/api/feed-stream?modes=live,history&thin=1', { headers: { authorization: 'Bearer ' + A.token }, signal: controller.signal });
    assert.equal(res.status, 200);
    const reader = res.body.getReader(), decoder = new TextDecoder();
    let text = '';
    const readAll = (async () => { for (;;) { const { value, done } = await reader.read(); if (done) return 'closed'; text += decoder.decode(value); } })();
    await new Promise((r) => setTimeout(r, 150));
    assert.match(text, /event: hello/);
    await api.call('/api/admin/users/' + A.id, MASTER, { capabilities: ['live.view', 'history.view', 'provider.astek', 'provider.pinnacle'] });
    const outcome = await Promise.race([readAll, new Promise((r) => setTimeout(() => r('timeout'), 3000))]);
    assert.equal(outcome, 'closed', 'the server ended the old stream');
    assert.match(text, /event: entitlements\ndata: \{"reason":"rights"/);
    const me = (await api.call('/api/me', A.token)).json;
    assert.ok(me.capabilities.includes('history.view') && me.capabilities.includes('provider.pinnacle'));
    assert.ok(me.entitlementsRevision > 0);
    controller.abort();
  } finally { await api.close(); }
});

test('settings survive a server restart (separate SQLite file); bad input is refused', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'settings-'));
  try {
    const store = new UserSettingsStore({ dataDir: dir });
    const id = { userId: 'u_1', keyId: 'k1' };
    store.put(id, 'ui', { baseVersion: 0, payload: { theme: 'light' } });
    store.close();
    const again = new UserSettingsStore({ dataDir: dir });
    assert.deepEqual(again.get(id, 'ui').payload, { theme: 'light' });
    assert.equal(again.get(id, 'ui').version, 1);
    assert.throws(() => again.put(id, 'ui', { baseVersion: 1, payload: [] }), /объектом/);
    assert.throws(() => again.put(id, 'nope', { baseVersion: 1, payload: {} }), /Неизвестный/);
    assert.throws(() => again.put(id, 'ui', { baseVersion: 1, payload: { big: 'x'.repeat(70000) } }), /слишком большие/);
    assert.throws(() => again.get({ userId: '' }, 'ui'), /только для пользователя/);
    again.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
