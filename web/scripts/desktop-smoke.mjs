// Smoke test of the built Windows app (CI, windows-latest). Starts the real EsportsData.exe and checks:
//
//   1. through Windows UI Automation (the WebView2 accessibility tree of the real window - no debug hooks in the
//      app): the app starts, its window stays up, the bundled frontend renders the Access Key gate (heading, key
//      field, «Войти»), and the monitor is not shown before sign-in;
//   2. when this runner's WebView2 opens a remote-debugging port (runner-only environment/HKCU policy, nothing in the
//      build), additionally over CDP: frontend served by the app itself (tauri.localhost), desktop build pointing at
//      https://esportsdata.online with protocol 1, Tauri APIs present, no request outside the app and the
//      production origin, no key/token in storage. Without the port these facts are covered by check-bundle.mjs on
//      the very files the build embeds (dist/tauri).
//
//   node web/scripts/desktop-smoke.mjs <path-to-EsportsData.exe> [--report smoke.json]
// Needs playwright-core only for part 2 (CDP client, no browser download).
import { spawn, execSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const exe = path.resolve(process.argv[2]);
const reportFile = process.argv.includes('--report') ? process.argv[process.argv.indexOf('--report') + 1] : '';
const PORT = 9333;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const checks = [];
const check = (name, ok, detail = '') => { checks.push({ name, ok: !!ok, detail }); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`); };
const note = (text) => { checks.push({ name: text, ok: true, info: true }); console.log('INFO ' + text); };

const UIA_SCRIPT = String.raw`[Console]::OutputEncoding = [Text.Encoding]::UTF8
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes
$A = [System.Windows.Automation.AutomationElement]
$cond = New-Object System.Windows.Automation.PropertyCondition($A::ProcessIdProperty, [int]$args[0])
$win = $A::RootElement.FindFirst([System.Windows.Automation.TreeScope]::Children, $cond)
if (-not $win) { '{"window":null,"names":[]}'; exit }
$items = $win.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition)
$names = @()
foreach ($e in $items) { $n = $e.Current.Name; if ($n) { $names += ($e.Current.ControlType.ProgrammaticName -replace '^ControlType\.', '') + '|' + $n } }
@{ window = $win.Current.Name; names = $names } | ConvertTo-Json -Compress -Depth 3`;
const uiaFile = path.join(os.tmpdir(), 'eds-uia.ps1');
fs.writeFileSync(uiaFile, '﻿' + UIA_SCRIPT);
function uia(pid) {
  try { return JSON.parse(execSync(`powershell -NoProfile -ExecutionPolicy Bypass -File "${uiaFile}" ${pid}`, { encoding: 'utf8', timeout: 90000 }).trim() || '{}'); }
  catch (e) { return { error: String(e.message).slice(0, 200), names: [] }; }
}
function ps(command) { try { return execSync(`powershell -NoProfile -Command "${command}"`, { encoding: 'utf8', timeout: 30000 }).trim(); } catch { return ''; } }

const child = spawn(exe, [], { env: { ...process.env, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${PORT}` }, stdio: 'ignore' });
let exited = null;
child.on('exit', (code) => { exited = code; });
let browser = null;
try {
  // ---- 1. UI Automation -------------------------------------------------------------------------------------------
  let ui = { names: [] };
  for (let i = 0; i < 20 && exited === null; i++) {
    await sleep(3000);
    ui = uia(child.pid);
    if ((ui.names || []).some((n) => n.includes('Вход по ключу доступа'))) break;
  }
  const names = ui.names || [];
  const has = (re) => names.some((n) => re.test(n));
  check('app starts and its window stays up', exited === null && !!ui.window, `window "${ui.window || ''}"${ui.error ? ' — ' + ui.error : ''}`);
  check('bundled frontend renders the Access Key gate (UI Automation)', has(/Вход по ключу доступа/) && has(/^Button\|Войти$/) && has(/Ключ доступа/), names.filter((n) => /Вход|Войти|Ключ доступа|Показать/.test(n)).slice(0, 6).join(' ; ') || `${names.length} names`);
  check('monitor is not shown before sign-in', !has(/^Button\|Результаты$/) && !has(/^Button\|История$/));
  console.log('INFO webview2:', (ps("(Get-CimInstance Win32_Process -Filter 'Name=''msedgewebview2.exe''' | Select-Object -First 1).CommandLine") || '(no command line)').slice(0, 500));

  // ---- 2. CDP (optional) ------------------------------------------------------------------------------------------
  let endpoint = '';
  for (const host of ['127.0.0.1', '[::1]']) { try { await (await fetch(`http://${host}:${PORT}/json/version`, { signal: AbortSignal.timeout(3000) })).json(); endpoint = `http://${host}:${PORT}`; break; } catch {} }
  if (!endpoint) {
    note('CDP not available on this runner: origin/target/secret checks rely on check-bundle.mjs over the embedded dist/tauri');
  } else {
    const require = createRequire(process.env.PLAYWRIGHT_CORE_DIR ? process.env.PLAYWRIGHT_CORE_DIR + '/package.json' : import.meta.url);
    const { chromium } = require('playwright-core');
    browser = await chromium.connectOverCDP(endpoint);
    const page = browser.contexts().flatMap((c) => c.pages()).find((p) => /^(https?:\/\/tauri\.localhost|tauri:\/\/localhost)/.test(p.url()));
    check('bundled frontend loaded from the app (not a remote site)', !!page, page ? page.url() : '');
    if (page) {
      const state = await page.evaluate(() => ({
        build: window.__EDS_BUILD__, tauri: !!window.__TAURI__, updater: !!window.__TAURI__?.updater, opener: !!window.__TAURI__?.opener,
        resources: performance.getEntriesByType('resource').map((e) => e.name), storage: JSON.stringify(localStorage) + JSON.stringify(sessionStorage),
      }));
      check('desktop build, production API origin, protocol 1', state.build?.target === 'tauri' && state.build?.apiBase === 'https://esportsdata.online' && state.build?.protocol === 1, `${state.build?.apiBase} v${state.build?.version} ${state.build?.commit}`);
      check('Tauri APIs available to the frontend (opener, updater)', state.tauri && state.updater && state.opener);
      const foreign = state.resources.filter((u) => !/^(https?:\/\/tauri\.localhost|tauri:\/\/localhost|https:\/\/esportsdata\.online|ipc:|http:\/\/ipc\.localhost|data:|blob:)/.test(u));
      check('no requests outside the app and https://esportsdata.online', !foreign.length, foreign.slice(0, 5).join(', ') || `${state.resources.length} requests`);
      check('no key or session token in app storage', !/emu_[0-9a-f]{48}|eds_[A-Za-z0-9_-]{43}/.test(state.storage));
      if (process.env.SMOKE_SCREENSHOT) await page.screenshot({ path: process.env.SMOKE_SCREENSHOT }).catch(() => {});
    }
  }
  await sleep(2000);
  check('window still running at the end', exited === null);
} catch (error) {
  check('smoke run completed', false, error.message);
} finally {
  try { await browser?.close(); } catch {}
  try { execSync(`taskkill /PID ${child.pid} /T /F`, { stdio: 'ignore' }); } catch { child.kill(); }
}
const failed = checks.filter((c) => !c.ok);
const real = checks.filter((c) => !c.info);
if (reportFile) fs.writeFileSync(reportFile, JSON.stringify({ at: new Date().toISOString(), passed: real.length - failed.length, total: real.length, checks }, null, 2));
console.log(`desktop smoke: ${real.length - failed.length}/${real.length}`);
process.exit(failed.length ? 1 : 0);
