// Browser end-to-end test of the web app: real Chromium profiles → gateway → fake monitor server (keys) + the 9.3.0 UX
// mock data set (1,900 synthetic matches). Checks the product behaviour in the order a user meets it.
//
//   node web/build.mjs && node web/test/web-e2e.mjs [--shots dir] [--json report.json]
// Playwright comes from PLAYWRIGHT_DIR (default /root/e2e-browser).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { startMockServer } from '../../tools/ux/mock-server.mjs';
import { startStack } from './helpers/gateway.mjs';

const require = createRequire(path.join(process.env.PLAYWRIGHT_DIR || '/root/e2e-browser', 'package.json'));
const { chromium } = require('playwright');
const arg = (n) => { const i = process.argv.indexOf('--' + n); return i > 0 ? process.argv[i + 1] : ''; };
const shots = arg('shots');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const root = path.resolve(new URL('../..', import.meta.url).pathname);

const results = [];
async function check(name, fn) {
  const t = Date.now();
  try { const detail = await fn(); results.push({ name, ok: true, ms: Date.now() - t, ...(detail ? { detail } : {}) }); console.log('PASS', name, detail ? JSON.stringify(detail) : ''); }
  catch (error) { results.push({ name, ok: false, ms: Date.now() - t, error: error.message }); console.log('FAIL', name, '-', error.message); }
}
const assert = (cond, msg) => { if (!cond) throw new Error(msg); };

const mock = await startMockServer({ historyLatencyMs: 300 });
const stack = await startStack({ backend: { fallback: mock.url }, config: { staticDir: path.join(root, 'dist', 'web'), sweepMs: 1000 } });
stack.config.publicOrigin = stack.base; // the browser's origin in this test
const customer = stack.backend.addUser({ name: 'Клиент Тест' });
const admin = stack.backend.addUser({ name: 'Администратор', role: 'admin' });
await stack.gateway.keys.sync();
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'eds-e2e-'));
const consoleErrors = [];
async function profile(name) {
  const context = await chromium.launchPersistentContext(path.join(tmp, name), { headless: true, viewport: { width: 1440, height: 900 } });
  const page = context.pages()[0] || await context.newPage();
  page.on('console', (m) => { if (m.type() === 'error' && !/401|Failed to load resource/.test(m.text())) consoleErrors.push(`${name}: ${m.text()}`); });
  page.on('pageerror', (e) => consoleErrors.push(`${name}: ${e.message}`));
  return { context, page, name };
}
const gateVisible = (page) => page.evaluate(() => !document.getElementById('gate').hidden);
const appVisible = (page) => page.evaluate(() => !document.getElementById('app').hidden);
async function signIn(page, key) {
  await page.waitForSelector('#gateKey', { state: 'visible', timeout: 10000 });
  await page.fill('#gateKey', key);
  await page.click('#gateSubmit');
}
const liveRows = (page) => page.waitForSelector('#content>.list[data-view="live"] article.match', { timeout: 30000 });
const snap = async (page, name) => { if (shots) { fs.mkdirSync(shots, { recursive: true }); await page.screenshot({ path: path.join(shots, name + '.png') }); } };

