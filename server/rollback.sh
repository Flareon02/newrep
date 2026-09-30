#!/bin/sh
set -eu
HERE="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
TARGET="$(cat "$HERE/rollback-container.txt" 2>/dev/null || true)"
DATA_DIR="$(cat "$HERE/rollback-data-dir.txt" 2>/dev/null || true)"
[ -n "$TARGET" ] && docker container inspect "$TARGET" >/dev/null 2>&1 || { echo "Saved rollback container not found: $TARGET" >&2; docker ps -a --format 'table {{.Names}}\t{{.Image}}\t{{.Status}}'; exit 1; }
[ -n "$DATA_DIR" ] && [ -s "$DATA_DIR/monitor-v2.sqlite3" ] || { echo "SQLite data directory is unavailable: $DATA_DIR" >&2; exit 1; }
STAMP="$(date -u +%Y%m%d-%H%M%S)"
REPLACED="astek-monitor-replaced-$STAMP"
STALE="astek-monitor-stale-$STAMP"
CURRENT=""
HAD_CURRENT=0
SUCCESS=0
container_exists(){ docker container inspect "$1" >/dev/null 2>&1; }
port_8080_container(){ docker ps --filter publish=8080 --format '{{.Names}}' 2>/dev/null | head -n1; }
restore_new(){
  code=$?; [ "$SUCCESS" -eq 1 ] && return 0; trap - EXIT
  echo "Rollback failed; restoring the newer container." >&2
  if container_exists astek-monitor; then docker stop --time 20 astek-monitor >/dev/null 2>&1 || true; docker rename astek-monitor "$TARGET" >/dev/null 2>&1 || true; fi
  if [ "$HAD_CURRENT" -eq 1 ] && container_exists "$REPLACED"; then docker rename "$REPLACED" astek-monitor >/dev/null 2>&1 || true; docker start astek-monitor >/dev/null 2>&1 || true; fi
  exit "$code"
}
trap restore_new EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

# Prefer the process actually serving 8080; interrupted updates can leave that
# container with an astek-monitor-failed-* name while astek-monitor itself is
# stopped. This keeps rollback deterministic even in that topology.
CURRENT="$(port_8080_container || true)"
if [ -z "$CURRENT" ] && container_exists astek-monitor; then CURRENT="astek-monitor"; fi
if [ -n "$CURRENT" ]; then
  if [ "$CURRENT" != "astek-monitor" ] && container_exists astek-monitor; then docker rename astek-monitor "$STALE"; fi
  docker stop --time 45 "$CURRENT" >/dev/null 2>&1 || true
  docker rename "$CURRENT" "$REPLACED"
  HAD_CURRENT=1
fi
if container_exists astek-monitor; then docker rename astek-monitor "$STALE-2"; fi
docker rename "$TARGET" astek-monitor
docker start astek-monitor >/dev/null
attempt=0
until curl -fsS --max-time 5 http://127.0.0.1:8080/health >/tmp/astek-rollback-health.json 2>/dev/null; do
  attempt=$((attempt+1)); [ "$attempt" -lt 40 ] || { docker logs --tail 120 astek-monitor >&2 || true; exit 1; }; sleep 3
done
SUCCESS=1
printf '\nPrevious server restored successfully.\nData was NOT rolled back; both versions use the same SQLite schema 3.\nActive data: %s\n' "$DATA_DIR"
[ "$HAD_CURRENT" -eq 1 ] && printf 'Newer container preserved as: %s\n' "$REPLACED"
