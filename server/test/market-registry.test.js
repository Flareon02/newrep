// Canonical market registry (semantics v2) on REAL provider markets from the production journal
// (test/fixtures/market-semantics-real.json, extracted read-only on 2026-10-06), plus targeted regressions.
// Expectations are written by hand from the provider's structured ids; the registry must never guess.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describeMarket, canonicalMarket, splitLegacyMarket, orientOutcome, canonicalId, unknownMarkets, resetUnknown, MARKET_SEMANTICS_VERSION } from '../src/market-registry.js';
import { enrichEventMarketSemantics } from '../src/market-semantics.js';
import { fonbetOdds } from '../src/book-odds.js';

const fixtures = new Map(JSON.parse(readFileSync(new URL('./fixtures/market-semantics-real.json', import.meta.url), 'utf8')).map((f) => [f.name, f]));
const d = (name, extra = {}) => { const f = fixtures.get(name); assert.ok(f, name); return describeMarket(f.provider, f.market, { sport: f.sport, team1: f.team1, team2: f.team2, ...extra }); };
const outs = (x) => x.outcomes.map((o) => o.key);

const EXPECT = {
  'astek-G1-match-winner': ['match_winner', ['home', 'away']],
  'fonbet-921-923-match-winner': ['match_winner', ['home', 'away']],
  'fonbet-921-923-map3-winner': ['map_winner|map=3|ot=included', ['home', 'away']],
  'fonbet-910-912-map3-handicap': ['round_handicap|map=3|line=-3.5|ot=unspecified', ['home', 'away']],
  'fonbet-1727-1728-map3-total': ['round_total|map=3|line=21.5|ot=unspecified', ['over', 'under']],
  'fonbet-930-931-map3-total': ['round_total|map=3|line=22.5|ot=unspecified', ['over', 'under']],
  'astek-G2438-map-handicap-dota': ['map_handicap|line=+1.5', ['home', 'away']],
  'astek-G2436-map-total-dota': ['map_total|line=2.5', ['over', 'under']],
  'ggbet-17-map-handicap': ['map_handicap|line=+1.5', ['home', 'away']],
  'ggbet-14-map-total': ['map_total|line=2.5', ['over', 'under']],
  'ggbet-300-map1-round-total': ['round_total|map=1|line=22.5|ot=unspecified', ['over', 'under']],
  'ggbet-50-map2-winner-lol': ['map_winner|map=2', ['home', 'away']],
  'fonbet-moneyline-map2-dota': ['map_winner|map=2', ['home', 'away']],
  'ggbet-13-round-winner': ['round_winner|map=1|round=14', ['home', 'away']],
  'fonbet-1696-1697-match-total': ['round_total|line=12.5|ot=unspecified', ['over', 'under']],
  'fonbet-3262-3263-map-handicap': ['map_handicap|line=-1.5', ['home', 'away']],
  'fonbet-3274-3275-map-total': ['map_total|line=2.5', ['over', 'under']],
  'ggbet-349-correct-map-score': ['correct_map_score', ['score:2-0', 'score:2-1', 'score:0-2', 'score:1-2']],
  'astek-G15-match-team-total-home': ['team_total|side=home|line=25.5|unit=unspecified', ['over', 'under']],
  'astek-G1-map2-winner': ['map_winner|map=2|ot=included', ['home', 'away']],
  'astek-G403-round-winner': ['round_winner|map=2|round=17', ['home', 'away']],
  'astek-G17-map2-total': ['round_total|map=2|line=20.5|ot=unspecified', ['over', 'under']],
  'astek-G2-map2-handicap': ['round_handicap|map=2|line=-3.5|ot=unspecified', ['home', 'away']],
  'astek-G2-match-handicap': ['handicap|line=+2.5|unit=unspecified', ['home', 'away']],
  'astek-G2434-race-to-8': ['race_to_rounds|map=2|target=8', ['home', 'away']],
  'astek-G15-map2-team-total-home': ['team_round_total|map=2|side=home|line=10.5|ot=unspecified', ['over', 'under']],
  'astek-G62-map2-team-total-away': ['team_round_total|map=2|side=away|line=10.5|ot=unspecified', ['over', 'under']],
  'astek-G2874-match-round-handicap': ['round_handicap|line=-10.5|ot=unspecified', ['home', 'away']],
  'astek-G1136-match-round-total': ['round_total|line=42.5|ot=unspecified', ['over', 'under']],
  'pinnacle-moneyline-match': ['match_winner', ['home', 'away']],
  'pinnacle-moneyline-map1': ['map_winner|map=1|ot=included', ['home', 'away']],
  'pinnacle-team-total-map1': ['team_round_total|map=1|side=home|line=11.5|ot=included', ['over', 'under']],
  'pinnacle-spread-map1': ['round_handicap|map=1|line=+2.5|ot=included', ['home', 'away']],
  'pinnacle-total-map1': ['round_total|map=1|line=21.5|ot=included', ['over', 'under']],
  'fonbet-unknown-1731-single': ['round_total|line=50.5|ot=unspecified', ['under']],
  'ggbet-7-map2-winner-ot': ['map_winner|map=2|ot=included', ['home', 'away']],
  'ggbet-8-race-to-13': ['race_to_rounds|map=1|target=13', ['home', 'away']],
  'ggbet-10-map1-round-handicap': ['round_handicap|map=1|line=-7.5|ot=included', ['home', 'away']],
  'ggbet-293-pistol-round-2': ['pistol_round_winner|map=1|round=2', ['home', 'away']],
  'ggbet-21-map3-1x2-no-ot': ['map_1x2|map=3|ot=excluded', ['home', 'draw', 'away']],
  'ggbet-1592-winning-margin': ['winning_margin|map=1|ot=included|variant=2-4', ['home', 'away']],
  'ggbet-1564-team-round-total-home': ['team_round_total|map=1|side=home|line=11.5|ot=included', ['over', 'under']],
  'ggbet-103-match-round-handicap': ['round_handicap|line=-4.5|ot=included', ['home', 'away']],
  'ggbet-194-match-round-total': ['round_total|line=62.5|ot=included', ['over', 'under']],
  'ggbet-407-match-team-round-total-home': ['team_round_total|side=home|line=34.5|ot=included', ['over', 'under']],
  'ggbet-1590-asian-handicap': ['asian_round_handicap|map=3|line=-1.75|ot=included', ['home', 'away']],
  'ggbet-929-round-total-3way': ['round_total_3way|map=3|line=22|ot=unspecified', ['over', 'exact', 'under']],
  'ggbet-1591-round-handicap-3way': ['round_handicap_3way|map=3|line=-3|ot=included', ['home', 'exact', 'away']],
  'ggbet-4-round-parity': ['round_parity|map=3|ot=included', ['odd', 'even']],
};
const UNKNOWN = ['pinnacle-spread-match-no-bestof', 'astek-G10558-asymmetric', 'fonbet-unknown-3266', 'astek-G7603-winning-margin-unknown', 'fonbet-legacy-mixed-handicap-map3', 'fonbet-legacy-mixed-handicap-match'];

