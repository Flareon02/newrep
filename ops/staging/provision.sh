#!/usr/bin/env bash
# One-time (idempotent) setup of the STAGING server: Ubuntu 24.04, run as root.
#
#   sudo bash provision.sh [--http-port 8080] [--profile prod|tight|relaxed] [--public-api] [--allow 443/tcp]...
#
# Firewall is an explicit allowlist: SSH always; the API port only with --public-api; anything else only via --allow.
#
# Creates: node 22, service user, directories, systemd service + health watchdog + journald limits, firewall (SSH stays
# open), and a staging-only API token in /etc/esports-monitor/server.env (never printed in full, never committed).
# It does NOT touch any production machine, production database or production secrets.
set -euo pipefail
[ "$(id -u)" = 0 ] || { echo "run as root" >&2; exit 1; }
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HTTP_PORT=8080; PROFILE=prod; PUBLIC_API=0; ALLOW=()
while [ $# -gt 0 ]; do case "$1" in --http-port) HTTP_PORT="$2"; shift 2;; --profile) PROFILE="$2"; shift 2;; --public-api) PUBLIC_API=1; shift;; --allow) ALLOW+=("$2"); shift 2;; *) echo "unknown option $1" >&2; exit 2;; esac; done

APP=/opt/esports-monitor; DATA=/var/lib/esports-monitor; ETC=/etc/esports-monitor; SOAK=/var/lib/esports-monitor-soak
log() { printf '\n==> %s\n' "$*"; }

. /etc/os-release
[ "${ID:-}" = ubuntu ] || echo "warning: tested on Ubuntu 24.04, found ${PRETTY_NAME:-unknown}" >&2

log "1/8 packages"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq ca-certificates curl ufw jq sqlite3 tar xz-utils git unzip logrotate >/dev/null

log "2/8 Node.js 22 (official tarball, checksum verified)"
need_node=1
if command -v node >/dev/null 2>&1 && node -e 'process.exit(Number(process.versions.node.split(".")[0])>=22?0:1)'; then need_node=0; fi
if [ "$need_node" = 1 ]; then
  case "$(uname -m)" in x86_64) arch=x64;; aarch64) arch=arm64;; *) echo "unsupported arch $(uname -m)" >&2; exit 1;; esac
  base=https://nodejs.org/dist/latest-v22.x
  tmp="$(mktemp -d)"; curl -fsSL "$base/SHASUMS256.txt" -o "$tmp/SHASUMS256.txt"
  file="$(grep -o "node-v22[0-9.]*-linux-$arch.tar.xz" "$tmp/SHASUMS256.txt" | head -n1)"
  curl -fsSL "$base/$file" -o "$tmp/$file"
  (cd "$tmp" && grep " $file\$" SHASUMS256.txt | sha256sum -c -)
  rm -rf /opt/node22 && mkdir -p /opt/node22 && tar -xJf "$tmp/$file" -C /opt/node22 --strip-components=1
  ln -sf /opt/node22/bin/node /usr/local/bin/node; ln -sf /opt/node22/bin/npm /usr/local/bin/npm; ln -sf /opt/node22/bin/npx /usr/local/bin/npx
  rm -rf "$tmp"
fi
node --version; npm --version

log "3/8 service user and directories"
id monitor >/dev/null 2>&1 || useradd --system --home-dir "$DATA" --shell /usr/sbin/nologin monitor
install -d -o root -g root -m 0755 "$APP" "$APP/releases"
install -d -o monitor -g monitor -m 0750 "$DATA" "$DATA/data"
install -d -o root -g monitor -m 0750 "$ETC"
install -d -o root -g root -m 0755 "$SOAK"

log "4/8 staging environment and token"
if [ ! -f "$ETC/server.env" ]; then
  token="$(openssl rand -hex 24)"
  umask 077
  cat > "$ETC/server.env" <<ENV
# STAGING ONLY. Overrides the settings derived from docker-compose.yml. Never commit this file.
PORT=$HTTP_PORT
DATA_DIR=$DATA/data
API_TOKEN=$token
LOG_LEVEL=info
ENV
  chown root:monitor "$ETC/server.env"; chmod 0640 "$ETC/server.env"
  echo "created $ETC/server.env (token ${token:0:4}…${token: -4}, $(( ${#token} )) chars; read it from that file, do not paste it anywhere public)"
else
  echo "keeping existing $ETC/server.env"
fi

log "5/8 systemd units"
install -m 0644 "$HERE/esports-monitor.service" /etc/systemd/system/esports-monitor.service
install -m 0644 "$HERE/esports-monitor-health.service" /etc/systemd/system/esports-monitor-health.service
install -m 0644 "$HERE/esports-monitor-health.timer" /etc/systemd/system/esports-monitor-health.timer
install -m 0644 "$HERE/esports-monitor-soak.service" /etc/systemd/system/esports-monitor-soak.service
install -m 0755 "$HERE/health-watch.sh" /usr/local/bin/esports-monitor-health-watch
install -m 0755 "$HERE/profile.sh" /usr/local/bin/esports-monitor-profile
install -m 0755 "$HERE/deploy.sh" /usr/local/bin/esports-monitor-deploy
install -m 0755 "$HERE/rollback.sh" /usr/local/bin/esports-monitor-rollback
install -m 0755 "$HERE/compose-env.py" /usr/local/lib/esports-monitor-compose-env.py
/usr/local/bin/esports-monitor-profile "$PROFILE" --no-restart
install -d /etc/systemd/journald.conf.d
cat > /etc/systemd/journald.conf.d/esports-monitor.conf <<'J'
# Log rotation: the service logs to journald. Cap the journal so logs can never fill the disk.
[Journal]
SystemMaxUse=200M
SystemMaxFileSize=20M
MaxRetentionSec=14day
RateLimitIntervalSec=30s
RateLimitBurst=2000
J
systemctl restart systemd-journald
systemctl daemon-reload
systemctl enable esports-monitor.service esports-monitor-health.timer >/dev/null

log "6/8 firewall (SSH is allowed BEFORE the firewall is enabled)"
ssh_ports="$(ss -Htlnp 2>/dev/null | awk '/sshd/ {n=split($4,a,":"); print a[n]}' | sort -u)"
[ -n "$ssh_ports" ] || ssh_ports=22
for p in $ssh_ports; do ufw allow "$p/tcp" >/dev/null; echo "allowed ssh on $p/tcp"; done
[ "$PUBLIC_API" = 1 ] && ufw allow "$HTTP_PORT/tcp" >/dev/null
for r in "${ALLOW[@]}"; do ufw allow "$r" >/dev/null; echo "allowed $r"; done
ufw default deny incoming >/dev/null; ufw default allow outgoing >/dev/null
ufw --force enable >/dev/null
ufw status | sed 's/^/   /'

log "7/8 nothing is deployed yet"
echo "deploy with: esports-monitor-deploy --tar /path/to/release.tar.gz   (see ops/staging/README.md)"
log "8/8 done"
