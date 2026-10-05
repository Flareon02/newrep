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
  // Full market tree of a LIVE match (the detail panel): winner, 30 total lines, 10 handicap lines.
  if (/LiveFeed\/GetGameZip/.test(req.url)) {
    const id = Number(new URL(req.url, 'http://x').searchParams.get('id')) || 1;
    const totals = Array.from({ length: 30 }, (_, i) => ({ G: 17, E: [[{ G: 17, T: 9, P: 10.5 + i, C: 1.5 + i / 40 }], [{ G: 17, T: 10, P: 10.5 + i, C: 2.6 - i / 40 }]] }));
    const hcp = Array.from({ length: 10 }, (_, i) => ({ G: 2, E: [[{ G: 2, T: 7, P: -(i + 0.5), C: 1.6 + i / 20 }], [{ G: 2, T: 8, P: i + 0.5, C: 2.3 - i / 20 }]] }));
    return void res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ Success: true, Value: { I: id, O1E: 'Alpha', O2E: 'Beta', GE: [{ G: 1, E: [[{ G: 1, T: 1, C: 1.85 }], [{ G: 1, T: 3, C: 1.95 }]] }, ...totals, ...hcp] } }));
  }
  if (/LineFeed\/GetChampsZip/.test(req.url)) return void res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(fx('astek-champs.json')));
  if (/LineFeed\/Get1x2_VZip/.test(req.url)) {
    const games = fx('astek-prematch-games.json');
    games.Value.forEach((g, i) => { g.S = Math.floor(Date.now() / 1000) + 3600 * (i + 2); });   // fixtures are dated; make them upcoming
    return void res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(games));
  }
  res.writeHead(404).end('{}');
});

