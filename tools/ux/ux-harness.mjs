#!/usr/bin/env node
// UX/performance harness for the extension: real Chromium + the unpacked extension + a mock API with synthetic data.
//
//   node tools/ux/ux-harness.mjs measure [--ext extension] [--json out.json] [--latency 450] [--idle 45000]
//   node tools/ux/ux-harness.mjs screens [--ext extension] [--out dir]
//   node tools/ux/ux-harness.mjs verify  [--ext extension] [--json out.json]   (real-browser acceptance checks)
//   node tools/ux/ux-harness.mjs profile [--ext extension]                     (CPU profile of History loading)
//
// `measure` profiles the History tab (~1,900 matches): requests, bytes, rows/DOM nodes, long tasks, event-loop lag,
// first rows, "older" loading latency, idle refetches under server invalidations, and tab switching during loading.
// `screens` captures the main screens in dark and light themes and at narrow and wide widths.
// Playwright is resolved from PLAYWRIGHT_MODULE or the default module path; nothing here talks to a real server.
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { startMockServer } from './mock-server.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const arg = (n, d) => { const i = process.argv.indexOf('--' + n); return i > 0 ? process.argv[i + 1] : d; };
const mode = process.argv[2] || 'measure';
const pw = process.env.PLAYWRIGHT_MODULE || 'playwright';
const { chromium } = await import(pw.startsWith('/') ? pathToFileURL(pw).href : pw);
const extensionDir = path.resolve(root, arg('ext', 'extension'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const step = (text) => { if (process.env.UX_VERBOSE) console.error('[ux]', text); };

async function launch(server, { width = 1440, height = 900, prefs = {}, theme } = {}) {
  const profile = mkdtempSync(path.join(tmpdir(), 'em-ux-'));
  const context = await chromium.launchPersistentContext(profile, {
    channel: 'chromium', headless: true, viewport: { width, height },
    args: [`--disable-extensions-except=${extensionDir}`, `--load-extension=${extensionDir}`, '--enable-precise-memory-info', '--no-first-run'],
  });
  step('browser launched');
  let [worker] = context.serviceWorkers(); if (!worker) worker = await context.waitForEvent('serviceworker');
  const id = new URL(worker.url()).host;
  await worker.evaluate(async ({ base, prefs }) => { await chrome.storage.local.clear(); await chrome.storage.local.set({ server: { base, token: '' }, prefs }); }, { base: server.url, prefs: { lastTab: 'live', ui900: true, ...prefs } });
  step('extension ' + id);
  const page = await context.newPage();
  await page.addInitScript(({ base, theme }) => {
    try { localStorage.setItem('monitor-server', JSON.stringify({ base, token: '' })); if (theme) localStorage.setItem('monitor-theme', theme); } catch {}
    window.__lt = []; window.__lag = { max: 0, over50: 0, samples: 0 };
    try { new PerformanceObserver((l) => { for (const e of l.getEntries()) window.__lt.push({ start: Math.round(e.startTime), ms: Math.round(e.duration) }); }).observe({ type: 'longtask', buffered: true }); } catch {}
    let last = performance.now(); setInterval(() => { const now = performance.now(), lag = now - last - 50; last = now; window.__lag.samples++; if (lag > window.__lag.max) window.__lag.max = Math.round(lag); if (lag > 50) window.__lag.over50++; }, 50);
  }, { base: server.url, theme });
  const close = async () => { await context.close(); rmSync(profile, { recursive: true, force: true }); };
  return { context, page, id, close, url: (p = 'app.html') => `chrome-extension://${id}/${p}` };
}

const historyRequests = (server, since) => server.log.filter((r) => r.path === '/api/ui/history' && r.at >= since);
const summarize = (reqs) => ({ count: reqs.length, bytes: reqs.reduce((n, r) => n + r.bytes, 0), maxBytes: Math.max(0, ...reqs.map((r) => r.bytes)) });

async function historyStats(page) {
  return page.evaluate(() => {
    const list = document.querySelector('#content>.list[data-view="history"]');
    return { rows: window.__monitorDebug?.history?.().loaded ?? (list?.querySelectorAll('article.match').length || 0), mountedRows: list?.querySelectorAll('article.match').length || 0, listNodes: list?.querySelectorAll('*').length || 0, documentNodes: document.querySelectorAll('*').length, heapMB: Math.round((performance.memory?.usedJSHeapSize || 0) / 1048576 * 10) / 10, longTasks: window.__lt.length, longTaskMs: window.__lt.reduce((n, t) => n + t.ms, 0), maxLongTask: Math.max(0, ...window.__lt.map((t) => t.ms)), lagMax: window.__lag.max, lagOver50: window.__lag.over50 };
  });
}
const resetPerf = (page) => page.evaluate(() => { window.__lt = []; window.__lag.max = 0; window.__lag.over50 = 0; });

async function measure() {
  const latency = Number(arg('latency', 450)), idle = Number(arg('idle', 45000));
  const server = await startMockServer({ historyLatencyMs: latency, invalidateEveryMs: 10000 });
  const out = { extension: path.relative(root, extensionDir), latencyMs: latency, knownHistory: server.fixtures.events.length };
  try {
    const b = await launch(server);
    const { page } = b;
    await page.goto(b.url());
    await page.waitForSelector('#content>.list[data-view="live"] article.match', { timeout: 30000 });
    await sleep(1500); await resetPerf(page);
    const t0 = Date.now();
    await page.evaluate(() => { window.__t0 = performance.now(); window.__tFirst = 0; document.querySelector('#tabs [data-tab="history"]').click(); window.__tClickSync = performance.now() - window.__t0; });
    await page.waitForFunction(() => { const ok = document.querySelector('#content>.list[data-view="history"] article.match'); if (ok && !window.__tFirst) window.__tFirst = performance.now(); return ok; }, null, { timeout: 60000, polling: 'raf' });
    const first = await page.evaluate(() => ({ firstRowsMs: Math.round(window.__tFirst - window.__t0), clickSyncMs: Math.round(window.__tClickSync) }));
    await sleep(3000);
    out.open = { ...first, ...(await historyStats(page)), requests: summarize(historyRequests(server, t0)), matchObjectsReceived: null };
    // "Older" loading: scroll to the end (and press the explicit button when present) until nothing more loads.
    await resetPerf(page);
    const steps = [];
    const tMore = Date.now();
    const loaded = () => page.evaluate(() => window.__monitorDebug?.history?.().loaded ?? document.querySelectorAll('#content>.list[data-view="history"] article.match').length);
    for (let i = 0; i < 30; i++) {
      const before = await loaded();
      const s = performance.now();
      await page.evaluate(() => { const l = document.querySelector('#content>.list[data-view="history"]'); l.scrollTop = l.scrollHeight; const b = l.querySelector('[data-more-history],[data-history-older]'); if (b && !b.disabled) b.click(); });
      let after = before;
      try { await page.waitForFunction((n) => (window.__monitorDebug?.history?.().loaded ?? document.querySelectorAll('#content>.list[data-view="history"] article.match').length) > n, before, { timeout: 15000, polling: 100 }); after = await loaded(); } catch {}
      const stalled = after === before ? await page.evaluate(() => { const h = window.__monitorDebug?.history?.(); const f = document.getElementById('historySentinel'); return h && { status: h.status, sections: h.sections.map((x) => `${x.id}:${x.state}:${x.rows}/${x.total}`).join(' '), foot: f?.textContent || document.querySelector('.list-end')?.textContent }; }) : undefined;
      steps.push({ before, after, ms: Math.round(performance.now() - s), ...(stalled ? { stalled } : {}) });
      if (after === before) break;
    }
    out.more = { steps, ...(await historyStats(page)), requests: summarize(historyRequests(server, tMore)) };
    // Idle on History while the server keeps announcing structural changes (every 10 s).
    await resetPerf(page);
    const tIdle = Date.now(); await sleep(idle);
    out.idle = { seconds: idle / 1000, ...(await historyStats(page)), requests: summarize(historyRequests(server, tIdle)) };
    await b.close();
    // Switch away while History is still loading.
    const c = await launch(server);
    await c.page.goto(c.url()); await c.page.waitForSelector('#content>.list[data-view="live"] article.match', { timeout: 30000 }); await sleep(1000); await resetPerf(c.page);
    const sw = await c.page.evaluate(async () => {
      document.querySelector('#tabs [data-tab="history"]').click(); await new Promise((r) => setTimeout(r, 120));
      const t = performance.now(); document.querySelector('#tabs [data-tab="live"]').click();
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      return { liveTabPaintMs: Math.round(performance.now() - t), liveVisible: !document.querySelector('#content>.list[data-view="live"]').hidden };
    });
    await sleep(4000);
    out.switchAway = { ...sw, ...(await historyStats(c.page)) };
    await c.close();
  } finally { await server.close(); }
  console.log(JSON.stringify(out, null, 2));
  if (arg('json')) writeFileSync(arg('json'), JSON.stringify(out, null, 2));
}

async function screens() {
  const dir = path.resolve(arg('out', path.join(tmpdir(), 'em-ux-shots'))); mkdirSync(dir, { recursive: true });
  const server = await startMockServer({ historyLatencyMs: 150 });
  const shots = [];
  const snap = async (page, name) => { const file = path.join(dir, name + '.png'); await page.screenshot({ path: file }); shots.push(file); };
  try {
    for (const theme of ['dark', 'light']) for (const [w, h, tag] of [[1440, 900, 'wide'], [560, 900, 'narrow']]) {
      const b = await launch(server, { width: w, height: h, theme, prefs: { theme } });
      const { page } = b; await page.goto(b.url());
      await page.waitForSelector('#content>.list[data-view="live"] article.match', { timeout: 30000 }); await sleep(1200);
      await snap(page, `${theme}-${tag}-live`);
      const cs = await page.$('#content>.list[data-view="live"] article.match');
      if (tag === 'wide') {
        // the first CS2 match: odds, statistics (CS2 board) and the Match tab
        const csId = await page.evaluate(() => [...document.querySelectorAll('#content>.list[data-view="live"] article.match')].find((n) => /Counter/i.test(n.closest('section')?.textContent || n.textContent))?.dataset.id || document.querySelector('#content>.list[data-view="live"] article.match')?.dataset.id);
        await page.click(`#content>.list[data-view="live"] article.match[data-id="${csId}"]`); await sleep(1500);
        await snap(page, `${theme}-${tag}-detail-odds`);
        const stats = await page.$('#dpTabs [data-dp-tab="stats"]'); if (stats) { await stats.click(); await sleep(2500); await snap(page, `${theme}-${tag}-detail-stats`); }
        const info = await page.$('#dpTabs [data-dp-tab="info"]'); if (info) { await info.click(); await sleep(600); await snap(page, `${theme}-${tag}-detail-info`); }
        await page.click(`#content>.list[data-view="live"] article.match[data-id="${csId}"]`); await sleep(500);
        await snap(page, `${theme}-${tag}-detail-closed`);
      } else if (cs) { await cs.click(); await sleep(1200); await snap(page, `${theme}-${tag}-detail`); await page.keyboard.press('Escape'); }
      for (const tab of ['prematch', 'results', 'compare', 'history']) { await page.click(`#tabs [data-tab="${tab}"]`); await sleep(tab === 'history' ? 2500 : 1200); await snap(page, `${theme}-${tag}-${tab}`); }
      const menu = await page.$('#categoryButton'); if (menu) { await menu.click(); await sleep(300); await snap(page, `${theme}-${tag}-game-menu`); await page.keyboard.press('Escape'); }
      await page.click('#settingsButton'); await sleep(500); await snap(page, `${theme}-${tag}-settings`);
      const src = await page.$('[data-settings-section="sources"]'); if (src) { await src.click(); await sleep(400); await snap(page, `${theme}-${tag}-settings-sources`); }
      await b.close();
    }
  } finally { await server.close(); }
  console.log(JSON.stringify({ dir, shots: shots.map((f) => path.basename(f)) }, null, 2));
}

// CPU profile of the History "older" phase: top functions by self time (CDP Profiler).
async function profile() {
  const server = await startMockServer({ historyLatencyMs: Number(arg('latency', 450)), invalidateEveryMs: 10000 });
  try {
    const b = await launch(server); const { page } = b;
    await page.goto(b.url()); await page.waitForSelector('#content>.list[data-view="live"] article.match', { timeout: 30000 }); await sleep(1000);
    const cdp = await page.context().newCDPSession(page); await cdp.send('Profiler.enable'); await cdp.send('Profiler.setSamplingInterval', { interval: 200 }); await cdp.send('Profiler.start');
    await page.click('#tabs [data-tab="history"]'); await page.waitForSelector('#content>.list[data-view="history"] article.match', { timeout: 60000 });
    for (let i = 0; i < 4; i++) { const n = await page.evaluate(() => { const l = document.querySelector('#content>.list[data-view="history"]'); l.scrollTop = l.scrollHeight; return l.querySelectorAll('article.match').length; }); try { await page.waitForFunction((n) => document.querySelectorAll('#content>.list[data-view="history"] article.match').length > n, n, { timeout: 20000 }); } catch {} }
    await sleep(12000);
    const { profile: prof } = await cdp.send('Profiler.stop');
    const self = new Map(), byId = new Map(prof.nodes.map((n) => [n.id, n])); const dt = prof.timeDeltas; const counts = new Map();
    prof.samples.forEach((id, i) => counts.set(id, (counts.get(id) || 0) + (dt[i] || 0)));
    for (const [id, us] of counts) { const n = byId.get(id), f = n.callFrame, key = `${f.functionName || '(anonymous)'} ${f.url.split('/').pop()}:${f.lineNumber + 1}`; self.set(key, (self.get(key) || 0) + us); }
    const top = [...self].sort((a, b) => b[1] - a[1]).slice(0, Number(arg('top', 25))).map(([k, us]) => `${String(Math.round(us / 1000)).padStart(7)} ms  ${k}`);
    console.log(top.join('\n'));
    await b.close();
  } finally { await server.close(); }
}

// Real-browser acceptance checks of the 9.2 UX (PASS/FAIL per check, exit code 1 on any failure).
async function verify() {
  const server = await startMockServer({ historyLatencyMs: 120 });
  const results = [];
  const check = async (name, fn) => { try { const detail = await fn(); results.push({ name, ok: true, detail }); console.error('PASS', name, detail ?? ''); } catch (e) { results.push({ name, ok: false, detail: e.message }); console.error('FAIL', name, e.message); } };
  const expect = (cond, msg) => { if (!cond) throw new Error(msg); };
  try {
    const b = await launch(server); const { page } = b;
    await page.addInitScript(() => { window.__copied = []; const w = navigator.clipboard?.writeText?.bind(navigator.clipboard); if (navigator.clipboard) navigator.clipboard.writeText = async (t) => { window.__copied.push(t); try { await w?.(t); } catch {} }; });
    await page.goto(b.url()); await page.waitForSelector('#content>.list[data-view="live"] article.match'); await sleep(1500);
    const rows = await page.$$eval('#content>.list[data-view="live"] article.match', (n) => n.slice(0, 2).map((x) => x.dataset.id));
    await check('same match click closes the panel; another match switches directly', async () => {
      const row = (id) => `#content>.list[data-view="live"] article.match[data-id="${id}"] .teams`;
      await page.click(row(rows[0])); await sleep(300);
      expect(await page.evaluate(() => !document.getElementById('detailPane').hidden), 'panel opens');
      await page.click(row(rows[1])); await sleep(300);
      const st = await page.evaluate(() => ({ open: !document.getElementById('detailPane').hidden, sel: document.querySelector('#content>.list[data-view="live"] [aria-selected="true"]')?.dataset.id }));
      expect(st.open && st.sel === rows[1], 'switched to B: ' + JSON.stringify(st));
      await page.click(row(rows[1])); await sleep(300);
      expect(await page.evaluate(() => document.getElementById('detailPane').hidden), 'second click on B closes');
      expect(await page.evaluate(() => !document.querySelector('#content>.list[data-view="live"] [aria-selected="true"]')), 'no row stays selected');
      await page.focus(row(rows[0]).replace(' .teams', '')); await page.keyboard.press('Enter'); await sleep(300); await page.focus(row(rows[0]).replace(' .teams', '')); await page.keyboard.press('Enter'); await sleep(300);
      expect(await page.evaluate(() => document.getElementById('detailPane').hidden), 'Enter toggles as well');
    });
    await check('CS2 statistics: event log collapsed by default, round icons visible', async () => {
      const cs = await page.evaluate(() => [...document.querySelectorAll('#content>.list[data-view="live"] section')].find((s) => /Counter/.test(s.textContent))?.querySelector('article.match')?.dataset.id);
      await page.click(`#content>.list[data-view="live"] article.match[data-id="${cs}"] .teams`); await sleep(600);
      await page.click('#dpTabs [data-dp-tab="stats"]'); await page.waitForSelector('.cs2-board', { timeout: 8000 });
      const st = await page.evaluate(() => { const log = document.querySelector('.cs2-event-log'), icon = document.querySelector('.slot.won svg'), c = icon && getComputedStyle(icon.closest('.slot')).color; return { log: !!log, open: log?.open, icons: document.querySelectorAll('.slot.won svg').length, color: c }; });
      expect(st.log && st.open === false, 'log closed: ' + JSON.stringify(st));
      expect(st.icons > 5 && st.color && st.color !== 'rgb(0, 0, 0)', 'icons coloured, not black: ' + JSON.stringify(st));
      await page.click('.cs2-event-log>summary'); await sleep(200);
      expect(await page.evaluate(() => document.querySelector('.cs2-event-log').open), 'opens on request');
      await page.keyboard.press('Escape'); await sleep(200);
      return st;
    });
    await check('right click on a match copies "Team A - Team B"; Menu key opens it too', async () => {
      const id = rows[0], names = await page.$eval(`#content>.list[data-view="live"] article.match[data-id="${id}"]`, (n) => [...n.querySelectorAll('.team .name')].map((x) => x.textContent));
      await page.click(`#content>.list[data-view="live"] article.match[data-id="${id}"] .team .name`, { button: 'right' }); await page.waitForSelector('.ctx-menu');
      await page.click('.ctx-menu [role=menuitem]'); await sleep(200);
      const copied = await page.evaluate(() => window.__copied.at(-1)), toast = await page.$eval('#toast', (t) => !t.hidden && t.textContent);
      expect(copied === `${names[0]} - ${names[1]}`, `copied ${copied}`); expect(/Скопировано/.test(toast || ''), 'toast shown');
      await page.focus(`#content>.list[data-view="live"] article.match[data-id="${id}"]`); await page.keyboard.press('Shift+F10'); await page.waitForSelector('.ctx-menu');
      const focused = await page.evaluate(() => document.activeElement?.getAttribute('role')); await page.keyboard.press('Escape');
      expect(focused === 'menuitem', 'keyboard menu focuses its first item');
      return copied;
    });
    await check('bookmaker badge: URL copied when the data has one, disabled when it does not', async () => {
      await page.click('#tabs [data-tab="history"]'); await page.waitForSelector('#content>.list[data-view="history"] .chip.book'); await sleep(500);
      const withUrl = await page.evaluate(() => [...document.querySelectorAll('#content>.list[data-view="history"] .chip.book.astek')][0]?.dataset.sourceRef);
      await page.click(`#content>.list[data-view="history"] .chip.book[data-source-ref="${withUrl}"]`, { button: 'right' }); await page.waitForSelector('.ctx-menu');
      const items = await page.$$eval('.ctx-menu [role=menuitem]', (n) => n.map((x) => ({ t: x.textContent, d: x.getAttribute('aria-disabled') })));
      await page.click('.ctx-menu [role=menuitem]:nth-child(3)'); await sleep(150);
      const url = await page.evaluate(() => window.__copied.at(-1));
      expect(/^https:\/\/astek\.example\/esports\/match\//.test(url), 'copied ' + url);
      const noUrl = await page.evaluate(() => [...document.querySelectorAll('#content>.list[data-view="history"] .chip.book.pinnacle')].map((n) => n.dataset.sourceRef).find((k) => Number(k.split(':p')[1]) % 12 === 0 || true));
      let disabled = null;
      for (const key of await page.$$eval('#content>.list[data-view="history"] .chip.book.pinnacle', (n) => n.slice(0, 30).map((x) => x.dataset.sourceRef))) {
        await page.click(`#content>.list[data-view="history"] .chip.book[data-source-ref="${key}"]`, { button: 'right' }); await page.waitForSelector('.ctx-menu');
        const d = await page.$$eval('.ctx-menu [role=menuitem]', (n) => n.map((x) => x.getAttribute('aria-disabled')));
        await page.keyboard.press('Escape');
        if (d[0] === 'true') { disabled = key; break; }
      }
      expect(disabled, 'a ref without URL offers a disabled item'); void noUrl;
      return { items: items.map((i) => i.t), disabled };
    });
    await check('History: first screen requests LIVE, line, today and a summary only (small pages)', async () => {
      const reqs = server.log.filter((r) => r.path === '/api/ui/history');
      const first = reqs.slice(0, 4).map((r) => Object.fromEntries(new URLSearchParams(r.query)));
      expect(first.every((q) => Number(q.limit) <= 100), 'limits ' + first.map((q) => q.limit));
      expect(first.some((q) => q.phase === 'live') && first.some((q) => q.phase === 'line') && first.some((q) => q.phase === 'removed' && q.end) && first.some((q) => q.limit === '1'), JSON.stringify(first));
      return reqs.length + ' requests so far';
    });
    await check('top filter bar keeps its height and edges across all tabs', async () => {
      const boxes = [];
      for (const t of ['live', 'prematch', 'results', 'compare', 'history']) { await page.click(`#tabs [data-tab="${t}"]`); await sleep(350); boxes.push(await page.evaluate(() => { const r = (id) => { const b = document.getElementById(id).getBoundingClientRect(); return [Math.round(b.x), Math.round(b.width), Math.round(b.y), Math.round(b.height)]; }; return { bar: r('toolbar'), search: r('search'), game: r('categoryButton'), fav: r('favorites'), list: Math.round(document.getElementById('listPane').getBoundingClientRect().y) }; })); }
      const same = boxes.every((x) => JSON.stringify(x) === JSON.stringify(boxes[0]));
      expect(same, JSON.stringify(boxes)); return boxes[0];
    });
    await check('game filter: icons, keyboard selection applies the filter', async () => {
      await page.click('#tabs [data-tab="live"]'); await sleep(300);
      await page.focus('#categoryButton'); await page.keyboard.press('ArrowDown'); await page.waitForSelector('#categoryList:not([hidden])');
      const icons = await page.$$eval('#categoryList .lb-option', (n) => n.map((o) => ({ label: o.querySelector('.lb-label').textContent, glyph: !!o.querySelector('.game-icon[data-glyph],.gi-all') })));
      expect(icons.length > 3 && icons.every((i) => i.glyph), JSON.stringify(icons));
      await page.keyboard.press('ArrowDown'); await page.keyboard.press('Enter'); await sleep(400);
      const st = await page.evaluate(() => ({ label: document.querySelector('#categoryButton .lb-label').textContent, cats: [...new Set([...document.querySelectorAll('#content>.list[data-view="live"] section .group-head>span:nth-child(2)')].map((n) => n.textContent))] }));
      expect(st.label !== 'Все игры' && st.cats.length === 1 && st.cats[0] === st.label, JSON.stringify(st));
      await page.click('#resetFilters'); await sleep(300);
      return { options: icons.length, chosen: st.label };
    });
    await check('Line: expand all = games open + leagues collapsed, never the previous nested state', async () => {
      await page.click('#tabs [data-tab="prematch"]'); await sleep(700);
      const open = () => page.evaluate(() => ({ games: document.querySelectorAll('#content>.list[data-view="prematch"] details.game-group[open]').length, all: document.querySelectorAll('#content>.list[data-view="prematch"] details.game-group').length, leagues: document.querySelectorAll('#content>.list[data-view="prematch"] details.league-group[open]').length }));
      const a = await open(); expect(a.games === a.all && a.leagues === 0, 'default ' + JSON.stringify(a));
      await page.click('#content>.list[data-view="prematch"] details.league-group>summary'); await sleep(300);
      expect((await open()).leagues === 1, 'a league opens');
      await page.click('[data-line-fold]'); await sleep(300);
      const c = await open(); expect(c.games === 0, 'collapse all ' + JSON.stringify(c));
      await page.click('[data-line-fold]'); await sleep(300);
      const d = await open(); expect(d.games === d.all && d.leagues === 0, 'expand all ' + JSON.stringify(d));
      const label = await page.$eval('[data-line-fold]', (x) => x.getAttribute('aria-label'));
      return { ...d, label };
    });
    await check('GGBET can be switched off and on in the extension; DataBet appears nowhere', async () => {
      await page.click('#tabs [data-tab="live"]'); await sleep(400);
      const cols = () => page.$$eval('#content>.list[data-view="live"] .col-head .book-col', (n) => n.map((x) => x.textContent.trim()));
      expect((await cols()).includes('GGBET'), 'GGBET column');
      await page.click('#sourcesButton'); await page.waitForSelector('#sourcesPopover:not([hidden])');
      expect(!/DataBet/i.test(await page.$eval('#sourcesPopover', (p) => p.textContent)), 'no DataBet in sources');
      await page.click('[data-book-toggle="ggbet"]'); await sleep(400);
      const off = await cols(); expect(!off.includes('GGBET') && off.length === 3, 'off: ' + off);
      await page.click('[data-book-toggle="ggbet"]'); await sleep(400);
      const on = await cols(); expect(on.includes('GGBET'), 'back on: ' + on);
      await page.keyboard.press('Escape');
      await page.click('#settingsButton'); await page.click('[data-settings-section="sources"]'); await sleep(300);
      const settings = await page.$eval('#settingsView', (v) => v.textContent);
      expect(/GGBET/.test(settings) && !/DataBet/i.test(settings), 'settings list'); await page.click('#settingsDone'); await sleep(200);
      expect(!/DataBet/.test(await page.evaluate(() => document.body.innerText)), 'no DataBet text on screen');
      return { off, on };
    });
    await check('team logos: broken URLs are requested once, then a placeholder or another logo', async () => {
      await page.click('#tabs [data-tab="history"]'); await sleep(1200);
      const broken = server.fixtures.logos.broken, hits = new Map();
      for (const r of server.log) if (r.path.startsWith('/api/team-logos/')) { const h = r.path.split('/').pop(); if (broken.includes(h)) hits.set(h, (hits.get(h) || 0) + 1); }
      const st = await page.evaluate(() => ({ imgs: document.querySelectorAll('img.team-logo').length, broken: [...document.querySelectorAll('img.team-logo')].filter((i) => i.complete && i.naturalWidth === 0).length, ph: document.querySelectorAll('.logo-ph').length }));
      expect([...hits.values()].every((n) => n <= 1), 'retry storm: ' + JSON.stringify([...hits]));
      expect(st.broken === 0 && st.imgs > 0 && st.ph > 0, JSON.stringify(st));
      return { ...st, brokenRequested: [...hits.values()].reduce((a, n) => a + n, 0) };
    });
    await check('theme: light applies at once and survives a reload', async () => {
      await page.click('#themeButton'); await sleep(200);
      const a = await page.evaluate(() => [document.documentElement.dataset.theme, getComputedStyle(document.body).backgroundColor]);
      await page.reload(); await page.waitForSelector('#content>.list article.match'); await sleep(300);
      const b = await page.evaluate(() => [document.documentElement.dataset.theme, localStorage.getItem('monitor-theme')]);
      expect(a[0] === 'light' && a[1] !== 'rgb(13, 17, 23)' && b[0] === 'light' && b[1] === 'light', JSON.stringify({ a, b }));
      await page.click('#themeButton'); await sleep(150);
      return { a, b };
    });
    await b.close();
  } finally { await server.close(); }
  const failed = results.filter((r) => !r.ok);
  console.log(JSON.stringify({ passed: results.length - failed.length, failed: failed.length, results }, null, 2));
  if (arg('json')) writeFileSync(arg('json'), JSON.stringify(results, null, 2));
  process.exit(failed.length ? 1 : 0);
}

await (mode === 'screens' ? screens() : mode === 'profile' ? profile() : mode === 'verify' ? verify() : measure());
process.exit(0);
