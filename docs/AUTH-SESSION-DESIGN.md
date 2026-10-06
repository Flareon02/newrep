# Access Key and session design

## Rule

**ONE ACCESS KEY = ONE ACTIVE PROFILE / SESSION.** A profile is one browser profile (any PC, any Windows user) or one
desktop app installation (per Windows user). Signing in with a key ends the key's previous session — web or desktop —
at that moment. Identity is the server-side session only: no IP address, hardware or browser fingerprint is used.

## Access Key

* An Access Key is a user of the monitor server (`users.json`, created in Settings → Пользователи, shown once; the
  server stores its SHA-256 and its capabilities). Existing customer keys work unchanged.
* `POST /auth/verify {key, client}`: rate limit → normalize (whitespace/invisible characters removed, charset and
  length checked) → the server's own `API_TOKEN` is refused → `GET /api/me` with the key (the only time a key reaches
  the server from the gateway) → key must be a real user (`u_…`), enabled on the server, not deleted, not expired in
  the gateway → session created.
* Every refusal is the same `401 {"error":"Неверный или просроченный ключ доступа","code":"invalid_key"}` after a
  250–500 ms delay; nothing tells whether the key exists, is disabled or expired. Server unreachable → `503`.
* The key is never stored (browser, desktop app, gateway database, logs). The gateway keeps only its last 4
  characters for the masked display (`emu_…ab12`).

## Session

| | |
|---|---|
| token | `eds_` + 32 random bytes (base64url, 256 bit), opaque |
| stored | SHA-256 of the token only (`sessions.token_hash`) |
| web | cookie `__Host-eds_session`: `Secure; HttpOnly; SameSite=Lax; Path=/`, Max-Age = absolute limit |
| desktop | token returned once in the verify response, kept in the app's WebView2 profile (per Windows user), sent as `Authorization: Bearer` |
| lifetime | 30 days idle (rolling: activity moves expiry forward, at most once a minute), 90 days absolute; administrator keys 7 days absolute |
| record | `created_at, last_seen_at, expires_at, absolute_expires_at, revoked_at, revoke_reason, client_type, user_agent_summary, platform, network (/24 or /48), country` |

Every `/api/*`, `/auth/admin/*`, `/health` and `/downloads/*` (except public desktop releases) request looks the
session up in the database — no cache — so a revoked session is refused on its next request.

## Atomicity (race safety)

`sessions_one_active` is a **partial unique index** on `sessions(access_key_id) WHERE revoked_at IS NULL`. Sign-in runs
in one `BEGIN IMMEDIATE` transaction: revoke the key's open sessions (`replaced`, or `expired` if their time ran out),
revoke the profile's previous session of another key (`switched`), insert the new session, write the audit rows.
SQLite serializes writers; the index makes a second open session impossible even for a buggy path or a second
process. Tested: 12 concurrent sign-ins → exactly one active session and one profile able to read data.

## Revocation

| Trigger | Reason stored | Client sees |
|---|---|---|
| same key signs in elsewhere | `replaced` | «Эта сессия была завершена, потому что ключ доступа использован в другом профиле.» |
| administrator revokes the session / all sessions of the key | `admin` / `admin_key` | «Сессия завершена администратором.» |
| key disabled, deleted or rotated (gateway or old admin panel) | `key_disabled` / `key_deleted` / `key_rotated` | «Ключ доступа больше не действует…» |
| key expiry date passed | `key_expired` | same |
| idle or absolute limit | `expired` | «Срок сессии истёк…» |
| logout | `logout` | — |

On revocation the gateway closes every open stream of the session with a final `event: session` and the reason.
The page reacts to (a) any 401 with `code: session_*` from the gateway (the reconnecting stream or the next request),
(b) the stream's `session` event (desktop), (c) a `/auth/session` check every 60 s and on tab focus. It then clears the
account's cached data (last-known feeds, capabilities, seen events), reloads and shows the gate with the reason.
Measured in production: old profile on the gate ≈ 0.9–1.2 s after the new sign-in; ≈ 3 s after an admin revoke.

Changes made outside the gateway (old extension admin panel) are picked up by the key mirror every 15 s
(`DIRECTORY_SYNC_MS`); changes made through the gateway apply immediately. A monitor-server outage never revokes
sessions (the mirror keeps its last state).

## CSRF, fixation, replay

* State-changing requests (`/auth/verify`, `/auth/logout`, `/auth/admin/*` POST, `/api/*` POST) need `Origin` equal
  to `https://esportsdata.online` (or a desktop app origin); `SameSite=Lax` is the second layer.
* Sign-in always issues a new token; a cookie planted before sign-in is replaced and, if it was a session of another
  key, revoked (`switched`).
* A copied token stops working at logout/revocation; tokens in a query string are ignored (no auth in URLs).

## Persistence

Web: reload, closing the tab or browser and rebooting keep the session (persistent cookie). Another browser profile or
Windows user has no cookie → gate. Desktop: the token lives in `%LOCALAPPDATA%\online.esportsdata.desktop\EBWebView`
(per Windows user), survives restarts and updates. When offline at start, a profile that was signed in opens with its
last-known data; the first server answer decides.

## Protocol compatibility

`/auth/session` returns `protocol: {version: 1, minClient: 1}`. Only an incompatible gateway change raises
`minClient`; a desktop build below it is asked to update. Web and server releases do not change it.