test('real provider markets map to the expected canonical identity and outcomes', () => {
  for (const [name, [id, outcomes]] of Object.entries(EXPECT)) {
    const x = d(name);
    assert.equal(x.unknown, false, name + ' must be known');
    assert.equal(x.id, id, name);
    assert.deepEqual(outs(x), outcomes, name + ' outcomes');
    assert.equal(x.v, MARKET_SEMANTICS_VERSION);
    assert.ok(x.rule, name + ' records the mapping rule');
  }
});

test('markets without proven semantics stay unknown with raw identity (never a winner)', () => {
  resetUnknown();
  for (const name of UNKNOWN) {
    const x = d(name);
    assert.equal(x.unknown, true, name);
    assert.equal(x.family, 'unknown');
    assert.ok(x.raw, name + ' keeps raw');
    assert.ok(x.outcomes.every((o) => o === null), name);
  }
  assert.ok(unknownMarkets().length >= UNKNOWN.length - 1, 'unknown markets are logged for classification');
  for (const row of unknownMarkets()) assert.ok(row.examples.length >= 1 && row.provider);
});

test('same bet from different bookmakers gets the same identity; different bets never do', () => {
  assert.equal(d('astek-G2438-map-handicap-dota').id, d('ggbet-17-map-handicap').id, 'Dota map handicap +1.5 (Astek = GGBET)');
  assert.equal(d('astek-G2436-map-total-dota').id, d('ggbet-14-map-total').id);
  assert.equal(d('ggbet-50-map2-winner-lol').id, d('fonbet-moneyline-map2-dota').id, 'MOBA map 2 winner');
  assert.equal(d('pinnacle-moneyline-map1').id, canonicalId('map_winner', { map: 1, ot: 'included' }));
  assert.equal(d('ggbet-7-map2-winner-ot').id, d('astek-G1-map2-winner').id, 'CS map 2 winner: GGBET incl. OT = Astek two-way');
  // overtime: included ≠ excluded ≠ unspecified
  assert.notEqual(d('ggbet-7-map2-winner-ot').family, d('ggbet-21-map3-1x2-no-ot').family);
  assert.notEqual(canonicalId('round_total', { map: 1, line: 21.5, ot: 'included' }), canonicalId('round_total', { map: 1, line: 21.5, ot: 'unspecified' }));
});

