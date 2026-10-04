# Collector forensics — server 4.14.0, schema 1

The recorder is observe-only. It does not change odds, source ownership, scheduling, proxy/VPN, API schemas or extension permissions. DataBet is never registered. Odds history is independent and remains disabled. Existing detailed GGBET logs and incidents remain intact.

## Storage and security

Default directory: `/var/lib/esports-monitor/data/collector-forensics/` (`DATA_DIR/collector-forensics` in containers).

```
providers/{astek,fonbet,pinnacle,ggbet-node,ggbet-browser}/YYYYMMDDTHH-instance-sequence.ndjson[.gz]
system/YYYYMMDDTHH-instance-sequence.ndjson[.gz]
incidents/incident-ID.json
indexes/YYYYMMDDTHH.json
logger-state.json
```

Directories are 0700, files 0600, owned by the server service account. CLI access requires that account or root. No public listener or public diagnostic route is added. Actual configured secret values are registered for redaction; sensitive keys, JWT/JWE strings, private keys, credential-bearing URLs and Authorization/Cookie text are redacted. Structured telemetry contains no full responses or WS payloads. Incident samples contain sanitized telemetry and phase descriptors, not authentication or raw bodies.

The existing GGBET detailed forensic is at `DATA_DIR/ggbet-forensics`; the Firefox worker keeps its native forensic at `/var/lib/esports-monitor-ggbet-browser/log`. The new session record links the existing Node forensic. These separate stores keep their existing retention and caps; the new cap does not govern them.

## Schema and stages

Each row contains schemaVersion, UTC timestamp, process monotonicMs, collector process instance, sequence, provider, phase, operation, result, durationMs, errorCategory, httpStatus, counts, receive/parse/publish ages, providerVersion/providerTimestamp, connectionState and retry/reconnect counters. Unknown values are null. providerVersion describes only the current operation; lastProviderVersion explicitly carries the last observed version. Worker IPC sequence is workerSequence, never a provider version. Counts may carry forward the last observed state. `operationId` links measured start/completion pairs within one process. Monotonic clocks are never compared between processes.

Real HTTP stages: upstream_request_start → upstream_response_received (headers) → payload_received (complete body) → upstream_request_complete → parse_start/complete (JSON decode) → separate provider normalization → state_start/complete → state_update → publish_start/complete. Request completion includes body download; normalization and JSON decode are separate operations. A failed decode retains receive evidence. An unchanged Astek fingerprint skips normalization and reports the actual unchanged state check.

Astek records gate queue delay, HTTP/download/decode, LIVE and prematch normalization, state reconciliation, deletion counts, retry/backoff and SSE work. Fonbet distinguishes base/delta requests, packetVersion, full-resync reason, delta reconcile/counts, LIVE/prematch parse and normalized state deletions. It does not invent an upstream deletion operation where provider semantics do not supply one. Pinnacle records HTTP status, payload sizes, decode, normalization, failed requests/429 backoff and publication. GGBET Node records bootstrap HTTP/body/extraction, real HTTP CONNECT responses, individual received WS frame bytes/message type/version, normalization/arbitration, publication and reconnect scheduling. Raw frame contents and bootstrap credentials are excluded.

GGBET Browser records individual Unix IPC request/receive/decode/apply spans and browser-owned publication. Every 15 seconds the existing worker `/health` supplies Firefox process/PSS, worker RSS, page states/counts, WS age/counter, discovery ages, VPN, BiDi connectivity, recoveries and restarts. Browser WS receipt is an explicitly labelled **aggregate worker-counter observation** with observedLastFrameAt, not an invented per-frame callback. Internal Firefox/worker parse duration is unavailable in the existing IPC contract; it remains UNKNOWN. No worker/session restart is needed. Native worker logs retain page/recovery/VPN details. QUIET pages remain valid.

`publish_complete` means server listeners/SSE enqueue completed. It cannot prove delivery to or rendering by a Chrome extension. SSE backpressure is recorded. Hybrid counts and operations are labelled: the shared GGBET state can contain both separately authoritative sources; telemetry never changes their markets or ownership.

## Heartbeat and system telemetry

15-second heartbeats: HEALTHY_ACTIVE, HEALTHY_QUIET, DEGRADED, STALE, DISCONNECTED. Health uses successful polling/transport checks and browser validation, not whether odds changed. No events is a valid quiet state. LIVE channels decide collector health; prematch channels are recorded separately in each heartbeat, so a delayed line can be investigated without claiming LIVE was broken. Initial startup has a 30-second incident grace period. An event-loop/process stall produces a heartbeat gap; lack of records is never declared health.

System rows contain server RSS/heap, interval process CPU (100% = one core), load average, MemAvailable, swap, sampled event-loop maximum/lag, SQLite WAL bytes, interface byte/error/drop counters, CPU/memory/IO pressure and logger diagnostics. Firefox/worker metrics are on the matching browser heartbeat. An event-loop delay histogram samples at20ms resolution; only the15-second summary is written. CPU and lag indicate contention; they do not identify a causal mechanism by themselves.

