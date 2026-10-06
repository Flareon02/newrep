// Smoke test of the built Windows app (CI, windows-latest): starts the real EsportsData.exe with WebView2 remote
// debugging enabled for this run only (environment variable; nothing in the build), attaches over CDP and checks that
//   - the app starts and the window stays up;
//   - the bundled frontend is loaded from the app itself (http(s)://tauri.localhost or tauri://localhost), not a website;
//   - it is the desktop build pointing at https://esportsdata.online, protocol 1;
//   - with no session the Access Key gate is shown (first launch);
//   - every network request goes only to the app itself or https://esportsdata.online (no localhost/dev endpoints);
//   - no Access Key or session token is present in its storage.
//
//   node web/scripts/desktop-smoke.mjs <path-to-EsportsData.exe> [--report smoke.json]
// Needs playwright-core (CDP client only; no browser download).
import { spawn, execSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';

const exe = process.argv[2];
const reportFile = process.argv.includes('--report') ? process.argv[process.argv.indexOf('--report') + 1] : '';
const require = createRequire(process.env.PLAYWRIGHT_CORE_DIR ? process.env.PLAYWRIGHT_CORE_DIR + '/package.json' : import.meta.url);
const { chromium } = require('playwright-core');
const PORT = 9333;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const checks = [];
const check = (name, ok, detail = '') => { checks.push({ name, ok: !!ok, detail }); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`); };

const child = spawn(exe, [], { env: { ...process.env, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${PORT}` }, stdio: 'ignore', detached: false });
let exited = null;
child.on('exit', (code) => { exited = code; });
let browser = null;
try {
  let version = null;
  for (let i = 0; i < 60 && !version && exited === null; i++) { await sleep(1000); try { version = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json(); } catch {} }
  check('app starts and WebView2 comes up', !!version && exited === null, version ? version.Browser : `exit ${exited}`);
  if (!version) throw new Error('no CDP endpoint');
  browser = await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`);
  let page = null;
  for (let i = 0; i < 30 && !page; i++) { page = browser.contexts().flatMap((c) => c.pages()).find((p) => /^(https?:\/\/tauri\.localhost|tauri:\/\/localhost)/.test(p.url())); if (!page) await sleep(500); }
  check('bundled frontend loaded from the app (not a remote site)', !!page, page ? page.url() : browser.contexts().flatMap((c) => c.pages()).map((p) => p.url()).join(', '));
  if (!page) throw new Error('no app page');
  const requests = [];
  page.on('request', (r) => requests.push(r.url()));
  await page.waitForFunction(() => document.getElementById('gate') && !document.getElementById('gate').hidden, null, { timeout: 30000 }).catch(() => {});
  const state = await page.evaluate(() => ({
    build: window.__EDS_BUILD__, title: document.title, origin: location.origin,
    gate: !document.getElementById('gate').hidden, app: !document.getElementById('app').hidden,
    tauri: !!window.__TAURI__, updater: !!window.__TAURI__?.updater, opener: !!window.__TAURI__?.opener,
    resources: performance.getEntriesByType('resource').map((e) => e.name),
    storage: JSON.stringify(localStorage) + JSON.stringify(sessionStorage),
  }));
  check('desktop build, production API origin', state.build?.target === 'tauri' && state.build?.apiBase === 'https://esportsdata.online', `${state.build?.target} ${state.build?.apiBase} v${state.build?.version} ${state.build?.commit}`);
  check('client protocol declared', state.build?.protocol === 1, String(state.build?.protocol));
  check('Access Key gate shown on first launch', state.gate && !state.app, `gate=${state.gate} app=${state.app}`);
  check('Tauri APIs available to the frontend (opener, updater)', state.tauri && state.updater && state.opener);
  const all = [...state.resources, ...requests];
  const foreign = all.filter((u) => !/^(https?:\/\/tauri\.localhost|tauri:\/\/localhost|https:\/\/esportsdata\.online|ipc:|http:\/\/ipc\.localhost|data:|blob:)/.test(u));
  check('no requests outside the app and https://esportsdata.online', foreign.length === 0, foreign.slice(0, 5).join(', ') || `${all.length} requests`);
  check('no key or session token in app storage', !/emu_[0-9a-f]{48}|eds_[A-Za-z0-9_-]{43}/.test(state.storage));
  await sleep(3000);
  check('window still running after load', exited === null);
  if (process.env.SMOKE_SCREENSHOT) await page.screenshot({ path: process.env.SMOKE_SCREENSHOT }).catch(() => {});
} catch (error) {
  check('smoke run completed', false, error.message);
  // Diagnostics for a failed start: is WebView2 running, what does the window say.
  try { console.log(execSync('powershell -NoProfile -Command "Get-Process EsportsData,msedgewebview2 -ErrorAction SilentlyContinue | Select-Object Name,Id,MainWindowTitle,SessionId | Format-Table -AutoSize | Out-String -Width 200"', { encoding: 'utf8' })); } catch {}
  try { console.log(execSync('reg query "HKLM\\SOFTWARE\\WOW6432Node\\Microsoft\\EdgeUpdate\\Clients\\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}" /v pv', { encoding: 'utf8' })); } catch { console.log('WebView2 runtime registry key not found'); }
} finally {
  try { await browser?.close(); } catch {}
  try { execSync(`taskkill /PID ${child.pid} /T /F`, { stdio: 'ignore' }); } catch { child.kill(); }
}
const failed = checks.filter((c) => !c.ok);
if (reportFile) fs.writeFileSync(reportFile, JSON.stringify({ at: new Date().toISOString(), passed: checks.length - failed.length, total: checks.length, checks }, null, 2));
console.log(`desktop smoke: ${checks.length - failed.length}/${checks.length}`);
process.exit(failed.length ? 1 : 0);
