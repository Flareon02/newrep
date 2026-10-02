import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const F = createRequire(import.meta.url)('../match-format.js');

test('display score: BO1, BO3 and BO5 with the current map and the maps still to come', () => {
  assert.equal(F.displayScore({ seriesScore: [0, 0], bestOf: 1 }).text, '0:0 (0:0)');
  assert.equal(F.displayScore({ scoreText: '0:0 (7:12)', bestOf: 1 }).text, '0:0 (7:12)');
  assert.equal(F.displayScore({ seriesScore: [0, 0], bestOf: 3 }).text, '0:0 (0:0, 0:0, 0:0)');
  const live = F.displayScore({ seriesScore: [1, 0], mapScores: [[13, 6], [5, 3]], bestOf: 3 });
  assert.equal(live.text, '1:0 (13:6, 5:3, 0:0)'); assert.equal(live.current, 1); assert.equal(live.decided, false);
  assert.equal(F.displayScore({ scoreText: '2:2 (0:4, 5:0, 2:7, 10:7, 8:1)', bestOf: 5 }).text, '2:2 (0:4, 5:0, 2:7, 10:7, 8:1)');
  assert.equal(F.displayScore({ seriesScore: [1, 0], mapScores: [[16, 14]], bestOf: 5 }).text, '1:0 (16:14, 0:0, 0:0, 0:0, 0:0)');
});

test('display score: a decided series lists only the maps played; no invented maps without a format', () => {
  const done = F.displayScore({ scoreText: '2:0 (13:5, 13:9, 0:0)', bestOf: 3 });
  assert.equal(done.text, '2:0 (13:5, 13:9)'); assert.equal(done.current, -1);
  assert.equal(F.displayScore({ scoreText: '1:0 (13:6, 5:3)' }).text, '1:0 (13:6, 5:3)', 'unknown format: only what the provider gave');
  assert.equal(F.displayScore({ scoreText: '1:0 (13:6, 0:0, 0:0)' }).text, '1:0 (13:6, 0:0)', 'unknown format: trailing future maps dropped, the current one kept');
  assert.equal(F.displayScore({ scoreText: '1:0' }).text, '1:0');
});

test('display score: an implausible "series" (rounds or kills) is not shown as maps won', () => {
  const fonbet = F.displayScore({ scoreText: '16:11 (15:1, 1:10, 0:0)', seriesScore: [16, 11], bestOf: 3 });
  assert.equal(fonbet.valid, false); assert.equal(fonbet.series, null);
  assert.equal(F.displayScore({ seriesScore: [3, 0], bestOf: 3 }).valid, false, 'more maps won than a BO3 allows');
  assert.equal(F.displayScore({ scoreText: 'перерыв' }).text, 'перерыв');
});

test('canonical score: furthest plausible state wins; empty or implausible providers never override it', () => {
  const refs = [
    { source: 'fonbet', scoreText: '16:11 (15:1, 1:10, 0:0)', seriesScore: [16, 11], bestOf: 3 },
    { source: 'pinnacle' },
    { source: 'ggbet', scoreText: '2:2 (0:4, 5:0, 2:7, 5:10, 0:0)', seriesScore: [2, 2], bestOf: 5 },
    { source: 'astek', scoreText: '2:2 (0:4, 5:0, 2:7, 10:7, 8:1)', seriesScore: [2, 2], bestOf: 5 },
  ];
  const c = F.canonicalScore(refs);
  assert.equal(c.best.source, 'astek', 'same series, more maps with points');
  assert.deepEqual(c.providers.map((p) => p.source), ['astek', 'ggbet']);
  assert.equal(c.disagree, true);
  // A provider that is a map behind loses even if it changed later.
  const behind = F.canonicalScore([{ source: 'astek', seriesScore: [0, 0], mapScores: [[10, 3]], bestOf: 3 }, { source: 'ggbet', seriesScore: [1, 0], mapScores: [[13, 7]], bestOf: 3 }], { changedAt: (r) => (r.source === 'astek' ? 2 : 1) });
  assert.equal(behind.best.source, 'ggbet');
  // Same state everywhere: the most recent change, then the fixed order.
  const same = [{ source: 'ggbet', seriesScore: [1, 0], mapScores: [[13, 7], [2, 1]], bestOf: 3 }, { source: 'astek', seriesScore: [1, 0], mapScores: [[13, 7], [2, 1]], bestOf: 3 }];
  assert.equal(F.canonicalScore(same).best.source, 'astek'); assert.equal(F.canonicalScore(same).disagree, false);
  assert.equal(F.canonicalScore(same, { changedAt: (r) => (r.source === 'ggbet' ? 5 : 0) }).best.source, 'ggbet');
  assert.equal(F.canonicalScore([{ source: 'pinnacle' }]).best, null);
});
