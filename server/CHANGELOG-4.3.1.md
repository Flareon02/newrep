# Server 4.3.1 — odds hydration + History/Results latency

- `/api/ui/event-detail` marks hydrated refs with the requested live/prematch phase so a thin client never drops full odds after hydration.
- Results recover `firstPrematchAt` directly by same-provider identity instead of resolving 14 days of prematch history through the cross-book matcher.
- The merged History view is warmed in the background after structural invalidations.
- Early updater failures no longer stop/rename the production container before rollback has actually been prepared.
- SQLite schema stays at 3; no migration is performed.
