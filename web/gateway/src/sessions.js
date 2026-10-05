// Persistent sessions. A session token is 256 random bits, opaque, and exists only in the client (HttpOnly cookie or
// the desktop app's private storage); the database keeps its SHA-256. One Access Key has at most one active session:
// see db.js (partial unique index) and create() (revoke + insert in one IMMEDIATE transaction).
import { createHash, randomBytes } from 'node:crypto';
import { audit, transaction } from './db.js';

export const TOKEN_PREFIX = 'eds_';
export const hashToken = (token) => createHash('sha256').update(String(token)).digest('hex');
const newToken = () => TOKEN_PREFIX + randomBytes(32).toString('base64url');
const newId = () => 's_' + randomBytes(9).toString('base64url');
const TOKEN_SHAPE = /^eds_[A-Za-z0-9_-]{43}$/;

// Reasons a session ended, as stored. Clients only ever see the coarse public category (publicReason).
export const REASONS = Object.freeze({
  replaced: 'replaced',         // the same Access Key signed in on another profile/device
  logout: 'logout',
  switched: 'switched',         // this profile signed in with another key
  admin: 'admin',               // an administrator revoked this session
  adminKey: 'admin_key',        // an administrator ended every session of the key
  keyDisabled: 'key_disabled',
  keyDeleted: 'key_deleted',
  keyRotated: 'key_rotated',
  keyExpired: 'key_expired',
  expired: 'expired',
});
export function publicReason(reason) {
  if (reason === 'replaced') return 'replaced';
  if (reason === 'expired') return 'expired';
  if (reason === 'logout' || reason === 'switched') return 'logout';
  if (reason === 'admin' || reason === 'admin_key') return 'admin';
  if (reason) return 'access_revoked';
  return 'none';
}

