import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../server-config.js', import.meta.url), 'utf8');

// Load server-config.js the way a page or the service worker would, with a fake
// chrome.storage and (optionally) a fake localStorage.
function load({ stored, mirror, withLocalStorage = true } = {}) {
  const listeners = [];
  const store = stored ? { server: stored } : {};
  const local = new Map(mirror ? [['monitor-server', JSON.stringify(mirror)]] : []);
  let reloads = 0;
  const context = {
    chrome: { storage: {
      local: {
        get: async (key) => ({ [key]: store[key] }),
        set: async (obj) => Object.assign(store, obj),
        remove: async (key) => { delete store[key]; },
      },
      onChanged: { addListener: (fn) => listeners.push(fn) },
    } },
    location: { reload: () => { reloads++; } },
    URL,
    ...(withLocalStorage ? { localStorage: { getItem: (k) => local.get(k) ?? null, setItem: (k, v) => local.set(k, v) } } : {}),
  };
  vm.createContext(context);
  const ServerConfig = vm.runInContext(source + '\nServerConfig;', context);
  return { ServerConfig, store, local, listeners, reloads: () => reloads };
}

test('defaults to the original production address and sends no auth header', async () => {
  const { ServerConfig, reloads } = load();
  await ServerConfig.ready;
  assert.equal(ServerConfig.base, 'http://87.199.202.237:8080');
  assert.equal(ServerConfig.token, '');
  assert.deepEqual({ ...ServerConfig.headers({ 'X-A': '1' }) }, { 'X-A': '1' });
  assert.equal(reloads(), 0);
});

test('stored server and token are used; token becomes a Bearer header', async () => {
  const { ServerConfig } = load({ stored: { base: 'https://monitor.example.com/', token: ' secret-token-value ' } });
  await ServerConfig.ready;
  assert.equal(ServerConfig.base, 'https://monitor.example.com');
  assert.equal(ServerConfig.token, 'secret-token-value');
  assert.equal(ServerConfig.headers({ 'Content-Type': 'application/json' }).Authorization, 'Bearer secret-token-value');
});

test('invalid addresses fall back to the default instead of breaking requests', async () => {
  for (const base of ['javascript:alert(1)', 'ftp://x', 'not a url', '', 'file:///etc/passwd']) {
    const { ServerConfig } = load({ stored: { base } });
    await ServerConfig.ready;
    assert.equal(ServerConfig.base, 'http://87.199.202.237:8080', base);
  }
});

test('a reverse-proxy path prefix is kept, credentials are refused, permission patterns carry no port', async () => {
  const { ServerConfig } = load({ stored: { base: 'https://host.example/monitor/?x=1#y' } });
  await ServerConfig.ready;
  assert.equal(ServerConfig.base, 'https://host.example/monitor');
  assert.equal(ServerConfig.normalize('http://user:pass@host:8080'), '');
  assert.equal(ServerConfig.normalize('http://host:8080/'), 'http://host:8080');
  assert.equal(ServerConfig.permissionPattern('http://10.0.0.5:8080/api'), 'http://10.0.0.5/*');
  assert.equal(ServerConfig.permissionPattern('https://host.example/monitor'), 'https://host.example/*');
  assert.equal(ServerConfig.permissionPattern('http://[::1]:8080'), 'http://[::1]/*');
});

test('a page whose mirror is stale reloads exactly once', async () => {
  const { ServerConfig, reloads, local } = load({ stored: { base: 'http://10.0.0.5:8080', token: '' } });
  const changed = await ServerConfig.ready;
  await new Promise((r) => setImmediate(r));
  assert.equal(changed, true);
  assert.equal(reloads(), 1);
  assert.equal(JSON.parse(local.get('monitor-server')).base, 'http://10.0.0.5:8080');
  // Next page load sees a matching mirror: no reload.
  const again = load({ stored: { base: 'http://10.0.0.5:8080', token: '' }, mirror: { base: 'http://10.0.0.5:8080', token: '' } });
  assert.equal(await again.ServerConfig.ready, false);
  assert.equal(again.reloads(), 0);
});

test('service worker (no localStorage) reads chrome.storage and never tries to reload', async () => {
  const { ServerConfig, reloads } = load({ stored: { base: 'http://10.0.0.5:8080', token: 'abc' }, withLocalStorage: false });
  assert.equal(await ServerConfig.ready, false);
  assert.equal(ServerConfig.base, 'http://10.0.0.5:8080');
  assert.equal(reloads(), 0);
});

test('save() persists sanitized values and storage changes propagate', async () => {
  const { ServerConfig, store, listeners } = load();
  await ServerConfig.ready;
  await ServerConfig.save({ base: 'http://host:9000/some/path', token: 'tok' });
  assert.equal(JSON.stringify(store.server), JSON.stringify({ base: 'http://host:9000/some/path', token: 'tok' }));
  listeners[0]({ server: { newValue: { base: 'http://other:1', token: '' } } }, 'local');
  assert.equal(ServerConfig.base, 'http://other:1');
  await ServerConfig.reset();
  assert.equal(ServerConfig.base, 'http://87.199.202.237:8080');
});

test('errorText turns browser network errors into Russian text and keeps server messages', () => {
  const { ServerConfig } = load();
  assert.equal(ServerConfig.errorText(Object.assign(new Error('signal timed out'), { name: 'TimeoutError' })), 'сервер не ответил вовремя');
  assert.equal(ServerConfig.errorText(Object.assign(new Error('The user aborted a request.'), { name: 'AbortError' })), 'сервер не ответил вовремя');
  assert.equal(ServerConfig.errorText(new TypeError('Failed to fetch')), 'сервер недоступен');
  assert.equal(ServerConfig.errorText(new Error('Нужен токен доступа')), 'Нужен токен доступа');
});
