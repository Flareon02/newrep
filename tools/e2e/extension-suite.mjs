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
  for (let i = 0; i < mockState.extraEvents; i++) { const e = JSON.parse(JSON.stringify(body.Value[0])); e.I = 990000 + i; e.O1 = `Notify Alpha ${i}`; e.O2 = `Notify Beta ${i}`; e.LI = 990000 + i; body.Value.push(e); }
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
const proxyState = { mode: 'pass', hits: new Map(), sseConnects: 0, sse: new Set() };
const hit = (p) => proxyState.hits.set(p, (proxyState.hits.get(p) || 0) + 1);
let serverPort = 0;
const proxy = http.createServer((req, res) => {
  const p = req.url.split('?')[0]; hit(p);
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
    FONBET_RESULTS_URLS: `http://127.0.0.1:${mock.address().port}/none`, GGBET_LIVE_ENABLED: '0', LOG_LEVEL: 'info', NODE_OPTIONS: '--disable-warning=ExperimentalWarning' } });
  child.stdout.on('data', (d) => { serverLog += d; }); child.stderr.on('data', (d) => { serverLog += d; });
}
const stopServer = async (signal = 'SIGTERM') => { if (!child) return; const c = child; child = null; c.kill(signal); await new Promise((r) => c.once('exit', r)); };
const serverHealth = async (base = `http://127.0.0.1:${serverPort}`) => { try { return await (await fetch(base + '/health', { signal: AbortSignal.timeout(4000) })).json(); } catch { return null; } };

// ---------------------------------------------------------------- browser helpers ---------------------------------------
let context, extensionId, directBase, proxyBase;
const base = () => (remote ? process.env.STAGING_URL.replace(/\/+$/, '') : proxyBase);
const swHandle = async () => { let [w] = context.serviceWorkers(); if (!w) w = await context.waitForEvent('serviceworker', { timeout: 20000 }); return w; };
const swEval = async (fn, arg2) => (await swHandle()).evaluate(fn, arg2);
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
const cards = (page) => page.locator('article.card').count();
const clickTab = async (page, tab) => { await page.click(`#tabs [data-tab="${tab}"]`); await sleep(700); };
// A provider (e.g. Fonbet) failing upstream is also surfaced as `transportError`; only these texts mean the SERVER is unreachable/broken.
const isDown = (err) => /Failed to fetch|HTTP (?:401|5\d\d)|aborted|timed? ?out|Unexpected token|not valid JSON|is not JSON|Нет списка/i.test(String(err || ''));
const swState = (key) => swEval((k) => { try { const c = cache[k]; return c ? { events: (c.events || []).length, transportError: c.transportError || '', stale: !!c.stale, receivedAt: c.receivedAt || 0 } : null; } catch (e) { return { error: String(e) }; } }, key);

// ---------------------------------------------------------------- scenarios ------------------------------------------------
const results = [];
const scenarios = [];
const scenario = (id, covers, title, fn, { needsMock = true } = {}) => scenarios.push({ id, covers, title, fn, needsMock });

scenario('E01', 'X1 X2', 'extension loads, service worker runs, LIVE cards render from the server feed, SSE is connected', async () => {
  const page = await openApp();
  await until(async () => (await cards(page)) >= 12, { what: '12 LIVE cards' });
  if (!remote) await until(async () => ((await serverHealth())?.sse?.open ?? 0) >= 1, { what: 'an SSE client on the server' });
  if (page.errors.length) throw new Error(page.errors.join(' | '));
  await page.close();
});

