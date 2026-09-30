#!/usr/bin/env bash
# Deploy a release tarball (server/ and tools/ of the repository) with automatic rollback.
#
#   esports-monitor-deploy --tar /root/release.tar.gz [--id name]
#
# Steps: unpack to releases/<id> -> npm ci -> derive compose.env -> switch `current` -> restart -> wait for a healthy
# /health of the expected version -> otherwise switch back to the previous release and restart it.
# The database in /var/lib/esports-monitor/data is shared between releases (schema changes are additive).
set -euo pipefail
APP=/opt/esports-monitor; TAR=""; ID=""
while [ $# -gt 0 ]; do case "$1" in --tar) TAR="$2"; shift 2;; --id) ID="$2"; shift 2;; *) echo "unknown option $1" >&2; exit 2;; esac; done
[ -f "$TAR" ] || { echo "--tar <file> required" >&2; exit 2; }
ID="${ID:-$(date -u +%Y%m%d-%H%M%S)}"; REL="$APP/releases/$ID"
[ ! -e "$REL" ] || { echo "release $ID already exists" >&2; exit 1; }
PORT="$(grep -E '^PORT=' /etc/esports-monitor/server.env | tail -n1 | cut -d= -f2)"; PORT="${PORT:-8080}"
touch /run/esports-monitor-deploying; trap 'rm -f /run/esports-monitor-deploying' EXIT

mkdir -p "$REL"; tar -xzf "$TAR" -C "$REL"
[ -f "$REL/server/package.json" ] || { echo "tarball must contain server/package.json" >&2; rm -rf "$REL"; exit 1; }
(cd "$REL/server" && npm ci --omit=dev --no-audit --no-fund >/dev/null)
VERSION="$(node -p "require('$REL/server/package.json').version")"
python3 /usr/local/lib/esports-monitor-compose-env.py "$REL/server/docker-compose.yml" > /etc/esports-monitor/compose.env
chown -R root:root "$REL"

PREV=""; [ -L "$APP/current" ] && PREV="$(readlink -f "$APP/current")"
ln -sfn "$REL" "$APP/current.new" && mv -T "$APP/current.new" "$APP/current"
[ -n "$PREV" ] && echo "$PREV" > "$APP/previous"
systemctl restart esports-monitor.service

ok=0
for _ in $(seq 1 45); do
  sleep 2
  h="$(curl -fsS --max-time 5 "http://127.0.0.1:$PORT/health" 2>/dev/null || true)"
  if [ -n "$h" ] && [ "$(echo "$h" | jq -r '.ok')" = true ] && [ "$(echo "$h" | jq -r '.version')" = "$VERSION" ] && [ "$(echo "$h" | jq -r '.runtime.storage.integrity')" != failed ]; then ok=1; break; fi
done
if [ "$ok" = 1 ]; then
  echo "deployed $ID (server $VERSION)"; echo "$ID" > "$APP/current.id"
  # keep the 5 newest releases, never the current or previous one
  ls -1dt "$APP"/releases/* | tail -n +6 | while read -r old; do [ "$old" != "$(readlink -f "$APP/current")" ] && [ "$old" != "$PREV" ] && rm -rf "$old"; done
  exit 0
fi
echo "release $ID did not become healthy; rolling back" >&2
journalctl -u esports-monitor.service -n 40 --no-pager >&2 || true
if [ -n "$PREV" ] && [ -d "$PREV" ]; then
  ln -sfn "$PREV" "$APP/current.new" && mv -T "$APP/current.new" "$APP/current"
  python3 /usr/local/lib/esports-monitor-compose-env.py "$PREV/server/docker-compose.yml" > /etc/esports-monitor/compose.env
  systemctl restart esports-monitor.service
  echo "restored $PREV" >&2
fi
exit 1
