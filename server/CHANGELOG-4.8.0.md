# Server 4.8.0 — GGBET full markets only for opened matches

API addition for extension 9.1; nothing is removed, SQLite schema unchanged, odds history stays off.

## Full markets on demand (leases)
- Before: every GGBET LIVE event got the "All" tab query, an `OnUpdateTab` stream and an `OnUpdateSportEvent` stream with
  every market id — 30 LIVE events = 30 full-market + 30 tab streams, all re-created on every session refresh.
- Now the LIVE catalog keeps every event with one **light** `OnUpdateSportEvent` stream limited to the top markets of the
  snapshot (score, status, main prices stay pushed). 30 events idle = 30 light streams, **0 full-market streams**.
- `POST /api/ui/full-markets {lease, action: acquire|release, id, provider}` — the match open in a detail panel. Acquire
  upgrades that event to the full tree inside the existing WebSocket (no reconnect, no bootstrap); a renewal extends the
  lease, the same lease with another match moves it (A → B), a non-GGBET provider releases it, the last release stops the
  upstream streams at once. Several clients on one match share one upstream stream (refcount).
- `GET /api/ui/event-detail?...&lease=<id>` acquires/renews too; without a lease (hover prefetch) it never subscribes
  full markets: it returns the light event, or the full tree cached after a recent release (`odds.fromCache`).
- `GGBET_FULL_LEASE_TTL_MS` (45 s; the extension renews every 10 s while the panel is visible) — a lease that is not
  renewed (browser crashed, laptop offline, lost release) expires and the subscription is stopped.
  `GGBET_FULL_CACHE_TTL_MS` (60 s, RAM only) — the last full tree for an instant reopen.
  `GGBET_MAX_FULL_EVENTS` (6) — safety cap on concurrently leased events; further events get the light data
  (`capped`), the main WebSocket is never closed for it.
- A match that leaves LIVE drops its leases and streams; a reconnect restores leased full streams in the new socket.

## Diagnostics (`/health` → `ggbetCollector`)
`ggbetCatalogEvents, ggbetLightSubscriptions, ggbetActiveFullMarketEvents, ggbetActiveFullMarketSubscriptions,
ggbetActiveFullMarketLeases, ggbetFullMarketSubscribes, ggbetFullMarketUnsubscribes, ggbetFullMarketLeaseExpirations,
ggbetFullMarketCapRejects, ggbetMaxFullEvents, ggbetFullLeaseTtlMs, ggbetFullCacheTtlMs, ggbetFullCacheEvents,
ggbetRootBootstrapFetches (0), ggbetRootBootstrapFailures (0), ggbetWsConnectionsCreated, ggbetReconnects,
ggbetBootstrapFetches, ggbetAuthRefreshes` — no token, cookie or proxy credential.
