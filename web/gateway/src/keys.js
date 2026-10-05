// Access Keys. A key is a user of the monitor server (server/src/entitlements.js UserStore): the server keeps the
// key's SHA-256, its capabilities and its enabled flag, and the existing admin panel creates and rotates keys. The
// gateway mirrors each user into access_keys (label, role, enabled, rotation time) and adds what the web needs:
// expiry, last use and the active session. The mirror is refreshed every few seconds; a key disabled, deleted or
// rotated on the server ends its web sessions at the next sync (immediately when done through this gateway).
import { createAccess } from './vendor/entitlements.js';
import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';
import { audit } from './db.js';
import { REASONS } from './sessions.js';

const sha = (v) => createHash('sha256').update(String(v)).digest();

export class KeyDirectory {
  constructor({ db, upstream, sessions, onEnded = () => {}, clock = Date.now, log = console, serviceToken = '' }) {
    Object.assign(this, { db, upstream, sessions, onEnded, clock, log });
    this.users = new Map();
    this.loaded = false;
    this.lastSyncAt = 0;
    this.lastError = '';
    this.serviceDigest = serviceToken ? sha(serviceToken) : null;
    // Principals are built by the server's own createAccess(), so capabilities, the "unrestricted" shortcut and the
    // ETag signature are exactly what the server would compute for this user. The random master token only switches
    // createAccess into enforcing mode; it is never sent anywhere.
    this.access = createAccess({
      masterToken: randomBytes(32).toString('hex'),
      users: { ready: Promise.resolve(), byToken: (id) => this.users.get(id) || null },
    });
    this.stmt = {
      all: db.prepare('SELECT * FROM access_keys'),
      get: db.prepare('SELECT * FROM access_keys WHERE id = ?'),
      insert: db.prepare('INSERT INTO access_keys (id, label, role, enabled, key_updated_at, created_at) VALUES (?, ?, ?, ?, ?, ?)'),
      update: db.prepare('UPDATE access_keys SET label = ?, role = ?, enabled = ?, key_updated_at = ?, deleted_at = NULL WHERE id = ?'),
      deleted: db.prepare('UPDATE access_keys SET deleted_at = ?, enabled = 0 WHERE id = ?'),
      setEnabled: db.prepare('UPDATE access_keys SET enabled = ? WHERE id = ?'),
      setExpiry: db.prepare('UPDATE access_keys SET expires_at = ? WHERE id = ?'),
    };
  }

  isServiceToken(value) { return !!this.serviceDigest && timingSafeEqual(sha(value), this.serviceDigest); }

  async sync() {
    const { status, data } = await this.upstream.json('/api/admin/users');
    if (status !== 200 || !Array.isArray(data?.users)) throw new Error(`user list unavailable (HTTP ${status})`);
    this.reconcile(data.users);
    this.loaded = true; this.lastSyncAt = this.clock(); this.lastError = '';
    return this.users.size;
  }

  async trySync() {
    try { return await this.sync(); } catch (error) { this.lastError = error.message; this.log.warn?.(`[keys] sync failed: ${error.message}`); return null; }
  }

  reconcile(list) {
    const now = this.clock(), seen = new Set(), next = new Map();
    const stored = new Map(this.stmt.all.all().map((r) => [r.id, r]));
    for (const u of list) {
      if (!u || typeof u.id !== 'string') continue;
      const user = { id: u.id, name: String(u.name || ''), role: u.role === 'admin' ? 'admin' : 'user', disabled: !!u.disabled, capabilities: Array.isArray(u.capabilities) ? u.capabilities : [], tokenUpdatedAt: Number(u.tokenUpdatedAt) || null };
      next.set(user.id, user); seen.add(user.id);
      const row = stored.get(user.id);
      if (!row) { this.stmt.insert.run(user.id, user.name, user.role, user.disabled ? 0 : 1, user.tokenUpdatedAt, now); continue; }
      this.stmt.update.run(user.name, user.role, user.disabled ? 0 : 1, user.tokenUpdatedAt, user.id);
      if (user.disabled) this.end(user.id, REASONS.keyDisabled, { action: row.enabled ? 'key.disabled.server' : null });
      else if (row.key_updated_at != null && user.tokenUpdatedAt != null && row.key_updated_at !== user.tokenUpdatedAt) this.end(user.id, REASONS.keyRotated, { action: 'key.rotated.server' });
    }
    for (const row of stored.values()) {
      if (seen.has(row.id) || row.deleted_at != null) continue;
      this.stmt.deleted.run(now, row.id);
      this.end(row.id, REASONS.keyDeleted, { action: 'key.deleted.server' });
    }
    this.users = next;
  }

  end(keyId, reason, { action = null, actorType = 'system', actorId = null } = {}) {
    const ended = this.sessions.revokeKey(keyId, reason, { actorType, actorId });
    if (action) audit(this.db, { at: this.clock(), actorType, actorId, action, keyId, detail: { sessionsEnded: ended.length } });
    if (ended.length) this.onEnded(ended);
    return ended;
  }

  principal(keyId) {
    const user = this.users.get(keyId);
    if (!user || user.disabled) return null;
    return this.access.resolve({ headers: { authorization: 'Bearer ' + keyId } }, null).then((p) => (p.anonymous ? null : p));
  }

  user(keyId) { return this.users.get(keyId) || null; }
  row(keyId) { return this.stmt.get.get(keyId) || null; }
  rows() { return this.stmt.all.all(); }

  setEnabledLocal(keyId, enabled) {
    this.stmt.setEnabled.run(enabled ? 1 : 0, keyId);
    const u = this.users.get(keyId);
    if (u) this.users.set(keyId, { ...u, disabled: !enabled });
  }
  setExpiry(keyId, expiresAt) { this.stmt.setExpiry.run(expiresAt, keyId); }
}
