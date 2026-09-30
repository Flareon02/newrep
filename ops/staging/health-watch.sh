#!/usr/bin/env bash
# Restarts the service after 3 consecutive failed health checks (hang detection; crashes are handled by Restart=always).
set -u
STATE=/run/esports-monitor-health.fails
PORT="$(grep -E '^PORT=' /etc/esports-monitor/server.env 2>/dev/null | tail -n1 | cut -d= -f2)"; PORT="${PORT:-8080}"
if [ "$(curl -fsS --max-time 8 "http://127.0.0.1:$PORT/health" 2>/dev/null | jq -r '.ok // false' 2>/dev/null)" = true ]; then
  rm -f "$STATE"; exit 0
fi
# Do not fight a deployment, a manual stop or systemd's own restart handling.
if ! systemctl is-active --quiet esports-monitor.service || [ -e /run/esports-monitor-deploying ]; then rm -f "$STATE"; exit 0; fi
fails=$(( $(cat "$STATE" 2>/dev/null || echo 0) + 1 )); echo "$fails" > "$STATE"
logger -t esports-monitor-health "health check failed ($fails/3)"
if [ "$fails" -ge 3 ]; then logger -t esports-monitor-health "restarting esports-monitor after 3 failed checks"; rm -f "$STATE"; systemctl restart esports-monitor.service; fi
