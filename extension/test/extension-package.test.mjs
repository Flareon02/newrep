import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

const root = path.resolve(new URL('..', import.meta.url).pathname);
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));
const exists = (p) => fs.existsSync(path.join(root, p));

test('manifest is Manifest V3 and every referenced file exists', () => {
  assert.equal(manifest.manifest_version, 3);
  assert.ok(exists(manifest.background.service_worker));
  for (const icon of Object.values(manifest.icons)) assert.ok(exists(icon), icon);
  assert.ok(manifest.permissions.includes('storage'));
  assert.ok(!manifest.permissions.includes('<all_urls>'));
  assert.ok(!manifest.content_security_policy?.extension_pages?.includes('unsafe-eval'));
});

test('every script and stylesheet referenced by the pages exists, with no inline or remote code', () => {
  for (const page of fs.readdirSync(root).filter((f) => f.endsWith('.html'))) {
    const html = fs.readFileSync(path.join(root, page), 'utf8');
    for (const match of html.matchAll(/<script\b([^>]*)>/g)) {
      const src = /src="([^"]+)"/.exec(match[1])?.[1];
      assert.ok(src, `${page}: inline <script> is not allowed`);
      assert.ok(!/^https?:/.test(src), `${page}: remote script ${src}`);
      assert.ok(exists(src), `${page}: missing ${src}`);
    }
    for (const match of html.matchAll(/<link\b[^>]*href="([^"]+)"/g)) assert.ok(/^https?:/.test(match[1]) ? false : exists(match[1]), `${page}: ${match[1]}`);
  }
});

test('service worker importScripts targets exist and server-config loads before use', () => {
  const background = fs.readFileSync(path.join(root, 'background.js'), 'utf8');
  const imports = /importScripts\(([^)]*)\)/.exec(background)[1].split(',').map((s) => s.trim().replace(/['"]/g, ''));
  for (const file of imports) assert.ok(exists(file), file);
  assert.equal(imports[0], 'server-config.js');
});

test('all scripts parse, and no hardcoded server address remains outside server-config.js', () => {
  for (const file of fs.readdirSync(root).filter((f) => f.endsWith('.js'))) {
    const code = fs.readFileSync(path.join(root, file), 'utf8');
    assert.doesNotThrow(() => new vm.Script(code, { filename: file }), file);
    if (file !== 'server-config.js') assert.ok(!/\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}:8080/.test(code), `${file} hardcodes a server address`);
  }
});

test('the two optional-permission rules hold: default host stays, arbitrary hosts are optional only', () => {
  assert.deepEqual(manifest.host_permissions, ['http://87.199.202.237/*']);
  assert.deepEqual(manifest.optional_host_permissions, ['http://*/*', 'https://*/*']);
});
