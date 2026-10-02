# Server 4.8.0 — GGBET full markets only for opened matches, long-lived session

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

## Session lifecycle
- No timed session refresh by default (`GGBET_SESSION_REFRESH_MS` = 0; a value ≥ 60000 restores the old behaviour).
  The 8-minute refresh came with the original import with no upstream evidence: no expiry in the code or logs, and the
  saved diagnostics of the last proxied session ended by our own timer (`scheduledRefreshes 1, authRefreshes 0`).
- A healthy WebSocket stays open. Renewal only for a real reason: close, auth/connection_init rejection (4401/4403/1008),
  network error, the watchdog (no message for `GGBET_WATCHDOG_MS`), or an expiry the token itself declares (`exp` in
  its public header, renewed a minute before; exposed as `tokenExpiresAt`, the token never is).
- The bootstrap stays one GET of the public LIVE page per new session (token from `bettingClientOptions`), through the
  same proxy agent as the WebSocket; no root page fetch, no cookies (not needed by the evidence).

## Quiet full streams
- Score and odds come in one `OnUpdateSportEvent` stream per event. A leased full stream that stops pushing while the
  event moves on (two snapshots ≥ 10 s apart show other prices for its markets, no push in between) is restarted
  inside the same WebSocket and the snapshot prices are applied (`ggbetFullStreamResyncs`); the session is not touched.
  Light events already get fresh top-market prices from every 30 s snapshot. See `docs/GGBET-SESSION-LIFECYCLE.md`.

## Bootstrap origins and diagnostics
- Trusted bootstrap origins are an exact static list (`GGBET_TRUSTED_ORIGINS` = `https://gg.bet`). The old default
  `GGBET_ORIGINS` also listed gg397.bet, gg253.bet, gg284.bet, ggbets.co, ggbet242.com and ggbet24.com, which the
  origin check (`*.gg.bet` only) always rejected *after* fetching their page; they are removed from the default and
  from `docker-compose.yml`, and any configured origin outside the list is ignored (shown in the diagnostics).
- Redirects of the bootstrap page are walked hop by hop (`proxyFetch` gained an opt-in `followRedirects: false`;
  existing callers, DataBet included, keep following): a hop may only lead to a trusted host over https; anything
  else is refused without being requested.
- A page without the token, a refused redirect, an origin-wide status (403/407/429) or a proxy failure costs one
  request per attempt (the next attempt, after the ff1beab back-off, starts with the next trusted origin).
- `GET /api/admin/ggbet-bootstrap` (API token required): the last 10 attempts — requested/final host, HTTP status,
  redirect count and host chain, Set-Cookie seen (true/false) and whether a browser would have sent it on the next hop
  (from the Domain attribute only), content type, body kind (html/json/empty/other) and size, token-extraction result
  (`ok`, `marker-missing`, `token-missing`, `token-short`, `endpoint-invalid`, `origin-untrusted`) and a normalized
  reason (`ok`, `http-status`, `redirect-untrusted`, `too-many-redirects`, `token-extraction`, `geo-blocked`,
  `network`, `timeout`). Never a token, cookie name/value, header value or body; nothing of it is in `/health`.

## Diagnostics (`/health` → `ggbetCollector`)
`ggbetCatalogEvents, ggbetLightSubscriptions, ggbetActiveFullMarketEvents, ggbetActiveFullMarketSubscriptions,
ggbetActiveFullMarketLeases, ggbetFullMarketSubscribes, ggbetFullMarketUnsubscribes, ggbetFullMarketLeaseExpirations,
ggbetFullMarketCapRejects, ggbetFullStreamResyncs, ggbetMaxFullEvents, ggbetFullLeaseTtlMs, ggbetFullCacheTtlMs, ggbetFullCacheEvents,
ggbetRootBootstrapFetches (0), ggbetRootBootstrapFailures (0), ggbetWsConnectionsCreated, ggbetReconnects,
ggbetBootstrapFetches, ggbetAuthRefreshes, expiryRefreshes, tokenExpiresAt` — no token, cookie or proxy credential.
