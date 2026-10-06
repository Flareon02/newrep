// /auth/verify, /auth/session, /auth/logout and the session resolution used by every other route.
//
// Access Key → (verified by the monitor server, never stored) → new session (revoking the key's previous one).
// Web clients get the token as an HttpOnly cookie; the desktop app gets it once in the response body and sends it
// as Authorization: Bearer. Neither the key nor the token is ever logged, put in a URL, or written to the database.
import { setTimeout as sleep } from 'node:timers/promises';
import { SessionStore, publicReason } from './sessions.js';
import { clearCookie, clientAddress, countryOf, describeClient, isAppOrigin, networkOf, readCookie, sameSiteWrite, sessionCookie, SlidingCounter } from './security.js';
import { readBody } from './proxy.js';

// Client protocol: bumped only when this API changes incompatibly. A desktop build older than minClient is asked to
// update; web/backend-only releases keep it, so they never force a desktop update.
export const PROTOCOL = Object.freeze({ version: 1, minClient: 1 });

export const INVALID_KEY = 'Неверный или просроченный ключ доступа';
const INVALID = { ok: false, error: INVALID_KEY, code: 'invalid_key' };
// Keys are printable tokens (emu_ + hex today). Whitespace and invisible characters from copy/paste are removed.
export function normalizeKey(raw) {
  const value = String(raw ?? '').normalize('NFKC').replace(/[\s​-‍⁠﻿]+/g, '');
  return /^[A-Za-z0-9_\-.~+/=]{16,256}$/.test(value) ? value : '';
}

