// Gateway database (SQLite through node:sqlite). Holds no raw secrets: only SHA-256 hashes of session tokens.
//
// The rule "one Access Key = one active session" is enforced by the schema itself: the partial unique index
// sessions_one_active allows at most one row with revoked_at IS NULL per access key. Every login revokes the previous
// row and inserts the new one inside one BEGIN IMMEDIATE transaction, so concurrent logins are serialized by SQLite
// and a second "active" row can never be committed, even by a buggy code path or a second gateway process.
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

const MIGRATIONS = [
  `CREATE TABLE access_keys (
     id              TEXT PRIMARY KEY,          -- the monitor server's user id (u_...): the key itself lives there, hashed
     label           TEXT NOT NULL DEFAULT '',
     role            TEXT NOT NULL DEFAULT 'user',
     enabled         INTEGER NOT NULL DEFAULT 1,
     key_suffix      TEXT,                      -- last 4 characters, learned at a successful verify (masked display)
     key_updated_at  INTEGER,                   -- server-side key rotation time: a new key ends the old key's sessions
     created_at      INTEGER NOT NULL,
     expires_at      INTEGER,                   -- NULL = no expiry
     last_used_at    INTEGER,
     deleted_at      INTEGER
   );
   CREATE TABLE sessions (
     id                   TEXT PRIMARY KEY,     -- public, non-secret identifier (s_...), safe to show to administrators
     access_key_id        TEXT NOT NULL REFERENCES access_keys(id),
     token_hash           TEXT NOT NULL UNIQUE, -- SHA-256 of the opaque session token; the token itself is never stored
     client_type          TEXT NOT NULL CHECK (client_type IN ('web','tauri')),
     created_at           INTEGER NOT NULL,
     last_seen_at         INTEGER NOT NULL,
     expires_at           INTEGER NOT NULL,     -- rolling idle expiry
     absolute_expires_at  INTEGER NOT NULL,     -- hard limit, never extended
     revoked_at           INTEGER,
     revoke_reason        TEXT,
     user_agent_summary   TEXT,
     platform             TEXT,
     network              TEXT,                 -- truncated address (/24 or /48), never the full IP
     country              TEXT
   );
   CREATE UNIQUE INDEX sessions_one_active ON sessions(access_key_id) WHERE revoked_at IS NULL;
   CREATE INDEX sessions_by_key ON sessions(access_key_id, created_at);
   CREATE INDEX sessions_open ON sessions(revoked_at, expires_at);
   CREATE TABLE audit_log (
     id                 INTEGER PRIMARY KEY AUTOINCREMENT,
     at                 INTEGER NOT NULL,
     actor_type         TEXT NOT NULL,          -- admin | user | system
     actor_id           TEXT,
     action             TEXT NOT NULL,
     target_key_id      TEXT,
     target_session_id  TEXT,
     detail             TEXT
   );
   CREATE INDEX audit_by_time ON audit_log(at);`,
];

export function openDatabase(file) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON; PRAGMA synchronous = NORMAL;');
  migrate(db);
  if (file !== ':memory:') for (const f of [file, file + '-wal', file + '-shm']) try { fs.chmodSync(f, 0o600); } catch {}
  return db;
}

function migrate(db) {
  const version = db.prepare('PRAGMA user_version').get().user_version;
  for (let i = version; i < MIGRATIONS.length; i++) {
    transaction(db, () => { db.exec(MIGRATIONS[i]); db.exec(`PRAGMA user_version = ${i + 1}`); });
  }
}

// BEGIN IMMEDIATE takes the write lock up front, so two logins never interleave their read-then-write steps.
export function transaction(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch {}
    throw error;
  }
}

export function audit(db, { at = Date.now(), actorType, actorId = null, action, keyId = null, sessionId = null, detail = null }) {
  db.prepare('INSERT INTO audit_log (at, actor_type, actor_id, action, target_key_id, target_session_id, detail) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(at, actorType, actorId, action, keyId, sessionId, detail == null ? null : JSON.stringify(detail));
}
