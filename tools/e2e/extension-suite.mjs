#!/usr/bin/env node
// Browser end-to-end suite for the extension: real Chromium + the unpacked extension + a real server process.
//
//   node tools/e2e/extension-suite.mjs [--only E05,E06] [--json out.json]
//   EXTENSION_DIR=dist/staging-extension STAGING_URL=http://host:8080 STAGING_TOKEN=... node tools/e2e/extension-suite.mjs --remote
//
// Default mode is self-contained: it starts a mock AstekBet API (fixtures), the server, and an HTTP proxy between the
// extension and the server that can inject failures (5xx, malformed JSON, hangs, 401, cut SSE streams).
// `--remote` runs only the scenarios that make sense against an already running server (staging with real feeds): it never
// injects faults and never sends anything a normal user would not send.
//
// Every scenario reports PASS / FAIL / SKIP and the inventory ids it covers (docs/FUNCTIONAL-INVENTORY.md).
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const arg = (n, d) => { const i = process.argv.indexOf('--' + n); return i > 0 ? process.argv[i + 1] : d; };
const remote = process.argv.includes('--remote');
const only = new Set(String(arg('only', '')).split(',').filter(Boolean));
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const extensionDir = path.resolve(root, process.env.EXTENSION_DIR || 'extension');
const TOKEN = process.env.STAGING_TOKEN || 'e2e-token-0123456789abcdef';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, { timeout = 20000, every = 250, what = 'condition' } = {}) => {
  const end = Date.now() + timeout; let last;
  while (Date.now() < end) { try { last = await fn(); if (last) return last; } catch (e) { last = e; } await sleep(every); }
  throw new Error(`timed out waiting for ${what}${last instanceof Error ? ': ' + last.message : ''}`);
};

// ---------------------------------------------------------------- mock upstream (AstekBet) -----------------------
const fx = (name) => JSON.parse(readFileSync(path.join(root, 'server/test/fixtures', name), 'utf8'));
const mockState = { extraEvents: 0, scoreBump: 0, mode: 'ok' };
function liveBody() {
  const body = fx('astek-live.json');
  for (let i = 0; i < mockState.extraEvents; i++) { const e = JSON.parse(JSON.stringify(body.Value[0])); e.I = 990000 + i; e.O1 = e.O1E = `Notify Alpha ${i}`; e.O2 = e.O2E = `Notify Beta ${i}`; e.LI = 990000 + i; body.Value.push(e); }
  if (mockState.scoreBump) body.Value[0].SC.PS[2].Value.S1 = 70 + mockState.scoreBump;
  return JSON.stringify(body);
}
const mock = http.createServer((req, res) => {
  if (mockState.mode === 'down') { req.socket.destroy(); return; }
  if (/LiveFeed\/Get1x2_VZip/.test(req.url)) return void res.writeHead(200, { 'content-type': 'application/json' }).end(liveBody());
  if (/LineFeed\/GetChampsZip/.test(req.url)) return void res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(fx('astek-champs.json')));
  if (/LineFeed\/Get1x2_VZip/.test(req.url)) {
    const games = fx('astek-prematch-games.json');
    games.Value.forEach((g, i) => { g.S = Math.floor(Date.now() / 1000) + 3600 * (i + 2); });   // fixtures are dated; make them upcoming
    return void res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(games));
  }
  res.writeHead(404).end('{}');
});

// ---------------------------------------------------------------- fault-injecting proxy ---------------------------
const proxyState = { mode: 'pass', hits: new Map(), sseConnects: 0, sse: new Set(), liveProviders: [], streamProviders: [] };
const hit = (p) => proxyState.hits.set(p, (proxyState.hits.get(p) || 0) + 1);
let serverPort = 0;
const proxy = http.createServer((req, res) => {
  const p = req.url.split('?')[0]; hit(p);
  if (p === '/api/ui/live') proxyState.liveProviders.push(new URL(req.url, 'http://x').searchParams.get('provider') || '');
  if (p === '/api/feed-stream') proxyState.streamProviders.push(new URL(req.url, 'http://x').searchParams.get('provider') || '');
  const apiUi = p.startsWith('/api/ui/') || p === '/api/leagues';
  if (p === '/api/feed-stream' && req.method === 'GET') { proxyState.sseConnects++; proxyState.sse.add(res); res.on('close', () => proxyState.sse.delete(res)); }
  const m = proxyState.mode;
  if (m === 'http500' && (apiUi || p === '/api/feed-stream')) return void res.writeHead(500, { 'content-type': 'application/json' }).end('{"error":"boom"}');
  if (m === 'malformed' && apiUi) return void res.writeHead(200, { 'content-type': 'application/json' }).end('<html>not json');
  if (m === 'hang' && (apiUi || p === '/api/feed-stream')) return;
  if (m === 'unauthorized') return void res.writeHead(401, { 'content-type': 'application/json' }).end('{"ok":false,"error":"Требуется токен доступа.","code":"unauthorized"}');
  const up = http.request({ host: '127.0.0.1', port: serverPort, path: req.url, method: req.method, headers: req.headers }, (r) => {
    res.writeHead(r.statusCode, r.headers);
    if (m === 'sse-stall' && p === '/api/feed-stream' && req.method === 'GET') { const started = Date.now(); r.on('data', (chunk) => { if (Date.now() - started < 3000 && !res.destroyed) res.write(chunk); }); r.on('error', () => {}); res.on('close', () => up.destroy()); return; }   // connection stays open, bytes stop (half-dead server / NAT)
    r.pipe(res);
    r.on('error', () => res.destroy());
    if (m === 'sse-cut' && p === '/api/feed-stream') setTimeout(() => { res.destroy(); up.destroy(); }, 4000);
  });
  up.on('error', () => { if (!res.headersSent) res.writeHead(502).end('{"error":"bad gateway"}'); else res.destroy(); });
  req.pipe(up);
});

