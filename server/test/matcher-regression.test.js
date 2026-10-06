// Matching regressions taken from the production feeds of 2026-10-06 (team spellings as each bookmaker sends them):
// merge the same fixture across bookmakers (aliases, reversed order), never merge different fixtures of the same teams.
import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveEvents } from '../src/entity-resolver.js';

const T = Date.parse('2026-10-06T15:00:00Z');
const ev = (source, id, team1, team2, league, startAt = T, category = 'Counter Strike 2') => ({ id: `${source}-${id}`, source, sourceEventId: String(id), provider: source, category, league, leagueId: `${source}-${league}`, team1, team2, startAt, marketKind: 'main' });
const groups = (events) => resolveEvents(events, { mode: 'prematch' }).map((e) => (e.sourceRefs || [e]).map((r) => `${r.source}:${r.sourceEventId}`).sort().join(','));

test('aliases of the same fixture are merged across bookmakers (1WIN / 1W Team / 1W, Spirit)', () => {
  const g = groups([ev('astek', 1, 'Team Spirit', '1WIN', 'CS 2. ESL Pro League'), ev('fonbet', 2, 'Team Spirit', '1W Team', 'Counter-Strike. ESL Pro League. Group stage. Bo3', T + 60000), ev('pinnacle', 3, 'Spirit', '1W', 'ESL Pro League', T)]);
  assert.ok(g.includes('astek:1,fonbet:2,pinnacle:3'), JSON.stringify(g));
});

test('reversed team order is merged and marked reversed', () => {
  const out = resolveEvents([ev('astek', 1, 'PARIVISION', 'G2 Esports', 'CS 2. ESL Pro League'), ev('fonbet', 2, 'G2 Esports', 'PARIVISION', 'Counter-Strike. ESL Pro League. Bo3')], { mode: 'prematch' });
  const merged = out.find((e) => (e.sourceRefs || []).length === 2);
  assert.ok(merged, 'merged');
  assert.equal(merged.sourceRefs.filter((r) => r.scoreReversed === true).length, 1, 'exactly one ref is oriented against the event');
});

test('the same teams 24 h apart are two fixtures (never merged)', () => {
  const g = groups([ev('astek', 1, 'NRG Esports', 'T1', 'Champions', T, 'Valorant'), ev('fonbet', 2, 'NRG', 'T1', 'Champions', T + 86400000, 'Valorant')]);
  assert.deepEqual(g.sort(), ['astek:1', 'fonbet:2']);
});

test('the same teams in different tournaments are different fixtures', () => {
  const g = groups([ev('astek', 1, 'LGD Gaming', 'Evolution Power', 'Douyu PengCheng Cup', T, 'CrossFire'), ev('fonbet', 2, 'LGD Gaming', 'Evolution Power', 'CrossFire Mobile League', T + 2 * 86400000, 'CrossFire')]);
  assert.deepEqual(g.sort(), ['astek:1', 'fonbet:2']);
});

test('one team in two simultaneous matches: each opponent stays its own fixture', () => {
  const g = groups([ev('astek', 1, 'Aurora', 'BB Team', 'Some Cup'), ev('fonbet', 2, 'Aurora', 'BB Team', 'Some Cup', T + 120000), ev('astek', 3, 'Aurora Academy', 'Nemiga', 'Other Cup'), ev('fonbet', 4, 'Aurora Academy', 'Nemiga', 'Other Cup', T + 60000)]);
  assert.ok(g.includes('astek:1,fonbet:2'), JSON.stringify(g));
  assert.ok(g.includes('astek:3,fonbet:4'), JSON.stringify(g));
  assert.ok(!g.some((x) => x.includes('astek:1') && x.includes('astek:3')));
});

test('one bookmaker never contributes two refs to one fixture', () => {
  const out = resolveEvents([ev('astek', 1, 'Shinden', 'G2 Esports', 'CS 2. CCT'), ev('astek', 2, 'Shinden', 'G2 Esports', 'CS 2. CCT', T + 30 * 60000), ev('fonbet', 3, 'ShindeN', 'G2 Esports', 'Counter-Strike. CCT. Bo3')], { mode: 'prematch' });
  for (const e of out) { const sources = (e.sourceRefs || [e]).map((r) => r.source); assert.equal(new Set(sources).size, sources.length, JSON.stringify(sources)); }
});
