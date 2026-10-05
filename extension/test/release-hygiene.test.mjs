// 9.3.0 release hygiene: least-privilege manifest, the optional native helper lives outside the extension package.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(new URL('..', import.meta.url).pathname);
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');

test('manifest: least privilege — no tabs, nativeMessaging only optional, only the default host is required', () => {
  assert.equal(manifest.version, '9.3.0');
  assert.deepEqual([...manifest.permissions].sort(), ['alarms', 'notifications', 'storage', 'unlimitedStorage'].sort());
  assert.deepEqual(manifest.optional_permissions, ['nativeMessaging']);
  for (const p of ['tabs', 'clipboardWrite', 'webRequest', 'scripting', 'downloads', 'nativeMessaging', '<all_urls>', 'cookies', 'history']) assert.ok(!manifest.permissions.includes(p), p);
  assert.deepEqual(manifest.host_permissions, ['https://api.esportsdata.online/*']);
});

test('own pages are found without the tabs permission (runtime.getContexts)', () => {
  const bg = read('background.js');
  assert.ok(!/chrome\.tabs\.query/.test(bg));
  assert.match(bg, /chrome\.runtime\.getContexts\(\{contextTypes:\['TAB'\]\}\)/);
});

test('native helper: not in the extension folder; requested only from Settings; missing helper falls back to the current browser', () => {
  assert.ok(!fs.existsSync(path.join(root, 'browser-host')), 'browser-host/ is packaged separately');
  for (const f of fs.readdirSync(root)) assert.ok(!/\.(ps1|cs|exe|dll|bat|cmd)$/i.test(f), f);
  assert.match(read('app-settings.js'), /chrome\.permissions\.request\(\{permissions:\['nativeMessaging'\]\}\)/);
  const bg = read('background.js');
  assert.match(bg, /typeof chrome\.runtime\.sendNativeMessage!=='function'/);
  assert.match(bg, /catch\(error\)\{\s*await chrome\.tabs\.create\(\{url:parsed\.href\}\);\s*return\{ok:false,fallback:true/);
  assert.match(read('app.js'), /DEFAULT_PREFS=\{[^}]*linkBrowser:'current'/, 'the default needs no helper');
});