## Incidents

On unhealthy detection, record incidentId, provider, startedAt/detectedAt, previousHealthyAt, symptom, transitions, state, evidence and UNKNOWN rootCause. The actual onset lies between previousHealthyAt and detectedAt; startedAt is detection time, not an asserted exact upstream failure time. Each incident preserves the preceding available 10-minute heartbeat/system context plus the provider's last 200 phase descriptors. Early startup may have less than ten minutes of history.

Incidents detected within 30 seconds link relatedIncidentIds across providers. This is evidence correlation, never an automatic shared-host diagnosis. Recovery records recoveredAt, detection-to-recovery duration, retry/reconnect counts and observed mechanism; unknown mechanisms are explicitly unproven. OPEN incidents survive server restarts and can close on fresh evidence in the new instance. A restart may be an observed recovery boundary; it is not proof that restart was the cause.

## Retention, bounds and failure isolation

- Detailed structured rows: target 72 hours; completed hours are streamed through gzip level 1, normally within one maintenance interval. Current files rotate at 16 MiB (a bounded batch can exceed the nominal segment size by at most 2 MiB).
- Incidents: target 14 days, including their context.
- New store disk cap: 1 GiB, including incidents, indexes and active segments. Free-space guard: 4 GiB. Emergency oldest-file eviction overrides retention targets; the cap never excludes the current hour. Compression runs one stream at a time.
- Queue: maximum 2 MiB / 5,000 records; incident context is bounded to1MiB and recent phases to256KiB per provider; max individual row 32 KiB. One asynchronous bounded append batch, 250 ms flush interval. Collector hooks do not await filesystem I/O.
- The free-space guard is checked at every flush; cap accounting includes control files and reserves temporary replacements/compression. Disk failures/drop counts do not throw into collectors. Retention retries every minute. Short recent unflushed records can be lost on an abrupt crash.
- `logger-state.json` and every system row show recordsWritten, recordsDropped, writeErrors, queue depth/bytes, current-file sizes, bytesWritten, disk usage/free space and retentionState. At low disk the logger cannot promise to persist its own newest error; the last stored state plus coverage gaps must be considered.

Configuration: `COLLECTOR_FORENSICS_ENABLED=0` disables the recorder; `COLLECTOR_FORENSICS_DIR`, `COLLECTOR_FORENSICS_HOURS` (default72, minimum24), `COLLECTOR_FORENSICS_MAX_MIB` (default1024), `COLLECTOR_FORENSICS_MIN_FREE_MIB` (default4096). Targets are conditional on disk safety and actual traffic. Monitor projected volume and retained hour partitions; no finite disk cap can guarantee retention under unlimited traffic.

## Read-only CLI and time interpretation

The CLI reads files directly, streams gzip, and visits only hour partitions overlapping the requested window. Hour filenames and `indexes/` provide the time index; fallback partition discovery also covers the latest unindexed records. It never contacts a bookmaker/API or opens SQLite for writing.

```sh
esports-monitor forensic --since 30m
esports-monitor forensic --at "2026-10-04 13:34" --window 5m
esports-monitor forensic --provider fonbet --from "2026-10-04T11:29:00Z" --to "2026-10-04T11:39:00Z" --json
esports-monitor forensic --at "13:34" --timezone Europe/Amsterdam
esports-monitor incidents --provider astek
esports-monitor incidents --json
```

All stored timestamps are UTC. Local input defaults to Europe/Amsterdam (override `--timezone` or `FORENSIC_TIMEZONE`). Date-less HH:mm means today in that zone. Reports display absolute UTC bounds, resolved --at and the input zone. Ambiguous/nonexistent DST times are rejected and require an explicit offset. `--window 5m` means five minutes on either side. No matched records yields NO DATA/UNKNOWN, never a healthy claim.

Output separates OBSERVED counts/states, SUPPORTED measured delays/errors, PLAUSIBLE shared pressure and UNKNOWN causes/coverage. JSON includes bounded heartbeat/incident/error and stage timelines, the largest measured delays, pending operations, system samples and incidents. A start without completion can indicate a stall, a process crash or a truncated window; it is not automatically classified as a parser hang.

## Acceptance and rollback

`tools/forensic-acceptance.mjs --dir /var/lib/esports-monitor/data/collector-forensics-acceptance/UTC-TIMESTAMP` creates a separate, explicitly synthetic timeline for all five providers, a correlated incident and recovery, without upstream connections or production publication. It runs for two real minutes. Query its saved manifest timestamp with `esports-monitor forensic --dir THAT-DIR --at T --window 2m --json`. Production timestamps are queried against the default store.

Rollback: return `/opt/esports-monitor/current` to the preceding release and restart only `esports-monitor`; existing forensic files remain readable through the deployed CLI module or saved release. Alternatively disable with COLLECTOR_FORENSICS_ENABLED=0 and restart only the server. Keep Czech proxy settings unchanged; no sidecar/cloudflared restart, DataBet activation, odds-history activation or database migration is required.
