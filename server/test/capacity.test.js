import test from 'node:test';
import assert from 'node:assert/strict';
import { historyCapacity, HISTORY_ROW_BYTES } from '../src/capacity.js';
import { startApi } from './helpers/api-harness.js';
import { setLogSink } from '../src/logger.js';

setLogSink(() => {});
const MIB = 1048576;

test('history capacity levels follow the share of the heap limit', () => {
  const heap = 320 * MIB;
  assert.equal(historyCapacity(1000, heap).level, 'ok');
  const half = Math.ceil((heap * 0.5) / HISTORY_ROW_BYTES);
  assert.equal(historyCapacity(half, heap).level, 'high');
  const most = Math.ceil((heap * 0.76) / HISTORY_ROW_BYTES);
  assert.equal(historyCapacity(most, heap).level, 'critical');
  assert.equal(historyCapacity(0, heap).estimatedMiB, 0);
});

test('/health reports history capacity', async () => {
  const api = await startApi();
  try {
    const health = await (await fetch(api.base + '/health')).json();
    assert.equal(health.runtime.history.rows, 0);
    assert.equal(health.runtime.history.level, 'ok');
    assert.ok(health.runtime.history.heapLimitMiB > 0);
  } finally { await api.close(); }
});
