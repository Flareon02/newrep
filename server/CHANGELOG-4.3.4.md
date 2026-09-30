# Server 4.3.4 — deployment topology fix

This release keeps the single-core runtime changes from 4.3.3 and fixes the updater failure seen after interrupted/rolled-back Docker updates.

## Fixed

- Detects the real production container by the process that owns host port 8080, instead of assuming it is always named `astek-monitor`.
- Safely handles a topology where a running production container is named `astek-monitor-failed-*` while an exited `astek-monitor` container still exists.
- Moves a stale canonical container aside instead of deleting it.
- Uses a unique Compose project name for every update attempt, so Compose cannot reuse a renamed failed container from an earlier attempt by its old Compose labels.
- Verifies port 8080 is free before the new release is created.
- Requires Compose to create the canonical `astek-monitor` container before health checks begin.
- Rollback now also detects the currently serving container by port 8080 and can recover from non-canonical names.

## Runtime

- Same single-core safeguards as 4.3.3: 320 MiB Node heap, UV thread pool 2, prematch concurrency 1, low-priority Results/History scheduling, schema 3, no migration.
