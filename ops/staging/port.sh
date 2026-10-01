#!/usr/bin/env bash
# Makes the systemd unit match PORT in /etc/esports-monitor/server.env (the single source of the listening port).
#   esports-monitor-port [--no-restart]
# Ports below 1024 need CAP_NET_BIND_SERVICE; it is granted (and the capability bounding set widened to exactly that one
# capability) only then. For any other port the drop-in is removed and the unit keeps its empty capability set.
# The firewall is not touched here: provision.sh --public-api / --allow decide what is reachable from outside.
set -euo pipefail
restart=1; [ "${1:-}" = "--no-restart" ] && restart=0
ENVFILE=/etc/esports-monitor/server.env
d=/etc/systemd/system/esports-monitor.service.d; install -d "$d"
PORT="$(grep -E '^PORT=' "$ENVFILE" 2>/dev/null | tail -n1 | cut -d= -f2)"; PORT="${PORT:-8080}"
case "$PORT" in ''|*[!0-9]*) echo "invalid PORT '$PORT' in $ENVFILE" >&2; exit 2;; esac
[ "$PORT" -ge 1 ] && [ "$PORT" -le 65535 ] || { echo "PORT $PORT out of range" >&2; exit 2; }
if [ "$PORT" -lt 1024 ]; then
  printf '[Service]\n# Privileged port %s: the unprivileged service user may bind it, nothing else is added.\nAmbientCapabilities=CAP_NET_BIND_SERVICE\nCapabilityBoundingSet=CAP_NET_BIND_SERVICE\n' "$PORT" > "$d/20-port.conf"
else
  rm -f "$d/20-port.conf"
fi
rm -f "$d/20-port80.conf"
systemctl daemon-reload
[ "$restart" = 1 ] && systemctl restart esports-monitor.service || true
echo "port: $PORT"
