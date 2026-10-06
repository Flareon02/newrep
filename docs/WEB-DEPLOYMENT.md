# Web deployment

## Layout on the server

| What | Where |
|---|---|
| service | `esportsdata-web.service` (user `esportsdata-web`, no shell, no home), 127.0.0.1:8090 |
| releases | `/opt/esportsdata-web/releases/<commit>/` (gateway + `dist/web`), `/opt/esportsdata-web/current` → active |
| configuration | `/etc/esportsdata-web/gateway.env` (no secrets) |
| server API token | `/etc/esportsdata-web/upstream-token` (root, 600) → systemd `LoadCredential=` → `$CREDENTIALS_DIRECTORY/upstream-token`; never in the environment, the command line, logs or the frontend |
| data | `/var/lib/esportsdata-web/gateway.sqlite3` (700/600) — sessions, key mirror, audit |
| desktop releases | `/var/lib/esportsdata-web/downloads/desktop/` → `https://esportsdata.online/downloads/desktop/…` |
| checkpoints | `/var/backups/esportsdata-web/checkpoint-<UTC stamp>/` |
| operator CLI | `/usr/local/sbin/eds-admin` |

Hardening: `ProtectSystem=strict`, `ProtectHome`, `PrivateTmp`, `PrivateDevices`, `NoNewPrivileges`, empty capability
set, `RestrictAddressFamilies`, `MemoryMax=384M`, `CPUQuota=50%` (`systemd-analyze security`: 3.0 OK). Typical RSS
≈ 20–60 MB.

## Deploy (root, from a committed checkout)

```
cd /root/newrep-web-tauri && git pull
web/deploy/install.sh
```
`install.sh`: refuses a dirty tree → writes a checkpoint (previous release, gateway DB backup, the monitor server's
`users.json`, esports-monitor PID) → creates user/dirs/env/credential (credential copied from
`/etc/esports-monitor/server.env`, never printed) → checks the vendored entitlements → builds `dist/web` → runs the
bundle check against the real API token → copies the release → switches `current` atomically → installs the unit and
`eds-admin` → restarts **only** `esportsdata-web` → waits for `/healthz`. Sessions survive restarts (database);
browsers reconnect their stream automatically.

First deployment only: `eds-admin bootstrap-admin` (see ADMIN-SESSION-MANAGEMENT.md).

## Cloudflare route

The tunnel is remotely managed (token in `/etc/cloudflared/token`); its ingress is edited in the Cloudflare dashboard:
Zero Trust → Networks → Tunnels → the existing tunnel → Public Hostname → add `esportsdata.online` → service
`http://localhost:8090`. This creates the proxied DNS record. `api.esportsdata.online → http://localhost:80` stays.
No change on the server is needed; cloudflared picks the new rule up live.

## Desktop release files

Download `manifest.json`, `latest.json`, `EsportsData-Desktop-Windows-x64.zip`, `…-setup.exe(.sig)` from the GitHub
release `desktop-v<version>` into `/var/lib/esportsdata-web/downloads/desktop/` (owner esportsdata-web), verify
`SHA256SUMS.txt`. Settings → Аккаунт then shows the download (version, date, size, SHA-256). See TAURI-BUILD.md.

## Checks

```
curl -s http://127.0.0.1:8090/healthz                 # gateway, key mirror age, streams, upstream feed
journalctl -u esportsdata-web -n 50                     # no keys/tokens ever logged (redacting logger)
cd web/gateway && npm test                              # 27 gateway tests
node web/build.mjs && node web/test/web-e2e.mjs         # 19 browser tests (mock data)
node web/test/prod-acceptance.mjs                       # 17 read-only production checks (temporary test keys)
```
`prod-acceptance.mjs` maps esportsdata.online to a local TLS terminator in Chromium, so it also works before DNS.
It creates two "Acceptance web test" keys through the admin API and deletes them at the end.
