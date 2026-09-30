# Server 4.3.5 — production update

This release is tuned for the production VPS: 1 vCPU / 1 GiB RAM.

1. Upload the release ZIP to `/root/`.
2. Extract it to a fresh `/root/monitor-update-4.3.5-stability-fix/` directory.
3. Run the relay configuration.
4. Run `./upgrade.sh`.

Expected end state:

```text
health OK: v4.3.5, SQLite ... MiB, integrity=ok
...
Server 4.3.5 is healthy.
Persistent SQLite: /root/monitor-update-3.2.19/astek-monitor-server-v3.2.19/data
No data migration was performed.
```

The updater requires six consecutive healthy stability samples within at most
18 probes. One five-second health timeout resets the healthy streak and is
retried; three consecutive timeout/slow responses trigger rollback. A historical
event-loop peak may clear at its next 60-second reset. Persistent lag or failure
to achieve the healthy streak exhausts the probe budget and triggers rollback.
Invalid health data, memory violations and container restarts fail immediately.

The 4.3.5 updater also repairs non-canonical Docker states left by interrupted 4.3.x attempts (for example, a running `astek-monitor-failed-*` container plus an exited `astek-monitor`).

## Retry after the timeout shown in update-4.3.5.log

First let the original updater finish. Its final line should say
`Previous server restored. Data directory: ...`. Verify the active container and
health before starting another update:

```sh
docker ps --filter publish=8080 --format 'table {{.Names}}\t{{.Image}}\t{{.Status}}'
curl -fsS --max-time 10 http://127.0.0.1:8080/health
```

Upload the corrected ZIP to `/root/`, then run:

```sh
mkdir -p /root/monitor-update-4.3.5-stability-fix
unzip /root/Esports-Monitor-server-4.3.5-deploy-history-fix.zip -d /root/monitor-update-4.3.5-stability-fix
cd /root/monitor-update-4.3.5-stability-fix/astek-monitor-server-v4.3.5-deploy-history-fix
chmod +x upgrade.sh rollback.sh configure-ggbet-relay.sh
nohup ./upgrade.sh > /root/update-4.3.5-stability-fix.log 2>&1 &
tail -f /root/update-4.3.5-stability-fix.log
```

The updater configures the relay from `/root/ggbet-relay-client.bundle` or
copies its configuration from the existing production container. Keep that
container and its data directory. No SQLite migration or data rollback is performed.
