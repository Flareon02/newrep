#!/bin/sh
set -eu
HERE="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
cd "$HERE"
STAMP="$(date -u +%Y%m%d-%H%M%S)"
OLD_CONTAINER="astek-monitor-rollback-$STAMP"
STALE_CONTAINER="astek-monitor-stale-$STAMP"
PROJECT_NAME="astek-monitor-435-$STAMP"
SOURCE=""
PROD_CONTAINER=""
RENAMED=0
NEW_STARTED=0
SUCCESS=0
ENV_BEFORE="$HERE/.env.before-$STAMP"
HAD_ENV=0

log(){ printf '%s\n' "$*"; }
container_exists(){ docker container inspect "$1" >/dev/null 2>&1; }
container_running(){ [ "$(docker inspect -f '{{.State.Running}}' "$1" 2>/dev/null || echo false)" = true ]; }
port_8080_container(){ docker ps --filter publish=8080 --format '{{.Names}}' 2>/dev/null | head -n1; }
diag(){
  echo "--- astek-monitor diagnostics ---" >&2
  if container_exists astek-monitor; then
    docker inspect astek-monitor --format 'Image={{.Config.Image}} Status={{.State.Status}} Running={{.State.Running}} RestartCount={{.RestartCount}} OOMKilled={{.State.OOMKilled}} Error={{.State.Error}}' >&2 2>/dev/null || true
    docker logs --tail 160 astek-monitor >&2 2>/dev/null || true
  else
    echo "canonical container astek-monitor is absent" >&2
    docker ps -a --filter publish=8080 --format 'table {{.Names}}\t{{.Image}}\t{{.Status}}' >&2 2>/dev/null || true
  fi
}
restore_previous(){
  # Free the canonical name if a failed candidate exists.
  if container_exists astek-monitor; then
    docker stop --time 20 astek-monitor >/dev/null 2>&1 || true
    docker rename astek-monitor "astek-monitor-failed-$STAMP" >/dev/null 2>&1 || true
  fi
  if container_exists "$OLD_CONTAINER"; then
    docker rename "$OLD_CONTAINER" astek-monitor >/dev/null 2>&1 || true
    docker start astek-monitor >/dev/null 2>&1 || true
  fi
}
rollback_on_failure(){
  code=$?
  [ "$SUCCESS" -eq 1 ] && { rm -f "$ENV_BEFORE"; return 0; }
  [ "$code" -eq 0 ] && return 0
  trap - EXIT
  echo "" >&2
  echo "Update failed. Restoring the previous container; SQLite data is not rolled back." >&2
  [ "$RENAMED" -eq 1 ] && restore_previous
  if [ "$HAD_ENV" -eq 1 ] && [ -f "$ENV_BEFORE" ]; then cp "$ENV_BEFORE" "$HERE/.env"; else rm -f "$HERE/.env"; fi
  echo "Previous server restored. Data directory: ${SOURCE:-unknown}" >&2
  exit "$code"
}
trap rollback_on_failure EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

command -v docker >/dev/null 2>&1 || { echo "Docker is required." >&2; exit 1; }
docker compose version >/dev/null

if [ -f "$HERE/.env" ]; then cp "$HERE/.env" "$ENV_BEFORE"; HAD_ENV=1; fi

# Production may have a non-canonical name after an interrupted older update.
# Prefer the running container that actually owns host port 8080; otherwise use
# the canonical astek-monitor container, even if it is currently stopped.
PORT_OWNER="$(port_8080_container || true)"
if [ -n "$PORT_OWNER" ]; then
  PROD_CONTAINER="$PORT_OWNER"
elif container_exists astek-monitor; then
  PROD_CONTAINER="astek-monitor"
fi

if [ -n "$PROD_CONTAINER" ]; then
  SOURCE="$(docker inspect -f '{{range .Mounts}}{{if eq .Destination "/data"}}{{.Source}}{{end}}{{end}}' "$PROD_CONTAINER" 2>/dev/null || true)"
fi
if [ -z "$SOURCE" ] || [ ! -d "$SOURCE" ]; then
  for d in /root/monitor-update-3.2.19/astek-monitor-server-v3.2.19/data /root/monitor-update-*/astek-monitor-server-v*/data; do
    [ -d "$d" ] || continue
    [ -f "$d/monitor-v2.sqlite3" ] || continue
    SOURCE="$d"; break
  done
