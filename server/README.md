# Esports Monitor Server 4.4.0 — production hardening

4.4.0 adds operational safety on top of the 4.3.5 runtime without changing its data model or API routes:
leveled logging, a unified error envelope, an optional API token, SSE limits, opt-in retention and low-disk/History-memory
warnings. See `CHANGELOG-4.4.0.md`; repository-level notes are in `../docs/` (audit, API contract, deployment, performance budget).

## 4.3.5 — realtime stability (still the runtime baseline)

Server 4.3.5 is a single-core stability release for the current Esports Monitor thin client. It keeps the server-authoritative GGBET market semantics from 4.3.0/4.3.1 and SQLite schema 3.

The production priority is explicit:

`LIVE -> prematch -> odds/detail -> results -> history/background`

This release is tuned for the actual production VPS: **1 vCPU, 1 GiB RAM** with a 768 MiB Docker memory limit.

## Main changes

- Removes the 4.3.2 unbounded odds-write/compression regression.
- Removes automatic full-History warm rebuilds.
- Builds History pages only when requested, in a worker, and only in a realtime-idle slot.
- Recycles idle matcher workers and uses smaller worker heaps.
- Makes Results yield to LIVE/prematch/odds work.
- Reduces prematch/background concurrency for one CPU core.
- Makes `/health` cheap and bounded so the updater can detect stalls instead of hanging forever.

## GGBET semantics

GGBET markets continue to be classified from stable provider metadata (`typeId`, specifiers and native tab membership). Unknown market types remain explicit `special` markets instead of being guessed.

## Upgrade

This is a code-only update. SQLite schema remains 3 and no migration is performed:

```sh
chmod +x upgrade.sh rollback.sh configure-ggbet-relay.sh
./configure-ggbet-relay.sh /root/ggbet-relay-client.bundle
./upgrade.sh
```

The updater preserves the current container for rollback and reuses the exact production `/data` mount.

## 4.3.5 deployment repair

The updater no longer assumes that the production container is named `astek-monitor`. After an interrupted older update, it can discover the container actually serving host port 8080, preserve it for rollback, move an exited stale canonical container aside, and start the new release under a unique Compose project. It also treats a retryable HTTP 503 from the low-priority History endpoint as an expected realtime-priority deferral during deployment, while LIVE, prematch and leagues remain mandatory smoke checks.

## Stability timeout repair

The deployment stability check now requires six consecutive healthy samples,
with at most 18 probes. Each HTTP probe still has a five-second deadline,
including reading the response body. One timeout resets the healthy streak;
three consecutive timeouts or slow responses trigger rollback. HTTP errors,
invalid health data, memory limit violations, process exits and restarts still
fail immediately, with container diagnostics printed before rollback.

The event-loop metric is the maximum over a rolling reset period of 60 seconds.
A startup peak above 3000ms resets the healthy streak and is allowed to clear
within the bounded probe budget. A peak that does not clear fails the update.
Successful responses still must arrive within 4500ms and satisfy all memory
and SQLite identity/integrity checks. Application runtime and schema are unchanged.

After the original updater has finished restoring the previous container,
extract this corrected archive into a fresh directory as described in
`START-HERE.md`. Do not reuse a directory containing another update's rollback
records. The new updater builds the corrected image itself.
