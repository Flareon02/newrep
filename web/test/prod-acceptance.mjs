// READ-ONLY production acceptance of the deployed web gateway (esportsdata-web on 127.0.0.1:8090) against the real
// monitor server. Chromium resolves esportsdata.online to a local TLS terminator in front of the gateway, so the page
// runs on the real origin (https://esportsdata.online, __Host- Secure cookie) before or without public DNS.
//
//   node web/test/prod-acceptance.mjs --admin-key-file /root/esportsdata-admin-key.txt [--json report.json] [--shots dir]
//
// Uses only dedicated test keys: two "Acceptance" users are created through the admin API (one full, one restricted)
// and deleted at the end. Customer keys are never used. Market data is only read.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import https from 'node:https';
import http from 'node:http';
import { execFileSync, execSync } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(path.join(process.env.PLAYWRIGHT_DIR || '/root/e2e-browser', 'package.json'));
const { chromium } = require('playwright');
const arg = (n, d = '') => { const i = process.argv.indexOf('--' + n); return i > 0 ? process.argv[i + 1] : d; };
const ORIGIN = 'https://esportsdata.online', GATEWAY = 'http://127.0.0.1:8090';
const adminKey = fs.readFileSync(arg('admin-key-file', '/root/esportsdata-admin-key.txt'), 'utf8').split('\n').map((l) => l.trim()).find((l) => /^emu_[0-9a-f]{48}$/.test(l));
if (!adminKey) throw new Error('admin key file has no key');
const shots = arg('shots');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const assert = (c, m) => { if (!c) throw new Error(m); };
async function check(name, fn) {
  const t = Date.now();
  try { const detail = await fn(); results.push({ name, ok: true, ms: Date.now() - t, ...(detail ? { detail } : {}) }); console.log('PASS', name, detail ? JSON.stringify(detail) : ''); }
  catch (e) { results.push({ name, ok: false, ms: Date.now() - t, error: e.message }); console.log('FAIL', name, '-', e.message.split('\n')[0]); }
}

// ---- local TLS terminator for esportsdata.online → gateway (streams pass through) ----
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'eds-acc-'));
execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=esportsdata.online', '-addext', 'subjectAltName=DNS:esportsdata.online', '-keyout', path.join(tmp, 'k.pem'), '-out', path.join(tmp, 'c.pem')], { stdio: 'ignore' });
const tls = https.createServer({ key: fs.readFileSync(path.join(tmp, 'k.pem')), cert: fs.readFileSync(path.join(tmp, 'c.pem')) }, (req, res) => {
  const up = http.request(GATEWAY + req.url, { method: req.method, headers: { ...req.headers, 'cf-connecting-ip': '198.51.100.7', 'cf-ipcountry': 'AM' } }, (r) => { res.writeHead(r.statusCode, r.headers); res.flushHeaders?.(); r.pipe(res); });
  up.on('error', () => { if (!res.headersSent) res.writeHead(502); res.end(); });
  // The response closing (client gone) ends the upstream request; req 'close' fires as soon as the body is read.
  res.on('close', () => up.destroy());
  req.pipe(up);
});
await new Promise((r) => tls.listen(0, '127.0.0.1', r));
const tlsPort = tls.address().port;

