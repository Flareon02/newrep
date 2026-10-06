// Timeline / replay: deterministic journal written through the production writer (SqliteHistoryStore.observe), then
// reconstructed by timeline-core (in-process) and through the worker (timeline-client) on a temporary database.
import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { SqliteHistoryStore } from '../src/sqlite-history-store.js';
import { stateAt, timelineRange, timelineMeta, createCache } from '../src/timeline-core.js';
import { TimelineClient } from '../src/timeline-client.js';

const T0 = Date.parse('2026-10-06T12:00:00Z'), MIN = 60000;
function schemaDb(file = ':memory:') {
  const db = new DatabaseSync(file);
  db.exec(`CREATE TABLE IF NOT EXISTS score_meta(identity TEXT PRIMARY KEY, started_at INTEGER NOT NULL DEFAULT 0) STRICT;
    CREATE TABLE IF NOT EXISTS score_entries(seq INTEGER PRIMARY KEY AUTOINCREMENT, identity TEXT NOT NULL, at INTEGER NOT NULL, payload TEXT NOT NULL) STRICT;
    CREATE TABLE IF NOT EXISTS odds_state(source TEXT NOT NULL, event_id TEXT NOT NULL, payload TEXT NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY(source,event_id)) STRICT;
    CREATE TABLE IF NOT EXISTS odds_entries_v3(seq INTEGER PRIMARY KEY AUTOINCREMENT, source TEXT NOT NULL, event_id TEXT NOT NULL, at INTEGER NOT NULL, payload BLOB NOT NULL, origin TEXT, origin_pos INTEGER) STRICT;
    CREATE INDEX IF NOT EXISTS score_entries_identity_at ON score_entries(identity,at DESC,seq DESC);
    CREATE INDEX IF NOT EXISTS odds_entries_v3_event_at ON odds_entries_v3(source,event_id,at DESC,seq DESC);`);
  return db;
}
const winner = (provider, h, a, status = 'open') => provider === 'astek'
  ? { marketId: 'a:0:1', typeId: 1, marketName: 'Победитель', marketStatus: status, period: 0, specifiers: {}, outcomes: [{ outcomeId: '1', outcomeName: '^1^', decimalOdds: h, isActive: status === 'open', line: null }, { outcomeId: '3', outcomeName: '^2^', decimalOdds: a, isActive: status === 'open', line: null }] }
  : provider === 'fonbet'
    ? { marketId: 'f:0:moneyline', typeId: 'moneyline', marketName: 'Победитель', marketStatus: status, period: 0, specifiers: {}, outcomes: [{ outcomeId: '921', outcomeName: '1', decimalOdds: h, isActive: true, line: null }, { outcomeId: '923', outcomeName: '2', decimalOdds: a, isActive: true, line: null }] }
    : { marketId: 'g1', typeId: 1, marketName: 'Winner', marketStatus: status === 'open' ? 'ACTIVE' : 'SUSPENDED', period: null, specifiers: {}, outcomes: [{ outcomeId: '1', outcomeName: 'Alpha', decimalOdds: h, isActive: true, line: null }, { outcomeId: '2', outcomeName: 'Beta', decimalOdds: a, isActive: true, line: null }] };
const obs = (provider, eventId, { score = '0:0', markets = [], oddsOnly = false } = {}) => ({ provider, eventId, authority: 'published', source: 'node', phase: 'live', oddsOnly, team1: 'Alpha', team2: 'Beta', state: { sport: 'Counter Strike 2', score, seriesScore: null, mapScores: null, map: null, period: null, gameState: 'live', betStop: false }, markets });

function scenario(db) {
  let now = T0;
  const store = new SqliteHistoryStore(db, { now: () => now, retentionDays: 3650 });
  const at = (minutes, fn) => { now = T0 + minutes * MIN; fn(); store.flush(); };
  at(0, () => store.observe(obs('astek', 'A1', { score: '0:0' })));
  at(1, () => store.observe(obs('astek', 'A1', { score: '0:0', markets: [winner('astek', 1.9, 1.9)] })));
  at(2, () => store.observe(obs('fonbet', 'F1', { score: '0:0', markets: [winner('fonbet', 1.85, 1.95)] })));
  at(3, () => store.observe(obs('astek', 'A1', { score: '1:0', markets: [winner('astek', 1.9, 1.9)] })));
  at(4, () => store.observe(obs('astek', 'A1', { score: '1:0', markets: [winner('astek', 1.9, 1.9, 'suspended')] })));
  at(5, () => store.observe(obs('astek', 'A1', { score: '1:0', markets: [winner('astek', 1.55, 2.4)] })));
  return store;
}
const REQ = { keys: ['astek:A1', 'fonbet:F1'], team1: 'Alpha', team2: 'Beta', sport: 'Counter Strike 2' };
const mw = (s) => s.markets.find((m) => m.key === 'match_winner');

