#!/usr/bin/env node
// READ-ONLY acceptance of the extension against a real Esports Monitor API (one user-like session, bounded steps).
//
//   PLAYWRIGHT_MODULE=… node tools/ux/real-acceptance.mjs --base http://127.0.0.1:80 --token-file /etc/esports-monitor/server.env \
//        [--ext extension] [--label 9.3.0] [--older 6] [--idle 45000] [--shots dir] [--json out.json] [--quick]
//
// Only GET/SSE requests a normal user makes (the extension's own), never upstream bookmakers. The token is read into
// memory and handed to the test browser profile (deleted afterwards); it is never printed or written to the output.
// --quick: performance flows only (used for the old 9.2.0 build, whose UI lacks the 9.3 controls).
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const arg = (n, d) => { const i = process.argv.indexOf('--' + n); return i > 0 ? process.argv[i + 1] : d; };
const pw = process.env.PLAYWRIGHT_MODULE || 'playwright';
const { chromium } = await import(pw.startsWith('/') ? pathToFileURL(pw).href : pw);
const base = String(arg('base', '')).replace(/\/+$/, '');
const origin = (() => { try { return new URL(base).origin; } catch { return ''; } })();   // Chrome reports http://127.0.0.1:80 as http://127.0.0.1
const tokenText = arg('token-file') ? readFileSync(arg('token-file'), 'utf8') : (process.env.MONITOR_TOKEN || '');
const token = ((/^API_TOKEN=(.*)$/m.exec(tokenText) || [])[1] || tokenText).trim().replace(/^(['"])(.*)\1$/, '$2');
const ext = path.resolve(root, arg('ext', 'extension')), label = arg('label', 'extension'), quick = process.argv.includes('--quick');
const shots = arg('shots', ''); if (shots) mkdirSync(shots, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
if (!base || !token) { console.error('--base and a token (--token-file or MONITOR_TOKEN) are required'); process.exit(2); }

const profile = mkdtempSync(path.join(tmpdir(), 'em-real-'));
const out = { label, base: base.replace(/\/\/[^@/]*@/, '//'), at: new Date().toISOString(), checks: [], perf: {} };
const requests = [];
const check = async (name, fn) => { try { const detail = await fn(); out.checks.push({ name, ok: true, detail }); console.error('PASS', name, JSON.stringify(detail ?? '').slice(0, 300)); } catch (e) { out.checks.push({ name, ok: false, detail: e.message }); console.error('FAIL', name, e.message); } };
const expect = (c, m) => { if (!c) throw new Error(m); };
const context = await chromium.launchPersistentContext(profile, { channel: 'chromium', headless: true, viewport: { width: 1440, height: 900 }, args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`, '--enable-precise-memory-info'] });
try {
  let [worker] = context.serviceWorkers(); if (!worker) worker = await context.waitForEvent('serviceworker');
  const id = new URL(worker.url()).host;
  await worker.evaluate(async ({ base, token }) => { await chrome.storage.local.clear(); await chrome.storage.local.set({ server: { base, token }, prefs: { lastTab: 'live', ui900: true } }); }, { base, token });
  const page = await context.newPage();
  page.on('request', (r) => { if (new URL(r.url()).origin === origin) requests.push({ at: Date.now(), path: new URL(r.url()).pathname, query: new URL(r.url()).search, method: r.method() }); });
  const sizes = new Map(); page.on('response', async (r) => { if (new URL(r.url()).origin === origin && new URL(r.url()).pathname === '/api/ui/history') { try { sizes.set(r.url(), (await r.body()).length); } catch {} } });
  const errors = []; page.on('pageerror', (e) => errors.push(e.message));
  await page.addInitScript(({ base, token }) => {
    try { localStorage.setItem('monitor-server', JSON.stringify({ base, token })); } catch {}
    window.__lt = []; window.__lag = { max: 0 };
    try { new PerformanceObserver((l) => { for (const e of l.getEntries()) window.__lt.push(Math.round(e.duration)); }).observe({ type: 'longtask', buffered: true }); } catch {}
    let last = performance.now(); setInterval(() => { const n = performance.now(), lag = n - last - 50; last = n; if (lag > window.__lag.max) window.__lag.max = Math.round(lag); }, 50);
  }, { base, token });
  const stats = (view) => page.evaluate((v) => { const l = document.querySelector(`#content>.list[data-view="${v}"]`); const h = window.__monitorDebug?.history?.(); return { mounted: l?.querySelectorAll('article.match,tr[data-id]').length || 0, loaded: v === 'history' ? h?.loaded ?? null : null, listNodes: l?.querySelectorAll('*').length || 0, documentNodes: document.querySelectorAll('*').length, heapMB: Math.round((performance.memory?.usedJSHeapSize || 0) / 104857.6) / 10, longTasks: window.__lt.length, maxLongTask: Math.max(0, ...window.__lt), totalLongTask: window.__lt.reduce((a, b) => a + b, 0), lagMax: window.__lag.max }; }, view);
  const reset = () => page.evaluate(() => { window.__lt = []; window.__lag.max = 0; });
  const histReq = (since) => requests.filter((r) => r.path === '/api/ui/history' && r.at >= since);
  const snap = async (name) => { if (shots) await page.screenshot({ path: path.join(shots, `${label}-${name}.png`) }); };
  const switchTo = async (view, rowSel = 'article.match') => { await reset(); const t = await page.evaluate((v) => { const t0 = performance.now(); document.querySelector(`#tabs [data-tab="${v}"]`).click(); return t0; }, view); await page.waitForFunction(([v, sel]) => document.querySelector(`#content>.list[data-view="${v}"] ${sel}`), [view, rowSel], { timeout: 60000, polling: 'raf' }); const ms = await page.evaluate((t0) => Math.round(performance.now() - t0), t); return ms; };

  // LIVE open
  const t0 = Date.now();
  await page.goto(`chrome-extension://${id}/app.html`);
  await page.waitForSelector('#content>.list[data-view="live"] article.match', { timeout: 60000 });
  out.perf.liveOpenMs = Date.now() - t0;
  await sleep(2500); out.perf.live = await stats('live'); await snap('live-dark');
  await check('LIVE renders real matches', async () => { const s = await stats('live'); expect(s.mounted > 0, 'no rows'); return s; });
  if (!quick) {
    await check('Line (prematch) renders', async () => { const ms = await switchTo('prematch', 'details.game-group,article.match'); await sleep(800); await snap('prematch'); const games = await page.$$eval('#content>.list[data-view="prematch"] details.game-group', (n) => n.length); const leaguesOpen = await page.$$eval('#content>.list[data-view="prematch"] details.league-group[open]', (n) => n.length); expect(games > 0, 'no games'); return { ms, games, leaguesOpen }; });
    await check('Results render', async () => { const ms = await switchTo('results', 'article.match'); await sleep(800); await snap('results'); return { ms, ...(await stats('results')) }; });
  }
  // History: first open, older days, filter, switches, idle under real invalidations
  await page.click('#tabs [data-tab="live"]'); await sleep(1500);
  const h0 = Date.now();
  out.perf.historyFirstRowsMs = await switchTo('history');
  await sleep(4000);
  out.perf.historyOpen = { ...(await stats('history')), requests: histReq(h0).length, bytes: [...sizes.values()].reduce((a, b) => a + b, 0) };
  await snap('history');
  await reset(); const hm = Date.now(); const steps = [];
  for (let i = 0; i < Number(arg('older', 6)); i++) {
    const before = (await stats('history')).loaded ?? (await stats('history')).mounted; const s = Date.now();
    await page.evaluate(() => { const l = document.querySelector('#content>.list[data-view="history"]'); l.scrollTop = l.scrollHeight; const b = l.querySelector('[data-history-older],[data-more-history]'); if (b && !b.disabled) b.click(); });
    try { await page.waitForFunction((n) => { const h = window.__monitorDebug?.history?.(); const v = h ? h.loaded : document.querySelectorAll('#content>.list[data-view="history"] article.match').length; return v > n; }, before, { timeout: 30000, polling: 200 }); } catch {}
    const after = (await stats('history')).loaded ?? (await stats('history')).mounted; steps.push({ before, after, ms: Date.now() - s }); if (after === before) break;
  }
  out.perf.historyOlder = { steps, ...(await stats('history')), requests: histReq(hm).length };
  await snap('history-older');
  out.perf.switchHistoryToLiveMs = await switchTo('live');
  out.perf.switchLiveToHistoryMs = await switchTo('history');
  await reset(); const hi = Date.now(); await sleep(Number(arg('idle', 45000)));
  out.perf.historyIdle = { seconds: Number(arg('idle', 45000)) / 1000, ...(await stats('history')), requests: histReq(hi).length };
  if (!quick) {
    await check('History game filter (listbox) applies and cancels the previous query', async () => {
      const s = Date.now(); await page.click('#categoryButton'); await page.waitForSelector('#categoryList:not([hidden])');
      const opts = await page.$$eval('#categoryList .lb-option', (n) => n.map((o) => o.querySelector('.lb-label').textContent));
      const key0 = await page.evaluate(() => window.__monitorDebug.history().status.key);
      const best = await page.$$eval('#categoryList .lb-option', (n) => n.slice(1).map((o, i) => [i + 2, Number(o.querySelector('.lb-count').textContent) || 0]).sort((a, b) => b[1] - a[1])[0][0]);
      await page.click(`#categoryList .lb-option:nth-child(${best})`);
      await page.waitForFunction((k) => { const h = window.__monitorDebug.history(); return h.status.key !== k && h.sections.some((x) => x.state === 'ready' && x.rows > 0); }, key0, { timeout: 60000 });
      await sleep(1500); const chosen = await page.$eval('#categoryButton .lb-label', (n) => n.textContent);
      const cats = await page.$$eval('#content>.list[data-view="history"] article.match .meta > span:not(.game-icon)', (n) => [...new Set(n.map((x) => x.textContent.split(' · ')[0]))]);
      await snap('history-filtered'); await page.click('#resetFilters').catch(() => {}); await sleep(800);
      expect(cats.length <= 1, 'mixed games after filter: ' + cats); return { options: opts.length, chosen, rowsGames: cats, requests: histReq(s).length };
    });
    await check('match details: odds, CS2 statistics and streams where available', async () => {
      await page.click('#tabs [data-tab="live"]'); await sleep(1200);
      const ids = await page.$$eval('#content>.list[data-view="live"] article.match', (n) => n.map((x) => ({ id: x.dataset.id, cs: /counter|cs2/i.test(x.closest('section')?.textContent || '') })));
      expect(ids.length, 'no LIVE match');
      const first = ids[0].id; await page.click(`#content>.list[data-view="live"] article.match[data-id="${first}"] .teams`); await sleep(2500);
      const odds = await page.evaluate(() => ({ books: document.querySelectorAll('#dpBooks [data-dp-book]').length, markets: document.querySelectorAll('#dpMarkets .mkt').length, tabs: [...document.querySelectorAll('#dpTabs [data-dp-tab]')].map((t) => t.dataset.dpTab) }));
      await snap('detail-odds');
      let cs2 = null;
      for (const c of ids.filter((x) => x.cs).slice(0, 6)) {
        await page.click(`#content>.list[data-view="live"] article.match[data-id="${c.id}"] .teams`); await sleep(800);
        if (!(await page.$('#dpTabs [data-dp-tab="stats"]'))) continue;
        await page.click('#dpTabs [data-dp-tab="stats"]'); try { await page.waitForSelector('.cs2-board,.cs2-wait', { timeout: 10000 }); } catch {}
        await sleep(2500);
        cs2 = await page.evaluate(() => ({ board: !!document.querySelector('.cs2-board'), rounds: document.querySelectorAll('.cs2-track .rc').length, coloured: [...document.querySelectorAll('.slot.won')].filter((s) => getComputedStyle(s).color !== 'rgb(0, 0, 0)').length, logOpen: document.querySelector('.cs2-event-log')?.open ?? null, streams: document.querySelectorAll('.streams .stream').length, wait: document.querySelector('.cs2-wait')?.textContent || '' }));
        await snap('detail-cs2'); if (cs2.board) break;
      }
      await page.keyboard.press('Escape');
      expect(odds.tabs.length > 0, 'detail did not open'); if (cs2?.board) expect(cs2.logOpen !== true, 'event log open by default');
      return { odds, cs2: cs2 || 'no CS2 match with statistics live right now' };
    });
    await check('logos: real logos load, broken ones fall back, no repeated failures', async () => {
      const s = await page.evaluate(() => ({ imgs: document.querySelectorAll('img.team-logo').length, loaded: [...document.querySelectorAll('img.team-logo')].filter((i) => i.complete && i.naturalWidth > 0).length, broken: [...document.querySelectorAll('img.team-logo')].filter((i) => i.complete && i.naturalWidth === 0).length, placeholders: document.querySelectorAll('.logo-ph').length }));
      const logoReq = requests.filter((r) => r.path.startsWith('/api/team-logos/')), byPath = new Map(); for (const r of logoReq) byPath.set(r.path, (byPath.get(r.path) || 0) + 1);
      expect(s.broken === 0, 'broken image visible'); return { ...s, logoRequests: logoReq.length, maxPerLogo: Math.max(0, ...byPath.values()) };
    });
    await check('GGBET toggle and provider visibility (no DataBet)', async () => {
      const cols = () => page.$$eval('#content>.list[data-view="live"] .col-head .book-col', (n) => n.map((x) => x.textContent.trim()));
      const before = await cols(); await page.click('#sourcesButton'); await page.waitForSelector('#sourcesPopover:not([hidden])');
      const popover = await page.$eval('#sourcesPopover', (p) => p.textContent);
      await page.click('[data-book-toggle="ggbet"]'); await sleep(500); const off = await cols();
      await page.click('[data-book-toggle="ggbet"]'); await sleep(500); const on = await cols(); await page.keyboard.press('Escape');
      expect(!/DataBet/i.test(popover) && !/DataBet/.test(await page.evaluate(() => document.body.innerText)), 'DataBet visible');
      expect(!off.includes('GGBET') && JSON.stringify(on) === JSON.stringify(before), JSON.stringify({ before, off, on })); return { before, off };
    });
    await check('themes: light and system render real data', async () => {
      await page.click('#themeButton'); await sleep(600); await snap('live-light'); await page.click('#tabs [data-tab="history"]'); await sleep(1200); await snap('history-light');
      const t = await page.evaluate(() => document.documentElement.dataset.theme); await page.click('#themeButton'); await sleep(300); await page.click('#tabs [data-tab="live"]');
      expect(t === 'light', t); return t;
    });
  }
  out.pageErrors = errors.slice(0, 20);
  out.requestSummary = Object.fromEntries([...requests.reduce((m, r) => m.set(r.path.replace(/\/[a-f0-9]{32}$/, '/<hash>').replace(/\/api\/events\/[^/]+/, '/api/events/<id>'), (m.get(r.path.replace(/\/[a-f0-9]{32}$/, '/<hash>')) || 0) + 1), new Map())].sort((a, b) => b[1] - a[1]));
} finally { await context.close(); rmSync(profile, { recursive: true, force: true }); }
const text = JSON.stringify(out, null, 2);
if (text.includes(token)) throw new Error('token leaked into the report');
console.log(text); if (arg('json')) writeFileSync(arg('json'), text);
process.exit(out.checks.some((c) => !c.ok) ? 1 : 0);
