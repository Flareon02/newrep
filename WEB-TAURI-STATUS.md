# Web / Tauri — work status (2026-10-06)

Branch `web-tauri-app` (worktree /root/newrep-web-tauri), based on extension 9.3.0 (19b2cc6). Nothing deployed; production collectors untouched.

## Done
- `web/gateway/` — same-origin gateway for https://esportsdata.online: `/auth/verify|session|logout`, `/auth/admin/*`,
  entitlement-enforcing `/api/*` proxy (server's own `entitlements.js`, vendored + drift test), multiplexed SSE (one
  upstream stream; the backend limits SSE per IP and cloudflared traffic is all 127.0.0.1), SQLite sessions
  (SHA-256 token hashes, partial unique index = one active session per Access Key, BEGIN IMMEDIATE), 30-day rolling /
  90-day absolute (admin 7-day) lifetime, immediate stream close on revoke, audit log, rate limits, CSP/headers.
  Access Key = existing server user key (`emu_…`), verified via backend `/api/me`, never stored.
- `web/platform/` + `web/build.mjs` — 9.3.0 UI unchanged plus a platform layer (chrome.* shim, gate, session-loss
  handling, Account and admin «Сессии» settings). Builds `dist/web` and `dist/tauri`.
- `web/scripts/check-bundle.mjs` — no keys/tokens/API token/source maps/localhost (passes against the real API token).
- Tests: `cd web/gateway && npm test` → 25/25; `node web/build.mjs && node web/test/web-e2e.mjs` → 19/19 (Chromium).

## Left
1. Tauri 2 project (`desktop/`) + `.github/workflows/tauri-windows.yml` (windows-latest, `tauri build --no-bundle`,
   portable ZIP, SHA256, manifest, CDP smoke test). Not started.
2. Deployment: systemd unit `esportsdata-web` (127.0.0.1:8090, LoadCredential=upstream-token copied from the server
   API_TOKEN), DATA_DIR /var/lib/esportsdata-web, `eds-admin bootstrap-admin` to create the admin key (written to a
   root-only file).
3. Docs: WEB-ARCHITECTURE, AUTH-SESSION-DESIGN, ADMIN-SESSION-MANAGEMENT, WEB-DEPLOYMENT, WEB-ROLLBACK, TAURI-BUILD,
   SECURITY-REVIEW.
4. External: the Cloudflare tunnel has no route for `esportsdata.online` (tunnel is dashboard-managed; DNS does not
   resolve). Needed: Zero Trust → Tunnels → this tunnel → Public Hostname → `esportsdata.online` → `http://localhost:8090`.
   GitHub push is not possible from this server (no credentials), which blocks the CI Tauri build.
