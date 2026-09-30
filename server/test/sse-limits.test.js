import test from 'node:test';
import assert from 'node:assert/strict';
import { startApi } from './helpers/api-harness.js';
import { safeWrite } from '../src/sse.js';
import { config } from '../src/config.js';
import { setLogSink } from '../src/logger.js';

setLogSink(() => {});

function fakeResponse(overrides = {}) {
  const written = [];
  return { written, writableEnded: false, destroyed: false, writableLength: 0, write(chunk) { written.push(chunk); return true; }, destroy() { this.destroyed = true; }, ...overrides };
}

test('safeWrite writes normally and skips finished responses', () => {
  const res = fakeResponse();
  assert.equal(safeWrite(res, 'a', 1000), true);
  assert.deepEqual(res.written, ['a']);
  const ended = fakeResponse({ writableEnded: true });
  assert.equal(safeWrite(ended, 'a', 1000), false);
  assert.deepEqual(ended.written, []);
});

test('safeWrite drops a client whose buffer exceeds the limit instead of growing RAM', () => {
  const res = fakeResponse({ writableLength: 5000 });
  assert.equal(safeWrite(res, 'event', 1000), false);
  assert.equal(res.destroyed, true);
  assert.deepEqual(res.written, []);
});

test('total SSE connection cap answers 429 with the unified error envelope', async () => {
  const previous = config.apiSseLimitTotal;
  config.apiSseLimitTotal = 2;
  const api = await startApi();
  const controllers = [];
  try {
    for (let i = 0; i < 2; i++) {
      const controller = new AbortController();
      controllers.push(controller);
      const res = await fetch(api.base + '/api/feed-stream?modes=results&thin=1', { signal: controller.signal });
      assert.equal(res.status, 200);
      await res.body.getReader().read(); // hello frame
    }
    const third = await fetch(api.base + '/api/feed-stream?modes=results&thin=1');
    assert.equal(third.status, 429);
    const body = await third.json();
    assert.equal(body.code, 'rate_limited');
    assert.equal(typeof body.error, 'string');
    const health = await (await fetch(api.base + '/health')).json();
    assert.equal(health.sse.open, 2);
    assert.equal(health.sse.limit, 2);
  } finally {
    for (const controller of controllers) controller.abort();
    config.apiSseLimitTotal = previous;
    await api.close();
  }
});