// ---------------------------------------------------------------- fault-injecting proxy ---------------------------
const proxyState = { mode: 'pass', hits: new Map(), sseConnects: 0, sse: new Set(), liveProviders: [], streamProviders: [], fullMarkets: [], details: [] };
const hit = (p) => proxyState.hits.set(p, (proxyState.hits.get(p) || 0) + 1);
let serverPort = 0;
const proxy = http.createServer((req, res) => {
  const p = req.url.split('?')[0]; hit(p);
  if (p === '/api/ui/live') proxyState.liveProviders.push(new URL(req.url, 'http://x').searchParams.get('provider') || '');
  if (p === '/api/feed-stream') proxyState.streamProviders.push(new URL(req.url, 'http://x').searchParams.get('provider') || '');
  if (p === '/api/ui/event-detail') proxyState.details.push(Object.fromEntries(new URL(req.url, 'http://x').searchParams));
  if (p === '/api/ui/full-markets' && req.method === 'POST') { const chunks = []; req.on('data', (c) => chunks.push(c)); req.on('end', () => { try { proxyState.fullMarkets.push({ at: Date.now(), ...JSON.parse(Buffer.concat(chunks).toString('utf8')) }); } catch {} }); }
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
const serverHealth = async (base = `http://127.0.0.1:${serverPort}`) => { try { return await (await fetch(base + '/health', { headers: { authorization: 'Bearer ' + TOKEN }, signal: AbortSignal.timeout(4000) })).json(); } catch { return null; } };

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
  await page.waitForSelector('#tabs [data-tab="live"]', { state: 'attached' });
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
  if (!/ключ доступа/i.test(msg) || /https?:|Bearer|API_TOKEN/i.test(msg)) throw new Error('unexpected message: ' + msg);
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

scenario('E18', 'X1 X2 X4', 'LIVE odds provider is GGBET only (9.3): DataBet is offered and requested nowhere, a stored DataBet preference migrates to GGBET, the GGBET switch is a display preference that leaves the feed unchanged', async () => {
  const shots = process.env.E2E_SCREENSHOTS || '';
  const shot = async (page, name) => { if (shots) await page.screenshot({ path: path.join(shots, name) }); };
  const liveCols = (page) => page.$$eval('#content .list[data-view="live"] .col-head .book-col', (n) => n.map((x) => x.textContent.trim()));
  // An old profile that had chosen DataBet in 9.2.
  await swEval(async () => { const p = (await chrome.storage.local.get('prefs')).prefs || {}; await chrome.storage.local.set({ prefs: { ...p, liveOddsProvider: 'databet', liveOddsMode: 'databet', databet: true } }); });
  proxyState.liveProviders.length = 0; proxyState.streamProviders.length = 0;
  let page = await openApp();
  await until(async () => (await cards(page)) >= 1, { what: 'LIVE cards' });
  if (await page.locator('#oddsSource, #ggbet, #databet, [data-odds-mode]').count()) throw new Error('a GGBET/DataBet provider switch is still present');
  await until(async () => (await swEval(async () => (await chrome.storage.local.get('prefs')).prefs?.liveOddsProvider)) === 'ggbet', { what: 'stored DataBet preference migrated to GGBET' });
  const stored = await swEval(async () => (await chrome.storage.local.get('prefs')).prefs);
  if ('databet' in stored || 'liveOddsMode' in stored) throw new Error('DataBet preferences kept: ' + JSON.stringify({ databet: stored.databet, mode: stored.liveOddsMode }));
  await until(async () => remote || (proxyState.liveProviders.length > 0 && proxyState.streamProviders.length > 0), { what: 'LIVE feed and stream requests' });
  if (!remote && [...proxyState.liveProviders, ...proxyState.streamProviders].some((p) => p !== 'ggbet')) throw new Error('a LIVE/stream request did not name GGBET: ' + [...proxyState.liveProviders, ...proxyState.streamProviders].join(','));
  if (/DataBet/i.test(await page.evaluate(() => document.body.innerText))) throw new Error('DataBet is visible on the main screen');
  // Settings → Источники: GGBET has its own switch; switching it off hides its column, the network does not change.
  await page.click('#settingsButton'); await sleep(400); await page.click('[data-settings-section="sources"]'); await sleep(400);
  const settingsText = await page.textContent('#settingsView');
  if (/DataBet/i.test(settingsText) || !/GGBET/.test(settingsText)) throw new Error('Settings → Источники must list GGBET and no DataBet');
  if (!(await page.locator('[data-book-setting="ggbet"]').count())) throw new Error('no GGBET switch in Settings');
  await shot(page, 'sources-ggbet-switch.png');
  const before = proxyState.liveProviders.length;
  await page.click('[data-book-setting="ggbet"]'); await sleep(500); await page.click('#settingsDone'); await sleep(600);
  if ((await swEval(async () => (await chrome.storage.local.get('prefs')).prefs?.ggbet)) !== false) throw new Error('GGBET off was not saved');
  if (!remote && (await liveCols(page)).includes('GGBET')) throw new Error('GGBET column still shown while switched off');
  await sleep(1500);
  if (!remote && proxyState.liveProviders.slice(before).some((p) => p !== 'ggbet')) throw new Error('switching GGBET off changed the feed provider');
  await page.close(); page = await openApp(); await until(async () => (await cards(page)) >= 1, { what: 'LIVE cards after reopen' });
  if ((await swEval(async () => (await chrome.storage.local.get('prefs')).prefs?.ggbet)) !== false) throw new Error('GGBET off did not survive a reopen');
  await page.click('#settingsButton'); await sleep(400); await page.click('[data-settings-section="sources"]'); await sleep(400);
  await page.click('[data-book-setting="ggbet"]'); await sleep(500); await page.click('#settingsDone'); await sleep(600);
  if ((await swEval(async () => (await chrome.storage.local.get('prefs')).prefs?.ggbet)) !== true) throw new Error('GGBET on was not saved');
  if (page.errors.length) throw new Error(page.errors.join(' | '));
  results.note = `LIVE requests: ${[...new Set(proxyState.liveProviders)].join(',') || 'remote'}`;
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

scenario('E23', 'X4', 'GGBET full-market lease follows the detail panel: acquire on open, moved on switch, renewed, released on close; a hover prefetch never carries the lease', async () => {
  const page = await openApp();
  await until(async () => (await cards(page)) >= 2, { what: 'two rows' });
  proxyState.fullMarkets.length = 0; proxyState.details.length = 0;
  const rows = page.locator('#content .list[data-view="live"] article.match');
  const [a, b] = [await rows.nth(0).getAttribute('data-id'), await rows.nth(1).getAttribute('data-id')];
  // Hover prefetch of a row that is not open: its detail request has no lease and no lease call is made.
  await rows.nth(1).hover(); await sleep(900);
  if (proxyState.fullMarkets.length) throw new Error('a hover made a lease call');
  if (proxyState.details.some((d) => d.lease)) throw new Error('a hover prefetch carried the lease');
  await rows.nth(0).click();
  await until(async () => proxyState.fullMarkets.some((x) => x.action === 'acquire' && x.id === a), { what: 'acquire for the opened match' });
  const lease = proxyState.fullMarkets.find((x) => x.action === 'acquire').lease;
  if (!/^[\w-]{8,64}$/.test(lease || '')) throw new Error('bad lease id');
  const acquire = proxyState.fullMarkets.find((x) => x.action === 'acquire');
  if (acquire.provider !== 'ggbet' || acquire.view !== 'live') throw new Error(`acquire for ${acquire.provider}/${acquire.view}`);
  await rows.nth(1).click();
  await until(async () => proxyState.fullMarkets.some((x) => x.action === 'acquire' && x.id === b && x.lease === lease), { what: 'the same lease moved to the second match' });
  if (!proxyState.details.some((d) => d.id === a && d.lease === lease)) throw new Error('the panel detail request did not carry the lease');
  // Renewal by the panel's 10 s refresh.
  const before = proxyState.fullMarkets.filter((x) => x.action === 'acquire' && x.id === b).length;
  await until(async () => proxyState.fullMarkets.filter((x) => x.action === 'acquire' && x.id === b).length > before, { timeout: 15000, what: 'a renewal within ~10 s' });
  await page.locator('#detailPane [data-dp="close"]').first().click();
  await until(async () => proxyState.fullMarkets.some((x) => x.action === 'release' && x.lease === lease), { what: 'release on close' });
  const released = proxyState.fullMarkets.find((x) => x.action === 'release').at;
  await sleep(11000);
  if (proxyState.fullMarkets.some((x) => x.action === 'acquire' && x.lease === lease && x.at > released)) throw new Error('renewed after the panel was closed');
  results.note = `lease calls: ${proxyState.fullMarkets.map((x) => x.action).join(', ')}`;
  await page.close();
});

// Holding ArrowDown over a long LIVE list: the handler must stay cheap (no full list render, no layout per row, no
// network per keypress). 200 matches, 150 key repeats at the key-repeat cadence, measured inside the page.
scenario('E24', 'P1', 'keyboard: holding ArrowDown over 200 LIVE matches stays responsive (no remount, no per-key network, no long stalls)', async () => {
  mockState.extraEvents = 200;
  const page = await openApp();
  try {
    await until(async () => (await cards(page)) >= 150, { timeout: 150000, every: 1000, what: '150+ rows (200 extra matches; the server picks them up after a reset)' });
    await sleep(1500);
    const run = (withDetail) => page.evaluate(async ({ withDetail, n }) => {
      const list = document.querySelector('#content .list[data-view="live"]');
      const rows = [...list.querySelectorAll('article.match')];
      rows.forEach((r, i) => { r.__probe = i; });
      const first = rows[0]; first.focus();
      if (withDetail) { first.click(); await new Promise((r) => setTimeout(r, 800)); first.focus(); }
      const longTasks = []; const po = new PerformanceObserver((l) => { for (const e of l.getEntries()) longTasks.push(Math.round(e.duration)); });
      try { po.observe({ type: 'longtask', buffered: false }); } catch {}
      let frames = [], last = performance.now(), on = true;
      const tick = (t) => { frames.push(t - last); last = t; if (on) requestAnimationFrame(tick); }; requestAnimationFrame(tick);
      const handler = [];
      for (let i = 0; i < n; i++) {
        const target = document.activeElement || first;
        const t0 = performance.now();
        target.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', code: 'ArrowDown', bubbles: true, cancelable: true, repeat: i > 0 }));
        handler.push(performance.now() - t0);
        await new Promise((r) => setTimeout(r, 16));
      }
      document.activeElement?.dispatchEvent(new KeyboardEvent('keyup', { key: 'ArrowDown', code: 'ArrowDown', bubbles: true }));
      await new Promise((r) => setTimeout(r, 700)); on = false; po.disconnect();
      const now = [...list.querySelectorAll('article.match')], kept = now.filter((r) => r.__probe != null).length;
      const active = document.activeElement?.closest?.('article.match'), sel = list.querySelector('article.match[aria-selected="true"]');
      const sorted = [...handler].sort((a, b) => a - b);
      return { rows: rows.length, kept, activeIndex: active ? now.indexOf(active) : -1, selectedIndex: sel ? now.indexOf(sel) : -1,
        handlerMedian: Math.round(sorted[Math.floor(sorted.length / 2)] * 10) / 10, handlerP95: Math.round(sorted[Math.floor(sorted.length * 0.95)] * 10) / 10, handlerMax: Math.round(sorted.at(-1) * 10) / 10,
        maxFrameGap: Math.round(Math.max(...frames.slice(1))), slowFrames: frames.slice(1).filter((f) => f > 100).length, longTasks: longTasks.length, longTaskMax: Math.max(0, ...longTasks) };
    }, { withDetail, n: 150 });
    const before = { details: proxyState.details.length, leases: proxyState.fullMarkets.length };
    const plain = await run(false);
    const detailStart = { details: proxyState.details.length, leases: proxyState.fullMarkets.length };
    const detail = await run(true);
    const net = { details: proxyState.details.length - detailStart.details, leases: proxyState.fullMarkets.length - detailStart.leases, plainDetails: detailStart.details - before.details };
    results.note = `list: ${JSON.stringify(plain)} | with detail: ${JSON.stringify(detail)} | network during the detail burst: ${JSON.stringify(net)}`;
    const fails = [];
    // a row whose data changed during the burst is rebuilt (correct); the list as a whole must not be
    if (plain.kept < plain.rows - 3) fails.push(`rows remounted: ${plain.kept}/${plain.rows}`);
    if (plain.activeIndex !== Math.min(150, plain.rows - 1)) fails.push(`focus at ${plain.activeIndex}`);
    if (plain.handlerP95 > 8) fails.push(`handler p95 ${plain.handlerP95} ms`);
    // a few late frames happen on a loaded 1-vCPU host; the old handler stalled frames for 200-400 ms on every key with the detail open
    if (plain.slowFrames > 5) fails.push(`${plain.slowFrames} frames over 100 ms`);
    if (detail.slowFrames > 8) fails.push(`with detail: ${detail.slowFrames} frames over 100 ms`);
    if (detail.handlerP95 > 8) fails.push(`with detail: handler p95 ${detail.handlerP95} ms`);
    if (detail.selectedIndex !== detail.activeIndex) fails.push(`detail selection ${detail.selectedIndex} != focus ${detail.activeIndex}`);
    // bounded (the open match may also refresh on its own feed patches), never one request per key repeat
    if (net.details > 10 || net.leases > 6) fails.push(`network during the burst: ${JSON.stringify(net)}`);
    if (fails.length) throw new Error(fails.join('; '));
  } finally { mockState.extraEvents = 0; await page.close(); }
});

// A feed update (one price/score) re-renders the LIVE list: measure the full render of 200 rows and check that rows
// keep their DOM nodes (focus/hover/scroll survive) and the shell is not rebuilt.
/* eslint-disable no-undef -- the page.evaluate bodies below run inside app.html and call its own globals */
scenario('E27', 'X1', 'Line: game > league hierarchy with counts; a collapsed game stays collapsed across refreshes and a reload; expand/collapse all; arrows walk the headers', async () => {
  let page = await openApp();
  try {
    await clickTab(page, 'prematch');
    await until(async () => (await page.locator('#content .list[data-view="prematch"] details.game-group').count()) >= 1, { what: 'game groups' });
    if ((await page.locator('#content .list[data-view="prematch"] [data-line-mode], #lineMode button[aria-pressed="true"]').first().getAttribute('data-line-mode')) === 'schedule') await page.click('#lineMode [data-line-mode="leagues"]');
    const game = page.locator('#content .list[data-view="prematch"] details.game-group').first(), key = await game.getAttribute('data-group');
    const count = await game.locator(':scope > summary .n').textContent();
    if (!/\d+ матч/.test(count || '')) throw new Error(`no match count on the game header: ${count}`);
    await game.locator(':scope > summary').click(); await sleep(300);
    const isOpen = () => page.evaluate((k) => document.querySelector(`#content .list[data-view="prematch"] details[data-group="${CSS.escape(k)}"]`)?.open, key);
    if (await isOpen()) throw new Error('the game did not collapse');
    await page.evaluate(() => { viewSignatures.delete('prematch'); renderView('prematch', true); });
    await sleep(300);
    if (await isOpen()) throw new Error('a refresh reopened the collapsed game');
    await page.reload(); await page.waitForSelector('#tabs [data-tab="prematch"]'); await clickTab(page, 'prematch'); await sleep(800);
    if (await isOpen()) throw new Error('the collapsed game reopened after a reload');
    // 9.3: one fold toggle ([data-line-fold]); expanding always gives games open + leagues collapsed (no nested state restored).
    const fold = async (want) => { for (let i = 0; i < 2; i++) { const action = await page.getAttribute('[data-line-fold]', 'data-line-fold'); await page.click('[data-line-fold]'); await sleep(400); if (action === want) return; } throw new Error('fold toggle never offered ' + want); };   // one toggle: it names the action it performs (mixed state: collapse first)
    const states = () => page.evaluate(() => [...document.querySelectorAll('#content .list[data-view="prematch"] details.game-group')].map((d) => d.open));
    const openLeagues = () => page.evaluate(() => document.querySelectorAll('#content .list[data-view="prematch"] details.league-group[open]').length);
    await fold('open');
    if ((await states()).some((o) => !o)) throw new Error('expand all left a game closed');
    if (await openLeagues()) throw new Error('expand all opened leagues');
    await page.locator('#content .list[data-view="prematch"] details.league-group > summary').first().click(); await sleep(300);
    if ((await openLeagues()) !== 1) throw new Error('a league did not open');
    await fold('close');
    if ((await states()).some((o) => o)) throw new Error('collapse all left a game open');
    await fold('open');
    if (await openLeagues()) throw new Error('the previously open league was restored after collapse/expand all');
    await fold('close');
    // keyboard over the headers: focus the first game header, ArrowDown moves to the next header, Enter toggles
    await page.locator('#content .list[data-view="prematch"] details.game-group > summary').first().focus();
    await page.keyboard.press('ArrowDown'); await sleep(150);
    const focused = await page.evaluate(() => document.activeElement?.closest('details')?.dataset.group || document.activeElement?.className);
    await page.keyboard.press('Enter'); await sleep(300);
    const toggled = await page.evaluate(() => document.activeElement?.closest('details')?.open);
    if (!toggled) throw new Error(`Enter on the focused header (${focused}) did not open it`);
    await fold('open');
    results.note = `game count "${count.trim()}", header nav ok`;
  } finally { await page.close(); }
});

scenario('E28', 'X1', 'Comparison: forks sort by arbitrage % numerically, both directions, and the choice is kept', async () => {
  const page = await openApp();
  try {
    await clickTab(page, 'compare');
    if (await page.locator('#compareMode [data-compare-mode="odds"]').isVisible()) await page.click('#compareMode [data-compare-mode="odds"]');
    // Deterministic data: a Line snapshot with two bookmakers' quotes per match (known forks), injected in the page.
    await page.click('#compareScope [data-compare-scope="prematch"]'); await sleep(300);
    await page.evaluate(() => {
      const mk = (i, h1, a1, h2, a2) => ({ id: 'arb-' + i, team1: 'Arb Home ' + i, team2: 'Arb Away ' + i, category: 'Counter Strike 2', league: 'Arb League', startAt: Date.now() + (i + 1) * 3600000, inPrematch: true,
        sourceRefs: [{ source: 'astek', sourceEventId: 'a' + i, id: 'a' + i, inPrematch: true, startAt: Date.now() + (i + 1) * 3600000, quote: { h: h1, a: a1 } }, { source: 'pinnacle', sourceEventId: 'p' + i, id: 'p' + i, inPrematch: true, startAt: Date.now() + (i + 1) * 3600000, quote: { h: h2, a: a2 } }] });
      setSnapshot('prematch', { events: [mk(0, 1.9, 1.9, 1.95, 1.85), mk(1, 2.2, 1.7, 1.8, 2.25), mk(2, 1.5, 2.6, 1.55, 2.5), mk(3, 2.05, 2.05, 2.1, 2.0), mk(4, 1.4, 3.1, 1.45, 3.0)], revision: 'arb-test', receivedAt: Date.now() });
      viewSignatures.delete('compare'); renderView('compare', true);
    });
    await sleep(400);
    const n = await page.locator('#content .list[data-view="compare"] tr[data-id]').count();
    if (n < 5) throw new Error(`expected 5 compared matches, got ${n}`);
    const values = () => page.evaluate(() => [...document.querySelectorAll('#content .list[data-view="compare"] tr[data-id]')].map((r) => (r.dataset.arb === '' ? null : Number(r.dataset.arb))));
    await page.selectOption('#compareSort', 'arb-desc'); await sleep(500);
    const desc = await values(), d = desc.filter((v) => v != null);
    if (d.length < 5) throw new Error(`arbitrage values missing: ${desc}`);
    if (d.some((v, i) => i && v > d[i - 1])) throw new Error(`desc not sorted: ${desc}`);
    if (desc.indexOf(null) >= 0 && desc.slice(desc.indexOf(null)).some((v) => v != null)) throw new Error('rows without a value are not last');
    await page.selectOption('#compareSort', 'arb-asc'); await sleep(500);
    const asc = (await values()).filter((v) => v != null);
    if (asc.some((v, i) => i && v < asc[i - 1])) throw new Error(`asc not sorted: ${asc}`);
    await page.reload(); await page.waitForSelector('#tabs [data-tab="compare"]'); await clickTab(page, 'compare'); await sleep(800);
    if ((await page.inputValue('#compareSort')) !== 'arb-asc') throw new Error('sort choice not kept');
    await page.selectOption('#compareSort', 'time');
    results.note = `${n} rows; desc ${d.slice(0, 4).join(', ')}…`;
  } finally { await page.close(); }
});

// Users and capabilities (local server only: it creates and deletes users through the admin API).
const adminApi = async (route, body, token = TOKEN) => {
  const res = await fetch(`http://127.0.0.1:${serverPort}${route}`, { method: body ? 'POST' : 'GET', headers: { authorization: 'Bearer ' + token, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const json = await res.json().catch(() => null);
  if (!res.ok) throw new Error(`${route} -> ${res.status}`);
  return json;
};
const useToken = async (token) => { await setServer(token); await swEval(async () => { await chrome.storage.local.remove('entitlements9'); }); };
const visibleTabs = (page) => page.$$eval('#tabs [data-tab]', (bs) => bs.filter((b) => !b.hidden && b.offsetParent).map((b) => b.dataset.tab));
const settingsSectionsShown = (page) => page.$$eval('[data-settings-section]', (bs) => bs.map((b) => b.dataset.settingsSection));

scenario('E29', 'X1 S1', 'capabilities: a new user sees nothing; granted sections/bookmakers appear without reinstall; normal settings have no admin parts; the admin edits rights in Settings → Пользователи', async () => {
  if (remote) { results.skip = 'creates users: local server only'; return; }
  const shots = process.env.E2E_SCREENSHOTS || '';
  const created = await adminApi('/api/admin/users', { name: 'E2E Viewer' });
  const id = created.user.id;
  let page;
  try {
    if (created.user.capabilities.length) throw new Error('a new user starts with rights: ' + created.user.capabilities.join(','));
    await useToken(created.token);
    page = await openApp();
    await until(async () => /Нет доступных разделов/.test(await page.textContent('#content')), { what: 'the "no sections" state for a user without rights' });
    if ((await visibleTabs(page)).length) throw new Error('tabs shown without rights: ' + (await visibleTabs(page)).join(','));
    // Granted on the server: LIVE with Astek only. Applied on the next check, no reinstall.
    await adminApi('/api/admin/users/' + id, { capabilities: ['live.view', 'provider.astek', 'odds.live'] });
    await page.evaluate(() => loadEntitlements());
    await until(async () => (await visibleTabs(page)).join() === 'live', { what: 'only the LIVE tab' });
    await until(async () => (await cards(page)) >= 1, { what: 'LIVE rows for the user' });
    const sources = await page.$$eval('#content .list[data-view="live"] [data-source-ref]', (rows) => [...new Set(rows.map((r) => r.dataset.sourceRef.split(':')[0]))]);
    if (sources.some((s) => s !== 'astek')) throw new Error('bookmakers without rights shown: ' + sources.join(','));
    await page.click('#settingsButton'); await sleep(500);
    const sections = await settingsSectionsShown(page);
    if (sections.some((s) => ['diagnostics', 'users'].includes(s))) throw new Error('admin settings shown to a user: ' + sections.join(','));
    await page.click('[data-settings-section="sources"]'); await sleep(400);
    if (await page.locator('[data-odds-mode]').count()) throw new Error('GGBET/DataBet choice shown without those bookmakers');
    if (shots) await page.screenshot({ path: path.join(shots, 'caps-settings-user.png') });
    await page.click('#settingsDone'); await sleep(300);
    // Revoked: gone at once.
    await adminApi('/api/admin/users/' + id, { capabilities: [] });
    await page.evaluate(() => loadEntitlements());
    await until(async () => !(await visibleTabs(page)).length && /Нет доступных разделов/.test(await page.textContent('#content')), { what: 'sections gone after the rights are revoked' });
    if (page.errors.length) throw new Error(page.errors.join(' | '));
    await page.close(); page = null;
    // The administrator grants a right in the editor.
    await useToken(TOKEN);
    page = await openApp();
    await page.click('#settingsButton'); await sleep(500);
    if (!(await settingsSectionsShown(page)).includes('users')) throw new Error('no Users section for the administrator');
    await page.click('[data-settings-section="users"]');
    await page.waitForSelector(`[data-admin-user="${id}"]`, { timeout: 15000 });
    await page.click(`[data-admin-user="${id}"]`);
    await page.waitForSelector('[data-admin-pick="prematch.view"]');
    await page.check('[data-admin-pick="prematch.view"]'); await page.check('[data-admin-pick="provider.fonbet"]');
    await page.click('[data-admin="enable"]');
    if (shots) await page.screenshot({ path: path.join(shots, 'caps-admin-editor.png') });
    await page.click('[data-admin="save"]');
    await until(async () => { const u = (await adminApi('/api/admin/users')).users.find((x) => x.id === id); return u && u.capabilities.slice().sort().join() === 'prematch.view,provider.fonbet'; }, { what: 'rights saved on the server' });
    await page.click('[data-admin="disable-all"]'); await page.click('[data-admin="save"]');
    await until(async () => !(await adminApi('/api/admin/users')).users.find((x) => x.id === id)?.capabilities.length, { what: '"Disable all" saved' });
    if (page.errors.length) throw new Error(page.errors.join(' | '));
  } finally {
    await page?.close().catch(() => {});
    await useToken(TOKEN).catch(() => {});
    await adminApi('/api/admin/users/' + id + '/delete', {}).catch(() => {});
  }
});

scenario('E30', 'X1', 'match detail: a click inside keeps it, another row switches it, Escape / an outside click / the drawer backdrop close it', async () => {
  const page = await openApp();
  const isOpen = () => page.evaluate(() => DetailPanel.isOpen());
  const rows = () => page.locator('#content .list[data-view="live"] article.match');
  const openFirst = async () => { await rows().first().click(); await until(isOpen, { what: 'detail open' }); await sleep(400); };
  try {
    await until(async () => (await cards(page)) >= 2, { what: 'rows' });
    await openFirst();
    const first = await page.evaluate(() => String(DetailPanel.currentId()));
    await page.click('#dpTabs [data-dp-tab]'); await page.click('#detailPane', { position: { x: 30, y: 200 } }); await sleep(300);
    if (!(await isOpen())) throw new Error('a click inside the detail closed it');
    await rows().nth(1).click(); await sleep(500);
    if (!(await isOpen()) || (await page.evaluate(() => String(DetailPanel.currentId()))) === first) throw new Error('another row did not switch the detail');
    await page.keyboard.press('Escape');
    await until(async () => !(await isOpen()), { what: 'Escape closes' });
    // A short list leaves empty space under the rows; a click there (not a row, control or header) closes the detail.
    const name = (await rows().first().locator('.team .name').first().textContent()).trim();
    await page.fill('#search', name); await sleep(600);
    await openFirst();
    const spot = await page.evaluate(() => { const list = document.querySelector('#content .list[data-view="live"]'), box = list.getBoundingClientRect(), right = box.left + list.clientWidth - 4; for (let y = box.bottom - 6; y > box.top + 40; y -= 12) for (const x of [box.left + 8, (box.left + right) / 2, right]) { const el = document.elementFromPoint(x, y); if (el && el.closest('#listPane') && !el.closest('[data-id],button,a,input,select,label,summary,.group-head,.col-head,.list-head,[role="button"]')) return { x, y }; } return null; });
    if (!spot) throw new Error('no empty list area to click');
    const target = await page.evaluate(({ x, y }) => { const el = document.elementFromPoint(x, y); return el.tagName + '.' + el.className; }, spot);
    await page.mouse.click(spot.x, spot.y);
    await until(async () => !(await isOpen()), { timeout: 5000, what: `an outside click closes (clicked ${target} at ${Math.round(spot.x)},${Math.round(spot.y)})` });
    await page.fill('#search', ''); await sleep(400);
    await page.setViewportSize({ width: 900, height: 800 }); await sleep(300);
    await openFirst();
    if (await page.locator('#drawerBackdrop').isHidden()) throw new Error('no backdrop under the drawer');
    await page.mouse.click(20, 500);
    await until(async () => !(await isOpen()), { what: 'the backdrop closes' });
    if (page.errors.length) throw new Error(page.errors.join(' | '));
  } finally { await page.setViewportSize({ width: 1360, height: 860 }).catch(() => {}); await page.close(); }
});

scenario('E31', 'X1', 'screenshot matrix (narrow/medium/wide): LIVE, Prematch collapsed/expanded, Comparison, match detail, detail + statistics, Settings of a user, the admin user editor', async () => {
  const shots = process.env.E2E_SCREENSHOTS || '';
  if (!shots) { results.skip = 'set E2E_SCREENSHOTS=<dir>'; return; }
  const widths = [['narrow', 390, 800], ['medium', 900, 820], ['wide', 1440, 900]];
  const notes = [];
  const user = remote ? null : await adminApi('/api/admin/users', { name: 'E2E Screens', capabilities: ['live.view', 'prematch.view', 'compare.view', 'results.view', 'provider.astek', 'provider.fonbet', 'odds.live', 'odds.prematch', 'statistics.view', 'favorites'] });
  let page = await openApp();
  try {
    await until(async () => (await cards(page)) >= LIVE_MIN, { what: 'LIVE rows' });
    for (const [label, width, height] of widths) {
      const shot = (name) => page.screenshot({ path: path.join(shots, `${label}-${name}.png`) });
      await page.setViewportSize({ width, height }); await sleep(400);
      await clickTab(page, 'live'); await sleep(500); await shot('live');
      await clickTab(page, 'prematch'); await page.waitForSelector('[data-line-fold]', { timeout: 30000 });
      if ((await page.getAttribute('[data-line-fold]', 'data-line-fold')) === 'close') { await page.click('[data-line-fold]'); await sleep(400); } await shot('prematch-collapsed');
      await page.click('[data-line-fold]'); await sleep(400); await shot('prematch-expanded');
      await clickTab(page, 'compare'); await sleep(1200); await shot('comparison');
      await clickTab(page, 'live'); await sleep(300);
      const rows = page.locator('#content .list[data-view="live"] article.match');
      await rows.first().click(); await sleep(1200); await shot('detail');
      let stats = false;
      for (let i = 0, n = Math.min(await rows.count(), 15); i < n && !stats; i++) {
        if (await page.evaluate(() => DetailPanel.isOpen())) { await page.keyboard.press('Escape'); await sleep(300); }
        await rows.nth(i).click(); await sleep(500);
        if (await page.locator('#dpTabs [data-dp-tab="stats"]').count()) { await page.click('#dpTabs [data-dp-tab="stats"]'); await sleep(1500); await shot('detail-statistics'); stats = true; }
      }
      if (!stats) notes.push(`${label}: no match with statistics in this feed`);
      await page.keyboard.press('Escape'); await sleep(300);
      if (user) {
        await page.click('#settingsButton'); await sleep(400); await page.click('[data-settings-section="users"]');
        await page.waitForSelector(`[data-admin-user="${user.user.id}"]`, { timeout: 15000 }); await page.click(`[data-admin-user="${user.user.id}"]`); await sleep(400);
        await shot('admin-user-editor'); await page.click('#settingsDone'); await sleep(300);
      }
    }
    if (user) {
      await page.close(); await useToken(user.token); page = await openApp();
      await until(async () => (await visibleTabs(page)).includes('live'), { what: 'user sections' });
      for (const [label, width, height] of widths) {
        await page.setViewportSize({ width, height }); await page.click('#settingsButton'); await sleep(500);
        await page.screenshot({ path: path.join(shots, `${label}-settings-user.png`) });
        await page.click('[data-settings-section="sources"]'); await sleep(300);
        await page.screenshot({ path: path.join(shots, `${label}-settings-user-sources.png`) });
        await page.click('#settingsDone'); await sleep(300);
      }
    }
    results.note = 'saved to ' + shots + (notes.length ? '; ' + notes.join('; ') : '');
    if (page.errors.length) throw new Error(page.errors.join(' | '));
  } finally {
    await page.setViewportSize({ width: 1360, height: 860 }).catch(() => {}); await page.close().catch(() => {});
    if (user) { await useToken(TOKEN).catch(() => {}); await adminApi('/api/admin/users/' + user.user.id + '/delete', {}).catch(() => {}); }
  }
});

scenario('E25', 'P1', 'render: a LIVE feed update over 200 matches is cheap and keeps row and shell nodes', async () => {
  mockState.extraEvents = 200;
  const page = await openApp();
  try {
    await until(async () => (await cards(page)) >= 150, { timeout: 150000, every: 1000, what: '150+ rows (200 extra matches; the server picks them up after a reset)' });
    await sleep(1500);
    const r = await page.evaluate(async () => {
      const list = document.querySelector('#content .list[data-view="live"]'), rows = [...list.querySelectorAll('article.match')];
      rows.forEach((n, i) => { n.__probe = i; }); const shell = document.getElementById('toolbar'); shell.__probe = 1;
      const t = [];
      for (let i = 0; i < 20; i++) { const t0 = performance.now(); renderView('live', true); t.push(performance.now() - t0); await new Promise((r) => requestAnimationFrame(r)); }
      t.sort((a, b) => a - b);
      const kept = [...list.querySelectorAll('article.match')].filter((n) => n.__probe != null).length;
      // one changed row: only that row is rebuilt
      const one = list.querySelector('article.match'); one.__html = 'changed'; const t1 = performance.now(); renderView('live', true); const oneRow = Math.round((performance.now() - t1) * 10) / 10;
      const onlyOne = [...list.querySelectorAll('article.match')].filter((n) => n.__probe == null).length;
      const cold = []; for (let i = 0; i < 3; i++) { for (const n of list.querySelectorAll('article.match')) { n.__html = null; } const t0 = performance.now(); renderView('live', true); cold.push(performance.now() - t0); await new Promise((r) => requestAnimationFrame(r)); }
      cold.sort((a, b) => a - b);
      return { coldRebuild: Math.round(cold[1]), oneRow, rebuiltRows: onlyOne, rows: rows.length, kept, shellKept: document.getElementById('toolbar').__probe === 1, median: Math.round(t[10] * 10) / 10, max: Math.round(t[19] * 10) / 10 };
    });
    const parts = await page.evaluate(() => {
      const m = (f) => { const t = []; for (let i = 0; i < 10; i++) { const t0 = performance.now(); f(); t.push(performance.now() - t0); } t.sort((a, b) => a - b); return Math.round(t[5] * 10) / 10; };
      const el = document.querySelector('#content .list[data-view="live"]'), books = viewBooks('live').filter(bookVisible);
      let rows; const vis = m(() => { rows = liveRowsVisible().rows; });
      const html = m(() => rows.map((e) => matchRow(e, 'live', { books })).join(''));
      const parse = m(() => { const t = document.createElement('template'); t.innerHTML = el.innerHTML; });
      const morph = m(() => morphInto(el, el.innerHTML));
      const rowsAll = liveRowsVisible();
      const stats = m(() => StatisticsClient.observe(rowsAll.rows)), cats = m(() => categoryOptions(rowsAll.all, null, 'live')), chrome = m(() => renderChrome()), head = m(() => updateListHead('live', rowsAll.rows.length)), watch = m(() => scheduleOddsWatch(rowsAll.rows)), navc = m(() => updateNavCounts());
      return { visible: vis, rowsHtml: html, parse, morphSame: morph, statsObserve: stats, categoryOptions: cats, renderChrome: chrome, listHead: head, oddsWatch: watch, navCounts: navc };
    });
    r.parts = parts;
    results.note = JSON.stringify(r);
    if (r.kept !== r.rows || !r.shellKept || r.rebuiltRows !== 1) throw new Error(`nodes replaced: ${JSON.stringify(r)}`);
    if (r.median > 40) throw new Error(`full LIVE render median ${r.median} ms ${JSON.stringify(r.parts)}`);
  } finally { mockState.extraEvents = 0; await page.close(); }
});

/* eslint-enable no-undef */
// Layout matrix: no page-level horizontal overflow, toolbar controls never overlap, rows fit their list, the match
// detail can be scrolled to its last market. Screenshots go to E2E_SCREENSHOTS when set.
const LAYOUT_WIDTHS = [360, 400, 600, 800, 1000, 1440];
async function layoutProblems(page) {
  return page.evaluate(() => {
    const out = [], doc = document.documentElement;
    if (doc.scrollWidth > doc.clientWidth + 1) out.push(`page overflow ${doc.scrollWidth}>${doc.clientWidth}`);
    const vis = (n) => n && !n.hidden && n.offsetParent !== null && n.getBoundingClientRect().width > 0;
    const boxes = [...document.querySelectorAll('#toolbar > *, .topbar > *, .topbar-right > *')].filter(vis).map((n) => ({ n, r: n.getBoundingClientRect() }));
    const tb = boxes.filter((b) => b.n.parentElement.id === 'toolbar' && !b.n.classList.contains('spacer'));
    for (let i = 0; i < tb.length; i++) for (let j = i + 1; j < tb.length; j++) { const a = tb[i].r, b = tb[j].r; if (a.left < b.right - 1 && b.left < a.right - 1 && a.top < b.bottom - 1 && b.top < a.bottom - 1) out.push(`toolbar overlap ${tb[i].n.id || tb[i].n.className} / ${tb[j].n.id || tb[j].n.className}`); }
    for (const b of boxes) if (b.r.right > doc.clientWidth + 1) out.push(`off-screen ${b.n.id || b.n.className} right=${Math.round(b.r.right)}`);
    // the tab strip may scroll, but the current tab must be reachable and the strip must show at least 3 tabs
    const nav = document.getElementById('tabs'), nr = nav.getBoundingClientRect(), shown = [...nav.children].filter((t) => { const r = t.getBoundingClientRect(); return r.left >= nr.left - 1 && r.right <= nr.right + 1; }).length;
    if (shown < 3) out.push(`only ${shown} tabs visible`);
    const list = document.querySelector('#content .list:not([hidden])');
    if (list) { const lr = list.getBoundingClientRect(); const row = list.querySelector('article.match'); if (row && row.scrollWidth > row.clientWidth + 2) out.push(`row overflow ${row.scrollWidth}>${row.clientWidth}`); if (row && row.getBoundingClientRect().right > lr.right + 1) out.push('row wider than list'); }
    // settings: the section body must fit its width (no sideways scrolling) and stay readable
    const sb = document.getElementById('settingsBody');
    if (vis(sb)) { if (sb.scrollWidth > sb.clientWidth + 2) out.push(`settings overflow ${sb.scrollWidth}>${sb.clientWidth}`); if (sb.clientWidth < 300) out.push(`settings body only ${sb.clientWidth}px wide`); }
    const pane = document.getElementById('detailPane');
    if (pane && !pane.hidden) { const pr = pane.getBoundingClientRect(); if (pr.right > doc.clientWidth + 1 || pr.width < 260) out.push(`detail pane ${Math.round(pr.left)}..${Math.round(pr.right)}`); }
    return out;
  });
}
scenario('E26', 'X1', 'responsive layout matrix (360-1440 px): no overflow or overlapping controls, rows fit, detail markets scroll to the end', async () => {
  const shots = process.env.E2E_SCREENSHOTS || '';
  const page = await openApp(); const problems = [];
  try {
    await until(async () => (await cards(page)) >= LIVE_MIN, { what: 'LIVE rows' });
    for (const width of LAYOUT_WIDTHS) {
      await page.setViewportSize({ width, height: width < 700 ? 760 : 860 }); await sleep(400);
      const views = [['live', async () => clickTab(page, 'live')], ['prematch', async () => clickTab(page, 'prematch')], ['compare', async () => clickTab(page, 'compare')],
        ['detail', async () => { await clickTab(page, 'live'); await page.locator('#content .list[data-view="live"] article.match').first().click(); await sleep(1200); }],
        ['settings', async () => { await page.click('#settingsButton'); await sleep(500); }]];
      for (const [name, open] of views) {
        await open();
        for (const p of await layoutProblems(page)) problems.push(`${width}px ${name}: ${p}`);
        if (name === 'detail') {
          const end = await page.evaluate(async () => { const body = document.getElementById('dpBody') || document.getElementById('detailPane'); const scroller = [body, document.getElementById('detailPane')].find((n) => n && n.scrollHeight > n.clientHeight + 2) || body; scroller.scrollTop = scroller.scrollHeight; await new Promise((r) => setTimeout(r, 200)); const last = [...document.querySelectorAll('#dpMarkets .mkt')].at(-1); if (!last) return 'no markets'; const lr = last.getBoundingClientRect(), pr = document.getElementById('detailPane').getBoundingClientRect(); const covering = document.elementFromPoint(lr.left + 10, Math.min(lr.bottom - 4, pr.bottom - 4)); return last.contains(covering) || covering === last ? '' : `last market covered by ${covering?.className || covering?.tagName}`; });
          if (end) problems.push(`${width}px detail: ${end}`);
        }
        if (shots) await page.screenshot({ path: path.join(shots, `layout-${width}-${name}.png`) });
        if (name === 'detail') { await page.keyboard.press('Escape'); await sleep(300); }
        if (name === 'settings') { await page.click('#settingsButton'); await sleep(300); }
      }
    }
    results.note = problems.length ? `${problems.length} problems` : 'clean at ' + LAYOUT_WIDTHS.join('/') + ' px';
    if (problems.length) throw new Error(problems.slice(0, 25).join(' | '));
  } finally { await page.setViewportSize({ width: 1360, height: 860 }).catch(() => {}); await page.close(); }
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
    const t0 = Date.now(); results.note = ''; results.skip = '';
    try { await Promise.race([s.fn(), new Promise((_, reject) => setTimeout(() => reject(new Error('scenario exceeded its 240 s budget')), 240000))]); report.push({ id: s.id, covers: s.covers, title: s.title, status: results.skip ? 'SKIP' : 'PASS', seconds: Math.round((Date.now() - t0) / 1000), detail: results.skip || results.note }); }
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