// ---------------------------------------------------------------- server process ---------------------------------------
const dataDir = mkdtempSync(path.join(tmpdir(), 'e2e-data-'));
const profile = mkdtempSync(path.join(tmpdir(), 'e2e-profile-'));
let child = null, serverLog = '';
function startServer() {
  child = spawn('node', ['src/index.js'], { cwd: path.join(root, 'server'), stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, DATA_DIR: dataDir, PORT: String(serverPort), API_TOKEN: TOKEN,
    ASTEK_ORIGINS: `http://127.0.0.1:${mock.address().port}`, FONBET_URLS: `http://127.0.0.1:${mock.address().port}/none`, FONBET_DELTA_URLS: `http://127.0.0.1:${mock.address().port}/none`,
    FONBET_RESULTS_URLS: `http://127.0.0.1:${mock.address().port}/none`, GGBET_LIVE_ENABLED: '0', DATABET_LIVE_ENABLED: '0', LOG_LEVEL: 'info', NODE_OPTIONS: '--disable-warning=ExperimentalWarning' } });
  child.stdout.on('data', (d) => { serverLog += d; }); child.stderr.on('data', (d) => { serverLog += d; });
}
const stopServer = async (signal = 'SIGTERM') => { if (!child) return; const c = child; child = null; c.kill(signal); await new Promise((r) => c.once('exit', r)); };
const serverHealth = async (base = `http://127.0.0.1:${serverPort}`) => { try { return await (await fetch(base + '/health', { signal: AbortSignal.timeout(4000) })).json(); } catch { return null; } };

// ---------------------------------------------------------------- browser helpers ---------------------------------------
let context, extensionId, directBase, proxyBase;
const base = () => (remote ? process.env.STAGING_URL.replace(/\/+$/, '') : proxyBase);
const swHandle = async () => { let [w] = context.serviceWorkers(); if (!w) w = await context.waitForEvent('serviceworker', { timeout: 20000 }); return w; };
// The worker can be stopped/restarted by the browser at any moment; retry on a fresh handle when the old context is gone.
const swEval = async (fn, arg2) => {
  let last;
  for (let attempt = 0; attempt < 6; attempt++) {
    try { const w = context.serviceWorkers().at(-1) || await swHandle(); return await w.evaluate(fn, arg2); }
    catch (e) { last = e; if (!/Execution context was destroyed|Target closed|has been closed|detached/i.test(String(e.message))) throw e; await sleep(1000); }
  }
  throw last;
};
const setServer = (token = TOKEN) => swEval(async ([b, t]) => { await chrome.storage.local.set({ server: { base: b, token: t } }); }, [base(), token]);
async function openApp() {
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource|net::ERR/.test(m.text())) errors.push('console: ' + m.text()); });
  await page.goto(`chrome-extension://${extensionId}/app.html`);
  page.errors = errors;
  await page.waitForSelector('#tabs [data-tab="live"]');
  if (await page.locator('#tabs [data-tab="live"]').isVisible()) await page.click('#tabs [data-tab="live"]');
  return page;
}
async function launch() {
  context = await chromium.launchPersistentContext(profile, { headless: false, args: ['--headless=new', '--no-sandbox', `--disable-extensions-except=${extensionDir}`, `--load-extension=${extensionDir}`] });
  const worker = await swHandle(); extensionId = new URL(worker.url()).host;
}
// Local fixtures have 12 LIVE matches; staging has whatever is live right now.
const LIVE_MIN = remote ? 1 : 12;
const cards = (page) => page.locator('#content .list:not([hidden]) article.match').count();
// In-page timing: run `action`, then poll every animation frame until `condition` holds (ms, or -1 on timeout).
const timed = (page, action, condition, timeout = 10000) => page.evaluate(async ({ action, condition, timeout }) => { const act = new Function(action), cond = new Function(`return (${condition})`), t0 = performance.now(); act(); while (performance.now() - t0 < timeout) { await new Promise((r) => requestAnimationFrame(r)); try { if (cond()) return Math.round(performance.now() - t0); } catch {} } return -1; }, { action, condition, timeout });
const clickTab = async (page, tab) => { await page.click(`#tabs [data-tab="${tab}"]`); await sleep(700); };
// A provider (e.g. Fonbet) failing upstream is also surfaced as `transportError`; only these texts mean the SERVER is unreachable/broken.
const dropStreams = () => { for (const res of [...proxyState.sse]) res.destroy(); };   // a failing server does not keep old streams open
// Since extension 8.2.x network failures reach the user in Russian (ServerConfig.errorText): match both wordings.
const isDown = (err) => /Failed to fetch|HTTP (?:401|5\d\d)|aborted|timed? ?out|Unexpected token|not valid JSON|is not JSON|Нет списка|сервер недоступен|сервер не ответил вовремя/i.test(String(err || ''));
const swState = (key) => swEval((k) => { try { const c = cache[k]; return c ? { events: (c.events || []).length, transportError: c.transportError || '', stale: !!c.stale, receivedAt: c.receivedAt || 0 } : null; } catch (e) { return { error: String(e) }; } }, key);

