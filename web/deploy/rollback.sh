#!/bin/bash
# Rolls the web gateway back to the state of a checkpoint written by install.sh (run as root).
#   web/deploy/rollback.sh /var/backups/esportsdata-web/checkpoint-<stamp> [--restore-sessions]
# - switches /opt/esportsdata-web/current back to the previous release, or stops and disables the service when there
#   was none (first deployment);
# - --restore-sessions also restores the gateway database (sessions/audit) from the checkpoint.
# The monitor server, its collectors and cloudflared are not touched.
set -euo pipefail
CHECK=${1:?checkpoint directory}
PREV=$(cat "$CHECK/previous-release")
if [ "$PREV" = none ] || [ ! -d "$PREV" ]; then
  systemctl disable --now esportsdata-web || true
  echo "no previous release: web gateway stopped and disabled (port 8090 closed)"
else
  ln -sfn "$PREV" /opt/esportsdata-web/current.new && mv -T /opt/esportsdata-web/current.new /opt/esportsdata-web/current
  if [ "${2:-}" = --restore-sessions ] && [ -f "$CHECK/gateway.sqlite3" ]; then
    systemctl stop esportsdata-web
    install -m 0600 -o esportsdata-web -g esportsdata-web "$CHECK/gateway.sqlite3" /var/lib/esportsdata-web/gateway.sqlite3
    rm -f /var/lib/esportsdata-web/gateway.sqlite3-wal /var/lib/esportsdata-web/gateway.sqlite3-shm
  fi
  systemctl restart esportsdata-web
  echo "rolled back to $PREV"
fi
