import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const T = createRequire(import.meta.url)('../user-text.js');

test('users never see technical reasons; plain server messages pass through', () => {
  const technical = ['Czech proxy disabled (CZECH_PROXY_ENABLED is not 1)', 'GGBET bootstrap HTTP 407', 'connect ECONNREFUSED 10.0.0.5:12323', 'GGBET: неожиданный origin (https://ggbets.co)', 'fetch failed', 'invalid token for user'];
  for (const message of technical) {
    const shown = T.error(new Error(message));
    assert.ok(!/proxy|CZECH|HTTP|ECONN|10\.0\.0\.5|https|token/i.test(shown), `${message} -> ${shown}`);
  }
  assert.equal(T.error(new Error('fetch failed')), 'Сервер недоступен');
  assert.equal(T.error(Object.assign(new Error('x'), { name: 'TimeoutError' })), 'Сервер не ответил вовремя');
  assert.equal(T.error(Object.assign(new Error('Матч уже не доступен'), { status: 404 })), 'Матч уже не доступен');
  assert.equal(T.error(Object.assign(new Error('nope'), { status: 404 })), 'Данные не найдены');
  assert.equal(T.error(Object.assign(new Error('x'), { status: 401 })), 'Нужен ключ доступа — укажите его в настройках подключения');
  assert.equal(T.error(Object.assign(new Error('x'), { status: 403 })), 'Нет доступа к этому разделу');
  assert.equal(T.error(Object.assign(new Error('Upstream 502 at http://1.2.3.4:80'), { status: 502 })), 'Сервер временно недоступен');
});

test('administrators see the reason, sanitized (no credentials, tokens or addresses)', () => {
  const shown = T.error(new Error('Czech proxy http://user:secret@1.2.3.4:12323 rejected Bearer abcdef0123456789'), { admin: true });
  assert.ok(shown.includes('Czech proxy'));
  assert.ok(!shown.includes('secret') && !shown.includes('1.2.3.4') && !shown.includes('abcdef0123456789'), shown);
  assert.equal(T.sourceReason('GGBET bootstrap HTTP 407'), '');
  assert.equal(T.sourceReason('GGBET bootstrap HTTP 407', { admin: true }), 'GGBET bootstrap HTTP 407');
  assert.ok(!T.sanitize('token emu_' + 'a'.repeat(48)).includes('aaaa'));
});
