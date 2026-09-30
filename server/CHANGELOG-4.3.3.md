# Server 4.3.3 — single-core realtime stability

Production target: 1 vCPU, 1 GiB RAM host, 768 MiB container limit.

## Root causes fixed

- 4.3.1 rebuilt the complete merged History view after structural feed changes. On a single CPU core this could monopolize the process long enough to push `eventLoopMaxMs` into multi-second spikes.
- 4.3.2 attempted to remove that latency by detaching odds journal work and using asynchronous compression without global backpressure. Fast LIVE updates could then enqueue compression/SQLite work faster than one CPU core could drain it, causing RAM growth, heavy block I/O, health timeouts and aborted collectors.

## Realtime priority

- Priority stays `LIVE > prematch > odds/detail > results > history`.
- Results now use the shared low-priority Astek gate and yield while LIVE/prematch/detail work is active.
- History has no automatic warm/rebuild job. It runs only on request, waits for a realtime-idle slot and returns a cached stale page instead of competing when possible.
- History work is paged and executed in a worker thread. Recent provider history is scanned from the tail rather than copying the full lifetime ledger.
- Matcher workers use smaller heaps and terminate after idle periods to return RAM to the 1 GiB host.

## Single-core tuning

- `PREMATCH_CONCURRENCY=1`.
- `UV_THREADPOOL_SIZE=2`.
- Node old-space cap is 320 MiB.
- Results background warmup is reduced to 7 days, starts later and runs at 10-second spacing.
- Statistics matching uses one worker and a 10-second sweep cadence.
- API gzip uses level 1; `/health` is not compressed.
- SQLite health metrics are cached for 30 seconds instead of counting the million-row odds journal on every health request.
- Snapshot watchdog is 10 seconds and league catalog watchdog is 120 seconds; structural feed changes still refresh immediately.

## Safety

- The updater uses bounded health requests and fails/rolls back on >3 s event-loop stalls, excessive memory, restart, or health timeout.
- SQLite schema remains 3. No migration is performed and the existing production `/data` is reused.
