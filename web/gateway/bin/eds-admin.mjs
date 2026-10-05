#!/usr/bin/env node
// Operator CLI for the gateway (run as root on the server). Prints no secrets: a new key is written to a file that
// only root can read, and the path is printed instead.
//
//   eds-admin bootstrap-admin [--name Оператор] [--out /root/esportsdata-admin-key.txt]
//       Creates an administrator Access Key on the monitor server (role admin) for signing in to the web admin panel.
//       Refuses when an administrator key already exists unless --force.
//   eds-admin sessions [--all]          list sessions (public ids only)
//   eds-admin revoke <session-id>       end one session
//   eds-admin revoke-key <key-id>       end every session of a key
//   eds-admin audit [--limit 50]        recent audit entries
//
// Environment: the same as the gateway service (DATA_DIR, UPSTREAM_BASE, UPSTREAM_TOKEN_FILE or CREDENTIALS_DIRECTORY).
import fs from 'node:fs';
import path from 'node:path';
import { loadConfig } from '../src/config.js';
import { openDatabase, audit } from '../src/db.js';
import { SessionStore } from '../src/sessions.js';
import { createUpstream } from '../src/upstream.js';

const args = process.argv.slice(2), cmd = args[0];
const opt = (name, fallback = '') => { const i = args.indexOf('--' + name); return i >= 0 ? args[i + 1] : fallback; };
const flag = (name) => args.includes('--' + name);
const config = loadConfig();
const dbFile = path.join(config.dataDir, 'gateway.sqlite3');
const iso = (ms) => (ms ? new Date(ms).toISOString().replace('T', ' ').slice(0, 16) : '—');

async function bootstrapAdmin() {
  if (!config.upstreamToken) throw new Error('upstream token is not configured (UPSTREAM_TOKEN_FILE)');
  const upstream = createUpstream({ base: config.upstreamBase, token: config.upstreamToken });
  const list = await upstream.json('/api/admin/users');
  if (list.status !== 200) throw new Error(`cannot list users (HTTP ${list.status})`);
  const admins = (list.data.users || []).filter((u) => u.role === 'admin' && !u.disabled);
  if (admins.length && !flag('force')) throw new Error(`an administrator key already exists (${admins.map((u) => u.name).join(', ')}); use --force to create another`);
  const out = opt('out', '/root/esportsdata-admin-key.txt');
  if (fs.existsSync(out)) throw new Error(`${out} already exists; move it away first`);
  const name = opt('name', 'Оператор (web admin)');
  const created = await upstream.json('/api/admin/users', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name, role: 'admin' }) });
  if (created.status !== 200 || !created.data?.token) throw new Error(`cannot create the administrator key (HTTP ${created.status})`);
  fs.writeFileSync(out, `Esports Data administrator Access Key (${name}, user ${created.data.user.id})\n${created.data.token}\n\nSign in at ${config.publicOrigin} with this key, store it in your password manager, then delete this file.\n`, { mode: 0o600 });
  upstream.close();
  if (fs.existsSync(dbFile)) { const db = openDatabase(dbFile); audit(db, { actorType: 'system', actorId: 'cli', action: 'admin_key.bootstrapped', keyId: created.data.user.id }); db.close(); }
  console.log(`Administrator key created for user ${created.data.user.id}. It was written to ${out} (mode 600); it is not printed here.`);
}

function withStore(fn) {
  const db = openDatabase(dbFile);
  const store = new SessionStore({ db, idleMs: config.sessionIdleMs, maxMs: config.sessionMaxMs, adminMaxMs: config.adminSessionMaxMs });
  try { return fn(db, store); } finally { db.close(); }
}

try {
  if (cmd === 'bootstrap-admin') await bootstrapAdmin();
  else if (cmd === 'sessions') withStore((db) => {
    const rows = db.prepare(`SELECT s.id, k.label, s.client_type, s.platform, s.user_agent_summary, s.created_at, s.last_seen_at, s.expires_at, s.revoked_at, s.revoke_reason
                               FROM sessions s JOIN access_keys k ON k.id = s.access_key_id ${flag('all') ? '' : 'WHERE s.revoked_at IS NULL'} ORDER BY s.last_seen_at DESC LIMIT 500`).all();
    for (const r of rows) console.log([r.id, r.label, r.client_type, r.user_agent_summary || r.platform || '', 'created ' + iso(r.created_at), 'seen ' + iso(r.last_seen_at), r.revoked_at ? `REVOKED ${iso(r.revoked_at)} (${r.revoke_reason})` : 'expires ' + iso(r.expires_at)].join(' | '));
    if (!rows.length) console.log('no sessions');
  });
  else if (cmd === 'revoke') withStore((db, store) => console.log(store.revoke(args[1], 'admin', { actorType: 'admin', actorId: 'cli' }) ? 'revoked (open streams close within 15 s)' : 'not found or already ended'));
  else if (cmd === 'revoke-key') withStore((db, store) => console.log(`revoked ${store.revokeKey(args[1], 'admin_key', { actorType: 'admin', actorId: 'cli' }).length} session(s)`));
  else if (cmd === 'audit') withStore((db) => { for (const r of db.prepare('SELECT * FROM audit_log ORDER BY id DESC LIMIT ?').all(Number(opt('limit', 50)))) console.log([iso(r.at), r.actor_type + (r.actor_id ? ':' + r.actor_id : ''), r.action, r.target_key_id || '', r.target_session_id || '', r.detail || ''].join(' | ')); });
  else { console.log('usage: eds-admin bootstrap-admin|sessions|revoke|revoke-key|audit (see the header of this file)'); process.exitCode = 2; }
} catch (error) {
  console.error('error:', error.message);
  process.exitCode = 1;
}
