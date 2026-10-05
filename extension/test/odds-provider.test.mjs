import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const read = (file) => fs.readFileSync(new URL('../' + file, import.meta.url), 'utf8');
const load = (file, name) => { const root = {}; vm.runInNewContext(read(file), { globalThis: root, self: root, window: root, module: undefined, console }); return root[name]; };
const OddsProvider = load('odds-provider.js', 'OddsProvider');
const MatchView = load('view-model.js', 'MatchView');

test('LIVE odds provider is GGBET; a stored DataBet preference resolves to GGBET and DataBet is never visible', () => {
  assert.equal(OddsProvider.selected({}), 'ggbet');
  assert.equal(OddsProvider.selected({ liveOddsProvider: 'databet' }), 'ggbet');
  assert.equal(OddsProvider.selected({ liveOddsProvider: 'DataBet' }), 'ggbet');
  assert.equal(OddsProvider.selected({ liveOddsProvider: 'betfair' }), 'ggbet');
  assert.deepEqual([...OddsProvider.PROVIDERS], ['ggbet']);
  assert.equal(OddsProvider.withProvider('/api/ui/live?thin=1', { liveOddsProvider: 'databet' }), '/api/ui/live?thin=1&provider=ggbet');
  assert.equal(OddsProvider.withProvider('/api/ui/live', {}), '/api/ui/live?provider=ggbet');
  assert.equal(OddsProvider.visible('astek', { liveOddsProvider: 'databet' }), true);
  assert.equal(OddsProvider.visible('ggbet', { liveOddsProvider: 'databet' }), true);
  assert.equal(OddsProvider.visible('databet', { liveOddsProvider: 'databet' }), false);
  assert.equal(OddsProvider.visible('databet', {}), false);
  assert.equal(OddsProvider.isOddsProvider('databet'), true, 'still recognised, so its refs are filtered out');
  assert.equal(OddsProvider.name('databet'), 'GGBET');
  assert.equal(OddsProvider.detailKey('live', 'logical:1', { liveOddsProvider: 'databet' }), 'live:ggbet:logical:1');
  assert.equal(OddsProvider.detailKey('prematch', 'p:1', {}), 'prematch:p:1');
});

test('provider health turns an unavailable GGBET into an explicit state instead of an endless spinner', () => {
  const prefs = {};
  assert.equal(OddsProvider.health(undefined, prefs).ok, true, 'no snapshot yet: the normal loading state applies');
  assert.equal(OddsProvider.health({ providers: { ggbet: { oddsProvider: { connectionState: 'connected', stale: false } } } }, prefs).ok, true);
  const down = OddsProvider.health({ providers: { ggbet: { oddsProvider: { connectionState: 'reconnecting', available: false, lastError: 'GGBET: WebSocket закрыт 1006' } } } }, prefs);
  assert.deepEqual([down.ok, down.label, down.reason], [false, 'GGBET', 'GGBET: WebSocket закрыт 1006']);
  assert.equal(OddsProvider.health({ providers: { ggbet: { oddsProvider: { connectionState: 'reconnecting', available: true } } } }, prefs).ok, true, 'a reconnect inside the grace window does not flash a banner');
  assert.equal(OddsProvider.health({ providers: { ggbet: { oddsProvider: { connectionState: 'disabled' } } } }, prefs).ok, true, 'a server without GGBET shows no banner');
  assert.equal(OddsProvider.health({ transportError: 'HTTP 503' }, prefs).ok, false);
  assert.equal(OddsProvider.health({ providers: { ggbet: { oddsProvider: { connectionState: 'connected', stale: true, lastUpdateAt: '2026-10-01T00:00:00Z' } } } }, prefs).reason, 'данные источника устарели');
  assert.equal(OddsProvider.health({ providers: { ggbet: { oddsProvider: { connectionState: 'reconnecting', stale: true, lastUpdateAt: null } } } }, prefs).reason, 'ожидаем первые данные источника');
});

test('match view: GGBET only in LIVE and toggleable like any bookmaker; DataBet never; neither in Results/History', () => {
  const event = { sourceRefs: [
    { source: 'astek', inLive: true, firstPrematchAt: 1 },
    { source: 'ggbet', inLive: true },
    { source: 'databet', inLive: true }
  ] };
  const sources = (prefs, view) => MatchView.selected(event, prefs, view).map((r) => r.source);
  assert.deepEqual(sources({}, 'live'), ['astek', 'ggbet']);
  assert.deepEqual(sources({ liveOddsProvider: 'databet' }, 'live'), ['astek', 'ggbet']);
  assert.deepEqual(sources({ ggbet: false }, 'live'), ['astek'], 'GGBET switched off in the extension');
  assert.deepEqual(sources({ ggbet: true }, 'live'), ['astek', 'ggbet'], 'and back on');
  assert.deepEqual(sources({}, 'results'), ['astek']);
  assert.deepEqual(sources({}, 'history'), ['astek']);
});

