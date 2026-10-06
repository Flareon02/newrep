# Web rollback

The web gateway is independent of the monitor server: rolling it back never touches `esports-monitor`, its
collectors, `cloudflared` or the API route `api.esportsdata.online`.

## Procedures

**Previous web release** (keeps sessions):
```
/root/newrep-web-tauri/web/deploy/rollback.sh /var/backups/esportsdata-web/checkpoint-<stamp>
```
switches `/opt/esportsdata-web/current` back and restarts `esportsdata-web`. With `--restore-sessions` it also
restores the gateway database from the checkpoint (sessions created since then are lost — users sign in again).

**Take the website offline** (first deployment's checkpoint has `previous-release = none`; the same script then
stops and disables the service):
```
systemctl disable --now esportsdata-web
```
The Cloudflare hostname then answers 502; nothing else changes. The extension keeps working through
`api.esportsdata.online`.

**Remove completely**: disable the service, remove `/etc/systemd/system/esportsdata-web.service`,
`/opt/esportsdata-web`, `/var/lib/esportsdata-web`, `/etc/esportsdata-web`, `/usr/local/sbin/eds-admin`,
user `esportsdata-web`; remove the `esportsdata.online` public hostname in the Cloudflare tunnel.

**Administrator key created by bootstrap**: it is a normal user of the monitor server («Оператор (web admin)»);
delete it in Settings → Пользователи or restore `monitor-users.json` from the checkpoint (that needs an
esports-monitor restart and is not normally required).

**Emergency: end all web sessions** without stopping the site:
```
sqlite3 /var/lib/esportsdata-web/gateway.sqlite3 "UPDATE sessions SET revoked_at=strftime('%s','now')*1000, revoke_reason='admin' WHERE revoked_at IS NULL"
```
(open streams close within 15 s).

## Checkpoint of the first deployment

`/var/backups/esportsdata-web/checkpoint-20261006T013929Z/` — previous release `none`, monitor `users.json` before
the administrator key was added, esports-monitor PID 708 (unchanged after deployment).

## Desktop

A bad desktop release: publish a new higher version (updates only move forward); point
`/downloads/desktop/latest.json` and the `desktop-stable` GitHub release back to the previous version's
`latest.json` to stop further updates. Portable ZIPs of every version stay on their `desktop-v*` releases.
