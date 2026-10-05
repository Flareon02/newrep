// Starts a gateway against a fake backend for tests, with a cookie-jar client per "browser profile".
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from '../../gateway/src/config.js';
import { createGateway } from '../../gateway/src/server.js';
import { startFakeBackend } from './fake-backend.mjs';

export const ORIGIN = 'https://esportsdata.online';

export async function startStack({ backend: backendOptions = {}, config: overrides = {}, clock } = {}) {
  const backend = await startFakeBackend(backendOptions);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eds-gw-'));
  const tokenFile = path.join(dir, 'upstream-token');
  fs.writeFileSync(tokenFile, backend.masterToken, { mode: 0o600 });
  const logs = [];
  const log = { info: (...a) => logs.push(a.join(' ')), warn: (...a) => logs.push(a.join(' ')), error: (...a) => logs.push(a.join(' ')) };
  const staticDir = overrides.staticDir || path.join(dir, 'static');
  fs.mkdirSync(staticDir, { recursive: true });
  if (!overrides.staticDir) fs.writeFileSync(path.join(staticDir, 'index.html'), '<!doctype html><title>t</title>');
  const config = loadConfig({ UPSTREAM_TOKEN_FILE: tokenFile }, {
    host: '127.0.0.1', port: 0, dataDir: dir, staticDir, upstreamBase: backend.base, publicOrigin: ORIGIN,
    cookieSecure: false, hsts: false, directorySyncMs: 60_000, sweepMs: 60_000, feedLingerMs: 50, ...overrides,
  });
  const gateway = createGateway(config, { log, ...(clock ? { clock } : {}) });
  const address = await gateway.start();
  await gateway.keys.trySync();
  const base = `http://127.0.0.1:${address.port}`;
  return {
    backend, gateway, base, config, dir, logs,
    profile: (name) => new Profile(base, config.cookieName, name),
    async stop() { await gateway.stop(); await backend.close(); fs.rmSync(dir, { recursive: true, force: true }); },
  };
}

// One browser profile: its own cookie jar. "Restarting the browser" keeps the jar (persistent cookie).
export class Profile {
  constructor(base, cookieName, name) { Object.assign(this, { base, cookieName, name, cookie: '', bearer: '' }); }
  async fetch(pathname, { method = 'GET', body, headers = {}, origin = method === 'GET' ? '' : ORIGIN, signal } = {}) {
    const h = { ...headers };
    if (origin) h.origin = origin;
    if (this.cookie) h.cookie = `${this.cookieName}=${this.cookie}`;
    if (this.bearer) h.authorization = 'Bearer ' + this.bearer;
    if (body !== undefined) h['content-type'] = 'application/json';
    const res = await fetch(this.base + pathname, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body), signal, redirect: 'manual' });
    for (const c of res.headers.getSetCookie?.() || []) {
      const m = new RegExp(`^${this.cookieName}=([^;]*)`).exec(c);
      if (m) this.cookie = /Max-Age=0\b/.test(c) ? '' : m[1];
    }
    return res;
  }
  async json(pathname, options) { const res = await this.fetch(pathname, options); let data = null; try { data = await res.json(); } catch {} return { status: res.status, data, headers: res.headers }; }
  login(key, client = 'web', origin) { return this.json('/auth/verify', { method: 'POST', body: { key, client }, origin }); }
}

const readers = new WeakMap();
export async function readSse(res, { until, timeoutMs = 3000 } = {}) {
  // One reader per response, reused by later calls (a ReadableStream can only be locked once).
  // A read still pending after a timeout is kept and awaited by the next call, so no chunk is lost.
  const state = readers.get(res) || { reader: res.body.getReader(), pending: null }, reader = state.reader, decoder = new TextDecoder();
  readers.set(res, state);
  let text = '';
  const deadline = Date.now() + timeoutMs;
  try {
    while (Date.now() < deadline) {
      state.pending ||= reader.read();
      const r = await Promise.race([state.pending, new Promise((resolve) => setTimeout(() => resolve({ timeout: true }), Math.max(1, deadline - Date.now())))]);
      if (r.timeout) break;
      state.pending = null;
      if (r.done) return { text, ended: true };
      text += decoder.decode(r.value, { stream: true });
      if (until && until(text)) return { text, ended: false };
    }
  } catch { return { text, ended: true }; }
  return { text, ended: false };
}