fi
[ -n "$SOURCE" ] && [ -d "$SOURCE" ] || { echo "Production data directory was not found." >&2; exit 1; }
SOURCE="$(CDPATH= cd -- "$SOURCE" && pwd -P)"
case "$SOURCE" in /|/root|/var|/home|/mnt|/data) echo "Refusing unsafe data path: $SOURCE" >&2; exit 1;; esac
[ -s "$SOURCE/monitor-v2.sqlite3" ] || { echo "SQLite database is missing: $SOURCE/monitor-v2.sqlite3" >&2; exit 1; }

log "[1/7] Preparing Warsaw GGBET relay configuration..."
if [ -f /root/ggbet-relay-client.bundle ]; then
  "$HERE/configure-ggbet-relay.sh" /root/ggbet-relay-client.bundle
else
  [ -n "$PROD_CONTAINER" ] || { echo "Warsaw relay configuration is unavailable and no production container can provide it." >&2; exit 1; }
  secret_src="$(docker inspect -f '{{range .Mounts}}{{if eq .Destination "/run/secrets/ggbet-relay-secret"}}{{.Source}}{{end}}{{end}}' "$PROD_CONTAINER" 2>/dev/null || true)"
  ca_src="$(docker inspect -f '{{range .Mounts}}{{if eq .Destination "/run/secrets/ggbet-relay-ca.pem"}}{{.Source}}{{end}}{{end}}' "$PROD_CONTAINER" 2>/dev/null || true)"
  relay_url="$(docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' "$PROD_CONTAINER" 2>/dev/null | sed -n 's/^GGBET_BOOTSTRAP_RELAY_URL=//p' | head -n1)"
  if [ -s "$secret_src" ] && [ -s "$ca_src" ] && [ -n "$relay_url" ]; then
    cp "$secret_src" "$HERE/secrets/ggbet-relay-secret"; cp "$ca_src" "$HERE/secrets/ggbet-relay-ca.pem"; chmod 600 "$HERE/secrets/ggbet-relay-secret" "$HERE/secrets/ggbet-relay-ca.pem"
    { grep -v '^GGBET_BOOTSTRAP_RELAY_URL=' "$HERE/.env" 2>/dev/null || true; printf 'GGBET_BOOTSTRAP_RELAY_URL=%s\n' "$relay_url"; } > "$HERE/.env.next"; mv "$HERE/.env.next" "$HERE/.env"; chmod 600 "$HERE/.env"
  else
    echo "Warsaw relay configuration is unavailable. Keep /root/ggbet-relay-client.bundle on the server." >&2; exit 1
  fi
fi

log "[2/7] Building Server 4.4.0 while the current server remains online..."
docker build -t astek-monitor-server:4.4.0 .

log "[3/7] Verifying existing SQLite schema without modifying data..."
docker run --rm --network none -e DB=/data/monitor-v2.sqlite3 -v "$SOURCE:/data:ro" astek-monitor-server:4.4.0 node --input-type=module -e '
  import {DatabaseSync} from "node:sqlite";
  const db=new DatabaseSync(process.env.DB,{readOnly:true});
  const row=db.prepare("SELECT value FROM meta WHERE key = ?").get("schema_version");
  const version=Number(row?.value||0);if(version!==3){console.error("Unexpected schemaVersion",version);process.exit(1)}
  console.log("SQLite schemaVersion=3; code-only upgrade, migration not required.");db.close();'

log "[4/7] Preserving the current server container for instant rollback..."
# If an interrupted old update left an exited canonical container while the real
# production instance is running under astek-monitor-failed-..., move the stale
# canonical name out of the way first. Never delete it automatically.
if [ "$PROD_CONTAINER" != "astek-monitor" ] && container_exists astek-monitor; then
  docker rename astek-monitor "$STALE_CONTAINER"
fi
if [ -n "$PROD_CONTAINER" ] && container_exists "$PROD_CONTAINER"; then
  if container_running "$PROD_CONTAINER"; then docker stop --time 45 "$PROD_CONTAINER" >/dev/null; fi
  docker rename "$PROD_CONTAINER" "$OLD_CONTAINER"
  RENAMED=1
  printf '%s\n' "$OLD_CONTAINER" > "$HERE/rollback-container.txt"
else
  : > "$HERE/rollback-container.txt"
fi
printf '%s\n' "$SOURCE" > "$HERE/rollback-data-dir.txt"

# Port 8080 must now be free. If another unexpected container owns it, abort
# before creating the new release and restore the previous production instance.
PORT_OWNER="$(port_8080_container || true)"
[ -z "$PORT_OWNER" ] || { echo "Port 8080 is still owned by container: $PORT_OWNER" >&2; exit 1; }