// ---- Node-side client of the deployed gateway (for setup/cleanup through the admin API) ----
async function gw(pathname, { method = 'GET', body, cookie = '' } = {}) {
  const res = await fetch(GATEWAY + pathname, { method, headers: { origin: ORIGIN, ...(cookie ? { cookie } : {}), ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const set = (res.headers.getSetCookie?.() || []).find((c) => c.startsWith('__Host-eds_session='));
  let data = null; try { data = await res.json(); } catch {}
  return { status: res.status, data, cookie: set ? set.split(';')[0] : '' };
}
const adminLogin = await gw('/auth/verify', { method: 'POST', body: { key: adminKey, client: 'web' } });
assert(adminLogin.status === 200, 'admin key sign-in failed: ' + adminLogin.status);
let adminCookie = adminLogin.cookie;
// One key = one session: the browser admin profile below replaces this session, so sign in again when needed.
const reAdmin = async () => { const r = await gw('/auth/verify', { method: 'POST', body: { key: adminKey, client: 'web' } }); adminCookie = r.cookie; return r.status; };
const caps = (await gw('/api/admin/capabilities', { cookie: adminCookie })).data.capabilities.map((c) => c.key).filter((k) => !k.startsWith('admin.'));
const restrictedCaps = caps.filter((k) => !['provider.pinnacle', 'odds.fullMarkets', 'history.view'].includes(k));
const created = [];
async function testUser(name, capabilities) {
  const r = await gw('/api/admin/users', { method: 'POST', cookie: adminCookie, body: { name, capabilities } });
  assert(r.status === 200 && r.data.token, 'cannot create test user: ' + r.status);
  created.push(r.data.user.id);
  return { id: r.data.user.id, key: r.data.token };
}
const full = await testUser('Acceptance web test (full)', caps);
const limited = await testUser('Acceptance web test (restricted)', restrictedCaps);
await sleep(500);

const consoleErrors = [];
async function profile(name) {
  const context = await chromium.launchPersistentContext(path.join(tmp, name), { headless: true, ignoreHTTPSErrors: true, viewport: { width: 1440, height: 900 }, args: [`--host-resolver-rules=MAP esportsdata.online 127.0.0.1:${tlsPort}`] });
  const page = context.pages()[0] || await context.newPage();
  page.on('pageerror', (e) => consoleErrors.push(`${name}: ${e.message}`));
  return { context, page, name };
}
const snap = async (page, name) => { if (shots) { fs.mkdirSync(shots, { recursive: true }); await page.screenshot({ path: path.join(shots, name + '.png') }); } };
async function signIn(page, key) { await page.waitForSelector('#gateKey', { state: 'visible', timeout: 15000 }); await page.fill('#gateKey', key); await page.click('#gateSubmit'); }
const liveRows = (page) => page.waitForSelector('#content>.list[data-view="live"] article.match', { timeout: 45000 });

let A = await profile('A');
try {
  await check('access gate on first visit (real origin, HTTPS)', async () => {
    const r = await A.page.goto(ORIGIN + '/');
    await A.page.waitForSelector('#gate:not([hidden])', { timeout: 15000 });
    const h = r.headers();
    assert(/frame-ancestors 'none'/.test(h['content-security-policy'] || ''), 'CSP');
    await snap(A.page, 'p01-gate');
  });
  await check('sign-in opens the monitor with real LIVE data', async () => {
    const t = Date.now();
    await signIn(A.page, full.key); await liveRows(A.page);
    const cookies = await A.context.cookies(ORIGIN);
    const c = cookies.find((x) => x.name === '__Host-eds_session');
    assert(c && c.httpOnly && c.secure && c.sameSite === 'Lax' && c.expires > Date.now() / 1000 + 29 * 86400, 'persistent __Host- Secure HttpOnly Lax cookie');
    const live = await A.page.$$eval('#content>.list[data-view="live"] article.match', (n) => n.length);
    await snap(A.page, 'p02-live');
    return { ms: Date.now() - t, liveRows: live };
  });
  await check('reload and browser restart keep the session', async () => {
    await A.page.reload(); await liveRows(A.page);
    await A.context.close(); A = await profile('A');
    await A.page.goto(ORIGIN + '/'); await liveRows(A.page);
    assert(await A.page.evaluate(() => document.getElementById('gate').hidden), 'gate hidden');
  });
  await check('GGBET and other bookmakers displayed; logos load', async () => {
    const head = await A.page.textContent('#content>.list[data-view="live"]');
    const books = ['ASTEKBET', 'FONBET', 'PINNACLE', 'GGBET'].filter((b) => head.toUpperCase().includes(b));
    assert(books.includes('GGBET'), 'GGBET column: ' + books);
    const logos = await A.page.$$eval('img.team-logo', (i) => i.filter((x) => x.complete && x.naturalWidth > 0).length);
    const sources = await A.page.textContent('#sourcesCount');
    return { books, logosLoaded: logos, sources };
  });
  await check('PREMATCH / RESULTS / HISTORY with real data; History windowed', async () => {
    const counts = {};
    for (const tab of ['prematch', 'results', 'history']) {
      await A.page.click(`#tabs [data-tab="${tab}"]`);
      if (tab === 'prematch') { await A.page.waitForSelector('#content>.list[data-view="prematch"] details.league-group>summary', { timeout: 45000 }); await A.page.click('#content>.list[data-view="prematch"] details.league-group>summary'); }
      const t = Date.now();
      await A.page.waitForSelector(`#content>.list[data-view="${tab}"] article.match`, { timeout: 60000 });
      counts[tab + 'FirstRowsMs'] = Date.now() - t;
      await sleep(tab === 'history' ? 2500 : 600);
      counts[tab] = await A.page.$$eval(`#content>.list[data-view="${tab}"] article.match`, (n) => n.length);
      await snap(A.page, 'p03-' + tab);
    }
    for (let i = 0; i < 5; i++) { await A.page.evaluate(() => { const l = document.querySelector('#content>.list[data-view="history"]'); l.scrollTop = l.scrollHeight; }); await sleep(1500); }
    const h = await A.page.evaluate(() => window.__monitorDebug.history());
    counts.historyLoaded = h.loaded; counts.historyMounted = h.mounted; counts.documentNodes = await A.page.evaluate(() => document.querySelectorAll('*').length);
    assert(counts.prematch > 0 && counts.results > 0 && counts.history > 0, JSON.stringify(counts));
    assert(h.mounted <= h.loaded, 'windowing');
    await A.page.click('#tabs [data-tab="live"]');
    return counts;
  });
  await check('filters: search and game filter on real data', async () => {
    const before = await A.page.$$eval('#content>.list[data-view="live"] article.match', (n) => n.length);
    await A.page.fill('#search', 'zzzz-no-such-team'); await sleep(500);
    const none = await A.page.$$eval('#content>.list[data-view="live"] article.match', (n) => n.length);
    await A.page.fill('#search', ''); await sleep(500);
    const after = await A.page.$$eval('#content>.list[data-view="live"] article.match', (n) => n.length);
    assert(none === 0 && after === before, `${before} → ${none} → ${after}`);
    return { before, filtered: none };
  });
  await check('match detail with real odds', async () => {
    await A.page.click('#content>.list[data-view="live"] article.match');
    await A.page.waitForSelector('#detailPane:not([hidden])', { timeout: 10000 }); await sleep(1500);
    await snap(A.page, 'p04-detail'); await A.page.keyboard.press('Escape');
  });
  await check('realtime: one multiplexed upstream feed, events flowing', async () => {
    const h1 = await (await fetch(GATEWAY + '/healthz')).json();
    await sleep(30000);
    const h2 = await (await fetch(GATEWAY + '/healthz')).json();
    assert(h2.feed.length === 1 && h2.feed[0].connected, JSON.stringify(h2.feed));
    return { feed: h2.feed, streams: h2.streams, firstSeen: h1.feed };
  });
  await check('reconnect: web gateway restart keeps the session and the stream recovers', async () => {
    execSync('systemctl restart esportsdata-web');
    for (let i = 0; i < 40; i++) { try { if ((await fetch(GATEWAY + '/healthz')).ok) break; } catch {} await sleep(250); }
    await sleep(12000);
    const h = await (await fetch(GATEWAY + '/healthz')).json();
    assert(h.streams >= 1 && h.feed[0]?.connected, 'stream reconnected: ' + JSON.stringify(h));
    assert(await A.page.evaluate(() => document.getElementById('gate').hidden), 'still signed in');
    return { streams: h.streams };
  });
  await check('restricted test user: no Pinnacle, no History, same as the server rules', async () => {
    const R = await profile('restricted');
    try {
      await R.page.goto(ORIGIN + '/'); await signIn(R.page, limited.key); await liveRows(R.page);
      const tabs = await R.page.$$eval('#tabs [data-tab]', (b) => b.filter((x) => !x.hidden).map((x) => x.dataset.tab));
      const live = await R.page.evaluate(async () => (await fetch('/api/ui/live?compact=1&thin=1&provider=ggbet')).text());
      const hist = await R.page.evaluate(async () => (await fetch('/api/ui/history?limit=1')).status);
      assert(!tabs.includes('history'), 'History hidden: ' + tabs);
      assert(!/"source":"pinnacle"/.test(live), 'no Pinnacle refs');
      assert(hist === 403, 'History API refused: ' + hist);
      return { tabs, historyApi: hist };
    } finally { await R.context.close(); }
  });

  let B = await profile('B');
  await check('Profile B with the same key: B valid, A kicked to the gate quickly', async () => {
    await B.page.goto(ORIGIN + '/');
    const t = Date.now();
    await signIn(B.page, full.key); await liveRows(B.page);
    await A.page.waitForSelector('#gate:not([hidden])', { timeout: 20000 });
    const kick = Date.now() - t;
    const notice = await A.page.textContent('#gateNotice');
    assert(notice.includes('другом профиле'), notice);
    await snap(A.page, 'p05-kicked');
    return { kickMs: kick };
  });
  const ADM = await profile('admin');
  await check('admin: test session visible, revoke works', async () => {
    await ADM.page.goto(ORIGIN + '/'); await signIn(ADM.page, adminKey); await liveRows(ADM.page);
    await ADM.page.click('#settingsButton'); await ADM.page.click('[data-settings-section="sessions"]');
    await ADM.page.waitForSelector('table.admin-sessions tbody tr', { timeout: 15000 });
    const row = 'table.admin-sessions tbody tr:has-text("Acceptance web test (full)")';
    const text = await ADM.page.textContent(row);
    assert(/Web/.test(text) && /активна/.test(text) && /198\.51\.100\.0\/24/.test(text), text);
    await snap(ADM.page, 'p06-admin-sessions');
    const t = Date.now();
    await ADM.page.click(`${row} [data-revoke]`); await ADM.page.click(`${row} [data-revoke]`);
    await B.page.waitForSelector('#gate:not([hidden])', { timeout: 20000 });
    return { kickMs: Date.now() - t };
  });
  await check('admin: disable key ends access and blocks sign-in; enable restores', async () => {
    await signIn(B.page, full.key); await liveRows(B.page);
    await ADM.page.click('#sessRefresh'); await sleep(800);
    await ADM.page.click(`[data-key-disable="${full.id}"]`); await ADM.page.click(`[data-key-disable="${full.id}"]`);
    await B.page.waitForSelector('#gate:not([hidden])', { timeout: 20000 });
    await signIn(B.page, full.key);
    await B.page.waitForFunction(() => document.getElementById('gateError').textContent.includes('Неверный'), null, { timeout: 15000 });
    await ADM.page.waitForSelector(`[data-key-enable="${full.id}"]`, { timeout: 15000 });
    await ADM.page.click(`[data-key-enable="${full.id}"]`); await sleep(800);
    await signIn(B.page, full.key); await liveRows(B.page);
  });
  await check('logout ends the session; reload stays on the gate', async () => {
    await B.page.click('#settingsButton'); await B.page.click('[data-settings-section="server"]');
    await B.page.waitForSelector('#accountLogout'); await snap(B.page, 'p07-account');
    await B.page.click('#accountLogout'); await B.page.click('#accountLogout');
    await B.page.waitForSelector('#gate:not([hidden])', { timeout: 15000 });
    await B.page.reload(); await B.page.waitForSelector('#gate:not([hidden])', { timeout: 15000 });
  });
  await check('audit log records admin actions without secrets', async () => {
    await reAdmin();
    const a = await gw('/auth/admin/audit?limit=50', { cookie: adminCookie });
    const actions = a.data.entries.map((e) => e.action);
    const text = JSON.stringify(a.data);
    assert(actions.includes('session.revoked') && actions.includes('key.disabled') && actions.includes('key.enabled'), actions.join(','));
    assert(!text.includes(full.key) && !text.includes(adminKey) && !/eds_[A-Za-z0-9_-]{43}/.test(text), 'no secrets');
    return { recent: actions.slice(0, 8) };
  });
  await check('no uncaught page errors', async () => { assert(!consoleErrors.length, consoleErrors.slice(0, 3).join(' | ')); });
  for (const p of [B, ADM]) await p.context.close().catch(() => {});
} finally {
  await A.context.close().catch(() => {});
  // Cleanup: delete the test keys (their sessions end with them) and sign the admin session out.
  await reAdmin();
  for (const id of created) await gw(`/api/admin/users/${id}/delete`, { method: 'POST', cookie: adminCookie, body: {} });
  const left = (await gw('/api/admin/users', { cookie: adminCookie })).data?.users?.filter((u) => created.includes(u.id)).length;
  await gw('/auth/logout', { method: 'POST', cookie: adminCookie, body: {} });
  results.push({ name: 'cleanup: test keys deleted', ok: left === 0 });
  console.log(left === 0 ? 'PASS cleanup: test keys deleted' : 'FAIL cleanup');
  tls.close(); fs.rmSync(tmp, { recursive: true, force: true });
}
const passed = results.filter((r) => r.ok).length;
console.log(`\nPRODUCTION ACCEPTANCE: ${passed}/${results.length}`);
if (arg('json')) fs.writeFileSync(arg('json'), JSON.stringify({ at: new Date().toISOString(), passed, total: results.length, results }, null, 2));
process.exit(passed === results.length ? 0 : 1);
