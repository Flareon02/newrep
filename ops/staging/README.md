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
| `ggbet-egress.sh` | `esports-monitor-ggbet-egress discover\|select <name.conf>\|status\|down`: ONE operator-chosen Mullvad WireGuard config as an isolated GGBET egress (namespace `ggbet-egress`, CONNECT proxy on a Unix socket, transient unit `esports-monitor-ggbet-egress`). The service uses it with `GGBET_NETWORK_MODE=netns`. Host route untouched; config contents never printed |
| `esports-monitor-ggbet-egressd.service` (tools/ggbet-egressd.mjs) | root egress controller: keeps ONE Mullvad config as the GGBET egress (preferred `ggbet-good.conf`), checks transport health every 30 s; only on transport failure: re-establish once, then cooldown + next config (max 3 switches/h), last resort = the HTTP proxy (`CZECH_PROXY_*`, still configured). Candidates are verified before the service sees them. Pool state: `/var/lib/esports-monitor-ggbet/pool.json` |
| `esports-monitor-ggbet` (tools/ggbet-cli.mjs) | read-only GGBET diagnostics: `status`, `vpns`, `sessions`, `history`, `switches`, `qualification`, `incidents [id]`, `tail`, `--json`; `select <name.conf>` = manual egress change |
| `compose-env.py` | Derives the service environment from the release's own `docker-compose.yml`, so staging runs production settings |

## Behind Cloudflare Tunnel (current staging)

The public API is `https://api.esportsdata.online` (Cloudflare Tunnel, `cloudflared` -> `http://127.0.0.1:80`). The service
listens on loopback only (`HOST=127.0.0.1` in `server.env`) and the firewall allows inbound SSH only; nothing reaches the
origin directly. Health checks, deploy and the soak sampler already use `127.0.0.1`.

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


### GGBET Firefox sidecar / hybrid release 4.13.0

Install the committed sidecar with `ops/staging/ggbet-browser-install.sh <commit>`; it creates the system group `esports-ggbet-browser` for `ggbetfx` and `monitor`, installs an immutable release, and restarts only the browser service. Firefox is headless, with a hard maximum of 3 LIVE match tabs and one discovery tab. The controller only reads Firefox/BiDi and local IPC; it does not issue GG.BET HTTP/WS/GraphQL requests.

Before server cutover verify the Zagreb exit and `ggbet-browser-netns.sh leaktest`, back up `/etc/esports-monitor/server.env` with mode 0600, and verify monitor can read `/run/ggbet-browser/data.sock`. Deploy the tested server commit with `GGBET_BROWSER_SOURCE=1`, `GGBET_NETWORK_MODE=proxy` and the existing Czech proxy credentials. The restarted server picks up its shared group membership despite ProtectSystem=strict. After cutover stop/disable the separate Node egress controller; leave cloudflared running. Verify bootstrap and WS use the Czech proxy, browser data comes from Firefox in Zagreb, and host routing is unchanged. Roll back to 4c6a5e3 with browser authority disabled and Node still on Czech proxy.