// ---------------------------------------------------------------- scenarios ------------------------------------------------
const results = [];
const scenarios = [];
const scenario = (id, covers, title, fn, { needsMock = true } = {}) => scenarios.push({ id, covers, title, fn, needsMock });

scenario('E01', 'X1 X2', 'extension loads, service worker runs, LIVE cards render from the server feed, SSE is connected', async () => {
  const page = await openApp();
  await until(async () => (await cards(page)) >= LIVE_MIN, { what: `${LIVE_MIN} LIVE rows` });
  if (!remote) await until(async () => ((await serverHealth())?.sse?.open ?? 0) >= 1, { what: 'an SSE client on the server' });
  if (page.errors.length) throw new Error(page.errors.join(' | '));
  await page.close();
});

scenario('E02', 'X1', 'every section opens without script errors (LIVE, Line, Results, Compare, History; Settings: league links, diagnostics)', async () => {
  const page = await openApp();
  await until(async () => (await cards(page)) > 0 || remote, { what: 'cards' });
  const shown = [];
  for (const tab of ['results', 'prematch', 'history', 'compare', 'live']) {
    await clickTab(page, tab);
    const ok = await page.evaluate((t) => document.querySelector(`#tabs [data-tab="${t}"]`).getAttribute('aria-current') === 'page' && !document.querySelector(`#content .list[data-view="${t}"]`).hidden, tab);
    if (!ok) throw new Error(`section ${tab} is not shown`); shown.push(tab);
  }
  await page.click('#settingsButton');
  for (const section of ['leagues', 'diagnostics', 'sources', 'server']) { await page.click(`[data-settings-section="${section}"]`); await sleep(700); shown.push('settings:' + section); }
  await page.click('#settingsDone');
  results.note = `opened: ${shown.join(', ')}`;
  if (page.errors.length) throw new Error(page.errors.join(' | '));
  await page.close();
});

scenario('E03', 'X1', 'Line (prematch) tab shows fixtures from the feed', async () => {
  const page = await openApp();
  await clickTab(page, 'prematch');
  // Line groups are collapsed by default, so count the rows the view reports instead of expanded cards.
  await until(async () => Number((await page.textContent('#viewCount')).replace(/\D/g, '')) > 0, { timeout: 25000, what: 'fixtures in the Line view' });
  await page.close();
});

scenario('E04', 'X2 X4', 'a score change on the server reaches an open page through the SSE push path (no reload)', async () => {
  const page = await openApp();
  await until(async () => (await cards(page)) >= 12, { what: 'LIVE cards' });
  const card = page.locator('article.match', { hasText: 'Two Move' }).first();
  mockState.scoreBump = 7;
  await until(async () => (await card.innerHTML()).includes('77'), { timeout: 30000, what: 'updated map score 77 on the row' });
  mockState.scoreBump = 0;
  await page.close();
});

scenario('E05', 'X2', 'server killed (SIGKILL) and restarted: extension reports the outage and recovers by itself', async () => {
  const page = await openApp();
  await until(async () => (await cards(page)) >= 12, { what: 'LIVE cards' });
  await stopServer('SIGKILL');
  await until(async () => isDown((await swState('live'))?.transportError), { timeout: 90000, what: 'transport error in the service worker' });
  const cardsDuring = await cards(page);
  if (cardsDuring < 12) throw new Error(`cards vanished during the outage (${cardsDuring})`);
  await until(async () => page.evaluate(() => !document.getElementById('banner').hidden && /Нет связи|Сервер недоступен/.test(document.getElementById('banner').textContent)), { timeout: 30000, what: 'the server-unavailable banner' });
  startServer();
  const t0 = Date.now();
  await until(async () => { const s = await swState('live'); return s && !isDown(s.transportError) && s.events >= 12; }, { timeout: 90000, what: 'recovery after the server restart' });
  await until(async () => ((await serverHealth())?.sse?.open ?? 0) >= 1, { timeout: 60000, what: 'SSE stream re-established' });
  await until(async () => page.evaluate(() => document.getElementById('banner').hidden), { timeout: 30000, what: 'the banner to clear after recovery' });
  results.note = `recovered ${Math.round((Date.now() - t0) / 1000)} s after the restart`;
  await page.close();
});

