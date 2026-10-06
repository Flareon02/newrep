#!/bin/sh
# Safe upgrade for the systemd layout (/opt/esports-monitor/releases/<id>/server + `current` symlink, unit
# esports-monitor.service). Run as root from the directory of the UNPACKED release (where this script is):
#
#   sh ./upgrade-systemd.sh                 # backup → new release dir → switch → restart → health check
#   sh ./upgrade-systemd.sh --no-db-backup  # skip the SQLite copy (the update does not change the monitor DB schema)
#
# Nothing is deleted. On a failed health check the previous release is restored automatically.
# Data: monitor-v2.sqlite3 is not migrated by 4.16.0 (journal rows only gain optional JSON fields); personal settings
# go to a NEW file user-settings.sqlite3 created on first use. Rollback therefore needs no database restore.
set -eu
HERE="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
ROOT="${ESM_ROOT:-/opt/esports-monitor}"
UNIT="${ESM_UNIT:-esports-monitor}"
ENV_FILE="${ESM_ENV:-/etc/esports-monitor/server.env}"
DB_BACKUP=1
[ "${1:-}" = "--no-db-backup" ] && DB_BACKUP=0
VERSION="$(sed -n 's/.*"version": *"\([^"]*\)".*/\1/p' "$HERE/package.json" | head -n1)"
STAMP="$(date -u +%Y%m%d-%H%M%S)"
ID="v$VERSION-$STAMP"
REL="$ROOT/releases/$ID"
log(){ printf '[upgrade %s] %s\n' "$(date -u +%H:%M:%S)" "$*"; }
die(){ log "ERROR: $*"; exit 1; }

[ "$(id -u)" = 0 ] || die "run as root"
[ -f "$HERE/src/index.js" ] || die "run this script from the unpacked server release"
[ -L "$ROOT/current" ] || die "$ROOT/current is not a symlink (different layout?)"
CURRENT="$(readlink -f "$ROOT/current")"
[ -d "$CURRENT/server" ] || die "current release has no server/ directory: $CURRENT"
PORT="$(sed -n 's/^PORT=//p' "$ENV_FILE" | tail -n1)"; PORT="${PORT:-8080}"
DATA_DIR="$(sed -n 's/^DATA_DIR=//p' "$ENV_FILE" | tail -n1)"; DATA_DIR="${DATA_DIR:-/var/lib/esports-monitor/data}"
TOKEN="$(sed -n 's/^API_TOKEN=//p' "$ENV_FILE" | tail -n1)"
log "upgrade to $VERSION; current: $CURRENT; data: $DATA_DIR; port: $PORT"

# 1. syntax check of every server file with the installed Node
for f in "$HERE"/src/*.js; do node --check "$f" || die "syntax error in $f"; done

# 2. backup (small files always; the SQLite database with an online, consistent copy if there is room)
BK="${ESM_BACKUP_DIR:-/var/backups/esports-monitor}/$STAMP"
mkdir -p "$BK"
for f in users.json league-links.json league-catalog.json entity-aliases.json user-settings.sqlite3; do [ -e "$DATA_DIR/$f" ] && cp -a "$DATA_DIR/$f" "$BK/" || true; done
if [ "$DB_BACKUP" = 1 ] && [ -s "$DATA_DIR/monitor-v2.sqlite3" ]; then
  need=$(( $(stat -c %s "$DATA_DIR/monitor-v2.sqlite3") / 1048576 + 1024 ))
  free=$(( $(df -Pm "$BK" | awk 'NR==2{print $4}') ))
  if [ "$free" -gt "$need" ] && command -v sqlite3 >/dev/null 2>&1; then
    log "online SQLite backup ($need MiB needed, $free MiB free) - low I/O priority"
    ionice -c3 nice -n 19 sqlite3 "$DATA_DIR/monitor-v2.sqlite3" ".backup '$BK/monitor-v2.sqlite3'" || die "SQLite backup failed"
    [ "$(sqlite3 "$BK/monitor-v2.sqlite3" 'PRAGMA quick_check;')" = ok ] || die "backup quick_check failed"
  else
    log "WARNING: SQLite backup skipped (free $free MiB, needed $need MiB, or sqlite3 missing); the update does not change the DB schema"
  fi
fi
echo "$CURRENT" > "$BK/previous-release.txt"
log "backup: $BK"

# 3. new release directory (dependencies: same package-lock → reuse the installed node_modules)
mkdir -p "$REL"
cp -a "$HERE" "$REL/server"
rm -f "$REL/server/upgrade-systemd.sh.lock"
if cmp -s "$HERE/package-lock.json" "$CURRENT/server/package-lock.json" && [ -d "$CURRENT/server/node_modules" ]; then
  rm -rf "$REL/server/node_modules"; cp -a "$CURRENT/server/node_modules" "$REL/server/node_modules"
else
  log "dependencies changed: npm ci --omit=dev"
  (cd "$REL/server" && npm ci --omit=dev --no-audit --no-fund) || die "npm ci failed"
fi
echo "$VERSION" > "$REL/REVISION"
chown -R root:root "$REL"; chmod -R go-w "$REL"

# 4. switch atomically, restart only the monitor (cloudflared, GGBET browser and the web gateway are not touched)
echo "$CURRENT" > "$ROOT/previous"
ln -sfn "$REL" "$ROOT/current.new" && mv -T "$ROOT/current.new" "$ROOT/current"
log "switched to $REL; restarting $UNIT"
systemctl restart "$UNIT"

# 5. health check: up, right version, LIVE answering; otherwise automatic rollback
ok=0
for i in $(seq 1 45); do
  sleep 2
  v="$(curl -fsS -m 3 ${TOKEN:+-H "Authorization: Bearer $TOKEN"} "http://127.0.0.1:$PORT/health" 2>/dev/null | sed -n 's/.*"version":"\([^"]*\)".*/\1/p' | head -n1 || true)"
  [ "$v" = "$VERSION" ] || continue
  code="$(curl -s -o /dev/null -w '%{http_code}' -m 5 ${TOKEN:+-H "Authorization: Bearer $TOKEN"} "http://127.0.0.1:$PORT/api/ui/live?meta=1&thin=1" || true)"
  [ "$code" = 200 ] && { ok=1; break; }
done
if [ "$ok" != 1 ]; then
  log "health check FAILED - restoring $CURRENT"
  journalctl -u "$UNIT" --no-pager -n 60 || true
  ln -sfn "$CURRENT" "$ROOT/current.new" && mv -T "$ROOT/current.new" "$ROOT/current"
  systemctl restart "$UNIT"
  die "upgrade rolled back to $CURRENT"
fi
log "OK: $VERSION is serving (release $REL). Rollback: sh $REL/server/rollback-systemd.sh"
