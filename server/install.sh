#!/bin/sh
set -eu
HERE="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
cd "$HERE"
if docker container inspect astek-monitor >/dev/null 2>&1; then
  echo "Existing server detected; switching to safe upgrade mode."
  exec "$HERE/upgrade.sh"
fi
mkdir -p "$HERE/data"
DATA="$(CDPATH= cd -- "$HERE/data" && pwd -P)"
{
  [ -f "$HERE/.env" ] && sed '/^COMPOSE_PROJECT_NAME=/d;/^HOST_DATA_DIR=/d' "$HERE/.env" || true
  printf 'HOST_DATA_DIR=%s\n' "$DATA"
  printf 'COMPOSE_PROJECT_NAME=astek-monitor-410\n'
} > "$HERE/.env.next"
mv "$HERE/.env.next" "$HERE/.env"
echo "Building and starting fresh server 4.4.0..."
docker compose up -d --build
ATTEMPT=0
until curl -fsS --max-time 4 http://127.0.0.1:8080/health >/dev/null 2>&1; do ATTEMPT=$((ATTEMPT+1)); [ "$ATTEMPT" -lt 20 ] || { docker compose logs --tail=120; exit 1; }; sleep 2; done
echo "Server 4.4.0 is ready. Persistent data: $DATA"
