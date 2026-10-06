import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const SettingsSync = require('../settings-sync.js');

function memoryStorage(initial = {}) {
  const data = structuredClone(initial);
  return {
    data,
    async get(keys) { return Object.fromEntries([].concat(keys).filter((k) => k in data).map((k) => [k, structuredClone(data[k])])); },
    async set(obj) { Object.assign(data, structuredClone(obj)); },
    async remove(keys) { for (const k of [].concat(keys)) delete data[k]; },
  };
}
// Server double: one settings row per "<user>:<key>", optimistic versions like server/src/user-settings.js.
function fakeServer() {
  const rows = new Map();
  let who = null;
  const err = (status, extra = {}) => Object.assign(new Error('HTTP ' + status), { status, ...extra });
  return {
    rows, as(id) { who = id; },
    client: {
      async get() { if (!who) throw err(401); const r = rows.get(who); return r ? { ...structuredClone(r) } : { version: 0, payload: null }; },
      async post(_, body) {
        if (!who) throw err(401);
        const cur = rows.get(who) || { version: 0, payload: null };
        if (body.baseVersion !== cur.version) throw err(409, { current: structuredClone(cur) });
        const next = { version: cur.version + 1, payload: structuredClone(body.payload) };
        rows.set(who, next); return next;
      },
    },
  };
}
const DEFAULTS = { theme: 'dark', favorites: [], openMode: 'window', hiddenLeagues: [] };
function harness(storageInit, server) {
  let prefs = { ...DEFAULTS, ...(storageInit.prefs || {}) };
  const storage = memoryStorage(storageInit);
  const timers = [];
  const sync = SettingsSync.create({ storage, client: server.client, getPrefs: () => prefs, applyPrefs: (p) => { prefs = { ...p }; }, defaults: DEFAULTS, setTimer: (fn) => { timers.push(fn); return timers.length; }, clearTimer: () => {} });
  const runTimers = async () => { while (timers.length) await timers.shift()(); };
  return { sync, storage, get prefs() { return prefs; }, set(k, v) { prefs = { ...prefs, [k]: v }; sync.changed([k]); }, runTimers };
}
const me = (id, keyId) => ({ principal: { id, name: id, role: 'user', anonymous: false }, keyId, capabilities: [] });

test('legacy device settings are imported once, for the first identity only', async () => {
  const server = fakeServer();
  const h = harness({ prefs: { theme: 'light', favorites: ['a'], openMode: 'tab' }, 'lastKnown9:live': { events: [1] } }, server);
  server.as('u1:k1');
  await h.sync.attach(me('u1', 'k1'));
  await h.runTimers();
  assert.deepEqual(server.rows.get('u1:k1').payload.favorites, ['a'], 'imported and pushed');
  assert.equal(server.rows.get('u1:k1').payload.openMode, undefined, 'device-only values stay on the device');
  assert.equal(h.storage.data.settingsLegacyOwner9, 'u1:k1');
  // another user on the same device starts clean, and the first user's cached feeds are dropped
  server.as('u2:k2');
  await h.sync.attach(me('u2', 'k2'));
  assert.deepEqual(h.prefs.favorites, [], 'user 2 does not get user 1 favorites');
  assert.equal(h.prefs.theme, 'dark');
  assert.equal(h.prefs.openMode, 'tab', 'device-only value kept');
  assert.equal(h.storage.data['lastKnown9:live'], undefined, 'cached feeds of the previous identity are removed');
});

test('switching back restores each identity\'s own profile; changes sync per key', async () => {
  const server = fakeServer();
  const h = harness({ prefs: {} }, server);
  server.as('u1:k1'); await h.sync.attach(me('u1', 'k1')); await h.runTimers();
  h.set('favorites', ['x']); await h.runTimers();
  server.as('u2:k2'); await h.sync.attach(me('u2', 'k2')); await h.runTimers();
  h.set('favorites', ['y']); await h.runTimers();
  server.as('u1:k1'); await h.sync.attach(me('u1', 'k1')); await h.runTimers();
  assert.deepEqual(h.prefs.favorites, ['x']);
  assert.deepEqual(server.rows.get('u1:k1').payload.favorites, ['x']);
  assert.deepEqual(server.rows.get('u2:k2').payload.favorites, ['y']);
});

test('a newer server copy (another device) wins, keys changed here are merged on top', async () => {
  const server = fakeServer();
  server.rows.set('u1:k1', { version: 5, payload: { theme: 'light', favorites: ['remote'], hiddenLeagues: ['L'] } });
  const h = harness({ prefs: {}, settingsLegacyOwner9: 'someone-else' }, server);
  server.as('u1:k1');
  await h.sync.attach(me('u1', 'k1')); await h.runTimers();
  assert.equal(h.prefs.theme, 'light'); assert.deepEqual(h.prefs.favorites, ['remote']);
  // concurrent edit elsewhere, then a local edit of another key → 409 → merge
  server.rows.set('u1:k1', { version: 6, payload: { theme: 'light', favorites: ['remote', 'other-device'], hiddenLeagues: ['L'] } });
  h.set('hiddenLeagues', ['L', 'M']);
  await h.runTimers();
  const row = server.rows.get('u1:k1');
  assert.equal(row.version, 7);
  assert.deepEqual(row.payload.favorites, ['remote', 'other-device'], 'other device change kept');
  assert.deepEqual(row.payload.hiddenLeagues, ['L', 'M'], 'local change kept');
  assert.deepEqual(h.prefs.favorites, ['remote', 'other-device']);
});

test('without a key (open server / logged out) settings stay local; an old server (404) disables sync', async () => {
  const server = fakeServer();
  const h = harness({ prefs: { favorites: ['a'] } }, server);
  assert.equal(await h.sync.attach({ principal: { anonymous: true } }), null);
  assert.equal(h.sync.status().state, 'local');
  const old = { client: { get: async () => { throw Object.assign(new Error('404'), { status: 404 }); }, post: async () => { throw new Error('must not post'); } } };
  const h2 = harness({ prefs: {} }, old);
  await h2.sync.attach(me('u1', 'k1')); h2.set('theme', 'light'); await h2.runTimers();
  assert.equal(h2.sync.status().state, 'unsupported');
});

test('a change made while a push is in flight is sent afterwards (not lost)', async () => {
  const server = fakeServer();
  let release; const gate = new Promise((r) => { release = r; });
  const slow = { client: { get: server.client.get, post: async (...a) => { await gate; return server.client.post(...a); } } };
  const timers = [];
  let prefs = { ...DEFAULTS };
  const storage = memoryStorage({ settingsLegacyOwner9: 'x' });
  const sync = SettingsSync.create({ storage, client: slow.client, getPrefs: () => prefs, applyPrefs: (p) => { prefs = { ...p }; }, defaults: DEFAULTS, setTimer: (fn) => { timers.push(fn); return timers.length; }, clearTimer: () => {} });
  server.as('u1:k1');
  await sync.attach(me('u1', 'k1'));
  const first = timers.shift()();            // push of the initial (empty server) state, blocked on the gate
  prefs = { ...prefs, favorites: ['late'] }; sync.changed(['favorites']);
  release(); await first;
  while (timers.length) await timers.shift()();
  assert.deepEqual(server.rows.get('u1:k1').payload.favorites, ['late']);
  assert.equal(sync.status().pending, 0);
});
