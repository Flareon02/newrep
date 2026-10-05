// /auth/admin/*: active sessions and Access Key controls for administrators.
//
// Only a signed-in session whose key has the administrator role on the monitor server can use these routes; customer
// keys get 403. Every state change needs a same-site request (Origin check) and is written to the audit log without
// secrets. Responses never contain a key, a session token or a token hash: sessions are shown by their public id.
import { audit } from './db.js';
import { can } from './vendor/entitlements.js';
import { readBody } from './proxy.js';
import { sameSiteWrite } from './security.js';
import { publicReason } from './sessions.js';

const statusOf = (s, now) => (s.revoked_at != null ? (s.revoke_reason === 'expired' ? 'EXPIRED' : 'REVOKED') : s.expires_at <= now || s.absolute_expires_at <= now ? 'EXPIRED' : 'ACTIVE');
export const maskKey = (suffix) => (suffix ? `emu_…${suffix}` : '');

export function createAdmin({ db, config, sessions, keys, upstream, registry, auth, clock = Date.now, log = console }) {
  const json = auth.json;
  const listSessions = db.prepare(`SELECT s.id, s.access_key_id, s.client_type, s.created_at, s.last_seen_at, s.expires_at, s.absolute_expires_at, s.revoked_at,
                                          s.revoke_reason, s.user_agent_summary, s.platform, s.network, s.country, k.label, k.key_suffix, k.role
                                     FROM sessions s JOIN access_keys k ON k.id = s.access_key_id
                                    WHERE (? = 'all' OR s.revoked_at IS NULL) ORDER BY (s.revoked_at IS NULL) DESC, s.last_seen_at DESC LIMIT ?`);
  const activeSessions = db.prepare('SELECT id, access_key_id, client_type, platform, user_agent_summary, last_seen_at FROM sessions WHERE revoked_at IS NULL AND expires_at > ? AND absolute_expires_at > ?');
  const auditRows = db.prepare('SELECT id, at, actor_type, actor_id, action, target_key_id, target_session_id, detail FROM audit_log ORDER BY id DESC LIMIT ?');

  function sessionRow(s, now, currentId) {
    return {
      id: s.id, keyId: s.access_key_id, keyLabel: s.label, keyMasked: maskKey(s.key_suffix), role: s.role,
      clientType: s.client_type === 'tauri' ? 'Tauri' : 'Web', platform: s.platform || 'Unknown', client: s.user_agent_summary || '',
      createdAt: s.created_at, lastSeenAt: s.last_seen_at, expiresAt: Math.min(s.expires_at, s.absolute_expires_at),
      revokedAt: s.revoked_at, revokeReason: s.revoke_reason, network: s.network || '', country: s.country || '',
      status: statusOf(s, now), current: s.id === currentId, live: registry.count(s.id) > 0,
    };
  }

  function keyRows(now, selfId) {
    const activeFor = new Map(activeSessions.all(now, now).map((r) => [r.access_key_id, r]));
    return keys.rows().filter((k) => k.deleted_at == null).map((k) => {
      const a = activeFor.get(k.id);
      return {
        id: k.id, self: k.id === selfId, label: k.label, role: k.role, masked: maskKey(k.key_suffix), enabled: !!k.enabled, createdAt: k.created_at, expiresAt: k.expires_at,
        expired: k.expires_at != null && k.expires_at <= now, lastUsedAt: k.last_used_at,
        activeSession: a ? { id: a.id, clientType: a.client_type === 'tauri' ? 'Tauri' : 'Web', platform: a.platform || '', client: a.user_agent_summary || '', lastSeenAt: a.last_seen_at } : null,
      };
    }).sort((a, b) => (b.activeSession ? 1 : 0) - (a.activeSession ? 1 : 0) || String(a.label).localeCompare(String(b.label)));
  }

  function closeEnded(list) { for (const e of list) registry.close(e.id, publicReason(e.reason)); }

  async function setServerDisabled(keyId, disabled) {
    const r = await upstream.json('/api/admin/users/' + encodeURIComponent(keyId), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ disabled }) });
    if (r.status !== 200) throw Object.assign(new Error(r.data?.error || `Сервер отклонил изменение (HTTP ${r.status})`), { status: r.status === 404 ? 404 : 502 });
  }

  async function handle(req, res, url, ctx) {
    const { principal, session } = ctx;
    if (principal.role !== 'admin' || !can(principal, 'admin.users')) return json(res, 403, { ok: false, error: 'Только для администратора', code: 'forbidden' });
    const parts = url.pathname.split('/').filter(Boolean).slice(2); // after /auth/admin
    const now = clock();
    const actor = { actorType: 'admin', actorId: session.access_key_id };

    if (req.method === 'GET') {
      if (parts[0] === 'sessions' && parts.length === 1) {
        const status = url.searchParams.get('status') === 'all' ? 'all' : 'active';
        const limit = Math.min(1000, Math.max(1, Number(url.searchParams.get('limit')) || 300));
        return json(res, 200, { now, sessions: listSessions.all(status, limit).map((s) => sessionRow(s, now, session.id)), keys: keyRows(now, session.access_key_id), sync: { at: keys.lastSyncAt, error: keys.lastError || '' } });
      }
      if (parts[0] === 'audit') {
        const limit = Math.min(500, Math.max(1, Number(url.searchParams.get('limit')) || 100));
        return json(res, 200, { entries: auditRows.all(limit).map((r) => ({ id: r.id, at: r.at, actorType: r.actor_type, actorId: r.actor_id, action: r.action, keyId: r.target_key_id, sessionId: r.target_session_id, detail: r.detail ? JSON.parse(r.detail) : null })) });
      }
      return json(res, 404, { ok: false, error: 'Не найдено' });
    }
    if (req.method !== 'POST') return json(res, 405, { ok: false, error: 'Метод не поддерживается' });
    if (!sameSiteWrite(req, config)) return json(res, 403, { ok: false, error: 'Запрос отклонён', code: 'origin' });
    let body = {};
    try { body = JSON.parse((await readBody(req, 8192)).toString('utf8') || '{}') || {}; } catch { return json(res, 400, { ok: false, error: 'Некорректный запрос' }); }

    try {
      // POST /auth/admin/sessions/:id/revoke
      if (parts[0] === 'sessions' && parts[2] === 'revoke') {
        const target = sessions.get(parts[1]);
        if (!target) return json(res, 404, { ok: false, error: 'Сессия не найдена' });
        const ended = sessions.revoke(target.id, 'admin', actor);
        if (ended) closeEnded([ended]);
        return json(res, 200, { ok: true, revoked: !!ended });
      }
      if (parts[0] === 'keys' && parts[1]) {
        const keyId = parts[1], row = keys.row(keyId);
        if (!row || row.deleted_at != null) return json(res, 404, { ok: false, error: 'Ключ не найден' });
        const self = keyId === session.access_key_id;
        if (parts[2] === 'revoke-sessions') {
          const ended = sessions.revokeKey(keyId, 'admin_key', actor);
          audit(db, { at: now, ...actor, action: 'key.sessions_revoked', keyId, detail: { sessionsEnded: ended.length } });
          closeEnded(ended);
          return json(res, 200, { ok: true, revoked: ended.length });
        }
        if (parts[2] === 'disable') {
          if (self) return json(res, 409, { ok: false, error: 'Нельзя отключить свой собственный ключ' });
          await setServerDisabled(keyId, true);
          keys.setEnabledLocal(keyId, false);
          const ended = keys.end(keyId, 'key_disabled', { action: 'key.disabled', ...actor });
          if (!ended.length) audit(db, { at: now, ...actor, action: 'key.disabled', keyId });
          keys.trySync();
          return json(res, 200, { ok: true, revoked: ended.length });
        }
        if (parts[2] === 'enable') {
          await setServerDisabled(keyId, false);
          keys.setEnabledLocal(keyId, true);
          audit(db, { at: now, ...actor, action: 'key.enabled', keyId });
          keys.trySync();
          return json(res, 200, { ok: true });
        }
        if (parts[2] === 'expiry') {
          const value = body.expiresAt == null || body.expiresAt === '' ? null : Number(body.expiresAt);
          if (value != null && (!Number.isFinite(value) || value < 0)) return json(res, 400, { ok: false, error: 'Неверная дата' });
          if (self && value != null && value <= now) return json(res, 409, { ok: false, error: 'Нельзя завершить срок своего ключа' });
          keys.setExpiry(keyId, value);
          audit(db, { at: now, ...actor, action: 'key.expiry_set', keyId, detail: { expiresAt: value } });
          let ended = [];
          if (value != null && value <= now) { ended = sessions.revokeKey(keyId, 'key_expired', actor); closeEnded(ended); }
          return json(res, 200, { ok: true, revoked: ended.length });
        }
      }
    } catch (error) {
      log.warn?.(`[admin] ${parts.join('/')} failed: ${error.message}`);
      return json(res, error.status || 500, { ok: false, error: error.message });
    }
    return json(res, 404, { ok: false, error: 'Не найдено' });
  }

  return { handle };
}
