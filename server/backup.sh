#!/bin/sh
set -eu
HERE="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
STAMP="$(date -u +%Y%m%d-%H%M%S)"
ROOT="${ASTEK_BACKUP_DIR:-/root}"
mkdir -p "$ROOT"
DATA=""
RUNNING=0
if docker container inspect astek-monitor >/dev/null 2>&1; then
  DATA="$(docker inspect -f '{{range .Mounts}}{{if eq .Destination "/data"}}{{.Source}}{{end}}{{end}}' astek-monitor)"
  if [ "$(docker inspect -f '{{.State.Running}}' astek-monitor)" = "true" ]; then docker stop --time 40 astek-monitor >/dev/null; RUNNING=1; fi
fi
[ -n "$DATA" ] || DATA="$(cat "$HERE/rollback-data-dir.txt" 2>/dev/null || true)"
[ -n "$DATA" ] && [ -d "$DATA" ] || { echo "Data directory not found." >&2; [ "$RUNNING" -eq 1 ] && docker start astek-monitor >/dev/null || true; exit 1; }
restore(){ [ "$RUNNING" -eq 1 ] && docker start astek-monitor >/dev/null 2>&1 || true; }
trap restore EXIT INT TERM
OUT="$ROOT/astek-monitor-manual-backup-$STAMP.tar.gz"
tar -czf "$OUT" -C "$DATA" .
gzip -t "$OUT"; tar -tzf "$OUT" >/dev/null
command -v sha256sum >/dev/null 2>&1 && sha256sum "$OUT" > "$OUT.sha256" || true
restore; RUNNING=0
printf 'Backup verified: %s\n' "$OUT"
