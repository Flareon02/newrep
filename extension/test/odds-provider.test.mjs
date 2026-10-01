import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const read = (file) => fs.readFileSync(new URL('../' + file, import.meta.url), 'utf8');
const load = (file, name) => { const root = {}; vm.runInNewContext(read(file), { globalThis: root, self: root, window: root, module: undefined, console }); return root[name]; };
const OddsProvider = load('odds-provider.js', 'OddsProvider');
const MatchView = load('view-model.js', 'MatchView');

test('odds provider selection defaults to GGBET and accepts only GGBET or DataBet', () => {
  assert.equal(OddsProvider.selected({}), 'ggbet');
  assert.equal(OddsProvider.selected({ liveOddsProvider: 'databet' }), 'databet');
  assert.equal(OddsProvider.selected({ liveOddsProvider: 'DataBet' }), 'databet');
  assert.equal(OddsProvider.selected({ liveOddsProvider: 'betfair' }), 'ggbet');
  assert.equal(OddsProvider.withProvider('/api/ui/live?thin=1', { liveOddsProvider: 'databet' }), '/api/ui/live?thin=1&provider=databet');
  assert.equal(OddsProvider.withProvider('/api/ui/live', {}), '/api/ui/live?provider=ggbet');
  assert.equal(OddsProvider.visible('astek', { liveOddsProvider: 'databet' }), true);
  assert.equal(OddsProvider.visible('ggbet', { liveOddsProvider: 'databet' }), false);
  assert.equal(OddsProvider.visible('databet', { liveOddsProvider: 'databet' }), true);
  assert.equal(OddsProvider.name('databet'), 'DataBet');
  assert.equal(OddsProvider.detailKey('live', 'logical:1', { liveOddsProvider: 'databet' }), 'live:databet:logical:1');
  assert.notEqual(OddsProvider.detailKey('live', 'logical:1', {}), OddsProvider.detailKey('live', 'logical:1', { liveOddsProvider: 'databet' }));
  assert.equal(OddsProvider.detailKey('prematch', 'p:1', { liveOddsProvider: 'databet' }), 'prematch:p:1');
});

test('provider health turns an unavailable DataBet into an explicit state instead of an endless spinner', () => {
  const prefs = { liveOddsProvider: 'databet' };
  assert.equal(OddsProvider.health(undefined, prefs).ok, true, 'no snapshot yet: the normal loading state applies');
  const ok = OddsProvider.health({ providers: { databet: { oddsProvider: { connectionState: 'connected', stale: false } } } }, prefs);
  assert.equal(ok.ok, true);
  const down = OddsProvider.health({ providers: { databet: { oddsProvider: { connectionState: 'reconnecting', available: false, lastError: 'DataBet: WebSocket закрыт 1006' } } } }, prefs);
  assert.deepEqual([down.ok, down.label, down.reason], [false, 'DataBet', 'DataBet: WebSocket закрыт 1006']);
  const refreshing = OddsProvider.health({ providers: { databet: { oddsProvider: { connectionState: 'reconnecting', available: true } } } }, prefs);
  assert.equal(refreshing.ok, true, 'a reconnect inside the grace window (token refresh) does not flash a banner');
  assert.equal(OddsProvider.health({ providers: { databet: { oddsProvider: { connectionState: 'disabled' } } } }, prefs).ok, false);
  assert.equal(OddsProvider.health({ providers: { ggbet: { oddsProvider: { connectionState: 'disabled' } } } }, {}).ok, true, 'a server without the default provider shows no banner');
  assert.equal(OddsProvider.health({ transportError: 'HTTP 503' }, prefs).ok, false);
  assert.equal(OddsProvider.health({ providers: { databet: { oddsProvider: { connectionState: 'connected', stale: true, lastUpdateAt: '2026-10-01T00:00:00Z' } } } }, prefs).reason, 'данные источника устарели');
  assert.equal(OddsProvider.health({ providers: { databet: { oddsProvider: { connectionState: 'reconnecting', stale: true, lastUpdateAt: null } } } }, prefs).reason, 'ожидаем первые данные источника');
});

test('match view never shows the unselected odds provider and keeps both out of Results/History', () => {
  const event = { sourceRefs: [
    { source: 'astek', inLive: true, firstPrematchAt: 1 },
    { source: 'ggbet', inLive: true },
    { source: 'databet', inLive: true }
  ] };
  const sources = (prefs, view) => MatchView.selected(event, prefs, view).map((r) => r.source);
  assert.deepEqual(sources({}, 'live'), ['astek', 'ggbet']);
  assert.deepEqual(sources({ liveOddsProvider: 'databet' }, 'live'), ['astek', 'databet']);
  assert.deepEqual(sources({ liveOddsProvider: 'databet', databet: false }, 'live'), ['astek']);
  assert.deepEqual(sources({ liveOddsProvider: 'databet' }, 'results'), ['astek']);
  assert.deepEqual(sources({ liveOddsProvider: 'databet' }, 'history'), ['astek']);
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

test('service worker: the stored provider drives LIVE requests and the feed stream; switching drops the old feed quietly', async () => {
  const sw = serviceWorker({ prefs: { liveOddsProvider: 'databet', notifications: { live: true } }, seenEvents: { live: ['seed'] } });
  try {
    sw.open();
    assert.ok(await until(() => sw.fetched.some((u) => u.includes('/api/ui/live?compact=1')) && sw.fetched.some((u) => u.includes('/api/feed-stream'))), 'initial LIVE fetch and stream');
    const live = sw.fetched.filter((u) => u.includes('/api/ui/live'));
    assert.ok(live.length >= 2 && live.every((u) => u.includes('provider=databet')), live.join('\n'));
    assert.ok(sw.fetched.find((u) => u.includes('/api/feed-stream')).includes('provider=databet'));
    assert.ok(sw.fetched.filter((u) => u.includes('/api/ui/prematch')).every((u) => !u.includes('provider=')), 'the line is provider-independent');
    const notifiedBefore = sw.notifications.length;
    // Switch to GGBET: the view is told, the LIVE feed is refetched for GGBET and the stream reconnects for GGBET.
    sw.fetched.length = 0;
    sw.changePrefs({ liveOddsProvider: 'ggbet', notifications: { live: true } });
    assert.ok(sw.posted.some((m) => m.kind === 'live-provider' && m.provider === 'ggbet'));
    assert.ok(await until(() => sw.fetched.some((u) => u.includes('/api/feed-stream') && u.includes('provider=ggbet')) && sw.fetched.some((u) => u.includes('/api/ui/live?compact=1') && u.includes('provider=ggbet'))), sw.fetched.join('\n'));
    assert.equal(sw.fetched.some((u) => u.includes('provider=databet')), false, 'nothing is requested for the old provider after the switch');
    const snapshot = [...sw.posted].reverse().find((m) => m.kind === 'live' && m.snapshot);
    assert.ok(snapshot.snapshot.events.every((e) => e.sourceRefs.every((r) => r.source === 'ggbet')));
    assert.equal(sw.notifications.length, notifiedBefore, 'switching providers is not a burst of "new match" notifications');
  } finally { sw.dispose(); }
});
