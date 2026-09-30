import test from 'node:test';
import assert from 'node:assert/strict';
import { startApi, postJson } from './helpers/api-harness.js';
import { setLogSink } from '../src/logger.js';

setLogSink(() => {});

test('POST /api/ui/odds-watch accepts the list the extension sends and validates it', async () => {
  const api = await startApi();
  try {
    const ok = await postJson(api.base, '/api/ui/odds-watch', { ids: ['101', 102] });
    assert.equal(ok.status, 200);
    assert.deepEqual(await ok.json(), { ok: true, accepted: 2, ttlMs: 45000, warming: false });
    let health = await (await fetch(api.base + '/health')).json();
    assert.deepEqual(health.oddsWatch, { clients: 1, ids: 2, warming: false });

    const clear = await postJson(api.base, '/api/ui/odds-watch', { ids: [] });
    assert.equal(clear.status, 200);
    health = await (await fetch(api.base + '/health')).json();
    assert.equal(health.oddsWatch.clients, 0);

    for (const body of [{ ids: Array.from({ length: 9 }, (_, i) => String(i)) }, { ids: 'x' }, {}, { ids: [{}] }, { ids: ['x'.repeat(301)] }]) {
      const res = await postJson(api.base, '/api/ui/odds-watch', body);
      assert.equal(res.status, 400, JSON.stringify(body).slice(0, 40));
    }
  } finally { await api.close(); }
});