test('stateAt reconstructs score and every bookmaker exactly as they were (no future data)', () => {
  const db = schemaDb(); scenario(db);
  const s1 = stateAt(db, { ...REQ, at: T0 + 2.5 * MIN });
  assert.equal(s1.providers.astek.score.score, '0:0');
  assert.deepEqual(mw(s1).books.astek.o.home, 1.9);
  assert.deepEqual(mw(s1).books.astek.o.away, 1.9);
  assert.equal(mw(s1).books.fonbet.o.home, 1.85);
  assert.equal(mw(s1).books.fonbet.o.away, 1.95);
  assert.equal(mw(s1).books.astek.status, 'open');

  const s2 = stateAt(db, { ...REQ, at: T0 + 4.5 * MIN });
  assert.equal(s2.providers.astek.score.score, '1:0');
  assert.equal(mw(s2).books.astek.status, 'suspended');
  assert.equal(mw(s2).books.astek.o.home, null, 'a suspended outcome has no price');
  assert.equal(mw(s2).books.fonbet.o.home, 1.85, 'Fonbet keeps its last known state');
  assert.equal(mw(s2).books.fonbet.at, T0 + 2 * MIN);

  const s3 = stateAt(db, { ...REQ, at: T0 + 5.5 * MIN });
  assert.equal(mw(s3).books.astek.o.home, 1.55);
  assert.equal(mw(s3).books.astek.o.away, 2.4);

  const s0 = stateAt(db, { ...REQ, at: T0 + 0.5 * MIN });
  assert.equal(s0.providers.astek.score.score, '0:0');
  assert.equal(mw(s0), undefined, 'no market existed yet');
  assert.equal(s0.providers.fonbet.present, false, 'Fonbet had not appeared at 12:00:30');
  assert.equal(s0.providers.astek.present, true);
});

test('checkpoints give the same state as a full replay, in any query order', () => {
  const db = schemaDb(); let now = T0;
  const store = new SqliteHistoryStore(db, { now: () => now, retentionDays: 3650 });
  for (let i = 0; i < 900; i++) { now = T0 + i * 1000; store.observe(obs('astek', 'A1', { score: String(Math.floor(i / 100)) + ':0', markets: [winner('astek', 1.5 + (i % 50) / 100, 2.5 - (i % 50) / 100)] })); store.flush(); }
  const cache = createCache();
  const times = [T0 + 850000, T0 + 120500, T0 + 600200, T0 + 120500, T0 + 899000];
  for (const at of times) {
    const cached = stateAt(db, { ...REQ, at }, cache), full = stateAt(db, { ...REQ, at });
    assert.deepEqual(mw(cached).books.astek.o, mw(full).books.astek.o, 'at ' + (at - T0));
    assert.equal(cached.providers.astek.score.score, full.providers.astek.score.score);
  }
  assert.ok(cache.events.get('astek:A1').checkpoints.length >= 2, 'checkpoints were created');
  const later = stateAt(db, { ...REQ, at: T0 + 899000 }, cache);
  assert.ok(later.replayedRows < 300, 'resumed from a checkpoint: ' + later.replayedRows);
});

test('GGBET Node→Browser handoff starts a new baseline (no market carried over from the other source)', () => {
  const db = schemaDb(); let now = T0;
  const store = new SqliteHistoryStore(db, { now: () => now, retentionDays: 3650 });
  const extra = { marketId: 'g2', typeId: 14, marketName: 'Total maps', marketStatus: 'ACTIVE', specifiers: { total: '2.5' }, outcomes: [{ outcomeId: '1', outcomeName: 'over 2.5', decimalOdds: 1.8, isActive: true }, { outcomeId: '2', outcomeName: 'under 2.5', decimalOdds: 2, isActive: true }] };
  store.observe(obs('ggbet-node', 'G1', { markets: [winner('ggbet', 1.7, 2.1), extra] })); store.flush();
  now = T0 + MIN; store.observe(obs('ggbet-browser', 'G1', { markets: [winner('ggbet', 1.72, 2.08)] })); store.flush();
  const before = stateAt(db, { keys: ['ggbet:G1'], at: T0 + 30000, sport: 'Counter Strike 2' }), after = stateAt(db, { keys: ['ggbet:G1'], at: T0 + 2 * MIN, sport: 'Counter Strike 2' });
  assert.ok(before.markets.some((m) => m.key === 'map_total|line=2.5'));
  assert.equal(after.markets.some((m) => m.key === 'map_total|line=2.5'), false, 'Node-only market not carried into the Browser context');
  assert.equal(after.providers.ggbet.publicationSource, 'ggbet-browser');
  assert.equal(mw(after).books.ggbet.o.home, 1.72);
});