scenario('E06', 'X2', 'service worker idles out and is terminated by the browser, then is woken by reopening the page: feed resumes without a reinstall', async () => {
  let page = await openApp();
  await until(async () => (await cards(page)) >= 12, { what: 'LIVE cards' });
  const worker = await swHandle();
  const gone = new Promise((resolve) => worker.once('close', resolve));
  await page.close();                       // no page, no port: the worker may now idle out (about 30 s)
  await Promise.race([gone, sleep(100000).then(() => { throw new Error('the worker was never terminated by the browser'); })]);
  mockState.extraEvents = 1;
  page = await openApp();                   // connecting wakes a fresh worker
  await until(async () => (await cards(page)) >= 13, { timeout: 60000, what: 'a fixture added while the worker was stopped' });
  mockState.extraEvents = 0;
  await page.close();
});

scenario('E07', 'X3', 'a new LIVE fixture raises exactly one browser notification (chrome.notifications) when LIVE notifications are on', async () => {
  const page = await openApp();
  await until(async () => (await cards(page)) >= 12, { what: 'LIVE cards' });
  await swEval(async () => { for (const id of Object.keys(await chrome.notifications.getAll())) await chrome.notifications.clear(id); });
  await page.evaluate(async () => { prefs.notifications = { ...prefs.notifications, live: true }; await chrome.storage.local.set({ prefs }); });
  await sleep(2000);
  mockState.extraEvents = 1;
  // Headless Chrome closes a notification by itself after a few seconds, so a single getAll() after a pause can see
  // none. Collect every live-* id that is ever shown instead: the new fixture must raise exactly one.
  const shown = new Set();
  const collect = async () => { for (const id of Object.keys(await swEval(() => chrome.notifications.getAll()))) if (id.startsWith('live-')) shown.add(id); return shown.size ? [...shown] : null; };
  await until(collect, { timeout: 90000, every: 250, what: 'a live notification' });
  for (const end = Date.now() + 8000; Date.now() < end;) { await collect(); await sleep(250); }
  if (shown.size !== 1) throw new Error(`expected exactly one notification, saw ${shown.size}: ${[...shown].join(', ')}`);
  mockState.extraEvents = 0;
  await swEval(async () => { for (const id of Object.keys(await chrome.notifications.getAll())) await chrome.notifications.clear(id); });
  await page.evaluate(async () => { prefs.notifications = { ...prefs.notifications, live: false }; await chrome.storage.local.set({ prefs }); });
  await page.close();
});

scenario('E08', 'X1 X9', 'settings persist in chrome.storage; the Settings view saves server address and token (custom hosts need a browser permission prompt: not automatable)', async () => {
  const page = await openApp();
  await until(async () => (await cards(page)) > 0 || remote, { what: 'cards' });
  await page.click('#settingsButton');
  await page.click('[data-settings-section="display"]');
  await page.click('#setLogos');               // a display preference, saved to chrome.storage immediately
  await sleep(500);
  await page.click('[data-settings-section="server"]');
  const before = await swEval(async () => (await chrome.storage.local.get('server')).server);
  // eslint-disable-next-line no-undef -- evaluated inside the extension page / worker, not in Node
  const defaultBase = await page.evaluate(() => ServerConfig.DEFAULT_BASE);
  await page.fill('#serverBase', defaultBase);
  await page.fill('#serverToken', 'replacement-token-1234567890');
  await Promise.all([page.waitForEvent('load'), page.click('#serverSave')]);
  const saved = await swEval(async () => (await chrome.storage.local.get(['server', 'prefs'])));
  if (saved.server.token !== 'replacement-token-1234567890' || saved.server.base !== defaultBase) throw new Error('server settings not saved: ' + JSON.stringify({ ...saved.server, token: '…' }));
  if (saved.prefs.teamLogos !== false) throw new Error('display preference not persisted');
  await swEval(async () => { const { prefs } = await chrome.storage.local.get('prefs'); await chrome.storage.local.set({ prefs: { ...prefs, teamLogos: true } }); });
  await swEval(async (b) => { await chrome.storage.local.set({ server: b }); }, before);
  await page.close();
});

scenario('E09', 'X1 X4', 'selecting a LIVE match opens the detail panel with bookmakers and priced markets (odds are on by default in 9.0)', async () => {
  const page = await openApp();
  await until(async () => (await cards(page)) >= 1, { what: 'rows' });
  await page.locator('#content .list[data-view="live"] article.match').first().click();
  // Staging has real markets; the local mock bookmaker serves none, so there the panel must say so explicitly.
  await until(async () => page.evaluate((needPrices) => !document.getElementById('detailPane').hidden && document.querySelector('#dpBooks [data-dp-book]') && (document.querySelector('#dpMarkets .outcome') || (!needPrices && document.querySelector('#dpMarkets .state') && !document.querySelector('#dpMarkets [aria-busy], #dpMarkets .skeleton'))), remote), { timeout: 20000, what: remote ? 'detail panel with priced markets' : 'detail panel with markets or an explicit no-markets state' });
  if (page.errors.length) throw new Error(page.errors.join(' | '));
  await page.close();
});