# A unique Compose project name prevents Compose from reusing a renamed failed
# container that still carries labels from a previous 4.3.x attempt.
{ grep -v '^HOST_DATA_DIR=\|^COMPOSE_PROJECT_NAME=' "$HERE/.env" 2>/dev/null || true; printf 'HOST_DATA_DIR=%s\n' "$SOURCE"; printf 'COMPOSE_PROJECT_NAME=%s\n' "$PROJECT_NAME"; } > "$HERE/.env.next"
mv "$HERE/.env.next" "$HERE/.env"; chmod 600 "$HERE/.env"

log "[5/7] Starting Server 4.4.0 on the same SQLite database..."
HOST_DATA_DIR="$SOURCE" COMPOSE_PROJECT_NAME="$PROJECT_NAME" docker compose up -d --no-build --force-recreate
NEW_STARTED=1
container_exists astek-monitor || { echo "Compose did not create canonical container astek-monitor." >&2; docker ps -a --format 'table {{.Names}}\t{{.Image}}\t{{.Status}}' >&2; exit 1; }

log "[6/7] Waiting for health and thin-client API..."
attempt=0
until curl -fsS --max-time 5 http://127.0.0.1:8080/health > /tmp/astek-health-440.json 2>/dev/null; do
  attempt=$((attempt+1))
  running="$(docker inspect -f '{{.State.Running}}' astek-monitor 2>/dev/null || echo false)"
  [ "$running" = true ] || { echo "4.4.0 exited during startup." >&2; diag; exit 1; }
  [ "$attempt" -lt 40 ] || { echo "4.4.0 did not become healthy within 120 seconds." >&2; diag; exit 1; }
  sleep 3
done

docker exec astek-monitor node --input-type=module -e '
 const r=await fetch("http://127.0.0.1:8080/health",{signal:AbortSignal.timeout(5000)}),d=await r.json();
 if(!d.ok||d.version!=="4.4.0"||d.runtime?.storage?.engine!=="sqlite"||d.runtime?.storage?.schemaVersion!==3||d.runtime?.storage?.integrity!=="ok"||d.features?.uiPush!==1||d.features?.thinClient!==2||d.features?.marketSemantics!==1||d.features?.ggbetNativeTabs!==1){console.error(d);process.exit(1)}
 console.log(`health OK: v${d.version}, SQLite ${d.runtime.storage.sizeMiB} MiB, integrity=${d.runtime.storage.integrity}`);'

docker exec astek-monitor node --input-type=module -e '
 const base="http://127.0.0.1:8080";
 const get=async(path,timeout=10000)=>{const c=new AbortController(),t=setTimeout(()=>c.abort(),timeout);try{const r=await fetch(base+path,{signal:c.signal});const d=await r.json();return {r,d}}finally{clearTimeout(t)}};
 const critical=["/api/ui/live?compact=1&thin=1","/api/ui/prematch?compact=1&thin=1","/api/ui/leagues?limit=20&thin=1"];
 for(const path of critical){const {r,d}=await get(path);if(!r.ok||d.serverUi!==true||d.features?.thinClient!==2||d.features?.marketSemantics!==1||d.features?.ggbetNativeTabs!==1){console.error(path,r.status,d);process.exit(1)}console.log(path,"OK",Array.isArray(d.events)?`events=${d.events.length}`:d.totals?`leagues=${Object.values(d.totals).reduce((a,b)=>a+b,0)}`:"");}
 const history=`/api/ui/history?limit=1&thin=1&since=${Date.now()-86400000}`;
 const {r:hr,d:hd}=await get(history,5000);
 if(hr.ok){if(hd.serverUi!==true||hd.features?.thinClient!==2||hd.features?.marketSemantics!==1||hd.features?.ggbetNativeTabs!==1){console.error(history,hr.status,hd);process.exit(1)}console.log(history,"OK",`events=${Array.isArray(hd.events)?hd.events.length:0}`);}
 else if(hr.status===503&&hd?.retryable===true){console.log(history,"DEFERRED: realtime queue has priority (expected)");}
 else {console.error(history,hr.status,hd);process.exit(1)}'