test('timeline range: chronological score + market events, suspension/reopen, pagination, filters', () => {
  const db = schemaDb(); scenario(db);
  const all = timelineRange(db, { ...REQ, from: T0, to: T0 + 10 * MIN });
  const kinds = all.items.map((x) => `${(x.at - T0) / MIN}:${x.provider}:${x.kind}:${x.event || ''}`);
  assert.deepEqual(kinds, ['0:astek:score:', '1:astek:market:appeared', '2:fonbet:score:', '2:fonbet:market:appeared', '3:astek:score:', '4:astek:market:suspended', '5:astek:market:reopened']);
  const reopened = all.items.at(-1);
  assert.equal(reopened.market, 'match_winner');
  assert.deepEqual(reopened.changes.map((c) => [c.outcome, c.old, c.new]), [['home', 1.9, 1.55], ['away', 1.9, 2.4]]);
  // pagination: 3 + 3 + 1 without gaps or duplicates
  const pages = []; let cursor = '';
  do { const p = timelineRange(db, { ...REQ, from: T0, to: T0 + 10 * MIN, limit: 3, cursor }); pages.push(...p.items.map((x) => x.id)); cursor = p.nextCursor; } while (cursor);
  assert.deepEqual(pages, all.items.map((x) => x.id));
  assert.equal(timelineRange(db, { ...REQ, from: T0, to: T0 + 10 * MIN, provider: 'fonbet' }).items.length, 2);
  assert.ok(timelineRange(db, { ...REQ, from: T0, to: T0 + 10 * MIN, kinds: 'score' }).items.every((x) => x.kind === 'score'));
  assert.ok(timelineRange(db, { ...REQ, from: T0, to: T0 + 10 * MIN, market: 'match_winner' }).items.every((x) => x.market === 'match_winner'));
  const meta = timelineMeta(db, REQ);
  assert.equal(meta.from, T0); assert.equal(meta.to, T0 + 5 * MIN);
  assert.equal(meta.density.counts.reduce((a, b) => a + b, 0), 4, 'odds rows at 12:01, 12:02, 12:04, 12:05 (12:03 changed only the score)');
  assert.deepEqual(meta.marks.filter((m) => m.kind === 'score').map((m) => m.score), ['1:0']);
});

test('reversed bookmaker: outcomes oriented to the event teams', () => {
  const db = schemaDb(); scenario(db);
  const s = stateAt(db, { ...REQ, reversed: ['fonbet:F1'], at: T0 + 2.5 * MIN });
  assert.equal(mw(s).books.fonbet.o.away, 1.85, 'Fonbet home (1.85) is the event away team');
  assert.equal(mw(s).books.fonbet.o.home, 1.95);
});

test('through the worker: same answers, bounded queue, idle stop', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'timeline-'));
  const file = path.join(dir, 'monitor-v2.sqlite3');
  const db = schemaDb(file); db.exec('PRAGMA journal_mode=WAL'); scenario(db); db.close();
  const client = new TimelineClient({ dataDir: dir, idleMs: 300, maxPending: 2 });
  try {
    const s = await client.request('stateAt', { ...REQ, at: T0 + 4.5 * MIN });
    assert.equal(mw(s).books.astek.status, 'suspended');
    const r = await client.request('range', { ...REQ, from: T0, to: T0 + 10 * MIN });
    assert.equal(r.items.length, 7);
    const burst = await Promise.allSettled([1, 2, 3, 4].map(() => client.request('meta', REQ)));
    assert.ok(burst.some((x) => x.status === 'rejected' && x.reason.status === 503), 'excess requests are refused, not queued');
    assert.ok(burst.some((x) => x.status === 'fulfilled'));
    await new Promise((res) => setTimeout(res, 700));
    assert.equal(client.status().running, false, 'worker stopped when idle');
    const again = await client.request('stateAt', { ...REQ, at: T0 + 2.5 * MIN });
    assert.equal(mw(again).books.fonbet.o.home, 1.85, 'restarted on demand');
  } finally { await client.stop(); rmSync(dir, { recursive: true, force: true }); }
});
