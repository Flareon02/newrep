# Admin session management

## Where

The existing admin panel (Settings) of the web app. «Пользователи» (unchanged: create keys, capabilities, rotate,
delete — the key is shown once) and the new «Сессии» section. Visible only to a session whose key has the
**administrator role** on the monitor server; customer keys get 403 even with admin capabilities.

## Administrator authentication

* Administrators sign in with an administrator Access Key (role `admin`), never a customer key, and never the
  server's `API_TOKEN` (refused by `/auth/verify`).
* The first administrator key is created with `eds-admin bootstrap-admin` (root on the server). It refuses to run when
  an administrator key exists (`--force` to add another) and writes the key to `/root/esportsdata-admin-key.txt`
  (mode 600) — never to stdout or logs. Store it in a password manager and delete the file.
* Administrator sessions: 7 days absolute; the same one-session rule applies to the administrator key.
* Every admin write needs the site's Origin (CSRF) and is audited.

## «Сессии»

Table (active or all): key label + masked key (`emu_…ab12`), public session id (`s_…`, truncated), client (Web /
Tauri), device (`Chrome 141 · Windows`), signed in, last activity («поток открыт» when a stream is open), expires
(or revoked at), network (`/24` or `/48`) and country, status ACTIVE / REVOKED / EXPIRED with the reason.
Never shown: Access Keys, session tokens, token hashes, the server API token.

Keys table: label, role, enabled/disabled/expired, expiry date, last sign-in, the active session, actions.

| Action | Effect |
|---|---|
| Отозвать (session) | session revoked (`admin`), its streams closed at once; the user sees «Сессия завершена администратором» |
| Отозвать все сессии | every session of the key revoked (`admin_key`) |
| Отключить ключ | key disabled on the monitor server (so the extension stops too) + all its sessions revoked; sign-in refused |
| Включить ключ | key enabled again; the user signs in again |
| Срок действия | date after which sign-in is refused and sessions end (`key_expired`); empty = no expiry |

Destructive actions need a second click. An administrator cannot disable or expire their own key (the button is
replaced by «ваш ключ»; the API answers 409), cannot delete it or rotate it from their own session.

## API (`/auth/admin/*`, administrator session)

```
GET  /auth/admin/sessions?status=active|all&limit=300   sessions + keys + mirror sync state
GET  /auth/admin/audit?limit=100                        audit log
POST /auth/admin/sessions/:id/revoke
POST /auth/admin/keys/:id/revoke-sessions
POST /auth/admin/keys/:id/disable
POST /auth/admin/keys/:id/enable
POST /auth/admin/keys/:id/expiry      {"expiresAt": <ms> | null}
```

## Audit log

`audit_log(at, actor_type admin|user|system, actor_id, action, target_key_id, target_session_id, detail)` — actions:
`session.created`, `session.replaced`, `session.switched`, `session.expired`, `session.revoked`, `key.disabled`,
`key.enabled`, `key.expiry_set`, `key.sessions_revoked`, `key.disabled.server`, `key.rotated.server`,
`key.deleted.server`, `admin_key.bootstrapped`. No secrets in any field.

## Command line (root)

```
eds-admin sessions [--all]       eds-admin revoke <session-id>      eds-admin revoke-key <key-id>
eds-admin audit [--limit 50]     eds-admin bootstrap-admin [--name …] [--out file] [--force]
```
CLI revocations close open streams within 15 s (`SESSION_SWEEP_MS`).

## Limitation

The browser extension still uses keys directly against `api.esportsdata.online`; it is not a "session" and is not
counted by the one-session rule. Disabling a key stops both. Moving the extension onto sessions is possible later
(it would sign in through `/auth/verify` like the desktop app).
