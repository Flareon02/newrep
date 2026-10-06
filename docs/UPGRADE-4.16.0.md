# Upgrade to server 4.16.0 + extension 9.4.0

## Server (systemd layout: /opt/esports-monitor/releases + current symlink)

Copy `Esports-Monitor-server-4.16.0.zip` to the server (Termius → SFTP, into `/root`). Then in the Termius terminal:

```sh
cd /root
sha256sum Esports-Monitor-server-4.16.0.zip          # must equal the published SHA256
rm -rf astek-monitor-server-v4.16.0 && unzip -q Esports-Monitor-server-4.16.0.zip
cd astek-monitor-server-v4.16.0
sudo sh ./upgrade-systemd.sh                          # prints root/unit, asks "upgrade", then:
#   syntax check → backup (users/leagues/settings + online SQLite copy if there is room) → new release dir
#   → switch `current` → restart esports-monitor only → health check (version + LIVE) → automatic rollback on failure
```

Options: `--no-db-backup` (skip the 1 GB SQLite copy; 4.16.0 does not change the monitor DB schema), `--yes` (no
question). cloudflared, the GGBET browser worker and the web gateway are not restarted.

Check afterwards:

```sh
curl -s http://127.0.0.1:$(sed -n 's/^PORT=//p' /etc/esports-monitor/server.env)/health   # "version":"4.16.0"
journalctl -u esports-monitor --since "5 min ago" --no-pager | grep -iE "error|warn" | tail -20
```

## Rollback

```sh
sudo sh /opt/esports-monitor/current/server/rollback-systemd.sh     # shows from/to, asks "rollback"
# or to a named release:
sudo sh /opt/esports-monitor/current/server/rollback-systemd.sh --yes /opt/esports-monitor/releases/d274d30
```

No data restore is needed: 4.16.0 only adds `user-settings.sqlite3` (ignored by 4.15.x) and optional JSON fields in new
journal rows. The backup made by the upgrade is in `/var/backups/esports-monitor/<UTC stamp>/`.

## Docker installations

`upgrade.sh` / `rollback.sh` in the ZIP are unchanged and work as before.

## Extension

Unpack `Esports-Monitor-extension-9.4.0.zip`, then in Chrome/Edge: `chrome://extensions` → «Загрузить распакованное»
(or replace the folder of the installed unpacked extension and press «Обновить»). Settings are kept: on the first start
the existing local settings become the profile of the user whose key is configured.

## Web / desktop

The shared UI changed (Timeline tab, comparison grid, responsive layout). Rebuild with `node web/build.mjs` and deploy
with the existing web procedure when wanted; the gateway forwards `/api/me/settings` and the timeline routes on behalf of
the signed-in user (gateway update needed for per-user settings on the web).
