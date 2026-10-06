# Security review — web gateway, web app, desktop app

Scope: `web/gateway`, `web/platform`, `web/build.mjs`, `desktop/`, `.github/workflows/tauri-windows.yml`, deployment.
Each item: control → evidence (automated test unless noted).

| # | Requirement | Control | Evidence |
|---|---|---|---|
| 1 | Access Key never stored | sent once to `/auth/verify`, compared by the monitor server; gateway keeps last 4 chars only; gate clears the field | `gateway-auth` "key is never stored or logged" (DB files scanned for the raw key); web E2E "key is not kept anywhere in the page storage" |
| 2 | Access Key / token never logged | no logging of bodies, headers or queries; logger masks `emu_…`, `eds_…`, `Bearer …`, cookie values as a last line of defence | same test scans all gateway logs for key, token and API token |
| 3 | `API_TOKEN` never in the browser | only the gateway holds it (systemd credential); `/auth/verify` refuses it as a key; frontend has no token setting | `check-bundle.mjs --secret-file` against the real token (deploy + this review): PASS; upstream only sees the service token (`gateway-proxy`) |
| 4 | No secrets in JS / source maps | no bundler, no maps; bundle scan for keys, tokens, Bearer literals, `API_TOKEN=` and `sourceMappingURL` | `check-bundle.mjs` (web + tauri), CI step "Frontend security check" |
| 5 | No auth in URL / query / Referer | cookie or Authorization header only; query tokens ignored; `Referrer-Policy: no-referrer` | `gateway-auth` "NO AUTH IN URL"; headers test |
| 6 | Session token | 256-bit random, opaque, SHA-256 at rest | `sessions.js`; DB scan test |
| 7 | Cookie flags | `__Host-` prefix, `Secure`, `HttpOnly`, `SameSite=Lax`, `Path=/` | `gateway-auth` (flags), production acceptance (Chromium cookie jar: httpOnly, secure, Lax, 30+ days) |
| 8 | One key = one session, race-free | partial unique index + `BEGIN IMMEDIATE` | "RACE" test (12 parallel sign-ins), direct INSERT refused by the index |
| 9 | Revocation is immediate | DB lookup on every request; streams closed on revoke; client returns to gate | kick/revoke tests; production: kick ≈ 1 s, admin revoke ≈ 3 s |
| 10 | Rate limiting | sign-in: 10 failures / 15 min per network (CF-Connecting-IP), 120 attempts/min global, delay on failure; API: 1200 req/min per session; 4 detail streams per session | "RATE LIMIT" test |
| 11 | CSRF | Origin must be the site (or desktop app) for every state change; SameSite=Lax | logout/admin cross-origin tests (403) |
| 12 | CSP | `default-src 'self'; script-src 'self'` (no inline script), `connect-src 'self'`, images self + 4 logo CDNs, `frame-ancestors 'none'`, `object-src 'none'`, `base-uri 'none'`; desktop CSP equivalent with `https://esportsdata.online` | headers test; desktop CSP in `tauri.conf.json` |
| 13 | Clickjacking | `frame-ancestors 'none'` + `X-Frame-Options: DENY` | headers test |
| 14 | XSS | UI is the reviewed 9.3.0 code (escapes all data with `esc()`); new UI (gate, account, sessions) escapes every value (`escText`); CSP blocks inline/external scripts | review |
| 15 | Session fixation | new token at every sign-in; a planted cookie is replaced; previous session of another key revoked | "SESSION FIXATION" test |
| 16 | Replay | copied token dies at logout/revoke/expiry | logout test (replayed cookie → 401) |
| 17 | Entitlements | server's own `entitlements.js` (vendored, drift-tested); restricted output equals the server's own answer for that user | `gateway-proxy` parity test; production: restricted test key had no Pinnacle refs and History 403 |
| 18 | Admin separation | admin routes need an administrator-role key; customer keys with admin capabilities still 403; bootstrap key written to a root-only file; self-lockout prevented | "ADMIN" test; bootstrap CLI |
| 19 | Path traversal | normalized paths, dot-segments refused, root-prefix check | headers test (`/../`, `%2e%2e`) |
| 20 | Information leaks | generic invalid-key message; upstream diagnostics scrubbed for non-admins; upstream 401 never reaches clients as a session error | tests |
| 21 | Service isolation | own user, `ProtectSystem=strict`, no capabilities, memory/CPU caps; loopback only | `systemd-analyze security` 3.0 OK |
| 22 | Desktop binary | no key/token/API token/GitHub token/private key/dev endpoint; production origin enforced at build; updates signed (minisign) and verified before install; private key only in GitHub secrets + root-only backup | CI "Release security check", "Smoke test"; TAURI-BUILD.md |
| 23 | CI logs | secrets only in the build step env, masked by Actions; nothing echoes them; checkout without persisted credentials | workflow review |
| 24 | Public repository | the 54 commits pushed with this branch were scanned for the real API token, proxy credentials, relay secret, user key hashes, `emu_` keys, GitHub tokens and private keys before pushing: none found | manual check (2026-10-06) |

## Residual risks / notes

* **Extension keys** are still used directly by the browser extension (not sessions); one-session does not apply there.
* **Logout of other browser tabs** of the same profile happens at their next request or within 60 s (session check).
* **Desktop token** is stored in the WebView2 profile of the Windows user (like a browser cookie jar); a local
  attacker with that user's rights can copy it — revocation ends it.
* **Authenticode**: the Windows binaries are not code-signed; SmartScreen and some antivirus products (e.g. Trellix)
  rate unsigned new binaries by reputation. Recommended: an OV/EV code-signing certificate (or Azure Trusted Signing)
  added to the workflow; this does not change the updater signature.
* **Network metadata** is truncated (/24, /48) and only shown to administrators.
