import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { queryUiEvents, compactUiPayload } from '../../server/src/ui-service.js';
import { buildFixtures } from '../../tools/ux/fixtures.mjs';

const require = createRequire(import.meta.url);
const HistoryLoader = require('../history-loader.js');
const NOW = Date.parse('2026-10-05T15:00:00+04:00');
const fx = buildFixtures({ now: NOW, historyCount: 1900, days: 10 });
const tick = () => new Promise((r) => setImmediate(r));
const settle = async (n = 8) => { for (let i = 0; i < n; i++) await tick(); };

// fetchPage backed by the server's own query code; every call is recorded and can be held or failed.
function backend({ hold = false, fail = null } = {}) {
  const calls = [];
  const fetchPage = (query, { signal }) => {
    const call = { query, params: Object.fromEntries(new URLSearchParams(query)), signal };
    calls.push(call);
    const answer = () => compactUiPayload(queryUiEvents(fx.events, call.params, { links: [] }, 'history'));
    return new Promise((resolve, reject) => {
      const go = () => { if (signal.aborted) return; if (fail && fail(call)) return reject(Object.assign(new Error('История не загрузилась'), { status: 503 })); resolve(answer()); };
      call.release = go;
      signal.addEventListener('abort', () => { const e = new Error('aborted'); e.name = 'AbortError'; reject(e); }, { once: true });
      if (!hold) queueMicrotask(go);
    });
  };
  return { calls, fetchPage };
}
const BASE = 'thin=1&sources=astek%2Cfonbet%2Cpinnacle&showExtras=1';
const make = (b, extra = {}) => HistoryLoader.create({ fetchPage: b.fetchPage, clock: () => NOW, ...extra });

test('first screen: LIVE, line, today and a 1-row summary only — the archive is never requested at once', async () => {
  const b = backend(), h = make(b);
  h.setQuery({ base: BASE }); h.ensureInitial(); await settle();
  const kinds = b.calls.map((c) => `${c.params.phase}:${c.params.limit}${c.params.end ? ':day' : ''}`);
  assert.deepEqual(kinds.sort(), ['line:50', 'live:100', 'removed:1', 'removed:100:day'].sort());
  assert.ok(b.calls.every((c) => Number(c.params.limit) <= 100), 'no request asks for more than one small page');
  const s = h.sections();
  assert.deepEqual(s.map((x) => x.id), ['live', 'line', 'd:2026-10-05']);
  assert.equal(s[0].rows.length, Math.min(100, fx.events.filter((e) => e.inLive).length));
  const shown = s.reduce((n, x) => n + x.rows.length, 0);
  assert.ok(shown < 700 && shown > 0, `first screen holds ${shown} of ${fx.events.length} matches`);
  assert.ok(h.remaining() > 1000, 'the summary knows how many older matches remain');
  // every LIVE match of the archive is in the LIVE section, none of them repeats in a day section
  const ids = s.flatMap((x) => x.rows.map((e) => e.id)); assert.equal(new Set(ids).size, ids.length);
});

test('older days load one at a time, newest first, until the archive ends', async () => {
  const b = backend(), h = make(b);
  h.setQuery({ base: BASE }); h.ensureInitial(); await settle();
  const before = b.calls.length;
  h.loadOlder(); h.loadOlder(); // the second call is ignored while a day is in flight
  assert.equal(b.calls.length, before + 1);
  await settle();
  assert.equal(h.sections().at(-1).id, 'd:2026-10-04');
  const last = b.calls.at(-1).params;
  assert.equal(new Date(Number(last.end) + 4 * 3600000).toISOString().slice(0, 10), '2026-10-04'); assert.equal(Math.round(Number(last.hours)), 24); assert.equal(last.phase, 'removed');
  for (let i = 0; i < 40 && h.status().canLoadOlder; i++) { h.loadOlder(); await settle(); while (h.sections().at(-1).hasMore) { h.loadMore(h.sections().at(-1).id); await settle(); } }
  for (const s of h.sections()) while (s.hasMore) { h.loadMore(s.id); await settle(); }
  const all = h.sections().flatMap((s) => s.rows.map((e) => e.id));
  assert.equal(new Set(all).size, fx.events.length, 'every match of the archive is reachable, exactly once');
  assert.equal(h.remaining(), 0); assert.equal(h.status().exhausted, true); assert.equal(h.status().canLoadOlder, false);
});