export class SessionStore {
  constructor({ db, clock = Date.now, idleMs, maxMs, adminMaxMs, touchEveryMs = 60_000 }) {
    Object.assign(this, { db, clock, idleMs, maxMs, adminMaxMs, touchEveryMs });
    this.lastTouch = new Map();
    this.stmt = {
      byHash: db.prepare(`SELECT s.*, k.label AS key_label, k.role AS key_role, k.enabled AS key_enabled, k.expires_at AS key_expires_at,
                                 k.deleted_at AS key_deleted_at, k.key_suffix AS key_suffix
                            FROM sessions s JOIN access_keys k ON k.id = s.access_key_id WHERE s.token_hash = ?`),
      openForKey: db.prepare('SELECT id, expires_at, absolute_expires_at FROM sessions WHERE access_key_id = ? AND revoked_at IS NULL'),
      revoke: db.prepare('UPDATE sessions SET revoked_at = ?, revoke_reason = ? WHERE id = ? AND revoked_at IS NULL'),
      insert: db.prepare(`INSERT INTO sessions (id, access_key_id, token_hash, client_type, created_at, last_seen_at, expires_at, absolute_expires_at,
                                                user_agent_summary, platform, network, country) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
      touch: db.prepare('UPDATE sessions SET last_seen_at = ?, expires_at = ? WHERE id = ? AND revoked_at IS NULL'),
      keyUsed: db.prepare('UPDATE access_keys SET last_used_at = ?, key_suffix = COALESCE(?, key_suffix) WHERE id = ?'),
      openIds: db.prepare('SELECT id, access_key_id FROM sessions WHERE revoked_at IS NULL AND (expires_at <= ? OR absolute_expires_at <= ?)'),
      openByKey: db.prepare('SELECT id FROM sessions WHERE access_key_id = ? AND revoked_at IS NULL'),
      get: db.prepare('SELECT * FROM sessions WHERE id = ?'),
    };
  }

  static validTokenShape(token) { return TOKEN_SHAPE.test(String(token || '')); }

  // Sign in: revoke whatever session this key has (and the profile's previous session of another key), then create
  // the new one - atomically. Returns the raw token exactly once; it is never stored.
  create({ keyId, role = 'user', clientType, userAgentSummary = '', platform = '', network = '', country = '', previousToken = '', keySuffix = null }) {
    const now = this.clock();
    const token = newToken(), id = newId();
    const lifetime = role === 'admin' ? Math.min(this.adminMaxMs, this.maxMs) : this.maxMs;
    const absolute = now + lifetime, expires = Math.min(now + this.idleMs, absolute);
    const ended = [];
    transaction(this.db, () => {
      for (const row of this.stmt.openForKey.all(keyId)) {
        const reason = row.expires_at <= now || row.absolute_expires_at <= now ? REASONS.expired : REASONS.replaced;
        this.stmt.revoke.run(now, reason, row.id);
        ended.push({ id: row.id, keyId, reason });
        audit(this.db, { at: now, actorType: 'system', action: reason === REASONS.replaced ? 'session.replaced' : 'session.expired', keyId, sessionId: row.id, detail: { by: id } });
      }
      if (previousToken && SessionStore.validTokenShape(previousToken)) {
        const previous = this.stmt.byHash.get(hashToken(previousToken));
        if (previous && previous.revoked_at == null && previous.access_key_id !== keyId) {
          this.stmt.revoke.run(now, REASONS.switched, previous.id);
          ended.push({ id: previous.id, keyId: previous.access_key_id, reason: REASONS.switched });
          audit(this.db, { at: now, actorType: 'user', actorId: previous.access_key_id, action: 'session.switched', keyId: previous.access_key_id, sessionId: previous.id, detail: { to: keyId } });
        }
      }
      this.stmt.insert.run(id, keyId, hashToken(token), clientType, now, now, expires, absolute, userAgentSummary || null, platform || null, network || null, country || null);
      this.stmt.keyUsed.run(now, keySuffix, keyId);
      audit(this.db, { at: now, actorType: 'user', actorId: keyId, action: 'session.created', keyId, sessionId: id, detail: { clientType, platform: platform || null } });
    });
    this.lastTouch.set(id, now);
    return { token, session: this.stmt.get.get(id), ended };
  }

  // Looks a token up. status: active | revoked | expired | unknown. An expired session is marked revoked here (lazy
  // expiry) so the "one active session" slot is released and its streams can be closed.
  lookup(token) {
    if (!SessionStore.validTokenShape(token)) return { status: 'unknown' };
    const row = this.stmt.byHash.get(hashToken(token));
    if (!row) return { status: 'unknown' };
    if (row.revoked_at != null) return { status: 'revoked', reason: row.revoke_reason, session: row };
    const now = this.clock();
    let reason = '';
    if (row.key_deleted_at != null) reason = REASONS.keyDeleted;
    else if (!row.key_enabled) reason = REASONS.keyDisabled;
    else if (row.key_expires_at != null && row.key_expires_at <= now) reason = REASONS.keyExpired;
    else if (row.expires_at <= now || row.absolute_expires_at <= now) reason = REASONS.expired;
    if (reason) {
      this.revoke(row.id, reason, { actorType: 'system' });
      return { status: reason === REASONS.expired ? 'expired' : 'revoked', reason, session: { ...row, revoked_at: now, revoke_reason: reason } };
    }
    return { status: 'active', session: row };
  }

  // Rolling renewal: real activity moves the idle expiry forward (at most once a minute per session), never past the
  // absolute limit fixed at sign-in.
  touch(session) {
    const now = this.clock(), last = this.lastTouch.get(session.id) || session.last_seen_at;
    if (now - last < this.touchEveryMs) return session;
    const expires = Math.min(now + this.idleMs, session.absolute_expires_at);
    this.stmt.touch.run(now, expires, session.id);
    this.lastTouch.set(session.id, now);
    if (this.lastTouch.size > 50_000) this.lastTouch.clear();
    return { ...session, last_seen_at: now, expires_at: expires };
  }

  revoke(id, reason, { actorType = 'system', actorId = null } = {}) {
    const now = this.clock(), row = this.stmt.get.get(id);
    if (!row) return null;
    const changed = this.stmt.revoke.run(now, reason, id).changes > 0;
    if (changed) audit(this.db, { at: now, actorType, actorId, action: 'session.revoked', keyId: row.access_key_id, sessionId: id, detail: { reason } });
    this.lastTouch.delete(id);
    return changed ? { id, keyId: row.access_key_id, reason } : null;
  }

  revokeKey(keyId, reason, actor = {}) {
    const ended = [];
    transaction(this.db, () => {
      for (const { id } of this.stmt.openByKey.all(keyId)) {
        const r = this.revoke(id, reason, actor);
        if (r) ended.push(r);
      }
    });
    return ended;
  }

  // Periodic sweep: sessions whose time ran out are marked expired (their open streams get closed by the caller).
  sweepExpired() {
    const now = this.clock(), ended = [];
    for (const row of this.stmt.openIds.all(now, now)) {
      const r = this.revoke(row.id, REASONS.expired, { actorType: 'system' });
      if (r) ended.push(r);
    }
    return ended;
  }

  get(id) { return this.stmt.get.get(id) || null; }
}