scenario('E10', 'X2', 'server answers 500: extension keeps the last data, backs off (no retry storm) and recovers', async () => {
  const page = await openApp();
  await until(async () => (await cards(page)) >= 12, { what: 'LIVE cards' });
  proxyState.mode = 'http500'; dropStreams();
  await until(async () => isDown((await swState('live'))?.transportError), { timeout: 120000, what: 'transport error' });
  const n0 = (proxyState.hits.get('/api/ui/live') || 0) + (proxyState.hits.get('/api/feed-stream') || 0);
  await sleep(40000);
  const n1 = (proxyState.hits.get('/api/ui/live') || 0) + (proxyState.hits.get('/api/feed-stream') || 0);
  if (n1 - n0 > 30) throw new Error(`retry storm: ${n1 - n0} requests in 40 s`);
  if ((await cards(page)) < 12) throw new Error('cards were dropped while the server was failing');
  results.note = `${n1 - n0} requests in 40 s while failing`;
  proxyState.mode = 'pass';
  await until(async () => { const s = await swState('live'); return s && !isDown(s.transportError); }, { timeout: 90000, what: 'recovery' });
  await page.close();
});

scenario('E11', 'X2', 'malformed (non-JSON) answer: worker survives, reports an error, recovers', async () => {
  const page = await openApp();
  await until(async () => (await cards(page)) >= 12, { what: 'LIVE cards' });
  proxyState.mode = 'malformed'; dropStreams();
  mockState.scoreBump = 3; // force a revision change so the worker must fetch the broken endpoint
  const state = await until(async () => { const s = await swState('live'); return isDown(s?.transportError) ? s : null; }, { timeout: 120000, what: 'malformed-response error' });
  results.note = `error shown: "${state.transportError.slice(0, 60)}"`;
  proxyState.mode = 'pass'; mockState.scoreBump = 0;
  await until(async () => { const s = await swState('live'); return s && !isDown(s.transportError); }, { timeout: 90000, what: 'recovery' });
  await page.close();
});

scenario('E12', 'X2', 'requests that never finish (timeout): bounded by the client timeout, then recovery', async () => {
  const page = await openApp();
  await until(async () => (await cards(page)) >= 12, { what: 'LIVE cards' });
  proxyState.mode = 'hang'; dropStreams();
  await until(async () => isDown((await swState('live'))?.transportError), { timeout: 90000, what: 'timeout error' });
  proxyState.mode = 'pass';
  await until(async () => { const s = await swState('live'); return s && !isDown(s.transportError); }, { timeout: 120000, what: 'recovery' });
  await page.close();
});

scenario('E13', 'X2', 'SSE stream cut every few seconds: reconnects with backoff, no reconnect storm', async () => {
  const page = await openApp();
  await until(async () => (await cards(page)) >= 12, { what: 'LIVE cards' });
  proxyState.sseConnects = 0; proxyState.mode = 'sse-cut'; dropStreams();
  await sleep(60000);
  const n = proxyState.sseConnects; proxyState.mode = 'pass';
  if (n > 25) throw new Error(`${n} SSE reconnects in 60 s`);
  results.note = `${n} SSE connections in 60 s while cut every 4 s`;
  await until(async () => ((await serverHealth())?.sse?.open ?? 0) >= 1, { timeout: 60000, what: 'stable SSE again' });
  await page.close();
});

