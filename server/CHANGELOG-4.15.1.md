# 4.15.1 — bounded SQLite busy retry

- Retry SQLITE_BUSY/LOCKED batches for up to five seconds instead of immediately dropping history.
- Bound queued changes to 4,096 records / 8 MiB; expose retry/error/queue counters.
- Flush pending retries on graceful shutdown; permanent disk failures remain fail-open.
- Refresh the extension latest history page every five seconds while keeping older pages in place.

Production observation of 4.15.0 recorded two write errors (four dropped records); the gap is not reconstructed or hidden.