test('identity separates every parameter that changes the bet', () => {
  const ids = [
    ['round_total', { map: 1, line: 26.5, ot: 'included' }], ['round_total', { map: 1, line: 27.5, ot: 'included' }],
    ['round_handicap', { map: 1, line: -1.5, ot: 'included' }], ['round_handicap', { map: 1, line: 1.5, ot: 'included' }],
    ['round_handicap', { map: 2, line: -1.5, ot: 'included' }], ['round_winner', { map: 1, round: 5 }], ['round_winner', { map: 1, round: 10 }],
    ['team_round_total', { map: 1, side: 'home', line: 11.5, ot: 'included' }], ['team_round_total', { map: 1, side: 'away', line: 11.5, ot: 'included' }],
    ['race_to_rounds', { map: 1, target: 5 }], ['race_to_rounds', { map: 1, target: 10 }],
    ['map_winner', { map: 1, ot: 'included' }], ['map_1x2', { map: 1, ot: 'excluded' }],
  ].map(([f, p]) => canonicalId(f, p));
  assert.equal(new Set(ids).size, ids.length, ids.join('\n'));
  assert.equal(canonicalId('round_handicap', { map: 1, line: 1.5 }), 'round_handicap|map=1|line=+1.5');
  assert.equal(canonicalId('round_handicap', { map: 1, line: -1.5 }), 'round_handicap|map=1|line=-1.5');
});

test('GGBET typeId 8 + roundnr is race-to-rounds with the target, never map winner', () => {
  const m = { rawType: 8, rawTitle: 'Map 1 - Winner', specifiers: { mapnr: '1', roundnr: '10' }, prices: [{ outcomeId: '1', designation: 'home' }, { outcomeId: '2', designation: 'away' }] };
  const x = describeMarket('ggbet', m, { sport: 'Counter Strike 2' });
  assert.equal(x.family, 'race_to_rounds');
  assert.equal(x.params.target, '10');
  assert.equal(x.id, 'race_to_rounds|map=1|target=10');
});

test('an unknown market with two team outcomes is NOT turned into a winner', () => {
  const two = [{ outcomeId: '1', designation: 'home', label: 'A' }, { outcomeId: '2', designation: 'away', label: 'B' }];
  assert.equal(describeMarket('ggbet', { rawType: 999999, rawTitle: 'Match winner', prices: two }).family, 'unknown');
  assert.equal(describeMarket('databet', { rawType: 424242, rawTitle: 'Winner', prices: two }).family, 'unknown');
  assert.equal(describeMarket('astek', { rawGroup: 99999, period: 0, prices: [{ rawType: 1, points: null }, { rawType: 3, points: null }] }).family, 'unknown', 'Astek T1/T3 under an unknown group');
  assert.equal(describeMarket('fonbet', { period: 0, prices: [{ rawType: 3265, points: '-1.5' }, { rawType: 3266, points: '+1.5' }] }).family, 'unknown', 'Fonbet opposite points ≠ handicap');
  assert.equal(describeMarket('pinnacle', { type: 'special', period: 0, prices: [{ designation: 'home' }, { designation: 'away' }] }, {}).family, 'unknown');
  // a positional GGBET designation alone never decides an outcome
  const x = describeMarket('ggbet', { rawType: 7, specifiers: { mapnr: '1' }, prices: [{ designation: 'home', designationSource: 'position' }, { designation: 'away', designationSource: 'position' }] }, { sport: 'Counter Strike 2' });
  assert.deepEqual(x.outcomes.map((o) => o.key), [null, null]);
});

test('legacy Fonbet journal rows that mixed -2.5 and +2.5 are split into separate lines', () => {
  const f = fixtures.get('fonbet-legacy-mixed-handicap-map3');
  const parts = splitLegacyMarket('fonbet', f.market).map((m) => describeMarket('fonbet', m, { sport: f.sport }));
  assert.deepEqual(parts.map((x) => x.id).sort(), ['round_handicap|map=3|line=+2.5|ot=unspecified', 'round_handicap|map=3|line=-2.5|ot=unspecified']);
  for (const x of parts) assert.deepEqual(outs(x), ['home', 'away']);
});

