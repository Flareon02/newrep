import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { config } from '../src/config.js';
import { SnapshotState } from '../src/state.js';
import { snapshotSave, closeSqliteStorage } from '../src/sqlite-storage.js';

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'history-memory-'));
config.dataDir = tmp;
test.after(async () => { closeSqliteStorage(); await fs.rm(tmp, { recursive: true, force: true }); });

const DAY = 86_400_000;
const NOW = Date.now();
// Row i was first seen i minutes before NOW (row 0 is the newest) and removed shortly after.
const MIN = 60_000;
const row = (name, i, step = 1) => ({
  id: `${name}-${i}`, sourceEventId: String(i), source: 'astek', category: 'Counter Strike 2', league: `League ${i % 50}`,
  team1: `Team ${i % 997}`, team2: `Team ${(i * 7) % 991}`, startAt: NOW - i * step * MIN, firstSeenAt: NOW - i * step * MIN - 10 * MIN,
  lastSeenAt: NOW - i * step * MIN, removedAt: NOW - i * step * MIN + 1000, marketKind: 'main', lifecycle: [],
});
const seed = (name, rows, step = 1) => snapshotSave(name, { revision: 1, matchRevision: 1, events: [], history: Array.from({ length: rows }, (_, i) => row(name, i, step)), seen: {} }, {});
const activity = (e) => Math.max(e.firstSeenAt || 0, e.lastSeenAt || 0, e.removedAt || 0);

test('REPRO 1: memory used by History must not grow with the size of the persisted table', async () => {
  seed('mem-big', 60_000, 5); // 60 000 rows spread over ~208 days
  const state = new SnapshotState('mem-big', 60_000);
  await state.load();
  const resident = state.historyIndex.size;
  assert.ok(resident < 5_000, `${resident} of 60000 rows are resident in memory`);
});

test('REPRO 2: recentHistory returns the newest rows even after the periodic prune reorders memory', async () => {
  seed('order', 3000);
  const state = new SnapshotState('order', 60_000);
  await state.load();
  state.lastHistoryPruneAt = 0;           // force the 5-minute TTL prune on the next poll
  await state.success([], { elapsedMs: 1 });
  const { events } = state.recentHistory(0, 500);
  const newest = Array.from({ length: 500 }, (_, i) => `order-${i}`).sort();
  assert.deepEqual(events.map((e) => e.id).sort(), newest, 'the 500 most recently seen rows');
  assert.ok(activity(events.at(-1)) >= activity(events[0]), 'ascending by first-seen order, newest last');
});

// ---------------------------------------------------------------------------------------------------------------
// Differential test: a state that keeps only the hot window (HISTORY_HOT_DAYS=7, cold rows in SQLite) must answer
// every History query exactly like a state that keeps everything resident (HISTORY_HOT_DAYS=0, the 4.3.x model),
// also after live updates that touch cold rows, create new rows and remove rows.
// ---------------------------------------------------------------------------------------------------------------
function rng(seed) { let x = seed; return () => { x = (x * 1664525 + 1013904223) % 4294967296; return x / 4294967296; }; }
const ids = (rows) => rows.map((e) => e.id);
const plain = (rows) => JSON.stringify(rows.map((e) => { const { odds, ...rest } = e; return rest; }));

