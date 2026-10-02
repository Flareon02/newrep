#!/usr/bin/env node
// Checks the API token rules against a running server (staging): public reads, and the same write endpoints with no
// token, a wrong token and the right token. The token is read from STAGING_TOKEN or --token-file and is never printed.
//
//   STAGING_URL=http://host:8080 STAGING_TOKEN=... node tools/staging-auth-check.mjs
//   node tools/staging-auth-check.mjs --url http://host:8080 --token-file /etc/esports-monitor/server.env
//
// Only lightweight endpoints are called with the right token (they do not contact any bookmaker). Endpoints that would
// trigger an outbound request (HLTV lookups) are checked for rejection only.
import { readFileSync } from 'node:fs';
import { defaultUrl } from './default-url.mjs';

const arg = (n, d) => { const i = process.argv.indexOf('--' + n); return i > 0 ? process.argv[i + 1] : d; };
const url = (arg('url', defaultUrl())).replace(/\/+$/, '');
let token = process.env.STAGING_TOKEN || '';
const file = arg('token-file', '');
if (!token && file) { const m = /^API_TOKEN=(.*)$/m.exec(readFileSync(file, 'utf8')); token = (m ? m[1] : readFileSync(file, 'utf8')).trim(); }
if (!token) { console.error('no token: set STAGING_TOKEN or --token-file'); process.exit(2); }
const mask = (t) => `${t.slice(0, 4)}…${t.slice(-4)} (${t.length} chars)`;
console.log(`target ${url}, token ${mask(token)}\n`);

let failed = 0;
const check = (name, ok, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`); if (!ok) failed++; };
const call = async (method, path, headers = {}, body) => {
  const r = await fetch(url + path, { method, headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(15000) });
  let json = null; try { json = await r.json(); } catch {}
  return { status: r.status, json, www: r.headers.get('www-authenticate') };
};
const WRONG = { Authorization: 'Bearer ' + 'wrong'.repeat(6) }, RIGHT = { Authorization: 'Bearer ' + token };

// Server 4.9+: only the bare health is public; every data read needs a token with that capability (entitlements).
{ const r = await call('GET', '/health'); check('read /health without a token (bare: no internals)', r.status === 200 && r.json?.ok === true && !r.json?.security, `HTTP ${r.status}`); }
for (const p of ['/api/ui/live?meta=1&thin=1', '/api/ui/prematch?meta=1&thin=1', '/api/leagues', '/api/hltv/data']) {
  const none = await call('GET', p), right = await call('GET', p, RIGHT);
  check(`read ${p.split('?')[0]} needs a token`, none.status === 401 && right.status === 200, `HTTP ${none.status}/${right.status}`);
}
// Protected endpoints: none / wrong / right.
const cases = [
  ['POST', '/api/ui/odds-watch', { ids: [] }, 200],
  ['GET', '/api/league-links/challenge', undefined, 200],
  ['POST', '/api/statistics/availability', { events: [] }, 200],
];
for (const [method, path, body, okStatus] of cases) {
  const none = await call(method, path, {}, body), wrong = await call(method, path, WRONG, body), right = await call(method, path, RIGHT, body);
  check(`${method} ${path} without a token is refused`, none.status === 401 && none.json?.code === 'unauthorized', `HTTP ${none.status}`);
  check(`${method} ${path} with a wrong token is refused`, wrong.status === 401, `HTTP ${wrong.status}`);
  check(`${method} ${path} with the right token is accepted`, right.status === okStatus, `HTTP ${right.status}`);
}
for (const [method, path, body] of [['POST', '/api/odds/manual', {}], ['POST', '/api/odds/generate', {}], ['POST', '/api/league-links/publish', { nonce: 'x' }], ['GET', '/api/hltv/search?q=zz', undefined]]) {
  const none = await call(method, path, {}, body), wrong = await call(method, path, WRONG, body);
  check(`${method} ${path.split('?')[0]} is refused without / with a wrong token`, none.status === 401 && wrong.status === 401, `HTTP ${none.status}/${wrong.status}`);
}
const h = (await call('GET', '/health', RIGHT)).json;
check('/health reports writeAuth=token and never contains the token', h?.security?.writeAuth === 'token' && !JSON.stringify(h).includes(token), `writeAuth=${h?.security?.writeAuth}`);
console.log(failed ? `\n${failed} check(s) FAILED` : '\nall checks passed');
process.exit(failed ? 1 : 0);
