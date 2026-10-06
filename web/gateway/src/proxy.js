// /api/* for signed-in web and desktop clients.
//
// The gateway calls the monitor server as its service account and applies the user's entitlements itself, with the
// server's own functions (vendor/entitlements.js): routeRequirement/routeProvider decide whether the route is allowed,
// filterForPrincipal removes bookmakers, odds and diagnostics the user may not see. For users without restrictions
// (and administrators) the server's bytes pass through untouched. The few places where the server shapes a response
// by principal outside those functions are handled here explicitly (feed stream, event history, /api/me, /health).
import { createHash } from 'node:crypto';
import { gzip } from 'node:zlib';
import { promisify } from 'node:util';
import { can, canAny, filterForPrincipal, routeProvider, routeRequirement } from './vendor/entitlements.js';
import { allowedModes, endStream } from './feed-hub.js';

const gzipAsync = promisify(gzip);
const STREAM_ROUTES = new Set(['/api/statistics/stream', '/api/pinnacle/live-stream']);
const COPY_HEADERS = ['content-type', 'content-encoding', 'cache-control', 'last-modified', 'vary', 'retry-after', 'content-disposition'];
const EVENT_HISTORY = /^\/api\/(?:events|ui\/event)\/[^/]+\/history$/;
const ON_BEHALF = /^\/api\/(?:me\/settings|(?:events|ui\/event)\/[^/]+\/(?:history|timeline\/meta|timeline|state-at))$/;
const BODY_LIMIT = 16 * 1024 * 1024;

// Same as server/src/api.js (req.dataMode): which odds capability applies to the payload.
export function dataModeOf(url) {
  return /prematch/.test(url.pathname) || url.searchParams.get('view') === 'prematch' || (url.pathname === '/api/ui/full-markets' ? false : url.searchParams.get('scope') === 'prematch') ? 'prematch' : 'live';
}
// filterForPrincipal is the identity for these principals: their responses are passed through unchanged.
export const passesThrough = (p) => p.role === 'admin' || (p.unrestricted && can(p, 'admin.diagnostics'));
const etagSuffix = (p) => (p.role === 'admin' ? '' : '-u' + createHash('sha1').update(p.sig).digest('hex').slice(0, 8));
function scopeEtag(etag, p) {
  const s = etagSuffix(p);
  if (!etag || !s) return etag;
  return etag.endsWith('"') ? etag.slice(0, -1) + s + '"' : etag + s;
}
// A client's If-None-Match is only meaningful for the principal that received it.
function unscopeEtag(value, p) {
  const s = etagSuffix(p);
  if (!value || !s) return value || '';
  const tags = String(value).split(',').map((t) => t.trim()).filter((t) => t.endsWith(s + '"')).map((t) => t.slice(0, -(s.length + 1)) + '"');
  return tags.join(', ');
}

export async function readBody(req, limit = BODY_LIMIT) {
  const chunks = []; let size = 0;
  for await (const chunk of req) { size += chunk.length; if (size > limit) throw Object.assign(new Error('Слишком большой запрос'), { status: 413 }); chunks.push(chunk); }
  return Buffer.concat(chunks);
}