scenario('E02', 'X1', 'every tab opens without script errors (LIVE, Results, Line, History, Compare, Leagues)', async () => {
  const page = await openApp();
  await until(async () => (await cards(page)) > 0 || remote, { what: 'cards' });
  const hidden = [], shown = [];
  for (const tab of ['results', 'prematch', 'history', 'compare', 'leagues', 'live']) {
    if (!(await page.locator(`#tabs [data-tab="${tab}"]`).isVisible())) { hidden.push(tab); continue; }   // History is an opt-in (hidden) feature
    await clickTab(page, tab); const heading = (await page.textContent('#viewTitle'))?.trim(); if (!heading) throw new Error(`tab ${tab} has no heading`); shown.push(tab);
  }
  results.note = `opened: ${shown.join(', ')}; hidden by default: ${hidden.join(', ') || 'none'}`;
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
  const card = page.locator('article.card', { hasText: 'Two Move' }).first();
  mockState.scoreBump = 7;
  await until(async () => (await card.textContent()).includes('77'), { timeout: 30000, what: 'updated map score 77 on the card' });
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
  startServer();
  const t0 = Date.now();
  await until(async () => { const s = await swState('live'); return s && !isDown(s.transportError) && s.events >= 12; }, { timeout: 90000, what: 'recovery after the server restart' });
  await until(async () => ((await serverHealth())?.sse?.open ?? 0) >= 1, { timeout: 60000, what: 'SSE stream re-established' });
  results.note = `recovered ${Math.round((Date.now() - t0) / 1000)} s after the restart`;
  await page.close();
});

scenario('E06', 'X2', 'service worker terminated by the browser: page reconnects, worker wakes, feed continues', async () => {
  const page = await openApp();
  await until(async () => (await cards(page)) >= 12, { what: 'LIVE cards' });
  const cdp = await context.newCDPSession(page);
  const bounded = (p) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('CDP call timed out')), 10000))]);
  await bounded(cdp.send('ServiceWorker.enable'));
  await bounded(cdp.send('ServiceWorker.stopAllWorkers'));
  await sleep(1500);
  mockState.extraEvents = 1;
  await until(async () => (await cards(page)) >= 13, { timeout: 60000, what: 'a new fixture after the worker was stopped' });
  mockState.extraEvents = 0;
  await page.close();
});

scenario('E07', 'X3', 'notification for a new LIVE fixture is raised once, with league and teams', async () => {
  const page = await openApp();
  await until(async () => (await cards(page)) >= 12, { what: 'LIVE cards' });
  await page.evaluate(async () => { prefs.notifications = { ...prefs.notifications, live: true }; await chrome.storage.local.set({ prefs }); });
  await sleep(1500);
  await swEval(() => { self.__notes = []; const orig = chrome.notifications.create.bind(chrome.notifications); chrome.notifications.create = (id, opts, cb) => { self.__notes.push(opts); return orig(id, opts, cb); }; });
  mockState.extraEvents = 2;
  const notes = await until(async () => { const n = await swEval(() => self.__notes); return n.length ? n : null; }, { timeout: 40000, what: 'a notification' });
  if (!notes.some((n) => /Notify Alpha \d - Notify Beta \d/.test(n.message))) throw new Error('unexpected notification text: ' + JSON.stringify(notes));
  await sleep(6000);
  const after = await swEval(() => self.__notes.length);
  if (after > 2) throw new Error(`notification repeated (${after})`);
  mockState.extraEvents = 0;
  await page.evaluate(async () => { prefs.notifications = { ...prefs.notifications, live: false }; await chrome.storage.local.set({ prefs }); });
  await page.close();
});

scenario('E08', 'X1 X9', 'settings persist in chrome.storage; server address and token are edited and saved from the Settings dialog', async () => {
  const page = await openApp();
  await until(async () => (await cards(page)) > 0 || remote, { what: 'cards' });
  await page.click('#settingsButton');
  await page.selectOption('#theme', 'dark');
  await sleep(500);
  const before = await swEval(async () => (await chrome.storage.local.get('server')).server);
  await page.fill('#serverToken', 'replacement-token-1234567890');
  await Promise.all([page.waitForEvent('load'), page.click('#serverSave')]);
  const saved = await swEval(async () => (await chrome.storage.local.get(['server', 'prefs']))); 
  if (saved.server.token !== 'replacement-token-1234567890' || saved.server.base !== before.base) throw new Error('server settings not saved: ' + JSON.stringify({ ...saved.server, token: '…' }));
  if (saved.prefs.theme !== 'dark') throw new Error('theme not persisted');
  await swEval(async (b) => { await chrome.storage.local.set({ server: b }); }, before);
  await page.close();
});

