# Server 4.2.1 — Astek LIVE priority / anti-stall

- Astek LIVE requests now outrank prematch work in the shared upstream gate.
- Added a hard gate watchdog so a stalled prematch response cannot keep LIVE stale for minutes.
- Gate timeout aborts the underlying Astek fetch via AbortSignal.
- `/health.runtime.astekGate` now reports `activeKind` and `activeForMs` for diagnosis.
- SQLite schema remains 3; this is a code-only update.
- Extension 8.0.0 remains compatible and does not need replacement.
