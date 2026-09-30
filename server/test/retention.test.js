import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { config } from '../src/config.js';
import { oddsAppend, oddsStateSave, oddsEntries, scoreAppend, scoreLoad, closeSqliteStorage, sqlite } from '../src/sqlite-storage.js';
import { pruneOdds, pruneScores, pruneStatistics, retentionEnabled } from '../src/retention.js';
import { diskLevel } from '../src/utils.js';

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 5, 1);
const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'retention-'));
config.dataDir = tmp;

test.after(async () => { closeSqliteStorage(); await fs.rm(tmp, { recursive: true, force: true }); });

function seedOdds(id, ageDays, rows = 3) {
  const at = NOW - ageDays * DAY;
  for (let i = 0; i < rows; i++) oddsAppend('astek', id, { at: at + i, changes: [{ key: 'k' + i }] });
  oddsStateSave('astek', id, { last: {}, lastAt: at + rows });
}

test('odds retention removes only events whose newest record is older than the cutoff', async () => {
  seedOdds('old1', 400); seedOdds('old2', 200); seedOdds('fresh', 5);
  // A long-lived fixture: early entries are old, but it is still being updated.
  oddsAppend('astek', 'longlived', { at: NOW - 300 * DAY, changes: [] });
  oddsAppend('astek', 'longlived', { at: NOW - DAY, changes: [] });
  oddsStateSave('astek', 'longlived', { last: {}, lastAt: NOW - DAY });

  const result = await pruneOdds({ cutoff: NOW - 180 * DAY, budgetMs: 5000 });
  assert.equal(result.events, 2);
  assert.equal(result.rows, 6);
  assert.equal(oddsEntries('astek', 'old1').length, 0);
  assert.equal(oddsEntries('astek', 'old2').length, 0);
  assert.equal(oddsEntries('astek', 'fresh').length, 3);
  assert.equal(oddsEntries('astek', 'longlived').length, 2, 'early history of an active event is kept');
  assert.equal(sqlite().db.prepare("SELECT COUNT(*) AS n FROM odds_state WHERE event_id IN ('old1','old2')").get().n, 0);
});

test('odds retention is resumable when the time budget is exhausted', async () => {
  seedOdds('big', 500, 5000);
  const first = await pruneOdds({ cutoff: NOW - 180 * DAY, budgetMs: 0 });
  assert.equal(first.more, true);
  let guard = 0, last;
  do { last = await pruneOdds({ cutoff: NOW - 180 * DAY, budgetMs: 0 }); } while (last.more && ++guard < 20);
  assert.equal(oddsEntries('astek', 'big').length, 0);
});

test('score retention removes whole old identities and keeps recent ones', async () => {
  scoreAppend('astek:old', NOW - 300 * DAY, { at: NOW - 300 * DAY, scoreText: '1:0' });
  scoreAppend('astek:old', NOW - 300 * DAY, { at: NOW - 299 * DAY, scoreText: '2:0' });
  scoreAppend('astek:new', NOW - 2 * DAY, { at: NOW - 2 * DAY, scoreText: '0:0' });
  const result = await pruneScores({ cutoff: NOW - 180 * DAY, budgetMs: 5000 });
  assert.equal(result.events, 1);
  assert.equal(scoreLoad('astek:old'), null);
  assert.equal(scoreLoad('astek:new').entries.length, 1);
});

test('statistics retention removes old files and index rows, ignores unsafe ids', async () => {
  await fs.mkdir(path.join(tmp, 'statistics'), { recursive: true });
  await fs.writeFile(path.join(tmp, 'statistics', 'hawk-1.json'), '{}');
  await fs.writeFile(path.join(tmp, 'statistics', 'hawk-2.json'), '{}');
  const store = { ready: Promise.resolve(), dirty: new Set(), cache: new Map(), index: {
    'hawk-1': { id: 'hawk-1', at: NOW - 400 * DAY },
    'hawk-2': { id: 'hawk-2', at: NOW - 1 * DAY },
    '../evil': { id: '../evil', at: NOW - 400 * DAY },
  } };
  const result = await pruneStatistics(store, { cutoff: NOW - 180 * DAY });
  assert.equal(result.events, 1);
  assert.equal(Object.keys(store.index).includes('hawk-1'), false);
  assert.equal(Object.keys(store.index).includes('hawk-2'), true);
  await assert.rejects(fs.access(path.join(tmp, 'statistics', 'hawk-1.json')));
  await fs.access(path.join(tmp, 'statistics', 'hawk-2.json'));
});

test('retention is disabled by default and disk level thresholds work', () => {
  assert.equal(retentionEnabled(config), false);
  assert.equal(retentionEnabled({ oddsRetentionDays: 90, scoreRetentionDays: 0, statisticsRetentionDays: 0 }), true);
  assert.equal(diskLevel(null), 'unknown');
  assert.equal(diskLevel(config.diskWarnFreeMiB + 1), 'ok');
  assert.equal(diskLevel(config.diskWarnFreeMiB - 1), 'low');
  assert.equal(diskLevel(config.diskCriticalFreeMiB - 1), 'critical');
});

test('scheduler runs after its delay, prunes, and reschedules', async (t) => {
  const { startRetention } = await import('../src/retention.js');
  seedOdds('sched-old', 400);
  seedOdds('sched-fresh', 1);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const handle = startRetention({ statistics: null, settings: { oddsRetentionDays: 180, scoreRetentionDays: 0, statisticsRetentionDays: 0 }, now: () => NOW });
  t.mock.timers.tick(60_000);
  // The run is async (setImmediate yields); wait until it has finished.
  for (let i = 0; i < 50 && oddsEntries('astek', 'sched-old').length; i++) await new Promise((resolve) => setImmediate(resolve));
  handle.stop();
  assert.equal(oddsEntries('astek', 'sched-old').length, 0);
  assert.equal(oddsEntries('astek', 'sched-fresh').length, 3);
});

test('a disabled scheduler never schedules anything', () => {
  return import('../src/retention.js').then(({ startRetention }) => {
    const handle = startRetention({ settings: { oddsRetentionDays: 0, scoreRetentionDays: 0, statisticsRetentionDays: 0 } });
    assert.equal(typeof handle.stop, 'function');
    handle.stop();
  });
});
