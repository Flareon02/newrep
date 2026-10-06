#!/bin/bash
# Deploys the web gateway from a checkout (run as root): builds dist/web, copies a release to
# /opt/esportsdata-web/releases/<commit>, switches /opt/esportsdata-web/current, (re)starts esportsdata-web only.
# Never touches esports-monitor, cloudflared or any collector service. Rollback: web/deploy/rollback.sh.
#   web/deploy/install.sh [--no-restart]
set -euo pipefail
SRC=$(cd "$(dirname "$0")/../.." && pwd)
COMMIT=$(git -C "$SRC" rev-parse --short=10 HEAD)
[ -z "$(git -C "$SRC" status --porcelain -- web extension)" ] || { echo "working tree has uncommitted web/extension changes; commit first"; exit 1; }
ROOT=/opt/esportsdata-web REL=$ROOT/releases/$COMMIT
STAMP=$(date -u +%Y%m%dT%H%M%SZ)
CHECK=/var/backups/esportsdata-web/checkpoint-$STAMP
install -d -m 0700 /var/backups/esportsdata-web "$CHECK"
# Checkpoint: what the web deploy can change, plus the monitor server's user list (bootstrap-admin adds a user).
{ readlink -f $ROOT/current 2>/dev/null || echo none; } > "$CHECK/previous-release"
systemctl is-active esportsdata-web > "$CHECK/service-state" 2>&1 || true
[ -f /var/lib/esportsdata-web/gateway.sqlite3 ] && sqlite3 /var/lib/esportsdata-web/gateway.sqlite3 ".backup '$CHECK/gateway.sqlite3'" 2>/dev/null || cp -a /var/lib/esportsdata-web/gateway.sqlite3 "$CHECK/" 2>/dev/null || true
cp -a /var/lib/esports-monitor/data/users.json "$CHECK/monitor-users.json" 2>/dev/null || true
systemctl show esports-monitor -p MainPID -p ActiveEnterTimestamp > "$CHECK/esports-monitor.state"
echo "$COMMIT" > "$CHECK/deploying"
echo "checkpoint: $CHECK"

id esportsdata-web >/dev/null 2>&1 || useradd --system --no-create-home --home-dir /nonexistent --shell /usr/sbin/nologin esportsdata-web
install -d -m 0755 $ROOT $ROOT/releases
install -d -m 0700 -o esportsdata-web -g esportsdata-web /var/lib/esportsdata-web
install -d -m 0755 -o esportsdata-web -g esportsdata-web /var/lib/esportsdata-web/downloads /var/lib/esportsdata-web/downloads/desktop
install -d -m 0750 /etc/esportsdata-web
[ -f /etc/esportsdata-web/gateway.env ] || install -m 0644 "$SRC/web/deploy/gateway.env" /etc/esportsdata-web/gateway.env
if [ ! -s /etc/esportsdata-web/upstream-token ]; then
  # Copied from the monitor server's own configuration, never printed.
  ( umask 077; grep -E '^API_TOKEN=' /etc/esports-monitor/server.env | head -1 | cut -d= -f2- | sed -E "s/^['\"]//; s/['\"]$//" | tr -d '\n' > /etc/esportsdata-web/upstream-token )
  [ -s /etc/esportsdata-web/upstream-token ] || { echo "API_TOKEN not found"; exit 1; }
fi
chmod 0600 /etc/esportsdata-web/upstream-token

node "$SRC/web/gateway/scripts/vendor-entitlements.mjs" --check
node "$SRC/web/build.mjs" --out "$SRC/dist/web" >/dev/null
node "$SRC/web/scripts/check-bundle.mjs" "$SRC/dist/web" --secret-file /etc/esportsdata-web/upstream-token
rm -rf "$REL.tmp"; install -d "$REL.tmp/web" "$REL.tmp/dist" "$REL.tmp/docs"
cp -a "$SRC/web/gateway" "$REL.tmp/web/gateway"
cp -a "$SRC/dist/web" "$REL.tmp/dist/web"
cp -a "$SRC"/docs/WEB-*.md "$SRC"/docs/AUTH-SESSION-DESIGN.md "$SRC"/docs/ADMIN-SESSION-MANAGEMENT.md "$SRC"/docs/SECURITY-REVIEW.md "$REL.tmp/docs/" 2>/dev/null || true
echo "$COMMIT" > "$REL.tmp/COMMIT"
chmod -R a+rX "$REL.tmp"
rm -rf "$REL"; mv "$REL.tmp" "$REL"
ln -sfn "$REL" $ROOT/current.new && mv -T $ROOT/current.new $ROOT/current
install -m 0644 "$SRC/web/deploy/esportsdata-web.service" /etc/systemd/system/esportsdata-web.service
install -m 0755 "$SRC/web/deploy/eds-admin" /usr/local/sbin/eds-admin
systemctl daemon-reload
systemctl enable esportsdata-web >/dev/null 2>&1
if [ "${1:-}" != "--no-restart" ]; then systemctl restart esportsdata-web; fi
for i in $(seq 1 20); do curl -fsS http://127.0.0.1:8090/healthz >/dev/null 2>&1 && break; sleep 0.5; done
curl -fsS http://127.0.0.1:8090/healthz; echo
echo "deployed $COMMIT; rollback: $SRC/web/deploy/rollback.sh $CHECK"
