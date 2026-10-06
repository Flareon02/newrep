import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { enrichEventMarketSemantics } from '../../server/src/market-semantics.js';
const require = createRequire(import.meta.url);
const MarketCompare = require('../market-compare.js');

// Real server semantics (market-registry v2) on one event with three bookmakers, GGBET in reversed team order.
const event = enrichEventMarketSemantics({
  id: 'e1', team1: 'Alpha', team2: 'Beta', category: 'Counter Strike 2',
  sourceRefs: [
    { source: 'astek', category: 'Counter Strike 2', odds: { team1: 'Alpha', team2: 'Beta', markets: [
      { key: 'a1', rawGroup: 1, semanticGroup: 1, period: 1, title: 'Победитель', status: 'open', prices: [{ rawType: 1, label: '^1^', decimal: 1.83 }, { rawType: 3, label: '^2^', decimal: 1.94 }] },
      { key: 'a2', rawGroup: 7603, period: 1, title: 'Победа с преимуществом', status: 'open', prices: [{ rawType: 6476, label: 'П1 в 11 и более', decimal: 4.1 }] },
    ] } },
    { source: 'fonbet', category: 'Counter Strike 2', odds: { team1: 'Alpha', team2: 'Beta', markets: [
      { key: 'f1', type: 'moneyline', period: 1, status: 'open', prices: [{ rawType: 921, designation: 'home', decimal: 1.87 }, { rawType: 923, designation: 'away', decimal: 1.91 }] },
    ] } },
    { source: 'ggbet', category: 'Counter Strike 2', scoreReversed: true, odds: { team1: 'Beta', team2: 'Alpha', markets: [
      { key: 'g7', rawType: 7, rawTitle: 'Map 1 - Winner (incl. overtime)', specifiers: { mapnr: '1' }, status: 'open', prices: [{ outcomeId: '1', rawLabel: 'Beta', decimal: 1.92 }, { outcomeId: '2', rawLabel: 'Alpha', decimal: 1.84 }] },
      { key: 'g10', rawType: 10, rawTitle: 'Map 1 - Round handicap', specifiers: { mapnr: '1', hcp: '1.5' }, status: 'suspended', prices: [{ outcomeId: '1', decimal: null }, { outcomeId: '2', decimal: null }] },
    ] } },
  ],
});

test('one row per canonical bet; outcomes oriented to the event; best price per outcome', () => {
  const model = MarketCompare.build(event.sourceRefs);
  const winner = model.groups.find((g) => g.family === 'map_winner');
  assert.ok(winner, 'map winner grouped');
  assert.deepEqual(Object.keys(winner.books).sort(), ['astek', 'fonbet', 'ggbet']);
  assert.deepEqual(winner.outcomes, ['home', 'away']);
  assert.equal(winner.books.ggbet.prices.home.value, 1.84, 'GGBET listed Alpha second; oriented to the event it is home');
  assert.equal(winner.books.ggbet.prices.away.value, 1.92);
  assert.equal(winner.best.home, 1.87);
  assert.equal(winner.best.away, 1.94);
  assert.equal(winner.title, 'Карта 1 — победитель (с овертаймом)');
  assert.match(winner.books.ggbet.raw.title, /Map 1 - Winner/, 'the bookmaker name stays for the tooltip');
  const hcp = model.groups.find((g) => g.family === 'round_handicap');
  assert.equal(hcp.key, 'round_handicap|map=1|line=-1.5|ot=included', 'GGBET Beta +1.5 is Alpha -1.5 for the event');
  assert.equal(hcp.books.ggbet.status, 'suspended');
  assert.equal(hcp.openCount, 0);
});

test('unclassified markets are listed per bookmaker, never merged into a known row', () => {
  const model = MarketCompare.build(event.sourceRefs);
  assert.equal(model.unknown.length, 1);
  assert.equal(model.unknown[0].source, 'astek');
  assert.ok(!model.groups.some((g) => g.books.astek && g.family !== 'map_winner'));
});

test('labels and ordering', () => {
  const g = { family: 'round_handicap', params: { line: -1.5 } };
  assert.equal(MarketCompare.outcomeLabel('home', g, { team1: 'A', team2: 'B' }), 'A (-1.5)');
  assert.equal(MarketCompare.outcomeLabel('away', g, { team1: 'A', team2: 'B' }), 'B (+1.5)');
  assert.equal(MarketCompare.outcomeLabel('over', { params: { line: 26.5 } }), 'Больше 26.5');
  assert.equal(MarketCompare.outcomeLabel('score:2-1', {}), '2:1');
  assert.equal(MarketCompare.outcomeLabel('id:7', {}), null, 'opaque outcome: the bookmaker label is used');
  assert.ok(MarketCompare.outcomeRank('home') < MarketCompare.outcomeRank('draw') && MarketCompare.outcomeRank('draw') < MarketCompare.outcomeRank('away'));
});

test('an older server without semantics v2 keeps the per-bookmaker view (build returns null)', () => {
  assert.equal(MarketCompare.build([{ source: 'astek', odds: { markets: [{ key: 'x', prices: [] }] } }]), null);
});

test('timeline state (compact) converts to the same model', () => {
  const model = MarketCompare.fromState({ markets: [{ key: 'match_winner', family: 'match_winner', params: {}, title: 'Победитель матча', category: 'winners', books: { astek: { status: 'open', at: 1, o: { home: 1.9, away: 1.9 }, name: 'Победитель' }, fonbet: { status: 'suspended', at: 2, o: { home: null, away: null } } } }], unknown: [] });
  assert.equal(model.groups[0].best.home, 1.9);
  assert.equal(model.groups[0].openCount, 1);
  assert.deepEqual(model.books, ['astek', 'fonbet']);
});