let A = await profile('chrome-profile-A');
await check('first visit shows the Access Key gate (no app, no data requests)', async () => {
  await A.page.goto(stack.base);
  await A.page.waitForSelector('#gate:not([hidden])', { timeout: 10000 });
  assert(!(await appVisible(A.page)), 'app hidden');
  const scripts = await A.page.evaluate(() => [...document.scripts].map((s) => s.src.split('/').pop().split('?')[0]));
  assert(!scripts.includes('app.js'), 'app scripts are not loaded before sign-in');
  await snap(A.page, '01-gate');
});
await check('wrong key: generic error, still on the gate, key field cleared', async () => {
  await signIn(A.page, 'emu_' + '0'.repeat(48));
  await A.page.waitForFunction(() => document.getElementById('gateError').textContent.length > 0);
  const text = await A.page.textContent('#gateError');
  assert(text.includes('Неверный или просроченный ключ доступа'), text);
  assert(await gateVisible(A.page), 'gate visible');
  assert((await A.page.inputValue('#gateKey')) === '', 'key field cleared');
});
let firstPaintMs = 0;
await check('valid key opens the full monitor (LIVE rows)', async () => {
  const t = Date.now();
  await signIn(A.page, customer.token);
  await liveRows(A.page);
  firstPaintMs = Date.now() - t;
  assert(await appVisible(A.page), 'app visible');
  const tabs = await A.page.$$eval('#tabs [data-tab]', (b) => b.filter((x) => !x.hidden).map((x) => x.dataset.tab));
  await snap(A.page, '02-live');
  return { signInToRowsMs: firstPaintMs, tabs };
});
await check('the key is not kept anywhere in the page storage', async () => {
  const dump = await A.page.evaluate(async () => {
    const out = [JSON.stringify(localStorage), JSON.stringify(sessionStorage), document.cookie];
    const all = await chrome.storage.local.get(null); out.push(JSON.stringify(all));
    return out.join('\n');
  });
  assert(!dump.includes(customer.token), 'raw key found in storage');
  assert(!dump.includes('eds_'), 'session token readable by scripts');
});
await check('reload keeps the session (monitor opens without the gate)', async () => {
  await A.page.reload();
  await liveRows(A.page);
  assert(!(await gateVisible(A.page)), 'gate hidden');
});
await check('browser restart keeps the session (persistent profile)', async () => {
  await A.context.close();
  A = await profile('chrome-profile-A');
  await A.page.goto(stack.base);
  await liveRows(A.page);
  assert(!(await gateVisible(A.page)), 'gate hidden after restart');
});
await check('LIVE / PREMATCH / RESULTS / HISTORY render; filters work', async () => {
  const counts = {};
  counts.live = await A.page.$$eval('#content>.list[data-view="live"] article.match', (n) => n.length);
  for (const tab of ['prematch', 'results', 'history']) {
    await A.page.click(`#tabs [data-tab="${tab}"]`);
    if (tab === 'prematch') {
      // Line: games open, leagues collapsed (9.3.0 fold model) - open the first league.
      await A.page.waitForSelector('#content>.list[data-view="prematch"] details.league-group>summary', { timeout: 45000 });
      await A.page.click('#content>.list[data-view="prematch"] details.league-group>summary');
    }
    await A.page.waitForSelector(`#content>.list[data-view="${tab}"] article.match`, { timeout: 45000 });
    await sleep(tab === 'history' ? 1500 : 400);
    counts[tab] = await A.page.$$eval(`#content>.list[data-view="${tab}"] article.match`, (n) => n.length);
    await snap(A.page, '03-' + tab);
  }
  await A.page.click('#tabs [data-tab="live"]');
  await A.page.fill('#search', 'zzzz-no-such-team');
  await sleep(400);
  const filtered = await A.page.$$eval('#content>.list[data-view="live"] article.match', (n) => n.length);
  await A.page.fill('#search', '');
  await sleep(300);
  assert(Object.values(counts).every((n) => n > 0), JSON.stringify(counts));
  assert(filtered === 0, `search filter left ${filtered} rows`);
  return counts;
});
await check('HISTORY stays windowed (bounded DOM) while loading older days', async () => {
  await A.page.click('#tabs [data-tab="history"]');
  await A.page.waitForSelector('#content>.list[data-view="history"] article.match', { timeout: 45000 });
  for (let i = 0; i < 6; i++) { await A.page.evaluate(() => { const l = document.querySelector('#content>.list[data-view="history"]'); l.scrollTop = l.scrollHeight; }); await sleep(900); }
  const h = await A.page.evaluate(() => window.__monitorDebug.history());
  const nodes = await A.page.evaluate(() => document.querySelectorAll('*').length);
  assert(h.loaded > 200, `loaded ${h.loaded}`);
  assert(h.mounted < h.loaded, `mounted ${h.mounted} of ${h.loaded}`);
  await A.page.click('#tabs [data-tab="live"]');
  return { loaded: h.loaded, mounted: h.mounted, documentNodes: nodes };
});
await check('match detail opens with odds', async () => {
  await A.page.click('#content>.list[data-view="live"] article.match');
  await A.page.waitForSelector('#detailPane:not([hidden])', { timeout: 10000 });
  await sleep(800);
  await snap(A.page, '04-detail');
  await A.page.keyboard.press('Escape');
});
await check('one realtime stream per page, through the gateway (multiplexed upstream)', async () => {
  const sessions = stack.gateway.registry.sessions();
  const feeds = stack.gateway.hub.status();
  assert(sessions.length === 1, `sessions with streams: ${sessions.length}`);
  assert(stack.gateway.registry.count(sessions[0], 'feed') === 1, 'one feed stream');
  return { feeds };
});
await check('SETTINGS → Аккаунт shows the session and the desktop download block', async () => {
  await A.page.click('#settingsButton');
  await A.page.click('[data-settings-section="server"]');
  await A.page.waitForSelector('#accountLogout', { timeout: 10000 });
  const text = await A.page.textContent('#settingsBody');
  assert(text.includes('Клиент Тест') && text.includes('активна') && text.includes('Веб-версия'), text.slice(0, 300));
  assert(text.includes('Приложение для Windows'), 'desktop block present');
  const sections = await A.page.$$eval('[data-settings-section]', (b) => b.map((x) => x.textContent));
  assert(!sections.includes('Подключение') && !sections.includes('Сессии'), sections.join(','));
  await snap(A.page, '05-settings-account');
  await A.page.click('#settingsDone');
  return { sections };
});

