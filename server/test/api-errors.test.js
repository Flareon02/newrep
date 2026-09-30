import test from 'node:test';
import assert from 'node:assert/strict';
import { startApi } from './helpers/api-harness.js';
import { publicMessage, normalizeErrorBody, errorCode } from '../src/http-errors.js';
import { setLogSink } from '../src/logger.js';

setLogSink(() => {});

test('every error response uses the unified envelope and keeps the legacy `error` string', async () => {
  const api = await startApi();
  try {
    const res = await fetch(api.base + '/api/nope');
    assert.equal(res.status, 404);
    const body = await res.json();
    assert.equal(body.ok, false);
    assert.equal(body.error, 'Not found');
    assert.equal(body.code, 'not_found');
    assert.match(body.requestId, /^[0-9a-f]{8}$/);
    assert.equal(res.headers.get('x-request-id'), body.requestId);

    const bad = await fetch(api.base + '/api/odds/history?source=evil&id=1');
    assert.equal(bad.status, 400);
    const badBody = await bad.json();
    assert.equal(badBody.code, 'bad_request');
    assert.equal(typeof badBody.error, 'string');
  } finally { await api.close(); }
});

test('internal JavaScript errors are not leaked to clients', async () => {
  const api = await startApi({ resultsService: { getRange: async () => { throw new TypeError("Cannot read properties of undefined (reading 'secretField') at /app/src/results.js:12:3"); } } });
  try {
    const res = await fetch(api.base + '/api/live/past?date=2026-01-01');
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.equal(body.error, 'Внутренняя ошибка сервера');
    assert.ok(!JSON.stringify(body).includes('secretField'));
    assert.ok(!JSON.stringify(body).includes('/app/'));
  } finally { await api.close(); }
});

test('user-facing validation messages pass through untouched', () => {
  assert.equal(publicMessage('Выберите две команды', 400).message, 'Выберите две команды');
  assert.equal(publicMessage('HTTP 403', 502).message, 'HTTP 403');
  assert.equal(publicMessage('fetch failed', 502).message, 'Источник данных временно недоступен');
  assert.equal(publicMessage('The operation was aborted due to timeout', 504).message, 'Превышено время ожидания');
  assert.equal(normalizeErrorBody({ matched: false, error: 'x' }, 404).body.matched, false);
  assert.equal(errorCode(413), 'payload_too_large');
});
