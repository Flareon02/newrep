// The gateway applies the server's entitlement rules (vendored server code) to everything it relays.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { startStack, readSse } from './helpers/gateway.mjs';
import { ALL_USER_CAPS } from './helpers/fake-backend.mjs';

const NO_PINNACLE = ALL_USER_CAPS.filter((k) => k !== 'provider.pinnacle' && k !== 'odds.fullMarkets');

test('vendored entitlements are identical to the server source (no drift)', () => {
  execFileSync(process.execPath, [new URL('../gateway/scripts/vendor-entitlements.mjs', import.meta.url).pathname, '--check']);
});

test('restricted users get exactly what the server would give them; diagnostics never leak', async () => {
  const stack = await startStack();
  try {
    const limited = stack.backend.addUser({ name: 'Limited', capabilities: NO_PINNACLE });
    const p = stack.profile('limited');
    await p.login(limited.token);
    const viaGateway = await p.json('/api/ui/live');
    assert.equal(viaGateway.status, 200);
    // Same request straight to the server with the user's own key = the server's own filtering.
    const direct = await (await fetch(stack.backend.base + '/api/ui/live', { headers: { authorization: 'Bearer ' + limited.token } })).json();
    assert.deepEqual(viaGateway.data, direct);
    const text = JSON.stringify(viaGateway.data);
    assert.ok(!text.includes('pinnacle'), 'no Pinnacle refs or provider block');
    assert.ok(!text.includes('internal'), 'no upstream diagnostics');
    assert.equal(viaGateway.data.events.length, 1, 'an event only Pinnacle has is removed');
    assert.equal(viaGateway.data.events[0].sourceRefs[0].odds.markets.length, 1, 'no full markets without odds.fullMarkets');
  } finally { await stack.stop(); }
});

test('routes the user may not use are refused before reaching the server', async () => {
  const stack = await startStack();
  try {
    const u = stack.backend.addUser({ name: 'NoHistory', capabilities: ALL_USER_CAPS.filter((k) => k !== 'history.view' && k !== 'provider.pinnacle') });
    const p = stack.profile('u');
    await p.login(u.token);
    stack.backend.seen.paths.length = 0;
    for (const path of ['/api/ui/history', '/api/pinnacle/live-markets?id=1', '/api/admin/users', '/api/status', '/api/unknown-route']) assert.equal((await p.json(path)).status, 403, path);
    assert.deepEqual(stack.backend.seen.paths.filter((x) => !x.startsWith('GET /api/admin/users')), [], 'nothing was forwarded');
  } finally { await stack.stop(); }
});

test('the server only ever sees the gateway service credential, never a user key or session', async () => {
  const stack = await startStack();
  try {
    const u = stack.backend.addUser({ name: 'Customer' });
    const p = stack.profile('u');
    await p.login(u.token);
    stack.backend.seen.authorizations.length = 0;
    await p.json('/api/ui/live'); await p.json('/api/events/m1/history');
    assert.ok(stack.backend.seen.authorizations.length >= 2);
    assert.ok(stack.backend.seen.authorizations.every((a) => a === 'Bearer ' + stack.backend.masterToken));
    // The only time a user's key reaches the server is the sign-in check (/api/me).
    stack.backend.seen.authorizations.length = 0; stack.backend.seen.paths.length = 0;
    await stack.profile('again').login(u.token);
    const withKey = stack.backend.seen.paths.filter((_, i) => stack.backend.seen.authorizations[i] === 'Bearer ' + u.token);
    assert.deepEqual(withKey, ['GET /api/me']);
  } finally { await stack.stop(); }
});

test('ETags are scoped per user and 304 still works', async () => {
  const stack = await startStack();
  try {
    const a = stack.backend.addUser({ name: 'A', capabilities: NO_PINNACLE }), b = stack.backend.addUser({ name: 'B' });
    const pa = stack.profile('a'), pb = stack.profile('b');
    await pa.login(a.token); await pb.login(b.token);
    const ra = await pa.fetch('/api/ui/live'), rb = await pb.fetch('/api/ui/live');
    const ea = ra.headers.get('etag'), eb = rb.headers.get('etag');
    assert.ok(ea && eb && ea !== eb, `${ea} vs ${eb}`);
    assert.equal((await pa.fetch('/api/ui/live', { headers: { 'if-none-match': ea } })).status, 304);
    assert.equal((await pa.fetch('/api/ui/live', { headers: { 'if-none-match': eb } })).status, 200, "another user's ETag is not honoured");
  } finally { await stack.stop(); }
});

test('event history: bookmakers and odds/score rights are applied to the entries', async () => {
  const stack = await startStack();
  try {
    const u = stack.backend.addUser({ name: 'ScoresOnly', capabilities: ALL_USER_CAPS.filter((k) => k !== 'odds.history' && k !== 'provider.pinnacle') });
    const p = stack.profile('u');
    await p.login(u.token);
    const r = await p.json('/api/events/m1/history');
    assert.equal(r.status, 200);
    assert.deepEqual(r.data.entries.map((e) => [e.provider, e.kind]), [['astek', 'score']]);
    assert.deepEqual(r.data.oddsTimeline, []);
  } finally { await stack.stop(); }
});

