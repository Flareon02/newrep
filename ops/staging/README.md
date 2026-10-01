# Staging server kit (Ubuntu 24.04, 1 vCPU, 2 GB)

Everything here is for the **staging** VPS only. It never references production hosts, data or secrets.

| File | Purpose |
|---|---|
| `provision.sh` | One-time idempotent setup: Node 22, user `monitor`, directories, systemd units, journald limits (200 MB), firewall (SSH first), staging `API_TOKEN` |
| `esports-monitor.service` | systemd unit: `Restart=always`, sandboxing that mirrors the container (`ProtectSystem=strict`, no capabilities, `TasksMax=128`) |
| `profile.sh` | Resource profile of the service cgroup: `prod` (768M, no swap), `tight` (640M), `relaxed`. Limits only the service, never the VM or sshd |
| `port.sh` | Makes the unit match `PORT` in `server.env`: for a port < 1024 (e.g. 80) it adds a drop-in granting only `CAP_NET_BIND_SERVICE`, otherwise removes it. Run `sudo esports-monitor-port` after changing `PORT` |
| `ggbet-relay.sh` | `esports-monitor-ggbet-relay <bundle>`: stores the relay secret/CA in `/etc/esports-monitor` (outside the repo) and sets `GGBET_BOOTSTRAP_RELAY_*` in `server.env`. Without it GGBET runs in direct mode, which is geo-blocked from this host |
| `deploy.sh` / `rollback.sh` | Release directories + `current` symlink, `npm ci`, health gate, automatic rollback to the previous release |
| `health-watch.sh` + timer | Restarts the service after 3 failed `/health` checks (hangs); crashes are handled by systemd |
| `esports-monitor-soak.service` | Runs `tools/soak-sampler.mjs` every minute -> `/var/lib/esports-monitor-soak/samples.jsonl` |
| `compose-env.py` | Derives the service environment from the release's own `docker-compose.yml`, so staging runs production settings |

## Install

```sh
# on your machine / CI: package the commit to test
git archive --format=tar.gz -o release.tar.gz refactor/production-hardening server tools
scp release.tar.gz ops/staging/* root@STAGING:/root/stage/      # or any other way to get the files there
# on staging
cd /root/stage && sudo bash provision.sh --profile prod            # add --http-port 80 --public-api when only 80/443 are reachable
sudo esports-monitor-deploy --tar /root/stage/release.tar.gz
sudo systemctl enable --now esports-monitor-soak
```

The listening port lives only in `/etc/esports-monitor/server.env` (`PORT=`); deploy, health-watch and the soak sampler read it from there.
To move it: edit `PORT`, run `sudo esports-monitor-port` (restarts the service), then open the new port with `ufw allow <port>/tcp` and close the old one.

## Everyday commands

```sh
systemctl status esports-monitor          journalctl -u esports-monitor -f
sudo esports-monitor-profile tight        # apply 640 MB limit, restarts the service
sudo esports-monitor-rollback             # previous release
curl -s localhost:8080/health | jq '{version,runtime:{rss:.runtime.rssMiB,history:.runtime.history,storage:.runtime.storage}}'
node /opt/esports-monitor/current/tools/feed-report.mjs                      # which real sources work
node /opt/esports-monitor/current/tools/soak-report.mjs /var/lib/esports-monitor-soak/samples.jsonl
STAGING_TOKEN=$(sed -n 's/^API_TOKEN=//p' /etc/esports-monitor/server.env) node /opt/esports-monitor/current/tools/staging-auth-check.mjs
```

The staging token lives only in `/etc/esports-monitor/server.env` (mode 0640, root:monitor). The private extension build
(`tools/build-staging-extension.mjs`) reads it from there and writes into `dist/`, which is git-ignored.
