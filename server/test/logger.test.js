import test from 'node:test';
import assert from 'node:assert/strict';
import { log, redact, setLogLevel, setLogSink } from '../src/logger.js';

function capture(level = 'info') {
  const lines = [];
  setLogSink((lvl, line) => lines.push({ lvl, line }));
  setLogLevel(level);
  return lines;
}

test('default level hides debug and keeps info/warn/error', () => {
  const lines = capture('info');
  log.debug('[live] unchanged');
  log.info('[api] listening');
  log.warn('[live] HTTP 403');
  log.error('[fatal] boom');
  assert.deepEqual(lines.map(l => l.lvl), ['info', 'warn', 'error']);
});

test('debug output appears only when explicitly enabled', () => {
  let lines = capture('debug');
  log.debug('[live] 12 events');
  assert.equal(lines.length, 1);
  lines = capture('warn');
  log.info('[api] listening');
  log.debug('[live] 12 events');
  assert.equal(lines.length, 0);
});

test('secrets never reach the log line', () => {
  const lines = capture('info');
  log.info('request', { token: 'super-secret-value', apiKey: 'k-12345678' });
  log.info('Authorization: Bearer abcdefghijklmnop');
  log.error('failed password=hunter2 cookie=sid123');
  const all = lines.map(l => l.line).join('\n');
  for (const secret of ['super-secret-value', 'k-12345678', 'abcdefghijklmnop', 'hunter2', 'sid123']) assert.ok(!all.includes(secret), secret);
  assert.match(all, /\[redacted\]/);
});

test('identical repeated lines are collapsed and counted', () => {
  const lines = capture('info');
  for (let i = 0; i < 50; i++) log.warn('[live] HTTP 403');
  assert.equal(lines.length, 1);
});

test('very long lines are truncated', () => {
  const lines = capture('info');
  log.info('x'.repeat(10000));
  assert.ok(lines[0].line.length < 4200);
  assert.match(lines[0].line, /truncated/);
});

test('redact handles plain text', () => {
  assert.equal(redact('no secrets here'), 'no secrets here');
});
