// Personal settings bound to user + key + namespace (GET/POST /api/me/settings).
//
// A separate small SQLite file (user-settings.sqlite3 in DATA_DIR), not the monitor database: settings writes are
// rare and tiny, and a separate file never takes the history writer's lock (LIVE never waits for a settings save) and
// can be backed up / rolled back on its own. Opened on first use; every statement is a single-row primary-key access.
//
// Model: (user_id, key_id, namespace) → { version, payload (JSON ≤ 64 KiB), updated_at }. A write carries the version
// it was based on; a stale base gets 409 with the current row (no lost updates between two devices). A new key of the
// same user starts from that user's latest settings of another key (`inheritedFrom`), so rotating a key does not wipe
// preferences, while different users never see each other's rows.
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import fs from 'node:fs';

export const SETTINGS_NAMESPACES = Object.freeze(['ui']);
export const SETTINGS_MAX_BYTES = 64 * 1024;
const fail = (status, error, code) => Object.assign(new Error(error), { status, code });

export class UserSettingsStore {
  constructor({ dataDir, file = 'user-settings.sqlite3', now = Date.now } = {}) {
    this.file = dataDir ? path.join(dataDir, file) : ':memory:';
    this.now = now;
    this.db = null;
  }
  open() {
    if (this.db) return this.db;
    if (this.file !== ':memory:') fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const db = new DatabaseSync(this.file);
    db.exec(`PRAGMA journal_mode=WAL;PRAGMA synchronous=NORMAL;PRAGMA busy_timeout=200;
      CREATE TABLE IF NOT EXISTS settings_meta(key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
      CREATE TABLE IF NOT EXISTS user_settings(
        user_id TEXT NOT NULL, key_id TEXT NOT NULL, namespace TEXT NOT NULL,
        version INTEGER NOT NULL, payload TEXT NOT NULL, updated_at INTEGER NOT NULL,
        PRIMARY KEY(user_id, key_id, namespace)) STRICT;
      CREATE INDEX IF NOT EXISTS user_settings_latest ON user_settings(user_id, namespace, updated_at DESC);
      INSERT OR IGNORE INTO settings_meta(key, value) VALUES('schemaVersion', '1');`);
    this.q = {
      get: db.prepare('SELECT version, payload, updated_at FROM user_settings WHERE user_id=? AND key_id=? AND namespace=?'),
      latest: db.prepare('SELECT key_id, version, payload, updated_at FROM user_settings WHERE user_id=? AND namespace=? AND key_id<>? ORDER BY updated_at DESC LIMIT 1'),
      upsert: db.prepare('INSERT INTO user_settings(user_id,key_id,namespace,version,payload,updated_at) VALUES(?,?,?,?,?,?) ON CONFLICT(user_id,key_id,namespace) DO UPDATE SET version=excluded.version,payload=excluded.payload,updated_at=excluded.updated_at'),
      count: db.prepare('SELECT COUNT(*) AS n FROM user_settings'),
    };
    this.db = db;
    return db;
  }
  static check(identity, namespace) {
    if (!identity?.userId || identity.anonymous) throw fail(404, 'Настройки сохраняются только для пользователя с ключом доступа', 'settings_unavailable');
    if (!SETTINGS_NAMESPACES.includes(namespace)) throw fail(400, 'Неизвестный раздел настроек', 'bad_namespace');
  }
  get(identity, namespace = 'ui') {
    UserSettingsStore.check(identity, namespace);
    this.open();
    const keyId = String(identity.keyId || '');
    const row = this.q.get.get(identity.userId, keyId, namespace);
    if (row) return { userId: identity.userId, keyId, namespace, version: Number(row.version), updatedAt: Number(row.updated_at), payload: JSON.parse(row.payload) };
    const other = this.q.latest.get(identity.userId, namespace, keyId);
    if (other) return { userId: identity.userId, keyId, namespace, version: 0, updatedAt: 0, payload: JSON.parse(other.payload), inheritedFrom: { keyId: other.key_id, updatedAt: Number(other.updated_at) } };
    return { userId: identity.userId, keyId, namespace, version: 0, updatedAt: 0, payload: null };
  }
  put(identity, namespace = 'ui', { baseVersion = 0, payload } = {}) {
    UserSettingsStore.check(identity, namespace);
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw fail(400, 'Настройки должны быть объектом', 'bad_payload');
    const text = JSON.stringify(payload);
    if (Buffer.byteLength(text) > SETTINGS_MAX_BYTES) throw fail(413, 'Настройки слишком большие', 'payload_too_large');
    this.open();
    const keyId = String(identity.keyId || '');
    const current = this.q.get.get(identity.userId, keyId, namespace), version = Number(current?.version || 0);
    if (Number(baseVersion) !== version) {
      const err = fail(409, 'Настройки изменены на другом устройстве', 'settings_conflict');
      err.current = this.get(identity, namespace);
      throw err;
    }
    const at = this.now();
    this.q.upsert.run(identity.userId, keyId, namespace, version + 1, text, at);
    return { userId: identity.userId, keyId, namespace, version: version + 1, updatedAt: at, payload };
  }
  status() {
    if (!this.db) return { open: false, file: path.basename(this.file) };
    return { open: true, file: path.basename(this.file), rows: Number(this.q.count.get().n) };
  }
  close() { try { this.db?.close(); } catch {} this.db = null; }
}