export function createApiProxy({ upstream, hub, registry, keys, log = console, config }) {
  function sendJson(res, status, data, extra = {}) {
    const body = Buffer.from(JSON.stringify(data));
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'content-length': body.length, ...extra });
    res.end(body);
  }
  const forbidden = (res) => sendJson(res, 403, { ok: false, error: 'Нет доступа к этому разделу.', code: 'forbidden' });
  const unavailable = (res, error) => { log.warn?.(`[api] upstream error: ${error?.code || error?.message}`); if (!res.headersSent) sendJson(res, 502, { ok: false, error: 'Сервер мониторинга временно недоступен', code: 'upstream_unavailable' }); else res.destroy(); };

  async function handle(req, res, url, ctx) {
    const { principal, session } = ctx;
    const path = url.pathname;
    const need = routeRequirement(req.method, path, url.searchParams), provider = routeProvider(path);
    if ((need && !canAny(principal, need)) || (provider && !can(principal, 'provider.' + provider))) return forbidden(res);
    if (req.method !== 'GET' && req.method !== 'HEAD' && req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'Метод не поддерживается' });

    if (path === '/api/feed-stream') return feedStream(req, res, url, ctx);
    if (STREAM_ROUTES.has(path)) return detailStream(req, res, url, ctx);
    let body = null;
    if (req.method === 'POST') {
      try { body = await readBody(req); } catch (error) { return sendJson(res, error.status || 400, { ok: false, error: error.message }); }
    }
    if (path.startsWith('/api/admin/users')) {
      const refused = adminUserGuard(req, path, session, body);
      if (refused) return sendJson(res, 409, { ok: false, error: refused });
    }
    const pass = passesThrough(principal);
    const clientGzip = /\bgzip\b/i.test(String(req.headers['accept-encoding'] || ''));
    const headers = { accept: String(req.headers.accept || 'application/json'), 'accept-encoding': pass && clientGzip ? 'gzip' : 'identity' };
    if (req.headers['content-type']) headers['content-type'] = String(req.headers['content-type']);
    // Per-user data (settings, event history, timeline/replay): the server runs these with the signed-in user's own
    // principal (rights, bookmakers, key id); it accepts a named user only from its service token.
    if (ON_BEHALF.test(path)) headers['x-esm-on-behalf-user'] = String(principal.id);
    const inm = unscopeEtag(req.headers['if-none-match'], principal);
    if (inm) headers['if-none-match'] = inm;

    let up;
    try { up = await upstream.request(url.pathname + url.search, { method: req.method, headers, body }); }
    catch (error) { return unavailable(res, error); }

    // The service token is the gateway's own credential: if the server refuses it, that is a gateway fault, never
    // a reason for the client to drop its session.
    if (up.statusCode === 401) { up.resume(); return unavailable(res, new Error('service token refused by upstream')); }
    const out = {};
    for (const h of COPY_HEADERS) if (up.headers[h] !== undefined) out[h] = up.headers[h];
    if (up.headers.etag) out.etag = scopeEtag(String(up.headers.etag), principal);

    const isJson = /application\/json/i.test(String(up.headers['content-type'] || ''));
    const filtering = isJson && up.statusCode >= 200 && up.statusCode < 300 && (!pass || EVENT_HISTORY.test(path));
    if (!filtering) {
      if (up.headers['content-length'] !== undefined) out['content-length'] = up.headers['content-length'];
      res.writeHead(up.statusCode, out);
      up.pipe(res);
      up.on('error', () => res.destroy());
      // A user leaving keeps the upstream request from running on (logos, large payloads).
      res.on('close', () => { if (!up.complete) up.destroy(); });
      if (path.startsWith('/api/admin/users') && req.method === 'POST' && up.statusCode === 200) keys.trySync();
      return;
    }
    let data;
    try { data = JSON.parse((await upstream.readAll(up)).toString('utf8')); }
    catch (error) { return unavailable(res, error); }
    if (EVENT_HISTORY.test(path)) data = filterEventHistory(data, principal);
    data = filterForPrincipal(principal, data, { mode: dataModeOf(url) });
    let payload = Buffer.from(JSON.stringify(data));
    delete out['content-encoding'];
    if (clientGzip && payload.length >= 2048) { payload = await gzipAsync(payload, { level: 1 }); out['content-encoding'] = 'gzip'; out.vary = [...new Set(String(out.vary || '').split(',').map((s) => s.trim()).filter(Boolean).concat('Accept-Encoding'))].join(', '); }
    out['content-length'] = payload.length;
    res.writeHead(up.statusCode, out);
    res.end(payload);
  }

  // The server asks the principal for odds/score rights and bookmakers inside the event-history query; the service
  // account gets everything, so the same three rules are applied to the result here.
  function filterEventHistory(data, p) {
    if (!data || typeof data !== 'object' || passesThrough(p)) return data;
    const ok = (e) => can(p, 'provider.' + e?.provider) && (['score', 'state'].includes(e?.kind) ? can(p, 'scores.history') : can(p, 'odds.history'));
    const out = { ...data };
    for (const k of ['entries', 'scoreTimeline', 'oddsTimeline']) if (Array.isArray(out[k])) out[k] = out[k].filter(ok);
    return out;
  }

  // The server's own protection ("nobody can lock themselves out") compares the caller's user id; the gateway's
  // service account is a different id, so the same rule is checked here against the signed-in administrator.
  function adminUserGuard(req, path, session, body) {
    if (req.method !== 'POST') return '';
    const parts = path.split('/').filter(Boolean), id = parts[3] || '', action = parts[4] || '';
    if (!id || id !== session.access_key_id) return '';
    if (action === 'delete') return 'Нельзя удалить свою учётную запись';
    if (action === 'token') return 'Свой ключ меняйте через другого администратора: текущая сессия иначе завершится';
    let patch = {};
    try { patch = JSON.parse(body?.toString('utf8') || '{}') || {}; } catch {}
    if (patch.disabled === true || patch.role === 'user') return 'Нельзя отключить себе доступ к управлению пользователями';
    return '';
  }

  function feedStream(req, res, url, { principal, session }) {
    const requested = String(url.searchParams.get('modes') || 'live,prematch,results,history,leagues').split(',');
    const modes = allowedModes(principal, requested);
    if (!modes.length) return forbidden(res);
    const provider = ['ggbet', 'databet'].includes(url.searchParams.get('provider')) ? url.searchParams.get('provider') : 'ggbet';
    res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache, no-transform', connection: 'keep-alive', 'x-accel-buffering': 'no' });
    res.write(': connected\n\n');
    const client = { res, principal, modes: new Set(modes), sessionId: session.id };
    const unsubscribe = hub.subscribe(provider, client);
    const unregister = registry.add(session.id, { kind: 'feed', end: (reason) => endStream(res, reason) });
    const close = () => { unsubscribe(); unregister(); };
    req.on('close', close); res.on('close', close);
  }

  async function detailStream(req, res, url, { session }) {
    if (registry.count(session.id, 'detail') >= config.detailStreamsPerSession) return sendJson(res, 429, { ok: false, error: 'Слишком много потоковых соединений' });
    const controller = new AbortController();
    const unregister = registry.add(session.id, { kind: 'detail', end: (reason) => { endStream(res, reason); controller.abort(); } });
    let up;
    try { up = await upstream.request(url.pathname + url.search, { headers: { accept: 'text/event-stream', 'accept-encoding': 'identity' }, signal: controller.signal, stream: true }); }
    catch (error) { unregister(); if (controller.signal.aborted) return; return unavailable(res, error); }
    if (up.statusCode === 401) { up.resume(); unregister(); return unavailable(res, new Error('service token refused by upstream')); }
    const out = {};
    for (const h of COPY_HEADERS) if (up.headers[h] !== undefined) out[h] = up.headers[h];
    res.writeHead(up.statusCode, out);
    res.flushHeaders();
    up.pipe(res);
    const close = () => { unregister(); controller.abort(); up.destroy(); };
    req.on('close', close); res.on('close', close); up.on('end', () => res.end()); up.on('error', () => res.destroy());
  }

  return { handle, sendJson };
}
