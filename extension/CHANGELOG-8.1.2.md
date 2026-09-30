# Extension 8.1.2 — priority realtime

- Treats LIVE as the first client-side feed path; fallback polling performs LIVE before prematch rather than starting both paths in parallel.
- Watches at most 8 visible LIVE fixtures so Server 4.3.2 can keep their full odds detail warm.
- Bounds the client event-detail cache and reuses fresh entries to reduce repeated large downloads.
- Keeps an open odds dialog responsive to `detailChanged` while avoiding aggressive full-detail polling.
- Opens from a recent server warm tree immediately when available; explicit refreshes use `fresh=1` so the user can force current detail.
- Results use stale-while-revalidate: the existing list remains visible during refresh.
- Sends `deltaSince=<uiRevision>` and applies server `remove` / `upsert` / `order` patches instead of replacing the entire Results page when possible.
- History requests a fast newest-500 page first.
- Canonical History refresh happens during browser idle time and transparently replaces the approximate fast page.
- Older History pages are prefetched 500 at a time with multi-second throttling and respect server 202 deferrals while realtime work is busy.
- Prevents History background work from advancing pagination when a page was deferred.