let B = await profile('chrome-profile-B');
await check('another browser profile sees the gate', async () => {
  await B.page.goto(stack.base);
  await B.page.waitForSelector('#gate:not([hidden])', { timeout: 10000 });
});
await check('same key in profile B: B gets the monitor, A is kicked to the gate with the reason', async () => {
  const t = Date.now();
  await signIn(B.page, customer.token);
  await liveRows(B.page);
  await A.page.waitForSelector('#gate:not([hidden])', { timeout: 15000 });
  const kickMs = Date.now() - t;
  const notice = await A.page.textContent('#gateNotice');
  assert(notice.includes('использован в другом профиле'), notice);
  const leftovers = await A.page.evaluate(async () => Object.keys(await chrome.storage.local.get(null)).filter((k) => k.startsWith('lastKnown')));
  assert(leftovers.length === 0, 'cached data of the old session cleared: ' + leftovers);
  await snap(A.page, '06-kicked');
  return { kickMs };
});

let ADM = await profile('admin-profile');
await check('admin panel lists active sessions with key, client and device', async () => {
  await ADM.page.goto(stack.base);
  await signIn(ADM.page, admin.token);
  await liveRows(ADM.page);
  await ADM.page.click('#settingsButton');
  await ADM.page.click('[data-settings-section="sessions"]');
  await ADM.page.waitForSelector('table.admin-sessions tbody tr', { timeout: 10000 });
  const rows = await ADM.page.$$eval('table.admin-sessions tbody tr', (r) => r.map((x) => x.textContent));
  assert(rows.some((r) => r.includes('Клиент Тест') && r.includes('Web') && r.includes('активна')), rows.join(' | '));
  const html = await ADM.page.content();
  assert(!html.includes(customer.token) && !html.includes(admin.token), 'no keys in the admin page');
  await snap(ADM.page, '07-admin-sessions');
  return { rows: rows.length };
});
await check('admin revoke: B loses access at once and sees the reason', async () => {
  const t = Date.now();
  const button = await ADM.page.$('table.admin-sessions tbody tr:has-text("Клиент Тест") [data-revoke]');
  await button.click(); // arm
  await ADM.page.click('table.admin-sessions tbody tr:has-text("Клиент Тест") [data-revoke]'); // confirm
  await B.page.waitForSelector('#gate:not([hidden])', { timeout: 15000 });
  const notice = await B.page.textContent('#gateNotice');
  assert(notice.includes('администратором'), notice);
  return { kickMs: Date.now() - t };
});
await check('admin disable key: sign-in refused afterwards; enable restores it', async () => {
  await signIn(B.page, customer.token);
  await liveRows(B.page);
  await ADM.page.click('#sessRefresh');
  await sleep(500);
  await ADM.page.click(`[data-key-disable="${customer.id}"]`);
  await ADM.page.click(`[data-key-disable="${customer.id}"]`);
  await B.page.waitForSelector('#gate:not([hidden])', { timeout: 15000 });
  await signIn(B.page, customer.token);
  await B.page.waitForFunction(() => document.getElementById('gateError').textContent.includes('Неверный'), null, { timeout: 10000 });
  await ADM.page.waitForSelector(`[data-key-enable="${customer.id}"]`, { timeout: 10000 });
  await ADM.page.click(`[data-key-enable="${customer.id}"]`);
  await sleep(500);
  await signIn(B.page, customer.token);
  await liveRows(B.page);
});
await check('logout: session revoked, back to the gate, reload stays on the gate', async () => {
  await B.page.click('#settingsButton');
  await B.page.click('[data-settings-section="server"]');
  await B.page.waitForSelector('#accountLogout');
  await B.page.click('#accountLogout'); await B.page.click('#accountLogout');
  await B.page.waitForSelector('#gate:not([hidden])', { timeout: 10000 });
  await B.page.reload();
  await B.page.waitForSelector('#gate:not([hidden])', { timeout: 10000 });
  const notice = await B.page.evaluate(() => document.getElementById('gateNotice').hidden);
  assert(notice, 'no warning after a normal logout');
});
await check('theme toggle works in the web build', async () => {
  const before = await ADM.page.evaluate(() => document.documentElement.dataset.theme);
  await ADM.page.click('#settingsDone').catch(() => {});
  await ADM.page.click('#themeButton');
  await sleep(200);
  const after = await ADM.page.evaluate(() => document.documentElement.dataset.theme);
  assert(before !== after, `${before} → ${after}`);
  await snap(ADM.page, '08-light');
  return { before, after };
});
await check('no uncaught page errors', async () => { assert(consoleErrors.length === 0, consoleErrors.slice(0, 5).join(' || ')); });

for (const p of [A, B, ADM]) await p.context.close().catch(() => {});
await stack.stop(); await mock.close();
fs.rmSync(tmp, { recursive: true, force: true });
const passed = results.filter((r) => r.ok).length;
console.log(`\nWEB E2E: ${passed}/${results.length}`);
if (arg('json')) fs.writeFileSync(arg('json'), JSON.stringify({ at: new Date().toISOString(), passed, total: results.length, results }, null, 2));
process.exit(passed === results.length ? 0 : 1);
