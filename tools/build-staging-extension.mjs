#!/usr/bin/env node
// Builds a PRIVATE test copy of the extension that talks to the staging server with the staging token preset.
// Nothing is committed: output goes to dist/ (git-ignored) and the token is read from the environment or a file.
//
//   STAGING_TOKEN=... node tools/build-staging-extension.mjs --url http://STAGING_IP:8080
//   node tools/build-staging-extension.mjs --url http://STAGING_IP:8080 --token-file /etc/esports-monitor/server.env
//
// The build is named "Esports Monitor (STAGING)" so it cannot be mistaken for the real extension, and it is
// for testing only: anyone holding the ZIP holds the staging token. The repository code is unchanged.
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const arg = (n, d) => { const i = process.argv.indexOf('--' + n); return i > 0 ? process.argv[i + 1] : d; };
const base = (arg('url', process.env.STAGING_URL || '')).replace(/\/+$/, '');
let url; try { url = new URL(base); } catch {}
if (!url || !['http:', 'https:'].includes(url.protocol)) { console.error('--url http://host:port is required'); process.exit(2); }
let token = process.env.STAGING_TOKEN || '';
const file = arg('token-file', '');
if (!token && file) { const text = readFileSync(file, 'utf8'); token = ((/^API_TOKEN=(.*)$/m.exec(text) || [])[1] || text).trim(); }
if (token.length < 16) { console.error('a staging token of at least 16 characters is required (STAGING_TOKEN or --token-file)'); process.exit(2); }

const out = path.join(root, 'dist', 'staging-extension');
rmSync(out, { recursive: true, force: true }); mkdirSync(out, { recursive: true });
cpSync(path.join(root, 'extension'), out, { recursive: true, filter: (src) => !/[\\/]extension[\\/]test([\\/]|$)/.test(src) });

const patch = (name, edit) => { const f = path.join(out, name), before = readFileSync(f, 'utf8'), after = edit(before); if (after === before) throw new Error(`${name}: nothing to patch`); writeFileSync(f, after); };
patch('server-config.js', (s) => s.replace("DEFAULT_BASE='http://87.199.202.237:8080',DEFAULT_TOKEN=''", `DEFAULT_BASE=${JSON.stringify(url.origin + url.pathname.replace(/\/+$/, ''))},DEFAULT_TOKEN=${JSON.stringify(token)}`));
patch('manifest.json', (s) => {
  const m = JSON.parse(s);
  m.name = 'Esports Monitor (STAGING)';
  m.description = 'STAGING test build - talks to a test server, not production.';
  m.host_permissions = [`${url.protocol}//${url.hostname}/*`];
  return JSON.stringify(m, null, 2) + '\n';
});
const version = JSON.parse(readFileSync(path.join(out, 'manifest.json'), 'utf8')).version;
const zip = path.join(root, 'dist', `Esports-Monitor-STAGING-${version}.zip`);
rmSync(zip, { force: true });
execFileSync('python3', ['-c', 'import shutil,sys; shutil.make_archive(sys.argv[1], "zip", sys.argv[2])', zip.replace(/\.zip$/, ''), out]);
console.log(`built ${path.relative(root, out)} and ${path.relative(root, zip)}`);
console.log(`server ${url.origin}, token ${token.slice(0, 4)}…${token.slice(-4)} (${token.length} chars) - keep this build private`);
