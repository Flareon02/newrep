#!/bin/sh
# Free disk space taken by old releases without touching live data.
#
#   ./prune-old-releases.sh            show what would be removed (default, changes nothing)
#   ./prune-old-releases.sh --apply    remove it
#
# Removes only:
#   * manual backups  astek-monitor-manual-backup-*.tar.gz  beyond the newest KEEP_BACKUPS (default 3)
#   * saved .env.before-* copies beyond the newest 3
#   * STOPPED containers named astek-monitor-failed-* / astek-monitor-stale-* (never the rollback target,
#     never a running container, never astek-monitor itself)
#   * astek-monitor-server images that no container uses (docker refuses to delete an image in use)
# The data directory (SQLite, /data) is never touched.
set -eu
HERE="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
DOCKER="${DOCKER:-docker}"
BACKUP_DIR="${ASTEK_BACKUP_DIR:-/root}"
KEEP_BACKUPS="${KEEP_BACKUPS:-3}"
APPLY=0
[ "${1:-}" = "--apply" ] && APPLY=1
case "$KEEP_BACKUPS" in ''|*[!0-9]*) echo "KEEP_BACKUPS must be a number" >&2; exit 2;; esac

say() { printf '%s\n' "$*"; }
act() { # act <description> <command...>
  desc="$1"; shift
  if [ "$APPLY" -eq 1 ]; then say "removing: $desc"; "$@" || say "  (could not remove: $desc)"; else say "would remove: $desc"; fi
}

[ "$APPLY" -eq 1 ] && say "== APPLY mode ==" || say "== DRY RUN (nothing is deleted; add --apply) =="

# 1. Backups, newest first by timestamp in the name.
n=0
for f in $(ls -1 "$BACKUP_DIR"/astek-monitor-manual-backup-*.tar.gz 2>/dev/null | sort -r); do
  n=$((n+1))
  [ "$n" -le "$KEEP_BACKUPS" ] && continue
  act "$f" rm -f -- "$f" "$f.sha256"
done

# 2. Saved environment copies made by upgrade.sh.
n=0
for f in $(ls -1 "$HERE"/.env.before-* 2>/dev/null | sort -r); do
  n=$((n+1))
  [ "$n" -le 3 ] && continue
  act "$f" rm -f -- "$f"
done

# 3. Stopped leftovers from interrupted updates.
PROTECT="$(cat "$HERE/rollback-container.txt" 2>/dev/null || true)"
if command -v "$DOCKER" >/dev/null 2>&1; then
  for name in $($DOCKER ps -a --filter status=exited --filter status=created --format '{{.Names}}' 2>/dev/null | grep -E '^astek-monitor-(failed|stale)-' || true); do
    [ "$name" = "$PROTECT" ] && continue
    act "container $name" $DOCKER rm "$name"
  done
  # 4. Images of this project that nothing uses.
  for image in $($DOCKER images --format '{{.Repository}}:{{.Tag}}' 2>/dev/null | grep -E '^astek-monitor-server:' || true); do
    if [ -n "$($DOCKER ps -a --filter "ancestor=$image" --format '{{.Names}}' 2>/dev/null)" ]; then continue; fi
    act "image $image" $DOCKER image rm "$image"
  done
  say "--- docker disk usage"; $DOCKER system df 2>/dev/null || true
else
  say "docker not found: skipped containers and images"
fi
say "--- filesystem"; df -h "$BACKUP_DIR" "$HERE" 2>/dev/null || true
