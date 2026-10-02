import test from 'node:test';
import assert from 'node:assert/strict';
import { englishize, canonicalCategory, resolveEvents } from '../src/entity-resolver.js';

// englishize/aliasNorm (and LeagueModel.norm) are memoized for speed; results must stay exactly the same.
test('memoized normalizers return identical results on repeated calls and after the cache is recycled', () => {
  const samples = ['Нави', 'Команда Спирит', 'Virtus.pro', 'MIBR Female (zh)', 'Тотал по картам Чет/Нечет', '', 'Counter-Strike 2', 'Дота 2'];
  const first = samples.map((s) => englishize(s));
  for (let i = 0; i < 25000; i++) englishize('filler ' + i);   // more distinct keys than the cache keeps
  assert.deepEqual(samples.map((s) => englishize(s)), first);
  assert.deepEqual(samples.map((s) => englishize(s)), first);
  assert.equal(canonicalCategory('Дота 2'), canonicalCategory('Дота 2'));
});

test('resolving the same fixtures twice gives the same logical events (memoization does not leak state)', () => {
  const rows = [
    { id: 'astek-1', source: 'astek', sourceEventId: '1', category: 'Counter Strike 2', league: 'CCT Europe', team1: 'Natus Vincere', team2: 'Team Spirit', startAt: 1790900000000, firstSeenAt: 1790890000000 },
    { id: 'fonbet-2', source: 'fonbet', sourceEventId: '2', category: 'CS2', league: 'CCT Europe', team1: 'NAVI', team2: 'Spirit', startAt: 1790900000000, firstSeenAt: 1790891000000 },
    { id: 'pinnacle-3', source: 'pinnacle', sourceEventId: '3', category: 'Dota 2', league: 'DreamLeague', team1: 'Tundra', team2: 'Falcons', startAt: 1790905000000, firstSeenAt: 1790892000000 }
  ];
  const a = JSON.stringify(resolveEvents(rows, { mode: 'prematch' })), b = JSON.stringify(resolveEvents(rows, { mode: 'prematch' }));
  assert.equal(a, b);
});