test('Fonbet parser keys handicaps by the home line and never pairs unknown factors', () => {
  const payload = {
    events: [{ id: 1, team1: 'A', team2: 'B' }],
    customFactors: [{ e: 1, factors: [
      { f: 927, v: 1.8, pt: '-1.5' }, { f: 928, v: 2.0, pt: '+1.5' }, { f: 1569, v: 2.6, pt: '+1.5' }, { f: 1572, v: 1.5, pt: '-1.5' },
      { f: 3265, v: 1.9, pt: '-1.5' }, { f: 3266, v: 1.9, pt: '+1.5' }, { f: 1677, v: 1.7, pt: '+2.5' }, { f: 1678, v: 2.1, pt: '-2.5' },
    ] }],
  };
  const odds = fonbetOdds(payload, '1', 0);
  const hcp = odds.markets.filter((m) => m.type === 'handicap');
  const byKey = Object.fromEntries(hcp.map((m) => [m.key.split(':').slice(-1)[0], m.prices.map((p) => `${p.rawType}:${p.designation}`).sort()]));
  assert.deepEqual(byKey['-1.5'], ['927:home', '928:away']);
  assert.deepEqual(byKey['1.5'], ['1569:home', '1572:away']);
  assert.deepEqual(byKey['2.5'], ['1677:home', '1678:away'], '1677 is the home factor even with a positive line');
  const unknown = odds.markets.filter((m) => m.type === 'unknown').map((m) => m.prices.length);
  assert.deepEqual(unknown, [1, 1], 'factors 3265/3266 stay separate unknown markets');
});

test('event orientation: a reversed bookmaker gets swapped sides and mirrored lines', () => {
  const m = { rawType: 10, specifiers: { mapnr: '1', hcp: '-2.5' }, prices: [{ outcomeId: '1' }, { outcomeId: '2' }] };
  const straight = describeMarket('ggbet', m, { sport: 'Counter Strike 2' });
  const reversed = describeMarket('ggbet', m, { sport: 'Counter Strike 2', reversed: true });
  assert.equal(straight.eventKey, 'round_handicap|map=1|line=-2.5|ot=included');
  assert.equal(reversed.eventKey, 'round_handicap|map=1|line=+2.5|ot=included');
  assert.deepEqual(reversed.outcomes.map((o) => o.eventKey), ['away', 'home']);
  assert.equal(reversed.id, straight.id, 'provider identity is unchanged');
  assert.equal(orientOutcome('score:2-1'), 'score:1-2');
  assert.equal(orientOutcome('home+odd'), 'away+odd');
  const tt = describeMarket('ggbet', { rawType: 1564, specifiers: { mapnr: '1', total: '11.5' }, prices: [{ outcomeId: '1' }, { outcomeId: '2' }] }, { reversed: true });
  assert.equal(tt.eventKey, 'team_round_total|map=1|side=away|line=11.5|ot=included');
});

test('enrichEventMarketSemantics canonicalizes every bookmaker and keeps raw + v1 fields', () => {
  const event = {
    id: 'e', team1: 'Alpha', team2: 'Beta', category: 'Counter Strike 2',
    sourceRefs: [
      { source: 'pinnacle', category: 'Counter Strike 2', bestOf: 3, odds: { team1: 'Alpha', team2: 'Beta', markets: [{ key: 's;1;s;2.5', type: 'spread', period: 1, prices: [{ designation: 'home', points: 2.5, decimal: 1.9 }, { designation: 'away', points: -2.5, decimal: 1.9 }] }] } },
      { source: 'ggbet', category: 'Counter Strike 2', scoreReversed: true, odds: { team1: 'Beta', team2: 'Alpha', markets: [{ key: 'g', rawType: 10, rawTitle: 'Map 1 - Round handicap (incl. overtime)', specifiers: { mapnr: '1', hcp: '-2.5' }, prices: [{ outcomeId: '1', decimal: 1.8 }, { outcomeId: '2', decimal: 2 }] }] } },
    ],
  };
  const out = enrichEventMarketSemantics(event);
  const [p, g] = out.sourceRefs.map((r) => r.odds.markets[0].canonical);
  assert.equal(p.eventKey, g.eventKey, 'Pinnacle Alpha +2.5 = GGBET (reversed) Beta -2.5');
  assert.equal(g.outcomes[0].eventKey, 'away');
  assert.equal(p.family, 'round-handicap', 'v1 family kept for old clients');
  assert.equal(g.raw.title, 'Map 1 - Round handicap (incl. overtime)');
  assert.equal(event.sourceRefs[0].odds.markets[0].canonical, undefined, 'input is not mutated');
});

test('canonicalMarket v1 compatibility fields', () => {
  const c = canonicalMarket('ggbet', { rawType: 21, rawTitle: '1x2', specifiers: { mapnr: '1' }, prices: [{ outcomeId: '1' }, { outcomeId: '2' }, { outcomeId: '3' }] }, {});
  assert.equal(c.overtime, 'exclude');
  assert.equal(c.scope, 'map');
  assert.equal(c.map, 1);
  assert.equal(c.v, MARKET_SEMANTICS_VERSION);
});
