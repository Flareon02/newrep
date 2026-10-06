// The esportsdata.online gateway: one origin for the web app.
//
//   /                 the monitor UI (static, built by web/build.mjs) - the Access Key gate is part of it
//   /auth/*           verify, session, logout; /auth/admin/* session management (administrators)
//   /api/*            the monitor API for the signed-in user (entitlements enforced here, see proxy.js)
//   /downloads/*      desktop app release files (signed-in users)
//
// Every /api request checks the session in the database, so a revoked session is refused on its very next request,
// and its open event streams are closed at the moment of revocation (StreamRegistry).
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { gzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { openDatabase } from './db.js';
import { SessionStore, publicReason } from './sessions.js';
import { KeyDirectory } from './keys.js';
import { createUpstream } from './upstream.js';
import { FeedHub, StreamRegistry } from './feed-hub.js';
import { createApiProxy } from './proxy.js';
import { createAuth } from './auth.js';
import { createAdmin } from './admin.js';
import { applyCors, securityHeaders, SlidingCounter } from './security.js';
import { createLogger } from './log.js';
import { can } from './vendor/entitlements.js';

export const GATEWAY_VERSION = '1.0.0';
export { PROTOCOL } from './auth.js';
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.webp': 'image/webp', '.jpg': 'image/jpeg', '.woff2': 'font/woff2', '.txt': 'text/plain; charset=utf-8', '.webmanifest': 'application/manifest+json', '.exe': 'application/vnd.microsoft.portable-executable', '.zip': 'application/zip', '.sha256': 'text/plain; charset=utf-8' };
const COMPRESSIBLE = /^(text\/|application\/(json|manifest\+json)|image\/svg)/;

export function createGateway(config, { clock = Date.now, log = createLogger(), upstream: injectedUpstream = null } = {}) {
  if (!config.upstreamToken) log.warn('[gateway] no upstream token configured: sign-in and data will fail');
  const db = openDatabase(config.dbFile || path.join(config.dataDir, 'gateway.sqlite3'));
  const upstream = injectedUpstream || createUpstream({ base: config.upstreamBase, token: config.upstreamToken, timeoutMs: config.upstreamTimeoutMs });
  const registry = new StreamRegistry();
  const sessions = new SessionStore({ db, clock, idleMs: config.sessionIdleMs, maxMs: config.sessionMaxMs, adminMaxMs: config.adminSessionMaxMs });
  const closeEnded = (list) => { for (const e of list) registry.close(e.id, publicReason(e.reason)); };
  const keys = new KeyDirectory({ db, upstream, sessions, clock, log, onEnded: closeEnded, serviceToken: config.upstreamToken });
  const hub = new FeedHub({ upstream, log, lingerMs: config.feedLingerMs, clock });
  const proxy = createApiProxy({ upstream, hub, registry, keys, log, config });
  const auth = createAuth({ config, sessions, keys, upstream, registry, log, clock });
  const admin = createAdmin({ db, config, sessions, keys, upstream, registry, auth, clock, log });
  const apiRate = new SlidingCounter({ windowMs: 60_000, limit: config.apiRequestsPerMinute, clock });
  const files = new Map();
  let serverVersion = { value: '', at: 0 };

  async function upstreamVersion() {
    if (clock() - serverVersion.at < 60_000) return serverVersion.value;
    try { const r = await upstream.json('/api/me', { timeout: 5000 }); serverVersion = { value: String(r.data?.serverVersion || ''), at: clock() }; } catch { serverVersion.at = clock(); }
    return serverVersion.value;
  }

  // ---------------------------------------------------------------------------------------------- static files --
  function staticFile(root, rel) {
    const clean = path.posix.normalize('/' + decodeURIComponent(rel)).replace(/^\/+/, '');
    if (clean.split('/').some((p) => p.startsWith('.'))) return null;
    const full = path.join(root, clean);
    if (!full.startsWith(path.resolve(root) + path.sep)) return null;
    let st;
    try { st = fs.statSync(full); } catch { return null; }
    if (!st.isFile()) return null;
    const id = `${full}:${st.mtimeMs}:${st.size}`;
    let entry = files.get(full);
    if (!entry || entry.id !== id) {
      const type = TYPES[path.extname(full).toLowerCase()] || 'application/octet-stream';
      const small = st.size <= 8 * 1024 * 1024;
      const body = small ? fs.readFileSync(full) : null;
      entry = { id, full, type, size: st.size, body, gz: body && COMPRESSIBLE.test(type) && st.size > 1024 ? gzipSync(body, { level: 9 }) : null, etag: '"' + createHash('sha1').update(id).digest('hex').slice(0, 16) + '"' };
      files.set(full, entry);
    }
    return entry;
  }

  function sendFile(req, res, entry, { immutable = false, download = false } = {}) {
    const headers = { 'content-type': entry.type, etag: entry.etag, 'cache-control': entry.type.startsWith('text/html') ? 'no-cache' : immutable ? 'public, max-age=31536000, immutable' : 'no-cache' };
    if (download) headers['content-disposition'] = `attachment; filename="${path.basename(entry.full).replace(/[^\w.-]/g, '_')}"`, headers['cache-control'] = 'private, no-cache';
    if (!entry.type.startsWith('text/html')) headers['cross-origin-resource-policy'] = 'same-origin';
    if (req.headers['if-none-match'] === entry.etag) { res.writeHead(304, headers); return res.end(); }
    if (!entry.body) { headers['content-length'] = entry.size; res.writeHead(200, headers); return fs.createReadStream(entry.full).pipe(res); }
    const gz = entry.gz && /\bgzip\b/.test(String(req.headers['accept-encoding'] || ''));
    headers.vary = 'Accept-Encoding';
    if (gz) headers['content-encoding'] = 'gzip';
    const body = gz ? entry.gz : entry.body;
    headers['content-length'] = body.length;
    res.writeHead(200, headers);
    res.end(req.method === 'HEAD' ? undefined : body);
  }

  const notFound = (res) => auth.json(res, 404, { ok: false, error: 'Не найдено' });
  const needSession = (res, r) => auth.json(res, r.status === 'unavailable' ? 503 : 401, { ok: false, error: r.status === 'unavailable' ? 'Сервис временно недоступен' : 'Требуется вход по ключу доступа', code: r.status === 'unavailable' ? 'unavailable' : 'session_' + (r.reason || 'none'), reason: r.reason || 'none' });

  // ---------------------------------------------------------------------------------------------- routing -------
  async function route(req, res) {
    const url = new URL(req.url, 'http://gateway.local');
    const p = url.pathname;
    securityHeaders(res, { hsts: config.hsts, html: true });
    const cors = applyCors(req, res, config);
    if (req.method === 'OPTIONS') {
      if (!cors) { res.writeHead(403); return res.end(); }
      res.writeHead(204, { 'access-control-allow-methods': 'GET, POST, OPTIONS', 'access-control-allow-headers': 'Authorization, Content-Type, If-None-Match, Accept', 'access-control-max-age': '600' });
      return res.end();
    }
    if (p === '/healthz') return auth.json(res, 200, { ok: true, service: 'esportsdata-web-gateway', version: GATEWAY_VERSION, directory: { loaded: keys.loaded, ageMs: keys.lastSyncAt ? clock() - keys.lastSyncAt : null }, streams: registry.total(), feed: hub.status().map(({ provider, clients, connected }) => ({ provider, clients, connected })) });
    if (p === '/auth/verify') return auth.verify(req, res);
    if (p === '/auth/session') return auth.session(req, res);
    if (p === '/auth/logout') return auth.logout(req, res);

    // Desktop releases are public: the desktop updater fetches latest.json and the signed installer without a session,
    // and the files contain no secrets (the update signature, not access control, protects them).
    if (p.startsWith('/downloads/desktop/') && (req.method === 'GET' || req.method === 'HEAD')) {
      if (!config.downloadsDir) return notFound(res);
      const entry = staticFile(config.downloadsDir, p.slice('/downloads/'.length));
      return entry ? sendFile(req, res, entry, { download: !p.endsWith('.json') }) : notFound(res);
    }
    if (p.startsWith('/auth/admin/') || p.startsWith('/api/') || p === '/health' || p.startsWith('/downloads/')) {
      // Team logos are public on the monitor server as well (images only); the desktop app loads them as <img>.
      if (p.startsWith('/api/team-logos/') && (req.method === 'GET' || req.method === 'HEAD')) {
        const r = await auth.resolve(req);
        return proxy.handle(req, res, url, { principal: r.principal || { role: 'anonymous', caps: new Set(), sig: '', unrestricted: false, anonymous: true }, session: r.session || { id: 'anonymous' } });
      }
      const r = await auth.resolve(req);
      if (r.status !== 'active') return needSession(res, r);
      if (apiRate.add(r.session.id) > config.apiRequestsPerMinute) return auth.json(res, 429, { ok: false, error: 'Слишком много запросов', code: 'rate_limited' }, { 'retry-after': String(apiRate.retryAfter(r.session.id)) });
      const ctx = { principal: r.principal, session: r.session };
      if (p.startsWith('/auth/admin/')) return admin.handle(req, res, url, ctx);
      if (p === '/api/me') return auth.json(res, 200, { ok: true, serverVersion: await upstreamVersion(), access: 'enforce', principal: { id: r.principal.id, name: r.principal.name, role: r.principal.role, anonymous: false }, keyId: r.principal.keyId || '', entitlementsRevision: r.principal.rev || 0, capabilities: [...r.principal.caps].sort(), features: { settingsSync: 1, timeline: 1, marketSemantics: 2 }, session: auth.sessionView(r.session, r.principal) });
      if (p === '/health') {
        if (!can(r.principal, 'admin.diagnostics')) return auth.json(res, 200, { ok: true, service: 'astek-fonbet-monitor-server', version: await upstreamVersion() });
        return proxy.handle(req, res, url, ctx);
      }
      if (p.startsWith('/downloads/')) {
        if (!config.downloadsDir) return notFound(res);
        const entry = staticFile(config.downloadsDir, p.slice('/downloads/'.length));
        return entry ? sendFile(req, res, entry, { download: !p.endsWith('.json') }) : notFound(res);
      }
      return proxy.handle(req, res, url, ctx);
    }

    if (req.method !== 'GET' && req.method !== 'HEAD') return auth.json(res, 405, { ok: false, error: 'Метод не поддерживается' });
    const entry = staticFile(config.staticDir, p === '/' ? 'index.html' : p.slice(1));
    if (!entry) return notFound(res);
    return sendFile(req, res, entry, { immutable: url.searchParams.has('v') });
  }

  const server = http.createServer((req, res) => {
    const started = clock();
    if (config.logRequests) res.on('finish', () => log.info(`[http] ${req.method} ${String(req.url).split('?')[0]} ${res.statusCode} ${clock() - started}ms`));
    route(req, res).catch((error) => {
      log.error(`[gateway] ${req.method} ${String(req.url).split('?')[0]} failed: ${error?.stack || error}`);
      if (!res.headersSent) auth.json(res, 500, { ok: false, error: 'Внутренняя ошибка' }); else res.destroy();
    });
  });
  server.keepAliveTimeout = 65_000;
  server.headersTimeout = 70_000;
  server.requestTimeout = 0; // event streams

  // ------------------------------------------------------------------------------------------------ timers ------
  const timers = [];
  function sweep() {
    closeEnded(sessions.sweepExpired());
    // Sessions changed outside this process (CLI) or by key rules: close their streams too.
    for (const id of registry.sessions()) {
      const s = sessions.get(id);
      if (!s || s.revoked_at != null) registry.close(id, publicReason(s?.revoke_reason));
    }
  }
  function start() {
    keys.trySync();
    timers.push(setInterval(() => keys.trySync(), config.directorySyncMs), setInterval(sweep, config.sweepMs));
    for (const t of timers) t.unref?.();
    return new Promise((resolve) => server.listen(config.port, config.host, () => resolve(server.address())));
  }
  async function stop() {
    for (const t of timers) clearInterval(t);
    hub.close();
    for (const id of registry.sessions()) registry.close(id, 'restart');
    await new Promise((resolve) => server.close(resolve));
    server.closeAllConnections?.();
    upstream.close?.();
    db.close();
  }

  return { server, start, stop, db, sessions, keys, registry, hub, sweep };
}