test('a day with more than one page offers "more for this day" with offset paging', async () => {
  const b = backend(), h = make(b, { pageSize: 50, firstPage: { live: 50, line: 50, day: 50 } });
  h.setQuery({ base: BASE }); h.ensureInitial(); await settle();
  const today = h.sections().find((s) => s.id === 'd:2026-10-05');
  assert.ok(today.total > 50 && today.hasMore);
  h.loadMore(today.id); await settle();
  assert.equal(b.calls.at(-1).params.offset, '50');
  assert.equal(today.rows.length, Math.min(100, today.total));
});

test('a filter change aborts the previous query; going back is served from cache', async () => {
  const b = backend({ hold: true }), h = make(b);
  h.setQuery({ base: BASE }); h.ensureInitial();
  const first = b.calls.slice();
  h.setQuery({ base: BASE + '&q=shinden' }); h.ensureInitial();
  assert.ok(first.every((c) => c.signal.aborted), 'obsolete requests are cancelled');
  for (const c of b.calls.slice(first.length)) c.release(); await settle();
  assert.ok(h.sections().every((s) => s.rows.every((e) => /shinden/i.test(e.team1 + e.team2 + e.league))));
  const n = b.calls.length;
  h.setQuery({ base: BASE + '&q=shinden' }); h.ensureInitial(); await settle();
  assert.equal(b.calls.length, n, 'same query, fresh sections: no request');
});

test('a late response of an aborted query never lands in the current one (race)', async () => {
  const b = backend({ hold: true }), h = make(b);
  h.setQuery({ base: BASE + '&category=dota+2' }); h.ensureInitial();
  const stale = b.calls.slice();
  h.setQuery({ base: BASE }); h.ensureInitial();
  for (const c of b.calls.slice(stale.length)) c.release();
  for (const c of stale) c.release(); // too late: already aborted
  await settle();
  assert.ok(h.sections().some((s) => s.rows.some((e) => !/dota/i.test(e.category))));
});

test('errors are per section and retry reloads only that section', async () => {
  let failing = true;
  const b = backend({ fail: (c) => failing && c.params.phase === 'line' }), h = make(b);
  h.setQuery({ base: BASE }); h.ensureInitial(); await settle();
  const line = h.sections().find((s) => s.id === 'line');
  assert.equal(line.state, 'error'); assert.match(line.error, /не загрузилась/);
  assert.equal(h.sections().find((s) => s.id === 'live').state, 'ready');
  failing = false; const n = b.calls.length;
  h.retry('line'); await settle();
  assert.equal(b.calls.length, n + 1); assert.equal(line.state, 'ready'); assert.ok(line.rows.length > 0);
});

test('a server invalidation refreshes LIVE, line and today — never the past days', async () => {
  const b = backend(), h = make(b);
  h.setQuery({ base: BASE }); h.ensureInitial(); await settle();
  h.loadOlder(); await settle(); h.loadOlder(); await settle();
  const n = b.calls.length;
  h.ensureInitial(); await settle();
  assert.equal(b.calls.length, n, 'fresh: nothing is requested again');
  h.invalidate(); h.ensureInitial(); await settle();
  assert.equal(b.calls.length, n, 'an invalidation alone (and any render) requests nothing');
  h.refresh(); await settle();
  const again = b.calls.slice(n).map((c) => c.params.end ? new Date(Number(c.params.end) + 4 * 3600000).toISOString().slice(0, 10) : c.params.phase);
  assert.deepEqual(again.sort(), ['2026-10-05', 'line', 'live', 'removed'].sort());
});

