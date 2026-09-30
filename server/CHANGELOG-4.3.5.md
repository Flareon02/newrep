# Server 4.3.5 — deploy History deferral fix

This is a deployment-only correction on top of the 4.3.4 single-core runtime.

## Fixed

- The 4.3.4 updater no longer treats an intentional HTTP 503 from `/api/ui/history` as a failed deployment when the response is marked `retryable:true`.
- A retryable History deferral is now considered proof that realtime priority protection is active: LIVE/prematch/leagues remain critical smoke checks, while History may yield to them during startup.
- History timeouts and non-retryable errors still fail the update.
- Keeps the 4.3.4 Docker topology repair for interrupted/renamed containers.
- Stability probes remain bounded to 5 seconds and still reject excessive event-loop lag, RSS or heap use.
- Fixes an immediate rollback after a single stability timeout: require six consecutive healthy samples within 18 probes, and fail on three consecutive timeout/slow responses.
- Allows the 60-second event-loop peak to clear after startup within that same bounded budget.
- Checks container state and restart count before and after each sample, including the final one; prints diagnostics before a failed stability check rolls back.
- Adds HTTP timeout/body timeout and deployment-loop regression tests.

## Runtime

No application runtime behavior changed from 4.3.4. SQLite schema remains 3 and no migration is performed.
