import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { config } from '../src/config.js';
import { SnapshotState } from '../src/state.js';
import { oddsLog } from '../src/odds-log.js';
import { createApi } from '../src/api.js';
import { stopMatcher } from '../src/matcher-client.js';
import { closeSqliteStorage, sqlite, writeCounters } from '../src/sqlite-storage.js';

const count = (table, where = '', ...params) => Number(sqlite().db.prepare(`SELECT COUNT(*) AS n FROM ${table}${where ? ' WHERE ' + where : ''}`).get(...params).n);
const event = (id, price, extra = {}) => ({
  id: `ggbet-${id}`, source: 'ggbet', provider: 'GGBET', sourceEventId: id, category: 'Dota 2', league: 'Test League', team1: 'Alpha', team2: 'Beta', startAt: 1, scoreText: '1:0',
  odds: { transport: 'graphql-ws', updatedAt: Date.now(), markets: [{ type: 'moneyline', title: 'Winner', status: 'open', prices: [{ designation: 'home', decimal: price, rawValue: String(price) }, { designation: 'away', decimal: 2.5, rawValue: '2.50' }] }] },
  ...extra
});
const homePrice = (state, id) => state.events.find((e) => e.id === `ggbet-${id}`)?.odds?.markets?.[0]?.prices?.[0]?.decimal;

async function withStore(oddsHistoryEnabled, fn) {
  const old = { dir: config.dataDir, flag: config.oddsHistoryEnabled }, tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'odds-history-switch-'));
  closeSqliteStorage(); config.dataDir = tmp; config.oddsHistoryEnabled = oddsHistoryEnabled;
  try { return await fn(tmp); } finally { closeSqliteStorage(); config.dataDir = old.dir; config.oddsHistoryEnabled = old.flag; await fs.rm(tmp, { recursive: true, force: true }); }
}

test('F: ODDS_HISTORY_ENABLED=0 - an odds change reaches the API from memory but adds no odds_entries_v3/odds_state rows', async () => {
  await withStore(false, async () => {
    const states = Array.from({ length: 7 }, (_, i) => new SnapshotState(i === 6 ? 'ggbet-live' : 'f-' + i, 60000));
    const server = createApi({ liveState: states[0], prematchState: states[1], fonbetLiveState: states[2], fonbetPrematchState: states[3], pinnaclePrematchState: states[4], pinnacleLiveState: states[5], ggbetLiveState: states[6], prematchCollector: { status: () => ({}), catalog: [] }, fonbetCollector: { status: () => ({}) }, pinnacleCollector: { status: () => ({}), catalog: [] }, ggbetCollector: { status: () => ({ enabled: true, connected: true }) }, resultsService: { status: () => ({}), days: new Map() }, startedAt: Date.now() });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const get = async (p) => (await fetch('http://127.0.0.1:' + server.address().port + p)).json();
    try {
      const before = { odds: count('odds_entries_v3'), state: count('odds_state'), w: writeCounters().dbOddsWritesSinceStart };
      await states[6].success([event('f1', 1.8)]);
      assert.equal((await get('/api/live/ggbet')).events[0].odds.markets[0].prices[0].decimal, 1.8);
      await states[6].success([event('f1', 1.95)]);
      assert.equal((await get('/api/live/ggbet')).events[0].odds.markets[0].prices[0].decimal, 1.95, 'API serves the new price');
      await states[6].persist(true);
      assert.equal(count('odds_entries_v3'), before.odds); assert.equal(count('odds_state'), before.state);
      assert.equal(writeCounters().dbOddsWritesSinceStart, before.w);
      assert.equal(count('snapshot_current', 'name=?', 'ggbet-live'), 0, 'no market trees in snapshot_current');
      const health = await get('/health');
      assert.equal(health.persistence.oddsHistoryEnabled, false); assert.equal(health.persistence.dbOddsWritesSinceStart, before.w);
      assert.ok(health.persistence.oddsRecordsSkipped >= 2); assert.ok(health.persistence.dbWritesSinceStart >= 0);
    } finally { await new Promise((resolve) => server.close(resolve)); await stopMatcher(); }
  });
});