export function createAuth({ config, sessions, keys, upstream, registry, log = console, clock = Date.now }) {
  const failures = new SlidingCounter({ windowMs: config.verifyWindowMs, limit: config.verifyFailuresPerWindow, clock });
  const attempts = new SlidingCounter({ windowMs: 60_000, limit: config.verifyGlobalPerMinute, clock });

  function bearerOf(req) {
    const m = /^Bearer\s+(\S+)$/i.exec(String(req.headers.authorization || ''));
    return m ? m[1] : '';
  }
  // The session token presented by this request: the cookie (web) or the Authorization header (desktop app).
  function tokenOf(req) { return readCookie(req, config.cookieName) || bearerOf(req); }

  // Resolves the request's session and principal. Never throws for an invalid client; returns { status, reason }.
  async function resolve(req) {
    const token = tokenOf(req);
    if (!token) return { status: 'none', reason: 'none' };
    const found = sessions.lookup(token);
    if (found.status !== 'active') return { status: found.status === 'unknown' ? 'none' : found.status, reason: publicReason(found.reason), session: found.session };
    if (!keys.loaded) await keys.trySync();
    const principal = await keys.principal(found.session.access_key_id);
    if (!principal) {
      // Known session but the key is gone or disabled on the server: end it now rather than at the next sync.
      if (keys.loaded) {
        const user = keys.user(found.session.access_key_id);
        const ended = sessions.revoke(found.session.id, user ? 'key_disabled' : 'key_deleted', { actorType: 'system' });
        if (ended) registry.close(ended.id, 'access_revoked');
        return { status: 'revoked', reason: 'access_revoked' };
      }
      return { status: 'unavailable', reason: 'none' };
    }
    const session = sessions.touch(found.session);
    return { status: 'active', session, principal, token };
  }

  function sessionView(session, principal) {
    const row = keys.row(session.access_key_id);
    return {
      id: session.id, clientType: session.client_type, platform: session.platform || '', client: session.user_agent_summary || '',
      createdAt: session.created_at, lastSeenAt: session.last_seen_at, expiresAt: session.expires_at, absoluteExpiresAt: session.absolute_expires_at,
      key: { label: row?.label || '', suffix: row?.key_suffix || '', expiresAt: row?.expires_at ?? null },
      principal: principal ? { name: principal.name, role: principal.role } : null,
    };
  }

  const json = (res, status, data, headers = {}) => {
    const body = Buffer.from(JSON.stringify(data));
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'content-length': body.length, ...headers });
    res.end(body);
  };

  async function verify(req, res) {
    if (req.method !== 'POST') return json(res, 405, { ok: false, error: 'Метод не поддерживается' });
    if (!sameSiteWrite(req, config)) return json(res, 403, { ok: false, error: 'Запрос отклонён', code: 'origin' });
    const address = clientAddress(req, config.trustCloudflare) || 'unknown';
    if (failures.blocked(address) || attempts.blocked('*')) {
      const retry = failures.blocked(address) ? failures.retryAfter(address) : attempts.retryAfter('*');
      return json(res, 429, { ok: false, error: 'Слишком много попыток. Повторите позже.', code: 'rate_limited' }, { 'retry-after': String(retry) });
    }
    attempts.add('*');
    let body = {};
    try { body = JSON.parse((await readBody(req, 4096)).toString('utf8') || '{}'); } catch { return json(res, 400, { ok: false, error: 'Некорректный запрос' }); }
    const clientType = body?.client === 'tauri' && isAppOrigin(req, config) ? 'tauri' : body?.client === 'tauri' && !req.headers.origin ? 'tauri' : 'web';
    const key = normalizeKey(body?.key);
    const reject = async () => { failures.add(address); await sleep(250 + Math.floor(Math.random() * 250)); return json(res, 401, INVALID); };
    // The server's own API token is not an Access Key: it never enters a browser session.
    if (!key || keys.isServiceToken(key)) return reject();

    let me;
    try { me = await upstream.json('/api/me', { auth: { bearer: key }, timeout: 8000 }); }
    catch (error) { log.warn?.(`[auth] verify: server unreachable (${error.code || error.message})`); return json(res, 503, { ok: false, error: 'Сервис временно недоступен. Повторите через минуту.', code: 'unavailable' }); }
    if (me.status >= 500) return json(res, 503, { ok: false, error: 'Сервис временно недоступен. Повторите через минуту.', code: 'unavailable' });
    const p = me.data?.principal;
    if (me.status !== 200 || !p || p.anonymous || p.id === 'admin' || !/^u_[A-Za-z0-9]+$/.test(String(p.id || ''))) return reject();
    if (!keys.user(p.id)) await keys.trySync();
    const user = keys.user(p.id), row = keys.row(p.id);
    if (!user || user.disabled || !row || !row.enabled || row.deleted_at != null || (row.expires_at != null && row.expires_at <= clock())) return reject();

    const info = describeClient(req, clientType);
    const created = sessions.create({
      keyId: p.id, role: user.role, clientType, userAgentSummary: info.userAgentSummary, platform: info.platform,
      network: networkOf(address), country: countryOf(req, config.trustCloudflare), previousToken: tokenOf(req), keySuffix: key.slice(-4),
    });
    failures.reset(address);
    // The old profile is kicked now: its open streams receive `session ended` and close.
    for (const e of created.ended) registry.close(e.id, e.reason === 'replaced' ? 'replaced' : publicReason(e.reason));
    log.info?.(`[auth] session ${created.session.id} created (${clientType}); ended ${created.ended.length}`);
    const principal = await keys.principal(p.id);
    const view = sessionView(created.session, principal);
    const headers = {};
    if (clientType === 'web') headers['set-cookie'] = sessionCookie(config, created.token, (created.session.absolute_expires_at - clock()) / 1000);
    return json(res, 200, { ok: true, session: view, ...(clientType === 'tauri' ? { token: created.token } : {}) }, headers);
  }

  async function session(req, res) {
    const r = await resolve(req);
    if (r.status === 'active') return json(res, 200, { authenticated: true, protocol: PROTOCOL, session: sessionView(r.session, r.principal) });
    if (r.status === 'unavailable') return json(res, 503, { authenticated: false, error: 'Сервис временно недоступен', code: 'unavailable' });
    const headers = readCookie(req, config.cookieName) ? { 'set-cookie': clearCookie(config) } : {};
    return json(res, 401, { authenticated: false, reason: r.reason || 'none', code: 'session_' + (r.reason || 'none') }, headers);
  }

  async function logout(req, res) {
    if (req.method !== 'POST') return json(res, 405, { ok: false });
    if (!sameSiteWrite(req, config)) return json(res, 403, { ok: false, error: 'Запрос отклонён', code: 'origin' });
    const token = tokenOf(req);
    const found = token ? sessions.lookup(token) : { status: 'unknown' };
    if (found.status === 'active') {
      const ended = sessions.revoke(found.session.id, 'logout', { actorType: 'user', actorId: found.session.access_key_id });
      if (ended) registry.close(ended.id, 'logout');
    }
    return json(res, 200, { ok: true }, { 'set-cookie': clearCookie(config) });
  }

  return { resolve, verify, session, logout, sessionView, tokenOf, json, valid: SessionStore.validTokenShape };
}