test('phase and time window filters shape the plan', async () => {
  const b = backend(), h = make(b);
  h.setQuery({ base: BASE, phase: 'live' }); h.ensureInitial(); await settle();
  assert.deepEqual(h.sections().map((s) => s.id), ['live']); assert.equal(h.status().canLoadOlder, false);
  h.setQuery({ base: BASE, phase: 'removed', hours: 6 }); h.ensureInitial(); await settle();
  assert.deepEqual(h.sections().map((s) => s.id), ['d:2026-10-05']);
  const day = b.calls.find((c) => c.params.end && c.params.phase === 'removed' && c.params.limit === '100');
  assert.equal(Number(day.params.end) - Number(day.params.hours) * 3600000, NOW - 6 * 3600000, 'today is cut to the 6 hour window');
  assert.equal(h.status().canLoadOlder, false, 'yesterday is outside a 6 hour window');
});

test('empty days are skipped automatically, a long empty run pauses until the user asks', async () => {
  const sparse = { ...fx, events: fx.events.filter((e) => !(e.removedAt && e.firstPrematchAt > NOW - 5 * 86400000)) };
  const calls = [];
  const fetchPage = (query) => { calls.push(query); return Promise.resolve(compactUiPayload(queryUiEvents(sparse.events, Object.fromEntries(new URLSearchParams(query)), { links: [] }, 'history'))); };
  const h = HistoryLoader.create({ fetchPage, clock: () => NOW, maxEmptySkip: 3 });
  h.setQuery({ base: BASE }); h.ensureInitial(); await settle(30);
  assert.equal(h.status().paused, true, 'three empty days in a row: paused');
  assert.ok(h.sections().filter((s) => s.kind === 'day').every((s) => s.total === 0));
  h.loadOlder({ user: true }); await settle(30);
  assert.ok(h.sections().some((s) => s.kind === 'day' && s.total > 0), 'the user continues past the gap');
});

test('snapshot/restore: an instant first paint that is refreshed at once', async () => {
  const b = backend(), h = make(b);
  h.setQuery({ base: BASE }); h.ensureInitial(); await settle();
  const snap = JSON.parse(JSON.stringify(h.snapshot(120)));
  assert.ok(snap.sections.reduce((n, s) => n + s.rows.length, 0) <= 120);
  const b2 = backend({ hold: true }), h2 = make(b2);
  assert.equal(h2.restore(snap), true);
  h2.setQuery({ base: BASE });
  assert.ok(h2.sections()[0].rows.length > 0, 'rows are there before any request');
  h2.ensureInitial();
  assert.ok(b2.calls.some((c) => c.params.phase === 'live'), 'restored sections are stale and refreshed');
});

test('game facets count LIVE, line and the archive once', async () => {
  const b = backend(), h = make(b);
  h.setQuery({ base: BASE }); h.ensureInitial(); await settle();
  const total = h.facets().reduce((n, f) => n + f.count, 0);
  assert.equal(total, fx.events.length);
});

test('a background refresh of today never swallows a request for an older day (regression)', async () => {
  const b = backend({ hold: true }), h = make(b);
  h.setQuery({ base: BASE }); h.ensureInitial();
  for (const c of b.calls.splice(0)) c.release(); await settle();
  h.loadOlder(); for (const c of b.calls.splice(0)) c.release(); await settle();      // yesterday loaded
  h.invalidate(); h.refresh();                                                          // today + LIVE + line refreshing (held)
  assert.ok(h.sections().find((s) => s.id === 'd:2026-10-05').state === 'loading');
  const n = b.calls.length;
  h.loadOlder({ user: true });
  assert.equal(b.calls.length, n + 1, 'the older day is requested while today refreshes');
  assert.equal(new Date(Number(b.calls.at(-1).params.end) + 4 * 3600000).toISOString().slice(0, 10), '2026-10-03');
  assert.equal(h.status().loadingOlder, true);
  for (const c of b.calls.splice(0)) c.release(); await settle();
  assert.equal(h.status().loadingOlder, false);
});