test('G: 100 consecutive odds updates change only the in-memory odds; DB odds rows stay constant', async () => {
  await withStore(false, async () => {
    const state = new SnapshotState('ggbet-live', 60000);
    const odds0 = count('odds_entries_v3'), state0 = count('odds_state'), current0 = count('snapshot_current'), w0 = writeCounters();
    for (let i = 0; i < 100; i++) {
      const price = Math.round((1.5 + i / 100) * 100) / 100;
      await state.success([event('g1', price), event('g2', 3 - i / 100)]);
      assert.equal(homePrice(state, 'g1'), price);
    }
    await state.persist(true);
    assert.equal(homePrice(state, 'g1'), 2.49);
    assert.equal(count('odds_entries_v3'), odds0); assert.equal(count('odds_state'), state0); assert.equal(count('snapshot_current'), current0);
    const w1 = writeCounters();
    assert.equal(w1.dbOddsWritesSinceStart, w0.dbOddsWritesSinceStart);
    assert.equal(w1.byCategory.snapshotCurrent, w0.byCategory.snapshotCurrent);
    assert.ok(w1.byCategory.snapshotHistory > w0.byCategory.snapshotHistory, 'fixture History (no odds) is still saved');
  });
});

test('H: after a restart the persisted odds snapshot is not served as LIVE; fresh upstream data fills the state', async () => {
  await withStore(true, async () => {
    // Before: a process with odds history enabled saved a current snapshot with market trees.
    const before = new SnapshotState('ggbet-live', 60000);
    await before.success([event('h1', 1.7), event('h2', 2.1)]); await before.persist(true);
    assert.equal(count('snapshot_current', 'name=?', 'ggbet-live'), 2);

    config.oddsHistoryEnabled = false;
    const after = new SnapshotState('ggbet-live', 60000); await after.load();
    assert.equal(after.events.length, 0, 'old odds are not restored as current');
    assert.equal(after.publicSnapshot().count, 0); assert.equal(after.publicSnapshot().stale, true, 'state is stale until upstream answers');
    assert.equal(after.status().lastSuccessfulUpdateAt, null);

    await after.success([event('h1', 1.75)]);
    assert.equal(after.events.length, 1); assert.equal(homePrice(after, 'h1'), 1.75); assert.equal(after.publicSnapshot().stale, false);
    const h1 = after.historyRow('ggbet-h1'), h2 = after.historyRow('ggbet-h2');
    assert.equal(h1.lifecycle.filter((x) => x.type === 'entered').length, 1, 'a fixture that stayed LIVE across the restart is not re-entered');
    assert.ok(h2.removedAt > 0, 'a fixture that ended during the restart is recorded as removed');
    assert.equal(count('snapshot_current', 'name=?', 'ggbet-live'), 2, 'the old rows are left untouched, not deleted');
  });
});

test('H2: a failure before the first update keeps the restored ids for the lifecycle', async () => {
  await withStore(false, async () => {
    const first = new SnapshotState('ggbet-live', 60000); await first.success([event('k1', 1.5)]); await first.persist(true);
    const second = new SnapshotState('ggbet-live', 60000); await second.load();
    await second.failure(Error('upstream down')); await second.persist(true);
    const third = new SnapshotState('ggbet-live', 60000); await third.load();
    assert.deepEqual([...third.restoredCurrentIds], ['ggbet-k1']);
    await third.success([event('k1', 1.6)]);
    assert.equal(third.historyRow('ggbet-k1').lifecycle.filter((x) => x.type === 'entered').length, 1);
  });
});

