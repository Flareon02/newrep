#!/usr/bin/env node
// DEV benchmark of the extension UI (9.x): real Chromium + the unpacked extension against a running server.
//
//   PLAYWRIGHT_MODULE=/path/to/playwright/index.mjs EXTENSION_DIR=dist/staging-extension node tools/bench/ui-bench.mjs [--runs 3] [--json out.json]
//
// Every number is measured inside the page: performance.now() at the click, then every animation frame until the
// expected DOM is there (no automation latency). Medians over the runs; -1 = not reached within the timeout.
// Never run two benchmarks or a benchmark and the E2E suite at the same time on a 1-vCPU host.
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const arg = (n, d) => { const i = process.argv.indexOf('--' + n); return i > 0 ? process.argv[i + 1] : d; };
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const ext = path.resolve(root, process.env.EXTENSION_DIR || 'dist/staging-extension');
const RUNS = Number(arg('runs', 3));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const median = (a) => { const s = a.filter((x) => x >= 0).sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : -1; };
const results = {}; const add = (k, v) => (results[k] ||= []).push(v);

const ctx = await chromium.launchPersistentContext(mkdtempSync(path.join(tmpdir(), 'ui-bench-')), { headless: false, viewport: { width: 1360, height: 860 }, args: ['--headless=new', '--no-sandbox', `--disable-extensions-except=${ext}`, `--load-extension=${ext}`] });
const sw = ctx.serviceWorkers()[0] || await ctx.waitForEvent('serviceworker'); const url = `chrome-extension://${new URL(sw.url()).host}/app.html`;
const measure = (page, action, condition, timeout = 30000) => page.evaluate(async ({ action, condition, timeout }) => {
  const act = new Function(action), cond = new Function(`return (${condition})`), t0 = performance.now(); act();
  while (performance.now() - t0 < timeout) { await new Promise((r) => requestAnimationFrame(r)); try { if (cond()) return Math.round(performance.now() - t0); } catch {} }
  return -1;
}, { action, condition, timeout });
const tabClick = (t) => `document.querySelector('#tabs [data-tab="${t}"]').click()`;
const tabShown = (t, extra = 'article.match') => `document.querySelector('#tabs [data-tab="${t}"]').getAttribute('aria-current')==='page' && document.querySelector('#content .list[data-view="${t}"]:not([hidden]) ${extra}')`;
// Time of the first frame that shows a LIVE row, recorded by an init script from navigation start (polling after
// page.goto() would report when the check ran, not when the row appeared).
const ROW = process.env.BENCH_ROW_SELECTOR || '#content .list[data-view="live"] article.match';
await ctx.addInitScript((sel) => { const poll = () => { if (document.querySelector(sel)) { window.__firstRowAt = Math.round(performance.now()); return; } requestAnimationFrame(poll); }; requestAnimationFrame(poll); }, ROW);
const firstPaint = async (page) => { for (let i = 0; i < 300; i++) { const t = await page.evaluate(() => window.__firstRowAt ?? null); if (t != null) return t; await sleep(100); } return -1; };

for (let run = 0; run < RUNS; run++) {
  const page = await ctx.newPage(); await page.goto(url);
  add(run === 0 ? 'initialRender.firstInstall' : 'initialRender.reopen', await firstPaint(page));
  await sleep(2500);
  add(run === 0 ? 'tab.results.first' : 'tab.results.reopenedPage', await measure(page, tabClick('results'), tabShown('results')));
  await sleep(800);
  add('tab.live', await measure(page, tabClick('live'), tabShown('live')));
  await sleep(400);
  add('tab.results.again', await measure(page, tabClick('results'), tabShown('results')));
  await sleep(400);
  add('tab.prematch', await measure(page, tabClick('prematch'), tabShown('prematch')));
  await sleep(400);
  add(run === 0 ? 'tab.history.first' : 'tab.history.reopenedPage', await measure(page, tabClick('history'), tabShown('history'), 60000));
  await sleep(400);
  await measure(page, tabClick('live'), tabShown('live')); await sleep(1500);
  // event detail: first open (renders from the feed quote, full tree from the server), then a cached reopen
  const row = (n) => `document.querySelectorAll('#content .list[data-view="live"] article.match')[${n}]`;
  add('detail.open.first.paint', await measure(page, `window.__id=${row(0)}.dataset.id;${row(0)}.click()`, `DetailPanel.currentId()===window.__id && document.querySelector('#dpMarkets .outcome, #dpMarkets .state')`));
  add('detail.open.first.fullMarkets', await measure(page, '', `DetailPanel.state()?.loading===false && document.querySelectorAll('#dpMarkets .mkt').length>1`, 30000));
  add('detail.marketTab', await measure(page, `const b=[...document.querySelectorAll('#dpMarketTabs [role=tab]')].find(x=>x.getAttribute('aria-selected')!=='true');window.__t=b?.dataset.dpScope||b?.dataset.dpPtab;b?.click()`, `!window.__t || [...document.querySelectorAll('#dpMarketTabs [aria-selected=true]')].some(x=>(x.dataset.dpScope||x.dataset.dpPtab)===window.__t)`));
  add('detail.bookSwitch', await measure(page, `const b=[...document.querySelectorAll('#dpBooks [data-dp-book]')].find(x=>x.getAttribute('aria-pressed')!=='true');window.__b=b?.dataset.dpBook;b?.click()`, `!window.__b || document.querySelector('#dpBooks [aria-pressed=true]')?.dataset.dpBook===window.__b`));
  await measure(page, `${row(1)}?.click()`, `!${row(1)} || DetailPanel.currentId()!==window.__id`, 5000); await sleep(800);
  const findFirst = `[...document.querySelectorAll('#content .list[data-view="live"] article.match')].find((n)=>n.dataset.id===window.__id)`;
  if (await page.evaluate(`!!${findFirst}`)) add('detail.open.cached', await measure(page, `${findFirst}.click()`, `DetailPanel.currentId()===window.__id && document.querySelector('#dpMarkets .outcome, #dpMarkets .state')`));
  add('provider.switch', await measure(page, `document.getElementById(document.getElementById('databet').getAttribute('aria-pressed')==='true'?'ggbet':'databet').click()`, `document.querySelector('#content .list[data-view="live"] article.match')`));
  await sleep(2000);
  await page.close();
}
const summary = Object.fromEntries(Object.entries(results).map(([k, v]) => [k, { median: median(v), runs: v }]));
for (const [k, v] of Object.entries(summary)) console.log(`${k.padEnd(32)} ${String(v.median).padStart(6)} ms   runs ${v.runs.join(', ')}`);
const out = arg('json', ''); if (out) writeFileSync(out, JSON.stringify({ at: new Date().toISOString(), summary }, null, 1));
await ctx.close();