scenario('E14', 'X9', '401 from the server: the server message reaches the user and feeds recover once the token is valid', async () => {
  const page = await openApp();
  await until(async () => (await cards(page)) >= 12, { what: 'LIVE cards' });
  await setServer('');
  const msg = await page.evaluate(async () => { try { await request('/api/ui/odds-watch', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"ids":[]}' }); return 'no error'; } catch (e) { return e.message; } });
  if (!/токен/i.test(msg)) throw new Error('unexpected message: ' + msg);
  await setServer(TOKEN);
  const ok = await page.evaluate(async () => { try { await request('/api/ui/odds-watch', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"ids":[]}' }); return 'ok'; } catch (e) { return e.message; } });
  if (ok !== 'ok') throw new Error('token not accepted after being restored: ' + ok);
  await page.close();
});

scenario('E15', 'X1', 'browser restart with the same profile: stored preferences and server settings survive and the feed comes back (chrome.runtime.reload() itself cannot be automated: a flag-loaded extension is not re-enabled)', async () => {
  const page = await openApp();
  await until(async () => (await cards(page)) >= LIVE_MIN, { what: 'LIVE rows' });
  await swEval(async () => { await chrome.storage.local.set({ e2eMarker: 'kept' }); });
  await page.evaluate(async () => { prefs.liveSort = 'asc'; await chrome.storage.local.set({ prefs }); });
  await sleep(800);
  await context.close();
  await launch();
  const marker = await swEval(async () => (await chrome.storage.local.get(['e2eMarker', 'prefs', 'server']))); 
  if (marker.e2eMarker !== 'kept' || marker.prefs?.liveSort !== 'asc') throw new Error('chrome.storage lost data across the browser restart');
  if (!marker.server?.base) throw new Error('server settings lost across the restart');
  const again = await openApp();
  await until(async () => (await cards(again)) >= LIVE_MIN, { timeout: 40000, what: 'rows after the browser restart' });
  await again.evaluate(async () => { prefs.liveSort = 'league'; await chrome.storage.local.set({ prefs }); });
  await again.close();
});

scenario('E16', 'X6 X9', 'secondary pages load without errors: odds generator and score history', async () => {
  for (const name of ['odds.html', 'score-history.html']) {
    const page = await context.newPage(); const problems = [];
    page.on('pageerror', (e) => problems.push(e.message));
    await page.goto(`chrome-extension://${extensionId}/${name}`); await sleep(1500);
    if (problems.length) throw new Error(`${name}: ${problems.join(' | ')}`);
    await page.close();
  }
});

scenario('E17', 'X2', 'SSE stream goes silent (half-dead connection): the worker notices and reconnects instead of waiting forever', async () => {
  const page = await openApp();
  await until(async () => (await cards(page)) >= 12, { what: 'LIVE cards' });
  proxyState.sseConnects = 0; proxyState.mode = 'sse-stall';
  await sleep(1000);
  for (const res of [...proxyState.sse]) res.destroy();   // drop the healthy stream; the worker reconnects into the stalled one
  await until(async () => proxyState.sseConnects >= 1, { timeout: 15000, what: 'the stalled connection' });
  const first = proxyState.sseConnects;
  try { await until(async () => proxyState.sseConnects > first, { timeout: 90000, what: 'a reconnect after the stream went silent' }); }
  // eslint-disable-next-line no-undef -- evaluated inside the extension page / worker, not in Node
  catch (e) { throw new Error(`${e.message}; worker state ${JSON.stringify(await swEval(() => ({ streamRunning, streamHealthy, streamFailures, ports: ports.size })))}; proxy sse connects ${proxyState.sseConnects}`); }
  proxyState.mode = 'pass';
  await page.close();
});

scenario('E18', 'X1 X2 X4', 'LIVE odds provider GGBET <-> DataBet: requests follow the choice, providers never mix, the choice survives a reopen, an unavailable provider is explicit', async () => {
  const shots = process.env.E2E_SCREENSHOTS || '';
  const shot = async (page, name) => { if (shots) await page.screenshot({ path: path.join(shots, name) }); };
  const rowSources = (page) => page.$$eval('#content .list[data-view="live"] article.match [data-source-ref]', (rows) => [...new Set(rows.map((r) => r.dataset.sourceRef.split(':')[0]))]);
  const pressed = (page) => page.evaluate(() => ({ ggbet: document.getElementById('ggbet').getAttribute('aria-pressed'), databet: document.getElementById('databet').getAttribute('aria-pressed') }));
  const notice = (page) => page.evaluate(() => { const n = document.getElementById('providerNotice'); return n && !n.hidden ? n.textContent : ''; });
  let page = await openApp();
  await until(async () => (await cards(page)) >= 1, { what: 'LIVE cards' });
  if ((await pressed(page)).databet === 'true') { await page.click('#ggbet'); await sleep(1500); }
  await until(async () => (await pressed(page)).ggbet === 'true', { what: 'GGBET selected' });
  await until(async () => !(await rowSources(page)).includes('databet'), { what: 'no DataBet rows while GGBET is selected' });
  await shot(page, 'provider-ggbet-selected.png');
  // Switch to DataBet.
  proxyState.liveProviders.length = 0; proxyState.streamProviders.length = 0;
  await page.click('#databet');
  await until(async () => (await pressed(page)).databet === 'true' && (await pressed(page)).ggbet === 'false', { what: 'DataBet selected' });
  await until(async () => remote || (proxyState.liveProviders.includes('databet') && proxyState.streamProviders.includes('databet')), { what: 'LIVE feed and stream requested for DataBet' });
  if (!remote && proxyState.liveProviders.some((p) => p !== 'databet')) throw new Error('a LIVE request after the switch did not name DataBet: ' + proxyState.liveProviders.join(','));
  await until(async () => (await cards(page)) >= 1, { what: 'LIVE cards after the switch' });
  await until(async () => !(await rowSources(page)).includes('ggbet'), { what: 'no GGBET rows while DataBet is selected' });
  // Staging: DataBet rows from the real feed, or (when its upstream is down) the explicit "unavailable" notice.
  if (remote) await until(async () => (await rowSources(page)).includes('databet') || /DataBet временно недоступен/.test(await notice(page)), { timeout: 30000, what: 'DataBet rows or the explicit DataBet-unavailable notice' });
  else await until(async () => /DataBet временно недоступен/.test(await notice(page)), { what: 'explicit "DataBet unavailable" notice (DataBet is disabled on the local server)' });
  // A provider outage is not a server outage: the server banner stays hidden and the other bookmakers keep their rows.
  if (await page.evaluate(() => !document.getElementById('banner').hidden)) throw new Error('provider outage shown as a server outage');
  if ((await cards(page)) < 1) throw new Error('rows vanished while the provider is unavailable');
  await shot(page, remote ? 'provider-databet-selected.png' : 'provider-databet-unavailable.png');
  // The choice survives closing and reopening the extension page.
  await page.close(); page = await openApp();
  await until(async () => (await pressed(page)).databet === 'true', { what: 'DataBet still selected after reopen' });
  const stored = await swEval(async () => (await chrome.storage.local.get('prefs')).prefs?.liveOddsProvider);
  if (stored !== 'databet') throw new Error('stored provider is ' + stored);
  // Switch back to GGBET from the notice / selector.
  if (!remote && await notice(page)) await page.click('#providerNotice [data-switch-provider="ggbet"]'); else await page.click('#ggbet');
  await until(async () => (await pressed(page)).ggbet === 'true' && (await pressed(page)).databet === 'false', { what: 'GGBET selected again' });
  await until(async () => !(await rowSources(page)).includes('databet') && !/DataBet временно недоступен/.test(await notice(page)), { what: 'GGBET view without DataBet rows or the DataBet notice' });
  if (remote) await until(async () => (await rowSources(page)).includes('ggbet') || /GGBET временно недоступен/.test(await notice(page)), { timeout: 30000, what: 'GGBET rows or the explicit GGBET-unavailable notice' });
  if (page.errors.length) throw new Error(page.errors.join(' | '));
  await page.close();
});

scenario('E19', 'P1', 'instant navigation: once a section has been visited, switching to it paints in under 100 ms (no network wait)', async () => {
  const page = await openApp();
  await until(async () => (await cards(page)) >= 1, { what: 'rows' });
  const tabs = ['prematch', 'results', 'compare', 'history', 'live'];
  for (const tab of tabs) { await clickTab(page, tab); await sleep(remote ? 2500 : 1200); }   // warm every section once
  const runs = Object.fromEntries(tabs.map((t) => [t, []]));
  for (let round = 0; round < 3; round++) for (const tab of tabs) {
    runs[tab].push(await timed(page, `document.querySelector('#tabs [data-tab="${tab}"]').click()`, `document.querySelector('#tabs [data-tab="${tab}"]').getAttribute('aria-current')==='page' && !document.querySelector('#content .list[data-view="${tab}"]').hidden && document.querySelector('#content .list[data-view="${tab}"]').childElementCount > 0`));
    await sleep(300);
  }
  const times = Object.fromEntries(tabs.map((t) => [t, [...runs[t]].sort((a, b) => a - b)[1]]));   // median of 3
  results.note = Object.entries(times).map(([k, v]) => `${k} ${v} ms`).join(', ');
  const slow = Object.entries(times).filter(([, v]) => v < 0 || v > 100);
  if (slow.length) throw new Error('slow switches: ' + results.note);
  if (page.errors.length) throw new Error(page.errors.join(' | '));
  await page.close();
});

scenario('E20', 'P2 X4', 'cached detail: reopening a match renders from cache in under 100 ms and is refreshed in the background (stale-while-revalidate)', async () => {
  const page = await openApp();
  await until(async () => (await cards(page)) >= 2, { what: 'two rows' });
  const rows = page.locator('#content .list[data-view="live"] article.match');
  const first = await rows.nth(0).getAttribute('data-id');
  await rows.nth(0).click();
  const ready = remote ? `document.querySelector('#dpMarkets .outcome')` : `(document.querySelector('#dpMarkets .outcome') || document.querySelector('#dpMarkets .state')) && !document.querySelector('#dpMarkets .skeleton')`;
  await until(async () => page.evaluate((c) => new Function(`return (${c})`)(), ready), { timeout: 20000, what: 'markets (or the explicit no-markets state) of the first match' });
  await rows.nth(1).click(); await sleep(1500);
  const click = (id) => `document.querySelector(${JSON.stringify(`#content .list[data-view="live"] [data-id="${id}"]`)}).click()`;
  const ms = await timed(page, click(first), `DetailPanel.currentId()===${JSON.stringify(first)} && ${ready}`);
  results.note = `cached reopen ${ms} ms`;
  if (ms < 0 || ms > 100) throw new Error(`cached detail took ${ms} ms`);
  await page.close();
});

scenario('E21', 'X1', 'filters and the chosen detail tab persist across sections and a reload', async () => {
  let page = await openApp();
  await until(async () => (await cards(page)) >= 1, { what: 'rows' });
  const name = (await page.locator('#content .list[data-view="live"] article.match .team .name').first().textContent()).trim();
  await page.fill('#search', name.slice(0, 6)); await sleep(400);
  await clickTab(page, 'results'); await sleep(300); await clickTab(page, 'live');
  if ((await page.inputValue('#search')) !== name.slice(0, 6)) throw new Error('LIVE search was not kept across sections');
  await page.locator('#content .list[data-view="live"] article.match').first().click();
  await until(async () => page.locator('#dpTabs [data-dp-tab="info"]').count(), { what: 'detail tabs' });
  await page.click('#dpTabs [data-dp-tab="info"]'); await sleep(400);
  await page.close(); page = await openApp();
  await until(async () => (await page.inputValue('#search')) === name.slice(0, 6), { what: 'search restored after reopening' });
  await page.locator('#content .list[data-view="live"] article.match').first().click();
  await until(async () => page.evaluate(() => document.querySelector('#dpTabs [data-dp-tab="info"]')?.getAttribute('aria-selected') === 'true'), { what: 'detail tab restored' });
  await page.fill('#search', ''); await page.click('#dpTabs [data-dp-tab="odds"]'); await sleep(400);
  await page.close();
});

scenario('E22', 'P3 X2', 'cold start while the server is down: the last-known LIVE list renders at once (marked as saved), and the outage is explicit', async () => {
  let page = await openApp();
  await until(async () => (await cards(page)) >= 12, { what: 'LIVE rows' });
  await sleep(1500); await page.close();
  await stopServer('SIGKILL');
  page = await openApp();
  const ms = await page.evaluate(async () => { const t0 = performance.now(); while (performance.now() - t0 < 5000) { if (document.querySelectorAll('#content .list[data-view="live"] article.match').length >= 12) return Math.round(performance.now()); await new Promise((r) => requestAnimationFrame(r)); } return -1; });
  if (ms < 0) throw new Error('no last-known rows while the server is down');
  if (!/сохранено|обновлено/.test(await page.textContent('#viewUpdated'))) throw new Error('saved data is not labelled');
  results.note = `last-known rows painted at ${ms} ms after navigation`;
  startServer();
  await until(async () => { const s = await swState('live'); return s && !isDown(s.transportError) && s.events >= 12; }, { timeout: 90000, what: 'recovery' });
  await page.close();
});

// ---------------------------------------------------------------- runner ---------------------------------------------------
const report = [];
try {
  if (!remote) {
    await new Promise((r) => mock.listen(0, '127.0.0.1', r));
    serverPort = 19700 + Math.floor(Math.random() * 200);
    startServer();
    for (let i = 0; i < 80 && !(await serverHealth()); i++) await sleep(250);
    await new Promise((r) => proxy.listen(0, '127.0.0.1', r));
    proxyBase = `http://127.0.0.1:${proxy.address().port}`;
  } else if (!process.env.STAGING_URL) throw new Error('--remote needs STAGING_URL (and STAGING_TOKEN)');
  await launch();
  await setServer();
  const remoteOk = new Set(['E01', 'E02', 'E03', 'E08', 'E09', 'E15', 'E16', 'E18', 'E19', 'E20', 'E21']);
  for (const s of scenarios) {
    if (only.size && !only.has(s.id)) continue;
    if (s.id === 'E06' && !only.has('E06')) { report.push({ id: s.id, covers: s.covers, title: s.title, status: 'SKIP', detail: 'NOT VERIFIABLE HERE: Playwright/CDP keeps the extension worker alive, so the browser never idles it out (and forcing it with ServiceWorker.stopAllWorkers leaves it unrecoverable); run with --only E06 on a real browser' }); console.log(`SKIP  E06  ${s.title}`); continue; }
    if (remote && !remoteOk.has(s.id)) { report.push({ id: s.id, covers: s.covers, title: s.title, status: 'SKIP', detail: 'fault injection needs the self-contained mode' }); continue; }
    const t0 = Date.now(); results.note = '';
    try { await Promise.race([s.fn(), new Promise((_, reject) => setTimeout(() => reject(new Error('scenario exceeded its 240 s budget')), 240000))]); report.push({ id: s.id, covers: s.covers, title: s.title, status: 'PASS', seconds: Math.round((Date.now() - t0) / 1000), detail: results.note }); }
    catch (e) { report.push({ id: s.id, covers: s.covers, title: s.title, status: 'FAIL', seconds: Math.round((Date.now() - t0) / 1000), detail: String(e.message || e).slice(0, 400) }); }
    // Leave the environment healthy for the next scenario.
    proxyState.mode = 'pass'; mockState.extraEvents = 0; mockState.scoreBump = 0; mockState.mode = 'ok';
    if (!remote && !child) { startServer(); for (let i = 0; i < 80 && !(await serverHealth()); i++) await sleep(250); }
    await setServer().catch(() => {});
    const last = report.at(-1); console.log(`${last.status}  ${last.id}  [${last.covers}]  ${last.title}  (${last.seconds ?? 0}s)${last.detail ? '\n        ' + last.detail : ''}`);
  }
} catch (e) { console.error('suite aborted:', e.message); report.push({ id: 'SETUP', status: 'FAIL', detail: e.message }); }
finally {
  await context?.close().catch(() => {}); await stopServer(); mock.close(); proxy.close();
  rmSync(dataDir, { recursive: true, force: true }); rmSync(profile, { recursive: true, force: true });
}
const jsonOut = arg('json', ''); if (jsonOut) writeFileSync(jsonOut, JSON.stringify(report, null, 2));
const failed = report.filter((r) => r.status === 'FAIL');
console.log(`\n${report.filter((r) => r.status === 'PASS').length} passed, ${failed.length} failed, ${report.filter((r) => r.status === 'SKIP').length} skipped`);
process.exit(failed.length ? 1 : 0);
