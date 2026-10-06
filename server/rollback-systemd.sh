#!/bin/sh
# Rollback for the systemd layout: point <root>/current back to the release recorded in <root>/previous (written by
# upgrade-systemd.sh) or to a named release, and restart only the monitor unit.
#
#   sh rollback-systemd.sh                                         # asks for confirmation
#   sh rollback-systemd.sh --yes                                   # no question (scripts)
#   sh rollback-systemd.sh --yes /opt/esports-monitor/releases/d274d30
#
# Which installation: when this script sits inside a release (<root>/releases/<id>/server/), it acts on THAT <root>
# only; otherwise ESM_ROOT, default /opt/esports-monitor. It always prints root, unit, from and to before acting, and
# without --yes it needs an interactive "rollback" answer (a non-interactive shell without --yes stops here).
#
# The 4.16.0 data changes are additive (new user-settings.sqlite3, optional JSON fields in new journal rows), so the
# previous server runs on the same data directory unchanged; no database restore is needed.
set -eu
YES=0
[ "${1:-}" = "--yes" ] && { YES=1; shift; }
HERE="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
OWN_ROOT="$(CDPATH= cd -- "$HERE/../../.." 2>/dev/null && pwd || true)"
if [ -n "${ESM_ROOT:-}" ]; then ROOT="$ESM_ROOT"
elif [ "$(basename "$(dirname "$(dirname "$HERE")")")" = releases ] && [ -L "$OWN_ROOT/current" ]; then ROOT="$OWN_ROOT"
else ROOT=/opt/esports-monitor; fi
UNIT="${ESM_UNIT:-esports-monitor}"
ENV_FILE="${ESM_ENV:-/etc/esports-monitor/server.env}"
TARGET="${1:-$(cat "$ROOT/previous" 2>/dev/null || true)}"
[ "$(id -u)" = 0 ] || { echo "run as root" >&2; exit 1; }
[ -n "$TARGET" ] && [ -f "$TARGET/server/src/index.js" ] || { echo "no valid rollback target: '$TARGET'" >&2; ls -1 "$ROOT/releases" >&2; exit 1; }
FROM="$(readlink -f "$ROOT/current")"
PORT="$(sed -n 's/^PORT=//p' "$ENV_FILE" | tail -n1)"; PORT="${PORT:-8080}"
TOKEN="$(sed -n 's/^API_TOKEN=//p' "$ENV_FILE" | tail -n1)"
echo "root:   $ROOT"
echo "unit:   $UNIT (env $ENV_FILE, port $PORT)"
echo "from:   $FROM"
echo "to:     $TARGET"
if [ "$YES" != 1 ]; then
  [ -t 0 ] || { echo "not interactive: add --yes to confirm" >&2; exit 1; }
  printf 'Type "rollback" to switch and restart %s: ' "$UNIT"; read -r answer
  [ "$answer" = rollback ] || { echo "cancelled"; exit 1; }
fi
ln -sfn "$TARGET" "$ROOT/current.new" && mv -T "$ROOT/current.new" "$ROOT/current"
echo "$FROM" > "$ROOT/previous"
systemctl restart "$UNIT"
for i in $(seq 1 45); do
  sleep 2
  code="$(curl -s -o /dev/null -w '%{http_code}' -m 5 ${TOKEN:+-H "Authorization: Bearer $TOKEN"} "http://127.0.0.1:$PORT/api/ui/live?meta=1&thin=1" || true)"
  [ "$code" = 200 ] && { echo "OK: serving from $TARGET"; curl -fsS -m 3 "http://127.0.0.1:$PORT/health" | head -c 200; echo; exit 0; }
done
echo "WARNING: $TARGET did not answer within 90 s; check: journalctl -u $UNIT -n 100" >&2
exit 1