test('hot-window History answers exactly like the fully resident History', async (t) => {
  const random = rng(42);
  const total = 4000;
  const base = Array.from({ length: total }, (_, i) => {
    const ageDays = random() * 300, startAt = Math.floor(NOW - ageDays * DAY);
    return {
      id: `astek-${i}`, sourceEventId: String(i), source: 'astek', category: 'Dota 2', league: `League ${i % 40}`, team1: `T${i % 97}`, team2: `U${i % 89}`,
      marketKind: 'main', lifecycle: [{ type: 'entered', at: startAt - 3_600_000 }], startAt,
      firstSeenAt: startAt - 3_600_000, lastSeenAt: startAt + Math.floor(random() * 3_600_000), removedAt: random() < 0.9 ? startAt + Math.floor(7_200_000 * random()) : 0,
    };
  });
  const wanted = (name) => base.map((r) => ({ ...r, id: r.id.replace('astek', name) }));
  snapshotSave('diff-prematch-hot', { revision: 1, matchRevision: 1, events: [], history: wanted('hot'), seen: {} }, {});
  snapshotSave('diff-prematch-all', { revision: 1, matchRevision: 1, events: [], history: wanted('all'), seen: {} }, {});

  t.mock.timers.enable({ apis: ['Date'], now: NOW });
  const previous = config.historyHotDays;
  const make = async (name, days) => { config.historyHotDays = days; const s = new SnapshotState(name, 60_000); await s.load(); s.lastPersistAt = Date.now(); return s; };
  const hot = await make('diff-prematch-hot', 7), all = await make('diff-prematch-all', 0);
  config.historyHotDays = previous;
  assert.ok(hot.historyIndex.size < all.historyIndex.size / 4, `hot window is small (${hot.historyIndex.size} vs ${all.historyIndex.size})`);
  assert.equal(hot.historyTotal, all.historyTotal);

  // Same live updates on both: re-enter old (cold) fixtures, add new ones, let some disappear.
  const live = (name, i, extra = {}) => ({ id: `${name}-${i}`, sourceEventId: String(i), source: 'astek', category: 'Dota 2', league: `League ${i % 40}`, team1: `T${i % 97}`, team2: `U${i % 89}`, marketKind: 'main', startAt: NOW + 3_600_000, ...extra });
  let current = [];
  for (let round = 0; round < 6; round++) {
    t.mock.timers.tick(60_000 * (round + 1));
    const coldPick = Array.from({ length: 5 }, () => Math.floor(random() * total));
    const fresh = Array.from({ length: 3 }, (_, k) => total + round * 10 + k);
    const chosen = [...coldPick, ...fresh, ...current.slice(0, 4)];
    const unique = [...new Set(chosen)];
    current = unique;
    await hot.success(unique.map((i) => live('hot', i)), { status: 200 });
    await all.success(unique.map((i) => live('all', i)), { status: 200 });
  }
  t.mock.timers.tick(5 * 60_000);
  await hot.success(current.slice(0, 2).map((i) => live('hot', i)), { status: 200 }); // forces the periodic prune/evict pass
  await all.success(current.slice(0, 2).map((i) => live('all', i)), { status: 200 });

  const norm = (rows) => rows.map((r) => ({ ...r, id: r.id.replace(/^(?:hot|all)-/, 'X-') }));
  const same = (a, b, what) => {
    const left = norm(a).map((r) => plain([r])), right = norm(b).map((r) => plain([r]));
    const missing = left.filter((x) => !right.includes(x)).map((x) => x.slice(0, 120)), extra = right.filter((x) => !left.includes(x)).map((x) => x.slice(0, 120));
    assert.ok(left.length === right.length && !missing.length && !extra.length, `${what}: ${left.length} vs ${right.length} rows; only in hot-window: ${JSON.stringify(missing.slice(0, 2))}; only in resident: ${JSON.stringify(extra.slice(0, 2))}`);
    assert.deepEqual(left.map((x) => JSON.parse(x)[0].id), right.map((x) => JSON.parse(x)[0].id), `${what}: order`);
  };

  const compare = (A, B, label) => {
    assert.equal(A.historyTotal, B.historyTotal, `${label}: total rows`);
    for (const days of [0, 0.5, 3, 6.9, 7.1, 20, 60, 150, 290, 400]) {
      const since = days === 0 ? 0 : Date.now() - days * DAY;
      same(A.publicHistory(since), B.publicHistory(since), `${label}: publicHistory(${days}d)`);
      for (const limit of [1, 10, 300, 5000]) {
        const a = A.recentHistory(since, limit), b = B.recentHistory(since, limit);
        same(a.events, b.events, `${label}: recentHistory(${days}d, ${limit})`);
        assert.equal(a.exhausted, b.exhausted, `${label}: exhausted(${days}d, ${limit})`);
      }
    }
    for (const [fromDays, toDays] of [[1, 0], [10, 8], [100, 90], [299, 0], [400, 300]]) {
      const from = Date.now() - fromDays * DAY, to = Date.now() - toDays * DAY;
      same(A.historyByStart(from, to), B.historyByStart(from, to), `${label}: historyByStart(${fromDays}..${toDays}d)`);
    }
    for (const probe of ['astek-0', 'astek-1', 'astek-3999', 'astek-nope', `astek-${total}`]) {
      const name = (s) => probe.replace('astek', s);
      assert.equal(A.hasHistoryId(name('hot')), B.hasHistoryId(name('all')), `${label}: hasHistoryId(${probe})`);
    }
  };
  compare(hot, all, 'in memory');

  // Persist and reload the hot-window state from SQLite: a restart must change nothing.
  await hot.save(); await all.save();
  const reloaded = await make('diff-prematch-hot', 7);
  compare(reloaded, all, 'after restart');
  assert.ok(reloaded.historyIndex.size < all.historyIndex.size / 4, `reloaded ${reloaded.historyIndex.size} vs all ${all.historyIndex.size}`);
  t.mock.timers.reset();
});