// ----------------------------------------------------------------------------------------------------------------
// Service worker harness: background.js with fake chrome.* APIs and a recording fetch.
function serviceWorker({ prefs, seenEvents } = {}) {
  const store = { prefs, seenEvents, server: { base: 'http://srv.test', token: '' } };
  const listeners = [], connect = [], fetched = [], posted = [], notifications = [], timers = new Set();
  const revision = { live: 0 };
  const json = (body, headers = {}) => Promise.resolve({ ok: true, status: 200, headers: { get: (k) => headers[k.toLowerCase()] || '' }, json: async () => body });
  const fakeFetch = (url, options = {}) => {
    fetched.push(String(url));
    const u = new URL(url), provider = u.searchParams.get('provider') || '';
    if (u.pathname === '/api/feed-stream') return new Promise((resolve, reject) => { options.signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))); }); // open until aborted
    if (u.pathname === '/api/ui/live') {
      if (u.searchParams.get('meta') === '1') return json({ revision: `r${revision.live}-${provider}`, leagueRules: { revision: 1 } });
      return json({ revision: `r${revision.live}-${provider}`, leagueRules: { revision: 1 }, events: [{ id: `e-${provider}`, team1: 'A', team2: 'B', league: 'L', category: 'Dota 2', sourceRefs: [{ source: provider, sourceEventId: `${provider}-1` }] }] }, { etag: 'W/"x"' });
    }
    return json({ revision: 'p1', leagueRules: { revision: 1 }, events: [] });
  };
  const chrome = {
    storage: {
      local: {
        get: async (keys) => { const list = Array.isArray(keys) ? keys : [keys]; return Object.fromEntries(list.filter((k) => store[k] !== undefined).map((k) => [k, store[k]])); },
        set: async (obj) => { Object.assign(store, obj); },
        remove: async () => {}
      },
      onChanged: { addListener: (fn) => listeners.push(fn) }
    },
    alarms: { get: async () => null, create: () => {}, clear: async () => true, onAlarm: { addListener: () => {} } },
    action: { onClicked: { addListener: () => {} } },
    notifications: { onClicked: { addListener: () => {} }, create: async (id, options) => { notifications.push({ id, options }); } },
    runtime: { onConnect: { addListener: (fn) => connect.push(fn) }, onMessage: { addListener: () => {} }, getURL: (p) => 'chrome-extension://test/' + p, sendNativeMessage: async () => ({}) },
    tabs: { query: async () => [], create: async () => ({}), remove: async () => {}, update: async () => {} },
    windows: { get: async () => ({}), update: async () => {}, create: async () => ({ id: 1 }) }
  };
  const track = (fn, kind) => (...args) => { const id = fn(...args); timers.add([kind, id]); return id; };
  const context = {
    chrome, fetch: fakeFetch, console, URL, TextDecoder, AbortController, AbortSignal, queueMicrotask, Promise, Date, Math, JSON,
    setTimeout: track(setTimeout, 't'), clearTimeout, setInterval: track(setInterval, 'i'), clearInterval
  };
  context.importScripts = (...files) => { for (const file of files) vm.runInContext(read(file), context, { filename: file }); };
  vm.createContext(context);
  vm.runInContext(read('background.js'), context, { filename: 'background.js' });
  const port = { name: 'monitor', postMessage: (m) => posted.push(m), onDisconnect: { addListener: () => {} }, onMessage: { addListener: () => {} } };
  return {
    store, fetched, posted, notifications, revision,
    open: () => { for (const fn of connect) fn(port); },
    changePrefs: (next) => { const oldValue = store.prefs; store.prefs = next; for (const fn of listeners) fn({ prefs: { oldValue, newValue: next } }, 'local'); },
    dispose: () => { for (const [kind, id] of timers) (kind === 'i' ? clearInterval : clearTimeout)(id); }
  };
}
const until = async (fn, ms = 3000) => { const end = Date.now() + ms; while (Date.now() < end) { if (fn()) return true; await new Promise((r) => setTimeout(r, 20)); } return false; };

test('service worker: LIVE requests and the feed stream always use GGBET, also with a stored DataBet preference', async () => {
  const sw = serviceWorker({ prefs: { liveOddsProvider: 'databet', notifications: { live: true } }, seenEvents: { live: ['seed'] } });
  try {
    sw.open();
    assert.ok(await until(() => sw.fetched.some((u) => u.includes('/api/ui/live?compact=1')) && sw.fetched.some((u) => u.includes('/api/feed-stream'))), 'initial LIVE fetch and stream');
    const live = sw.fetched.filter((u) => u.includes('/api/ui/live'));
    assert.ok(live.length >= 2 && live.every((u) => u.includes('provider=ggbet')), live.join('\n'));
    assert.ok(sw.fetched.find((u) => u.includes('/api/feed-stream')).includes('provider=ggbet'));
    assert.ok(sw.fetched.filter((u) => u.includes('/api/ui/prematch')).every((u) => !u.includes('provider=')), 'the line is provider-independent');
    // Turning GGBET off in the extension is a display preference: the feed and the stream are unchanged.
    sw.fetched.length = 0; const posted = sw.posted.length;
    sw.changePrefs({ liveOddsProvider: 'ggbet', ggbet: false, notifications: { live: true } });
    await new Promise((r) => setTimeout(r, 120));
    assert.equal(sw.posted.slice(posted).some((m) => m.kind === 'live-provider'), false, 'no provider switch');
    assert.equal(sw.fetched.some((u) => u.includes('provider=databet')), false, 'DataBet is never requested');
  } finally { sw.dispose(); }
});
