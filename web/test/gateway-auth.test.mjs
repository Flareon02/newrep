// Access Key gate, persistent sessions and "one Access Key = one active session" (gateway, against a fake server).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { startStack, readSse, ORIGIN } from './helpers/gateway.mjs';
import { ALL_USER_CAPS } from './helpers/fake-backend.mjs';
import { DatabaseSync } from 'node:sqlite';

const activeCount = (stack, keyId) => stack.gateway.db.prepare('SELECT COUNT(*) AS n FROM sessions WHERE access_key_id = ? AND revoked_at IS NULL').get(keyId).n;

test('AUTH: invalid, disabled and expired keys are rejected with one generic message; a valid key is accepted', async () => {
  const stack = await startStack();
  try {
    const ok = stack.backend.addUser({ name: 'Customer' });
    const disabled = stack.backend.addUser({ name: 'Disabled', disabled: true });
    const expiring = stack.backend.addUser({ name: 'Expiring' });
    await stack.gateway.keys.sync();
    stack.gateway.keys.setExpiry(expiring.id, Date.now() - 1000);
    const a = stack.profile('A');
    const results = [await a.login('emu_' + 'f'.repeat(48)), await a.login(disabled.token), await a.login(expiring.token), await a.login(''), await a.login(stack.backend.masterToken)];
    for (const r of results) {
      assert.equal(r.status, 401);
      assert.deepEqual(r.data, { ok: false, error: 'Неверный или просроченный ключ доступа', code: 'invalid_key' });
    }
    assert.equal(a.cookie, '');
    const good = await a.login(ok.token);
    assert.equal(good.status, 200);
    assert.equal(good.data.ok, true);
    assert.ok(a.cookie.startsWith('eds_'), 'web client receives the session as a cookie');
    assert.equal(good.data.token, undefined, 'web clients never receive the token in the body');
    const set = good.headers.getSetCookie()[0];
    assert.match(set, /HttpOnly/); assert.match(set, /SameSite=Lax/); assert.match(set, /Path=\//);
  } finally { await stack.stop(); }
});

test('AUTH: the master API token is never accepted as an Access Key, and the key is never stored or logged', async () => {
  const stack = await startStack();
  try {
    const u = stack.backend.addUser({ name: 'Customer' });
    const a = stack.profile('A');
    assert.equal((await a.login(stack.backend.masterToken)).status, 401);
    assert.equal((await a.login(u.token)).status, 200);
    await a.json('/api/ui/live');
    const dbFiles = fs.readdirSync(stack.dir).filter((f) => f.startsWith('gateway.sqlite3'));
    const raw = dbFiles.map((f) => fs.readFileSync(`${stack.dir}/${f}`).toString('latin1')).join('');
    assert.ok(!raw.includes(u.token), 'raw Access Key absent from the database files');
    assert.ok(!raw.includes(a.cookie), 'raw session token absent from the database files');
    assert.ok(!raw.includes(stack.backend.masterToken), 'API token absent from the database files');
    const logs = stack.logs.join('\n');
    for (const secret of [u.token, a.cookie, stack.backend.masterToken]) assert.ok(!logs.includes(secret), 'secret absent from logs');
  } finally { await stack.stop(); }
});

test('PERSISTENCE: reload and browser restart keep the session; a valid cookie opens the app without a key', async () => {
  const stack = await startStack();
  try {
    const u = stack.backend.addUser({ name: 'Customer' });
    const a = stack.profile('A');
    await a.login(u.token);
    const cookie = a.cookie;
    for (let i = 0; i < 3; i++) {
      const s = await a.json('/auth/session');
      assert.equal(s.status, 200); assert.equal(s.data.authenticated, true);
    }
    // Browser restart: a new process with the same persistent profile (same cookie jar).
    const restarted = stack.profile('A after restart'); restarted.cookie = cookie;
    const s = await restarted.json('/auth/session');
    assert.equal(s.data.authenticated, true);
    assert.equal(s.data.session.key.label, 'Customer');
    assert.equal((await restarted.json('/api/ui/live')).status, 200);
    // The cookie lives until the absolute session limit, not just until the browser closes.
    const set = (await stack.profile('B').fetch('/auth/verify', { method: 'POST', body: { key: u.token } })).headers.getSetCookie()[0];
    const maxAge = Number(/Max-Age=(\d+)/.exec(set)[1]);
    assert.ok(maxAge > 29 * 86400, `persistent cookie (Max-Age ${maxAge})`);
  } finally { await stack.stop(); }
});

test('PERSISTENCE: a different browser profile without a session sees the gate', async () => {
  const stack = await startStack();
  try {
    const u = stack.backend.addUser({ name: 'Customer' });
    await stack.profile('A').login(u.token);
    const b = stack.profile('B');
    const s = await b.json('/auth/session');
    assert.equal(s.status, 401); assert.equal(s.data.authenticated, false); assert.equal(s.data.reason, 'none');
    assert.equal((await b.json('/api/ui/live')).status, 401);
  } finally { await stack.stop(); }
});

test('ONE KEY = ONE PROFILE: profile B signing in with the same key ends A at once (API, session, stream)', async () => {
  const stack = await startStack();
  try {
    const u = stack.backend.addUser({ name: 'Customer' });
    const a = stack.profile('A'), b = stack.profile('B');
    await a.login(u.token);
    const stream = await a.fetch('/api/feed-stream?modes=live,prematch&thin=1&provider=ggbet', { headers: { accept: 'text/event-stream' } });
    assert.equal(stream.status, 200);
    const first = await readSse(stream, { until: (t) => t.includes('event: hello') });
    assert.match(first.text, /event: hello/);
    assert.equal((await b.login(u.token)).status, 200);
    // A's open stream receives the reason and is closed by the gateway.
    const tail = await readSse(stream, { timeoutMs: 3000 }), rest = tail.text;
    assert.ok(tail.ended, 'old stream closed');
    assert.match(rest, /event: session\ndata: \{"state":"ended","reason":"replaced"\}/);
    const api = await a.json('/api/ui/live');
    assert.equal(api.status, 401); assert.equal(api.data.code, 'session_replaced');
    const sa = await a.json('/auth/session');
    assert.equal(sa.data.reason, 'replaced');
    const again = await a.fetch('/api/feed-stream?modes=live', { headers: { accept: 'text/event-stream' } });
    assert.equal(again.status, 401, 'a new stream is refused');
    assert.equal((await b.json('/api/ui/live')).status, 200, 'B stays valid');
    assert.equal(activeCount(stack, u.id), 1);
  } finally { await stack.stop(); }
});

test('ONE KEY = ONE PROFILE: web and desktop app replace each other in both directions', async () => {
  const stack = await startStack();
  try {
    const u = stack.backend.addUser({ name: 'Customer' });
    const web = stack.profile('web'), app = stack.profile('tauri');
    await web.login(u.token);
    const t = await app.login(u.token, 'tauri', 'http://tauri.localhost');
    assert.equal(t.status, 200);
    assert.ok(t.data.token.startsWith('eds_'), 'desktop app receives its token once in the body');
    assert.equal(app.cookie, '', 'desktop app gets no cookie');
    app.bearer = t.data.token;
    assert.equal((await web.json('/api/ui/live')).status, 401);
    const appApi = await app.fetch('/api/ui/live', { origin: 'http://tauri.localhost' });
    assert.equal(appApi.status, 200);
    assert.equal(appApi.headers.get('access-control-allow-origin'), 'http://tauri.localhost');
    await web.login(u.token);
    assert.equal((await app.json('/api/ui/live')).status, 401);
    assert.equal((await web.json('/api/ui/live')).status, 200);
    const sessions = stack.gateway.db.prepare('SELECT client_type, revoked_at, revoke_reason FROM sessions WHERE access_key_id = ? ORDER BY created_at').all(u.id);
    assert.deepEqual(sessions.map((s) => [s.client_type, s.revoke_reason]), [['web', 'replaced'], ['tauri', 'replaced'], ['web', null]]);
  } finally { await stack.stop(); }
});

test('RACE: concurrent sign-ins with one key leave exactly one active session', async () => {
  const stack = await startStack();
  try {
    const u = stack.backend.addUser({ name: 'Customer' });
    const profiles = Array.from({ length: 12 }, (_, i) => stack.profile('P' + i));
    const results = await Promise.all(profiles.map((p) => p.login(u.token)));
    assert.ok(results.every((r) => r.status === 200));
    assert.equal(activeCount(stack, u.id), 1, 'exactly one active session');
    const valid = [];
    for (const p of profiles) if ((await p.json('/api/ui/live')).status === 200) valid.push(p.name);
    assert.equal(valid.length, 1, 'exactly one profile can still read data');
    // The database itself refuses a second active row for the key.
    assert.throws(() => stack.gateway.db.prepare("INSERT INTO sessions (id, access_key_id, token_hash, client_type, created_at, last_seen_at, expires_at, absolute_expires_at) VALUES ('s_x', ?, 'h', 'web', 1, 1, 9e15, 9e15)").run(u.id), /UNIQUE/);
  } finally { await stack.stop(); }
});

test('REVOKE: an administrator revoking a session cuts API and stream; the client is told why', async () => {
  const stack = await startStack();
  try {
    const admin = stack.backend.addUser({ name: 'Admin', role: 'admin' });
    const u = stack.backend.addUser({ name: 'Customer' });
    const ap = stack.profile('admin'), cp = stack.profile('customer');
    await ap.login(admin.token); await cp.login(u.token);
    const stats = await cp.fetch('/api/statistics/stream?id=1', { headers: { accept: 'text/event-stream' } });
    assert.equal(stats.status, 200);
    const list = await ap.json('/auth/admin/sessions');
    assert.equal(list.status, 200);
    const target = list.data.sessions.find((s) => s.keyLabel === 'Customer');
    assert.equal(target.status, 'ACTIVE'); assert.equal(target.clientType, 'Web');
    assert.ok(!JSON.stringify(list.data).includes(u.token) && !JSON.stringify(list.data).includes(cp.cookie), 'no secrets in the admin listing');
    const r = await ap.json(`/auth/admin/sessions/${target.id}/revoke`, { method: 'POST', body: {} });
    assert.deepEqual(r.data, { ok: true, revoked: true });
    const tail = await readSse(stats, { timeoutMs: 2000 });
    assert.ok(tail.ended, 'detail stream closed');
    assert.match(tail.text, /"reason":"admin"/);
    const api = await cp.json('/api/ui/live');
    assert.equal(api.status, 401); assert.equal(api.data.reason, 'admin');
    const audit = await ap.json('/auth/admin/audit');
    assert.ok(audit.data.entries.some((e) => e.action === 'session.revoked' && e.actorType === 'admin' && e.sessionId === target.id));
  } finally { await stack.stop(); }
});

test('ADMIN: customer sessions cannot use admin routes; admin writes need the site origin', async () => {
  const stack = await startStack();
  try {
    const admin = stack.backend.addUser({ name: 'Admin', role: 'admin' });
    const u = stack.backend.addUser({ name: 'Customer', capabilities: [...ALL_USER_CAPS, 'admin.panel', 'admin.users', 'admin.diagnostics'] });
    const cp = stack.profile('customer'), ap = stack.profile('admin');
    await cp.login(u.token); await ap.login(admin.token);
    assert.equal((await cp.json('/auth/admin/sessions')).status, 403, 'a user role is refused even with admin capabilities');
    assert.equal((await stack.profile('anon').json('/auth/admin/sessions')).status, 401);
    const target = (await ap.json('/auth/admin/sessions')).data.sessions.find((s) => s.keyLabel === 'Customer');
    assert.equal((await ap.json(`/auth/admin/sessions/${target.id}/revoke`, { method: 'POST', body: {}, origin: 'https://evil.example' })).status, 403);
    assert.equal((await cp.json('/api/ui/live')).status, 200, 'cross-site request changed nothing');
  } finally { await stack.stop(); }
});

test('DISABLE KEY: active session revoked at once, future sign-in refused, enable restores sign-in', async () => {
  const stack = await startStack();
  try {
    const admin = stack.backend.addUser({ name: 'Admin', role: 'admin' });
    const u = stack.backend.addUser({ name: 'Customer' });
    const ap = stack.profile('admin'), cp = stack.profile('customer');
    await ap.login(admin.token); await cp.login(u.token);
    const r = await ap.json(`/auth/admin/keys/${u.id}/disable`, { method: 'POST', body: {} });
    assert.equal(r.status, 200); assert.equal(r.data.revoked, 1);
    assert.equal(stack.backend.users.find((x) => x.id === u.id).disabled, true, 'disabled on the monitor server too');
    const api = await cp.json('/api/ui/live');
    assert.equal(api.status, 401); assert.equal(api.data.reason, 'access_revoked');
    assert.equal((await stack.profile('again').login(u.token)).status, 401);
    assert.equal((await ap.json(`/auth/admin/keys/${admin.id}/disable`, { method: 'POST', body: {} })).status, 409, 'an admin cannot disable their own key');
    assert.equal((await ap.json(`/auth/admin/keys/${u.id}/enable`, { method: 'POST', body: {} })).status, 200);
    assert.equal((await stack.profile('again').login(u.token)).status, 200);
  } finally { await stack.stop(); }
});

test('DISABLE KEY elsewhere: a key disabled, rotated or deleted on the server ends its session at the next sync', async () => {
  const stack = await startStack();
  try {
    const a = stack.backend.addUser({ name: 'A' }), b = stack.backend.addUser({ name: 'B' }), c = stack.backend.addUser({ name: 'C' });
    const pa = stack.profile('a'), pb = stack.profile('b'), pc = stack.profile('c');
    await pa.login(a.token); await pb.login(b.token); await pc.login(c.token);
    stack.backend.users.find((x) => x.id === a.id).disabled = true;
    const ub = stack.backend.users.find((x) => x.id === b.id); ub.token = 'emu_' + '1'.repeat(48); ub.tokenUpdatedAt += 1;
    stack.backend.users.splice(stack.backend.users.findIndex((x) => x.id === c.id), 1);
    await stack.gateway.keys.sync();
    for (const p of [pa, pb, pc]) assert.equal((await p.json('/api/ui/live')).status, 401, p.name);
    const reasons = stack.gateway.db.prepare('SELECT revoke_reason FROM sessions ORDER BY created_at').all().map((r) => r.revoke_reason);
    assert.deepEqual(reasons, ['key_disabled', 'key_rotated', 'key_deleted']);
  } finally { await stack.stop(); }
});

test('LOGOUT: the session is revoked and the cookie cleared; logout needs the site origin', async () => {
  const stack = await startStack();
  try {
    const u = stack.backend.addUser({ name: 'Customer' });
    const a = stack.profile('A');
    await a.login(u.token);
    const token = a.cookie;
    assert.equal((await a.json('/auth/logout', { method: 'POST', body: {}, origin: 'https://evil.example' })).status, 403);
    const r = await a.fetch('/auth/logout', { method: 'POST', body: {} });
    assert.equal(r.status, 200);
    assert.match(r.headers.getSetCookie()[0], /Max-Age=0/);
    assert.equal(a.cookie, '');
    const replay = stack.profile('replay'); replay.cookie = token;
    const s = await replay.json('/api/ui/live');
    assert.equal(s.status, 401, 'a copied token stops working after logout');
    assert.equal(s.data.reason, 'logout');
  } finally { await stack.stop(); }
});

test('EXPIRY: idle and absolute limits end the session; activity renews it but never past the absolute limit', async () => {
  let now = Date.UTC(2026, 9, 6, 12);
  const DAY = 86_400_000;
  const stack = await startStack({ clock: () => now });
  try {
    const u = stack.backend.addUser({ name: 'Customer' });
    const a = stack.profile('A');
    await a.login(u.token);
    for (let d = 0; d < 80; d += 20) { now += 20 * DAY; assert.equal((await a.json('/api/ui/live')).status, 200, `active at day ${d + 20}`); }
    now += 11 * DAY; // 91 days after sign-in: past the 90-day absolute limit despite activity
    const r = await a.json('/api/ui/live');
    assert.equal(r.status, 401); assert.equal(r.data.reason, 'expired');
    const b = stack.profile('B');
    await b.login(u.token);
    now += 31 * DAY; // idle for more than 30 days
    const s = await b.json('/auth/session');
    assert.equal(s.status, 401); assert.equal(s.data.reason, 'expired');
    assert.equal((await stack.profile('C').login(u.token)).status, 200, 'the key can sign in again');
  } finally { await stack.stop(); }
});

test('SESSION FIXATION: a cookie set by someone else is replaced at sign-in; switching keys ends the old one', async () => {
  const stack = await startStack();
  try {
    const u1 = stack.backend.addUser({ name: 'One' }), u2 = stack.backend.addUser({ name: 'Two' });
    const a = stack.profile('A');
    a.cookie = 'eds_' + 'A'.repeat(43);
    await a.login(u1.token);
    assert.notEqual(a.cookie, 'eds_' + 'A'.repeat(43));
    const first = a.cookie;
    await a.login(u2.token);
    const old = stack.profile('old'); old.cookie = first;
    assert.equal((await old.json('/api/ui/live')).status, 401);
    assert.equal(activeCount(stack, u1.id), 0);
  } finally { await stack.stop(); }
});

test('RATE LIMIT: repeated wrong keys from one network are throttled', async () => {
  const stack = await startStack({ config: { verifyFailuresPerWindow: 3 } });
  try {
    const u = stack.backend.addUser({ name: 'Customer' });
    const a = stack.profile('A');
    for (let i = 0; i < 3; i++) assert.equal((await a.login('emu_' + String(i).repeat(48))).status, 401);
    const r = await a.login(u.token);
    assert.equal(r.status, 429); assert.ok(Number(r.headers.get('retry-after')) > 0);
    // Another network is not affected.
    const other = await stack.profile('B').json('/auth/verify', { method: 'POST', body: { key: u.token }, headers: { 'cf-connecting-ip': '203.0.113.9' } });
    assert.equal(other.status, 200);
  } finally { await stack.stop(); }
});

test('NO AUTH IN URL: tokens in the query string are ignored', async () => {
  const stack = await startStack();
  try {
    const u = stack.backend.addUser({ name: 'Customer' });
    const a = stack.profile('A');
    await a.login(u.token);
    const token = a.cookie;
    const anon = stack.profile('anon');
    assert.equal((await anon.json(`/api/ui/live?access_token=${token}`)).status, 401);
    assert.equal((await anon.json(`/api/feed-stream?access_token=${u.token}`)).status, 401);
    assert.equal(ORIGIN, stack.config.publicOrigin);
  } finally { await stack.stop(); }
});