test('I: ODDS_HISTORY_ENABLED=1 keeps the previous behaviour (journal, odds_state, current snapshot restored)', async () => {
  await withStore(true, async () => {
    const odds0 = count('odds_entries_v3'), w0 = writeCounters().dbOddsWritesSinceStart;
    const state = new SnapshotState('ggbet-live', 60000);
    await state.success([event('i1', 1.8)]); await state.success([event('i1', 1.9)]); await state.persist(true);
    assert.equal(count('odds_entries_v3', 'source=? AND event_id=?', 'ggbet', 'i1') - 0, 2, 'initial prices and the change are journaled');
    assert.ok(count('odds_entries_v3') > odds0); assert.equal(count('odds_state', 'source=? AND event_id=?', 'ggbet', 'i1'), 1);
    assert.ok(writeCounters().dbOddsWritesSinceStart >= w0 + 4);
    assert.equal(count('snapshot_current', 'name=?', 'ggbet-live'), 1);
    const history = await oddsLog.get('ggbet', 'i1'); assert.equal(history.entries.length, 2);
    const restarted = new SnapshotState('ggbet-live', 60000); await restarted.load();
    assert.equal(restarted.events.length, 1, 'the current snapshot is restored as before'); assert.equal(homePrice(restarted, 'i1'), 1.9);
  });
});

test('History heartbeat throttle: a still-listed unchanged fixture is not rewritten every save; changes, removals and shutdown are', async () => {
  await withStore(false, async () => {
    const old = config.historyTouchPersistMs; config.historyTouchPersistMs = 15 * 60 * 1000;
    try {
      const state = new SnapshotState('t-touch', 60000);
      const hist = () => writeCounters().byCategory.snapshotHistory;
      const fixture = (score) => ({ id: 'astek-t1', source: 'astek', sourceEventId: 't1', team1: 'A', team2: 'B', startAt: 1, scoreText: score });
      await state.success([fixture('0:0'), { ...fixture('0:0'), id: 'astek-t2', sourceEventId: 't2' }]); await state.persist(true);
      const lastSeen = (id) => Number(sqlite().db.prepare('SELECT last_seen_at AS v FROM snapshot_history WHERE name=? AND event_id=?').get('t-touch', id).v);
      const h0 = hist(), seen0 = lastSeen('astek-t1');
      for (let i = 0; i < 5; i++) { await new Promise((r) => setTimeout(r, 5)); await state.success([fixture('0:0'), { ...fixture('0:0'), id: 'astek-t2', sourceEventId: 't2' }]); state.lastPersistAt = 0; await state.persist(false); }
      assert.equal(hist(), h0, 'lastSeenAt-only refreshes are not written');
      assert.ok(state.historyRow('astek-t1').lastSeenAt > seen0, 'RAM still has the fresh lastSeenAt');
      await state.success([fixture('1:0'), { ...fixture('0:0'), id: 'astek-t2', sourceEventId: 't2' }]); state.lastPersistAt = 0; await state.persist(false);
      assert.equal(hist(), h0 + 1, 'a content change (score) is written');
      await state.success([fixture('1:0')]); state.lastPersistAt = 0; await state.persist(false);
      assert.equal(hist(), h0 + 2, 'a removal is written'); assert.ok(Number(sqlite().db.prepare('SELECT removed_at AS v FROM snapshot_history WHERE name=? AND event_id=?').get('t-touch', 'astek-t2').v) > 0);
      await new Promise((r) => setTimeout(r, 5)); await state.success([fixture('1:0')]);
      const before = lastSeen('astek-t1'); await state.persist(true);
      assert.ok(lastSeen('astek-t1') > before, 'a forced (shutdown) save stores the latest lastSeenAt');
    } finally { config.historyTouchPersistMs = old; }
  });
});

test('History heartbeat throttle is off by default: every save writes every listed fixture (previous behaviour)', async () => {
  await withStore(true, async () => {
    assert.equal(config.historyTouchPersistMs, 0);
    const state = new SnapshotState('t-touch-off', 60000), fixture = { id: 'astek-u1', source: 'astek', sourceEventId: 'u1', team1: 'A', team2: 'B', startAt: 1, scoreText: '0:0' };
    await state.success([fixture]); await state.persist(true);
    const h0 = writeCounters().byCategory.snapshotHistory;
    await state.success([fixture]); state.lastPersistAt = 0; await state.persist(false);
    assert.equal(writeCounters().byCategory.snapshotHistory, h0 + 1);
  });
});