scenario('E09', 'X1 X4', 'odds dialog opens from a LIVE card and lists markets', async () => {
  const page = await openApp();
  await until(async () => (await cards(page)) >= 1, { what: 'cards' });
  await page.locator('article.card [data-book-odds]').first().click();
  await until(async () => page.evaluate(() => { const m = document.getElementById('modal'); return m?.open && m.textContent.trim().length > 40; }), { timeout: 20000, what: 'odds dialog content' });
  if (page.errors.length) throw new Error(page.errors.join(' | '));
  await page.close();
});

scenario('E10', 'X2', 'server answers 500: extension keeps the last data, backs off (no retry storm) and recovers', async () => {
  const page = await openApp();
  await until(async () => (await cards(page)) >= 12, { what: 'LIVE cards' });
  proxyState.mode = 'http500';
  await until(async () => isDown((await swState('live'))?.transportError), { timeout: 60000, what: 'transport error' });
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
  proxyState.mode = 'malformed';
  mockState.scoreBump = 3; // force a revision change so the worker must fetch the broken endpoint
  const state = await until(async () => { const s = await swState('live'); return isDown(s?.transportError) ? s : null; }, { timeout: 60000, what: 'malformed-response error' });
  results.note = `error shown: "${state.transportError.slice(0, 60)}"`;
  proxyState.mode = 'pass'; mockState.scoreBump = 0;
  await until(async () => { const s = await swState('live'); return s && !isDown(s.transportError); }, { timeout: 90000, what: 'recovery' });
  await page.close();
});

scenario('E12', 'X2', 'requests that never finish (timeout): bounded by the client timeout, then recovery', async () => {
  const page = await openApp();
  await until(async () => (await cards(page)) >= 12, { what: 'LIVE cards' });
  proxyState.mode = 'hang';
  await until(async () => isDown((await swState('live'))?.transportError), { timeout: 90000, what: 'timeout error' });
  proxyState.mode = 'pass';
  await until(async () => { const s = await swState('live'); return s && !isDown(s.transportError); }, { timeout: 120000, what: 'recovery' });
  await page.close();
});

scenario('E13', 'X2', 'SSE stream cut every few seconds: reconnects with backoff, no reconnect storm', async () => {
  const page = await openApp();
  await until(async () => (await cards(page)) >= 12, { what: 'LIVE cards' });
  proxyState.sseConnects = 0; proxyState.mode = 'sse-cut';
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

scenario('E15', 'X1', 'extension reload (chrome.runtime.reload): preferences survive and the feed comes back', async () => {
  const page = await openApp();
  await until(async () => (await cards(page)) >= 12, { what: 'LIVE cards' });
  await swEval(async () => { await chrome.storage.local.set({ e2eMarker: 'kept' }); });
  const closed = page.waitForEvent('close', { timeout: 20000 }).catch(() => null);
  await swEval(() => { setTimeout(() => chrome.runtime.reload(), 50); });
  await closed; await sleep(2500);
  const again = await openApp();
  await until(async () => (await cards(again)) >= 12, { timeout: 40000, what: 'cards after the reload' });
  if ((await swEval(async () => (await chrome.storage.local.get('e2eMarker')).e2eMarker)) !== 'kept') throw new Error('chrome.storage lost after reload');
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
  catch (e) { throw new Error(`${e.message}; worker state ${JSON.stringify(await swEval(() => ({ streamRunning, streamHealthy, streamFailures, ports: ports.size })))}; proxy sse connects ${proxyState.sseConnects}`); }
  proxyState.mode = 'pass';
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
  context = await chromium.launchPersistentContext(profile, { headless: false, args: ['--headless=new', '--no-sandbox', `--disable-extensions-except=${extensionDir}`, `--load-extension=${extensionDir}`] });
  const worker = await swHandle(); extensionId = new URL(worker.url()).host;
  await setServer();
  const remoteOk = new Set(['E01', 'E02', 'E03', 'E08', 'E09', 'E15', 'E16']);
  for (const s of scenarios) {
    if (only.size && !only.has(s.id)) continue;
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
