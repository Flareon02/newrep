import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../store.js', import.meta.url), 'utf8');
const Store = (() => { const root = {}; vm.runInNewContext(source, { globalThis: root, self: root, window: root, module: undefined, console, setTimeout, clearTimeout, AbortController, Promise, Date, Error, Map }); return root.Store; })();
const plain = (v) => JSON.parse(JSON.stringify(v));
const tick = () => new Promise((r) => setImmediate(r));
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };

function fakeFetch() {
  const calls = [];
  const fn = (url, init) => { const d = deferred(); calls.push({ url, init, ...d }); init.signal?.addEventListener('abort', () => { const e = new Error('aborted'); e.name = 'AbortError'; d.reject(e); }); return d.promise; };
  const respond = (i, body, status = 200) => calls[i].resolve({ ok: status < 300, status, json: async () => body });
  return { fn, calls, respond };
}

test('client: concurrent GETs of one URL share a single request', async () => {
  const f = fakeFetch(), client = Store.createClient({ base: () => 'https://api', fetchImpl: f.fn });
  const a = client.get('/x'), b = client.get('/x');
  assert.equal(f.calls.length, 1); assert.equal(f.calls[0].url, 'https://api/x');
  f.respond(0, { ok: 1 });
  assert.deepEqual(await a, { ok: 1 }); assert.deepEqual(await b, { ok: 1 }); assert.equal(client.pending(), 0);
});

test('client: a shared request is aborted only when every waiter gave up', async () => {
  const f = fakeFetch(), client = Store.createClient({ base: () => '', fetchImpl: f.fn });
  const c1 = new AbortController(), c2 = new AbortController();
  const a = client.get('/d', { signal: c1.signal }), b = client.get('/d', { signal: c2.signal });
  c1.abort(); await assert.rejects(a, { name: 'AbortError' });
  assert.equal(f.calls[0].init.signal.aborted, false, 'the other waiter still needs it');
  c2.abort(); await assert.rejects(b, { name: 'AbortError' });
  assert.equal(f.calls[0].init.signal.aborted, true, 'nobody needs it any more: cancelled');
});

test('client: HTTP errors carry the server message; timeouts are reported as such', async () => {
  const f = fakeFetch(), client = Store.createClient({ base: () => '', fetchImpl: f.fn, timeoutFor: () => 20 });
  const a = client.get('/e'); f.respond(0, { error: 'нет такого матча' }, 404);
  await assert.rejects(a, /нет такого матча/);
  await assert.rejects(client.get('/slow'), { name: 'TimeoutError' });
  await assert.rejects(client.post('/slow-post', {}), { name: 'TimeoutError', message: 'сервер не ответил вовремя' });
});

test('resource: stale-while-revalidate returns the cached value at once and reports the fresh one', async () => {
  let t = 1000, n = 0; const r = Store.createResource({ fetcher: async (k) => `${k}#${++n}`, fresh: 100, usable: 10000, clock: () => t });
  const first = r.swr('a'); assert.equal(first.cached, null); assert.equal(first.refreshing, true); assert.equal(await first.promise, 'a#1');
  t += 50; const fresh = r.swr('a'); assert.equal(fresh.cached, 'a#1'); assert.equal(fresh.refreshing, false, 'fresh: no request');
  t += 100; let updated = null; const stale = r.swr('a', { onValue: (v) => { updated = v; } });
  assert.equal(stale.cached, 'a#1', 'stale value is shown immediately'); assert.equal(stale.refreshing, true);
  await stale.promise; assert.equal(updated, 'a#2');
  t += 20000; assert.equal(r.swr('a').cached, null, 'beyond the usable window nothing stale is shown');
});

test('resource: concurrent loads of one key are deduplicated; LRU keeps the newest entries', async () => {
  const d = deferred(); let n = 0; const r = Store.createResource({ fetcher: () => { n++; return d.promise; }, max: 2 });
  const a = r.get('k'), b = r.get('k'); d.resolve('v'); assert.equal(await a, 'v'); assert.equal(await b, 'v'); assert.equal(n, 1);
  r.set('x', 1); r.set('y', 2); r.peek('k'); r.set('z', 3);
  assert.deepEqual(plain(r.keys().sort()), ['y', 'z']);
});

test('resource: invalidate marks entries stale but keeps them displayable', async () => {
  const r = Store.createResource({ fetcher: async () => 'new', fresh: 60000 });
  r.set('live:ggbet:1', 'old'); assert.equal(r.peek('live:ggbet:1').fresh, true);
  r.invalidate((key) => key.endsWith(':1'));
  const s = r.swr('live:ggbet:1'); assert.equal(s.cached, 'old'); assert.equal(s.refreshing, true); assert.equal(await s.promise, 'new');
});

test('persist: writes are throttled per key, the latest value wins, flush writes pending values', async () => {
  let t = 0; const writes = []; const storage = { get: async (keys) => ({ [keys[0]]: { a: 1 } }), set: async (o) => { writes.push(o); } };
  const p = Store.createPersist({ storage, minIntervalMs: 1000, clock: () => t });
  assert.deepEqual(plain(await p.load(['live'])), { live: { a: 1 } });
  p.save('live', 1); await tick(); assert.equal(writes.length, 1);
  p.save('live', 2); p.save('live', 3); await tick(); assert.equal(writes.length, 1, 'throttled');
  await p.flush(); assert.deepEqual(plain(writes.at(-1)), { 'lastKnown:live': 3 });
});
