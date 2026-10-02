import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../match-format.js', import.meta.url), 'utf8');
const F = (() => { const root = {}; vm.runInNewContext(source, { globalThis: root, module: undefined, Map, Date, Object, Number, Math, JSON }); return root.MatchFormat; })();
const plain = (v) => JSON.parse(JSON.stringify(v));

test('quotes are flipped for refs with reversed teams (same rule as scores)', () => {
  assert.deepEqual(plain(F.orientQuote({ quote: { h: 1.5, a: 2.6, at: 1 } })), { h: 1.5, a: 2.6, at: 1 });
  assert.deepEqual(plain(F.orientQuote({ scoreReversed: true, quote: { h: 1.5, a: 2.6 } })), { h: 2.6, a: 1.5 });
  assert.equal(F.orientQuote({}), null);
});

test('best price per side across bookmakers ignores suspended and stale quotes; margin is computed', () => {
  const best = F.bestPrices({ astek: { h: 1.8, a: 2.0 }, fonbet: { h: 1.85, a: 1.95 }, pinnacle: { h: 1.85, a: 2.1, s: 's' }, ggbet: { h: 3, a: 3, stale: 1 } });
  assert.equal(best.h, 1.85); assert.equal(best.a, 2.0); assert.deepEqual(plain(best.by.h), ['fonbet']); assert.deepEqual(plain(best.by.a), ['astek']);
  assert.equal(F.margin({ h: 1.87, a: 1.83 }), 8.1); assert.equal(F.margin({ h: 1.9, a: null }), null); assert.equal(F.margin({ h: 1.9, a: 1.9, s: 's' }), null);
  assert.equal(F.formatPrice(1.833), '1.833'); assert.equal(F.formatPrice(2.05), '2.05'); assert.equal(F.formatPrice(2), '2.00'); assert.equal(F.formatPrice(12.5), '12.50'); assert.equal(F.formatPrice(1), '');
});

test('score parts: series, current map and its score', () => {
  const live = F.scoreParts({ scoreText: '1:1 (13:11, 3:13, 10:7)', seriesScore: [1, 1], mapScores: [[13, 11], [3, 13], [10, 7]], bestOf: 3 });
  assert.deepEqual(plain(live.series), [1, 1]); assert.equal(live.mapNumber, 3); assert.deepEqual(plain(live.map), [10, 7]);
  const done = F.scoreParts({ scoreText: '2:0 (13:5, 13:9, 0:0)', bestOf: 3 });
  assert.equal(done.mapNumber, 2, 'finished series points at the last played map'); assert.deepEqual(plain(done.map), [13, 9]);
  const plainText = F.scoreParts({ scoreText: '0:0' }); assert.deepEqual(plain(plainText.series), [0, 0]); assert.equal(plainText.map, null);
  assert.equal(F.scoreParts({ scoreText: '1:0 (5:3)', activeMap: 1 }).mapNumber, 1);
});

test('price tracker reports a change direction for a while, then forgets it', () => {
  let t = 0; const tr = F.createPriceTracker({ windowMs: 1000, clock: () => t });
  assert.equal(tr.track('k', 1.8).dir, null);
  t = 10; assert.deepEqual(plain(tr.track('k', 1.9)), { dir: 'up', was: 1.8 });
  t = 500; assert.equal(tr.track('k', 1.9).dir, 'up');
  t = 2000; assert.equal(tr.track('k', 1.9).dir, null);
  t = 2100; assert.equal(tr.track('k', 1.7).dir, 'down');
});
