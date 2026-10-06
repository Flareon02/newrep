# Web / Tauri — status (2026-10-06)

Branch `web-tauri-app` (pushed to GitHub), based on extension 9.3.0 (19b2cc6, frozen worktree untouched).

| Area | State |
|---|---|
| Web gateway | deployed: `esportsdata-web.service`, 127.0.0.1:8090, release in `/opt/esportsdata-web/current` |
| Public URL | waits for the Cloudflare tunnel hostname `esportsdata.online → http://localhost:8090` (only external step) |
| Tests | gateway 27/27 · browser E2E 19/19 · production acceptance 17/17 (real backend, temporary test keys, cleaned up) |
| Desktop | Tauri 2 Windows x64 1.0.0 built by CI run 37403037546, smoke 4/4, published as `desktop-v1.0.0` + channel `desktop-stable`, served at `/downloads/desktop/` |
| Admin | administrator key created (`/root/esportsdata-admin-key.txt`, root 600) |
| Updater key | GitHub secrets + `/root/esportsdata-desktop-updater.key/.password` (root 600) |
| Collectors | unchanged, not restarted (esports-monitor PID 708) |

Docs: `docs/WEB-ARCHITECTURE.md`, `AUTH-SESSION-DESIGN.md`, `ADMIN-SESSION-MANAGEMENT.md`, `WEB-DEPLOYMENT.md`,
`WEB-ROLLBACK.md`, `TAURI-BUILD.md`, `SECURITY-REVIEW.md`.
