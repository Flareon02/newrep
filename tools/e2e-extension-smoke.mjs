#!/usr/bin/env node
// End-to-end smoke test: real Chromium + the unpacked extension + a real local server process.
// Verifies that the extension loads without errors, talks to a configured server, sends the
// access token, and shows the server's 401 message when the token is missing.
//
//   cd server && npm install --omit=dev && cd ..
//   node tools/e2e-extension-smoke.mjs        (needs Playwright + Chromium; see docs/DEPLOYMENT.md)
//
// The server is started with an empty temporary data directory and cannot reach the real
// bookmakers from CI, so no feed content is asserted - only transport, config and auth.
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { networkInterfaces, tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const TOKEN = 'e2e-token-0123456789abcdef';
const PORT = 18000 + Math.floor(Math.random() * 1000);
// The server trusts loopback callers; use a non-loopback address of this machine to exercise auth.
const host = Object.values(networkInterfaces()).flat().find((i) => i && i.family === 'IPv4' && !i.internal)?.address || '127.0.0.1';
const dataDir = mkdtempSync(path.join(tmpdir(), 'monitor-e2e-data-'));
const profile = mkdtempSync(path.join(tmpdir(), 'monitor-e2e-profile-'));
const failures = [];
const check = (name, ok, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' - ' + detail : ''}`); if (!ok) failures.push(name); };

const server = spawn('node', ['src/index.js'], {
  cwd: path.join(root, 'server'),
  env: { ...process.env, DATA_DIR: dataDir, PORT: String(PORT), API_TOKEN: TOKEN, NODE_OPTIONS: '--disable-warning=ExperimentalWarning' },
  stdio: 'ignore',
});
const base = `http://${host}:${PORT}`;
for (let i = 0; i < 40; i++) { try { if ((await fetch(base + '/health')).ok) break; } catch {} await new Promise((r) => setTimeout(r, 250)); }

let context;
try {
  context = await chromium.launchPersistentContext(profile, {
    headless: false,
    args: ['--headless=new', '--no-sandbox', `--disable-extensions-except=${path.join(root, 'extension')}`, `--load-extension=${path.join(root, 'extension')}`],
  });
  let [worker] = context.serviceWorkers();
  worker ||= await context.waitForEvent('serviceworker', { timeout: 15000 });
  const extensionId = new URL(worker.url()).host;
  check('service worker starts', worker.url().endsWith('/background.js'));

  await worker.evaluate(async ([b, t]) => { await chrome.storage.local.set({ server: { base: b, token: t } }); }, [base, TOKEN]);
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await page.goto(`chrome-extension://${extensionId}/app.html`);
  await page.waitForTimeout(4000);
  check('app page uses the configured server', (await page.evaluate(() => BASE)) === base);
  check('no script errors on load', errors.length === 0, errors.slice(0, 3).join(' | '));

  await page.click('#settingsButton');
  check('settings show the server section', (await page.inputValue('#serverBase')) === base);
  check('team logos checkbox reflects the stored preference', await page.isChecked('#settingsTeamLogos'));
  await page.click('#settingsClose');

  const call = (body) => page.evaluate(async (b) => { try { return 'OK ' + JSON.stringify(await request('/api/odds/manual', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) })).slice(0, 60); } catch (e) { return 'ERR ' + e.message; } }, body);
  check('authorized POST is accepted', (await call({})).startsWith('OK'));
  await worker.evaluate(async () => { const s = (await chrome.storage.local.get('server')).server; await chrome.storage.local.set({ server: { ...s, token: '' } }); });
  await page.waitForTimeout(1000);
  const denied = await call({});
  check('POST without a token shows the server 401 message', denied.startsWith('ERR') && /токен/i.test(denied), denied);
} catch (error) {
  check('smoke test ran to completion', false, error.message);
} finally {
  await context?.close().catch(() => {});
  server.kill('SIGTERM');
  rmSync(dataDir, { recursive: true, force: true });
  rmSync(profile, { recursive: true, force: true });
}
process.exit(failures.length ? 1 : 0);
