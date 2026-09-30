import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { config } from '../src/config.js';
import { ScoreLog } from '../src/score-log.js';
import { scoreAppend, closeSqliteStorage } from '../src/sqlite-storage.js';

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'score-cache-'));
config.dataDir = tmp;
test.after(async () => { closeSqliteStorage(); await fs.rm(tmp, { recursive: true, force: true }); });

test('REPRO: reading many score histories must not grow the in-memory cache without bound', async () => {
  for (let i = 0; i < 400; i++) scoreAppend(`astek:${i}`, 1, { at: 1000 + i, scoreText: '1:0', team1: 'A', team2: 'B' });
  const log = new ScoreLog();
  for (let i = 0; i < 400; i++) await log.load(`astek:${i}`);
  assert.ok(log.cache.size <= 160, `cache holds ${log.cache.size} identities`);
  // The newest reads stay cached, and an evicted identity is simply read again from SQLite.
  assert.ok(log.cache.has('astek:399'));
  assert.equal((await log.load('astek:0')).entries.length, 1);
});