test('feed stream: one upstream connection for many users, filtered per user', async () => {
  const stack = await startStack();
  try {
    const full = stack.backend.addUser({ name: 'Full' }), limited = stack.backend.addUser({ name: 'Limited', capabilities: NO_PINNACLE });
    const pf = stack.profile('full'), pl = stack.profile('limited');
    await pf.login(full.token); await pl.login(limited.token);
    const sf = await pf.fetch('/api/feed-stream?modes=live,prematch,history&thin=1&provider=ggbet');
    const sl = await pl.fetch('/api/feed-stream?modes=live&thin=1&provider=ggbet');
    const hf = await readSse(sf, { until: (t) => t.includes('event: hello') }), hl = await readSse(sl, { until: (t) => t.includes('event: hello') });
    assert.equal(stack.backend.feedClients.size, 1, 'one upstream stream');
    assert.ok(!hl.text.includes('secret-diag') && !hf.text.includes('secret-diag'), 'provider diagnostics scrubbed for non-admins');
    assert.ok(!hl.text.includes('"history"'), 'modes not requested are not announced');
    stack.backend.push('patch', { mode: 'live', provider: 'pinnacle', meta: { revision: 'r2' }, patches: [{ source: 'pinnacle', id: 'p1', fields: ['scoreText'], scoreText: '1:0' }] });
    stack.backend.push('patch', { mode: 'live', provider: 'astek', meta: { revision: 'r3' }, patches: [{ source: 'astek', id: 'a1', fields: ['scoreText'], scoreText: '2:0' }] });
    stack.backend.push('ui-invalidate', { view: 'history', revision: 2 });
    const tf = await readSse(sf, { until: (t) => t.includes('ui-invalidate') }), tl = await readSse(sl, { until: (t) => t.includes('"2:0"'), timeoutMs: 1500 });
    assert.match(tf.text, /"1:0"/); assert.match(tf.text, /"2:0"/); assert.match(tf.text, /ui-invalidate/);
    assert.ok(!tl.text.includes('"1:0"'), 'Pinnacle patch not sent to a user without Pinnacle');
    assert.match(tl.text, /"2:0"/);
    assert.ok(!tl.text.includes('ui-invalidate'), 'history invalidation not sent to a stream without history');
    // A late subscriber starts from the newest revisions.
    const late = stack.profile('late'); await late.login(full.token);
    const sLate = await late.fetch('/api/feed-stream?modes=live&thin=1&provider=ggbet');
    const hLate = await readSse(sLate, { until: (t) => t.includes('event: hello') });
    assert.match(hLate.text, /"revision":"r3"/);
  } finally { await stack.stop(); }
});

test('administrators get the server response unchanged; anonymous logo requests work, other data does not', async () => {
  const stack = await startStack();
  try {
    const admin = stack.backend.addUser({ name: 'Admin', role: 'admin' });
    const p = stack.profile('admin');
    await p.login(admin.token);
    const r = await p.json('/api/ui/live');
    assert.match(JSON.stringify(r.data), /internal/, 'diagnostics visible to administrators');
    const anon = stack.profile('anon');
    assert.equal((await anon.fetch('/api/team-logos/0123456789abcdef0123456789abcdef')).status, 200);
    assert.equal((await anon.fetch('/api/ui/live')).status, 401);
    assert.equal((await anon.fetch('/health')).status, 401);
  } finally { await stack.stop(); }
});

test('security headers: CSP, frame denial, no referrer, nosniff on pages and API', async () => {
  const stack = await startStack();
  try {
    for (const path of ['/', '/auth/session']) {
      const r = await fetch(stack.base + path);
      assert.match(r.headers.get('content-security-policy'), /frame-ancestors 'none'/);
      assert.match(r.headers.get('content-security-policy'), /script-src 'self'(;|$)/);
      assert.equal(r.headers.get('x-frame-options'), 'DENY');
      assert.equal(r.headers.get('referrer-policy'), 'no-referrer');
      assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
    }
    assert.equal((await fetch(stack.base + '/../../etc/passwd')).status, 404);
    assert.equal((await fetch(stack.base + '/%2e%2e/%2e%2e/etc/passwd')).status, 404);
    // CORS only for the desktop app's origins.
    const pre = await fetch(stack.base + '/api/ui/live', { method: 'OPTIONS', headers: { origin: 'https://evil.example', 'access-control-request-method': 'GET' } });
    assert.equal(pre.status, 403);
    const ok = await fetch(stack.base + '/api/ui/live', { method: 'OPTIONS', headers: { origin: 'http://tauri.localhost', 'access-control-request-method': 'GET' } });
    assert.equal(ok.status, 204); assert.equal(ok.headers.get('access-control-allow-credentials'), null);
  } finally { await stack.stop(); }
});