docker exec astek-monitor node --input-type=module -e '
 const c=new AbortController(),t=setTimeout(()=>c.abort(new Error("SSE hello timeout")),12000);
 try {
   const r=await fetch("http://127.0.0.1:8080/api/feed-stream?modes=live,prematch,results,history,leagues&thin=1",{signal:c.signal,headers:{Accept:"text/event-stream"}});
   if(!r.ok)throw new Error(`SSE HTTP ${r.status}`);
   const reader=r.body.getReader(),dec=new TextDecoder();let text="";
   while(!/\r?\n\r?\n/.test(text)){const {done,value}=await reader.read();if(done)break;text+=dec.decode(value,{stream:true});if(text.length>65536)throw new Error("SSE hello frame exceeded 64 KiB");}
   const match=text.match(/^([\s\S]*?)\r?\n\r?\n/);if(!match)throw new Error(`Incomplete SSE hello frame: ${JSON.stringify(text.slice(0,200))}`);
   const lines=match[1].split(/\r?\n/),event=(lines.find(x=>x.startsWith("event:"))||"").slice(6).trim(),dataText=lines.filter(x=>x.startsWith("data:")).map(x=>x.slice(5).trimStart()).join("\n");
   let data;try{data=JSON.parse(dataText)}catch(e){throw new Error(`Invalid SSE hello JSON: ${dataText.slice(0,200)}`)}
   if(event!=="hello"||data?.features?.uiPush!==1||data?.features?.thinClient!==2||data?.thin!==true||!data?.ui?.results||!data?.ui?.history||!data?.ui?.leagues)throw new Error(`Unexpected SSE hello: event=${event} data=${dataText.slice(0,300)}`);
   console.log(`push UI SSE OK: results=${data.ui.results.revision} history=${data.ui.history.revision} leagues=${data.ui.leagues.revision}`);
 } catch(e) { console.error("Push UI SSE smoke test failed:",e?.message||e); process.exit(1); }
 finally { clearTimeout(t); c.abort(); }'

log "[7/7] Stability check: 6 consecutive healthy samples, up to 18 bounded probes..."
base_restarts="$(docker inspect -f '{{.RestartCount}}' astek-monitor)"
i=0
healthy=0
transient_failures=0
while [ "$i" -lt 18 ] && [ "$healthy" -lt 6 ]; do
  sleep 5
  i=$((i+1))
  running="$(docker inspect -f '{{.State.Running}}' astek-monitor 2>/dev/null || echo false)"
  restarts="$(docker inspect -f '{{.RestartCount}}' astek-monitor 2>/dev/null || echo 999)"
  [ "$running" = true ] && [ "$restarts" = "$base_restarts" ] || { echo "Server restarted during stability check." >&2; diag; exit 1; }
  # Use an if so set -e does not turn one transient timeout into a rollback.
  probe_code=0
  if docker exec astek-monitor node src/deploy-health-probe.js; then
    healthy=$((healthy+1))
    transient_failures=0
    log "Healthy sample $healthy/6 (probe $i/18)."
  else
    probe_code=$?
    healthy=0
    case "$probe_code" in
      75)
        transient_failures=$((transient_failures+1))
        log "Retrying transient health failure $transient_failures/3 (probe $i/18)."
        [ "$transient_failures" -lt 3 ] || { echo "Three consecutive health timeouts/slow responses." >&2; diag; exit 1; }
        ;;
      76)
        # /health reports the maximum since its last 60-second reset. Do not
        # count the same historical startup spike as repeated fresh stalls.
        transient_failures=0
        log "Waiting for rolling event-loop peak to clear (probe $i/18)."
        ;;
      *) echo "Stability probe failed (exit $probe_code)." >&2; diag; exit 1 ;;
    esac
  fi
  # Catch a restart during the probe, including the final successful sample.
  running="$(docker inspect -f '{{.State.Running}}' astek-monitor 2>/dev/null || echo false)"
  restarts="$(docker inspect -f '{{.RestartCount}}' astek-monitor 2>/dev/null || echo 999)"
  [ "$running" = true ] && [ "$restarts" = "$base_restarts" ] || { echo "Server restarted during stability check." >&2; diag; exit 1; }
done
[ "$healthy" -eq 6 ] || { echo "Server did not produce six consecutive healthy samples within 18 probes." >&2; diag; exit 1; }

mount_source="$(docker inspect -f '{{range .Mounts}}{{if eq .Destination "/data"}}{{.Source}}{{end}}{{end}}' astek-monitor)"
[ "$(CDPATH= cd -- "$mount_source" && pwd -P)" = "$SOURCE" ] || { echo "Unexpected /data mount: $mount_source" >&2; exit 1; }
SUCCESS=1
rm -f "$ENV_BEFORE"
printf '\nServer 4.4.0 is healthy.\nPersistent SQLite: %s\nRollback container: %s\nCompose project: %s\nNo data migration was performed.\n' "$SOURCE" "$OLD_CONTAINER" "$PROJECT_NAME"
