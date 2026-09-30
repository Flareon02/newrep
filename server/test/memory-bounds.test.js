import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { config } from '../src/config.js';
import { StatisticsStore } from '../src/statistics-store.js';
import { HltvService } from '../src/hltv-service.js';

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'memory-bounds-'));
config.dataDir = tmp;
test.after(async () => { await fs.rm(tmp, { recursive: true, force: true }); });

test('REPRO: the statistics payload cache must stay bounded while matches keep arriving', async () => {
  const store = new StatisticsStore();
  await store.ready;
  const big = 'x'.repeat(20_000);
  for (let i = 0; i < 300; i++) {
    await store.record('hawk', { team1: 'A', team2: 'B', league: 'L', startAt: Date.now(), source: 'astek', id: 'astek-' + i, sourceEventId: String(i) },
      { matched: true, event: { id: 'm' + i, team1: 'A', team2: 'B', filler: big } });
    if (i % 25 === 0) await store.flush();
  }
  await store.flush();
  clearInterval(store.timer);
  assert.ok(store.cache.size <= 60, `${store.cache.size} payloads cached`);
  assert.equal(Object.keys(store.index).length, 300, 'every match is still indexed');
  const old = await store.get('stats-dota2-m0');
  assert.ok(old && old.event?.id === 'm0', 'an evicted payload is read back from disk');
});

test('REPRO: the HLTV search cache must not grow with every distinct query', async () => {
  const hltv = new HltvService({ read: async () => ({}), write: async () => {}, request: async () => { throw new Error('offline'); } });
  await hltv.ready;
  hltv.blockedUntil = Date.now() + 60_000;
  for (let i = 0; i < 2000; i++) await hltv.search('query number ' + i);
  assert.ok(hltv.searchCache.size <= 500, `${hltv.searchCache.size} cached queries`);
});
