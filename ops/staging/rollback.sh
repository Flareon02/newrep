#!/usr/bin/env bash
# Switch back to the previous release (recorded by deploy.sh) and restart.
set -euo pipefail
APP=/opt/esports-monitor
PREV="$(cat "$APP/previous" 2>/dev/null || true)"
[ -n "$PREV" ] && [ -d "$PREV" ] || { echo "no previous release recorded" >&2; exit 1; }
CUR="$(readlink -f "$APP/current")"
ln -sfn "$PREV" "$APP/current.new" && mv -T "$APP/current.new" "$APP/current"
echo "$CUR" > "$APP/previous"
python3 /usr/local/lib/esports-monitor-compose-env.py "$PREV/server/docker-compose.yml" > /etc/esports-monitor/compose.env
systemctl restart esports-monitor.service
sleep 6; curl -fsS --max-time 8 http://127.0.0.1:$(grep -E '^PORT=' /etc/esports-monitor/server.env | cut -d= -f2)/health | jq '{ok,version}'
echo "rolled back to $PREV (was $CUR)"
