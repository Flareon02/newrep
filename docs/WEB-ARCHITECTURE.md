# Web architecture — https://esportsdata.online

## Shape

```
Browser (web)  ─┐                          ┌─ /            UI (dist/web, the approved 9.3.0 UI + platform layer)
                ├─ HTTPS ─ Cloudflare ─ cloudflared ─ 127.0.0.1:8090  esportsdata-web (gateway, Node 22)
Desktop (Tauri)─┘   (esportsdata.online)                   ├─ /auth/*      Access Key → session, admin sessions
                                                           ├─ /api/*       monitor API for the signed-in user
                                                           └─ /downloads/desktop/*  desktop releases (public)
                                                                │  service credential (API_TOKEN, server-side only)
                                                                ▼
                                                     127.0.0.1:80  esports-monitor (unchanged, collectors)
```

* One origin for the browser: cookies, the event stream and CSP need no CORS. Only the desktop app's origins
  (`tauri://localhost`, `http(s)://tauri.localhost`) get CORS, without credentials (it sends a Bearer session token).
* The monitor server (`esports-monitor`) and its collectors are not modified and were not restarted. The gateway is a
  separate service (`esportsdata-web`), separate user, separate database (`/var/lib/esportsdata-web/gateway.sqlite3`).

## Why a gateway, and what it enforces

The monitor server already has per-user keys and capabilities (`server/src/entitlements.js`). The browser must never
hold the server's `API_TOKEN`, and the customer's Access Key must become a revocable session. The gateway therefore:

1. turns an Access Key into a session (see AUTH-SESSION-DESIGN.md) — one active session per key;
2. calls the monitor server as its service account and applies the user's entitlements itself **with the server's
   own code**: `web/gateway/src/vendor/entitlements.js` is generated from `server/src/entitlements.js`
   (`web/gateway/scripts/vendor-entitlements.mjs`; a test fails on drift). `routeRequirement`/`routeProvider` gate the
   route, `filterForPrincipal` / `filterSsePayload` filter the payload. Users without restrictions and administrators
   get the server's bytes unchanged (gzip passes through). Places where the server shapes a response by principal
   outside those functions are handled explicitly: `/api/me` (answered by the gateway), `/health`, event history
   (bookmaker + odds/score rights per entry), admin user routes (self-lockout guard), and the feed stream;
3. scopes ETags per user (`-u<sig>`), so a 304 is never served across users;
4. multiplexes the realtime feed (below);
5. closes every stream of a session the moment it is revoked.

Unknown routes fall into the server's default rule (`admin.diagnostics`), i.e. closed for customers.

## Realtime feed (SSE)

The monitor server limits event streams per remote address (`API_SSE_LIMIT_PER_IP`, 24), and all traffic through
cloudflared arrives from 127.0.0.1. One upstream stream per browser would exhaust that budget shared with the
extension users. The gateway holds **one** upstream `/api/feed-stream` per LIVE odds provider (`FeedHub`), keeps the
latest `hello` current from later events, and fans each event out to its web clients, filtered per user and per
requested mode (wire bytes cached per entitlement signature, like the server does). Per-match streams
(`/api/statistics/stream`, `/api/pinnacle/live-stream`) are proxied per client, capped at 4 per session.
The gateway pings clients every 15 s; an upstream loss reconnects with backoff and a new `hello` makes every client
re-check revisions.

## Frontend: one UI, three builds

`extension/` (9.3.0) stays the source of the UI. `web/build.mjs` produces:

* `dist/web` — served by the gateway; API base = same origin; session = HttpOnly cookie;
* `dist/tauri` — bundled into the desktop app; API base = `https://esportsdata.online`; session = Bearer token.

The build copies the extension files, wraps `background.js` (the extension's feed engine: poll + SSE + notifications)
into page scope as `background-web.js`, swaps `server-config.js` for the web one, turns `app.html` into `index.html`
with the Access Key gate, and versions every script/style (`?v=<hash>`, served immutable). No bundler, no
minification, no source maps.

`web/platform/platform.js` supplies what the extension platform gave the UI: `chrome.storage` (IndexedDB with an
in-memory copy, shared between tabs through BroadcastChannel; big last-known snapshots stay per tab), runtime ports
and messages (the feed engine and the page talk exactly as before), alarms, notifications (Notification API; one tab
per profile shows them, via Web Locks; desktop: notification plugin), links/windows (`window.open`; desktop: opener
plugin and a webview window). It also owns the gate, session-loss handling and the Account/Sessions settings.
The shared UI code has three small hooks (`HOSTED` in `app-settings.js`/`app-admin.js`): «Подключение» becomes
«Аккаунт», administrators get «Сессии», and extension-only options (window mode, native link helper) are hidden.
The extension build is unaffected (no `Platform` there).

## Performance (9.3.0 gains kept)

Navigation still renders from memory; last-known snapshots load from IndexedDB for the first paint; History keeps its
progressive loading and windowing (measured: 700 rows loaded, ~150 mounted; production: first History rows ≈ 50–90 ms
after the tab click); request deduplication, logo cache and broken-logo memory are the same code. One feed stream per
page, one upstream feed per gateway. Idle pages poll only the tiny meta probe the extension already used.

## Files

| Path | Role |
|---|---|
| `web/gateway/src/server.js` | routing, static files, timers |
| `web/gateway/src/auth.js`, `sessions.js`, `db.js` | Access Key verification, sessions, schema |
| `web/gateway/src/keys.js` | Access Key mirror of the server's users, principals |
| `web/gateway/src/proxy.js`, `feed-hub.js` | API proxy with entitlements, SSE hub, stream registry |
| `web/gateway/src/admin.js` | `/auth/admin/*` |
| `web/gateway/src/security.js`, `log.js` | headers/CSP, origin checks, rate limits, client metadata, redacting logger |
| `web/platform/*`, `web/build.mjs` | platform layer, builds |
| `web/deploy/*` | systemd unit, env, install, rollback, `eds-admin` |
| `desktop/` | Tauri 2 app (TAURI-BUILD.md) |
