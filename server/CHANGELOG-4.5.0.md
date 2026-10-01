# Server 4.5.0 — DataBet as a second LIVE odds provider

Built on 4.4.0 without changing the data model: SQLite schema stays at 3 and no migration is performed.
A request that does not name a provider gets exactly the 4.4.0 LIVE result (GGBET).

## Added

- **DataBet LIVE collector** (`src/databet.js`, public `https://demo.data.bet`). An ordinary server-side GraphQL-WS
  client, no browser: the guest token is read from the public page (`window.bettingOptions`) on every session start and
  kept in memory only; the endpoint carries the operator label (`?label=...`). DataBet is the DATA.BET sportsbook GGBET
  runs on, so the schema and market typeIds are the same and the pure normalization helpers are shared with `ggbet.js`;
  GGBET's persisted-query hashes are not registered there, so all operations are sent as plain GraphQL text.
  - Every LIVE esports event streams fixture + top markets (`onUpdateSportEvent`, ~2.5 KB/push). The complete market tree
    and DataBet's native tabs (Popular / Match / Map N / Kills …) are pushed only for events whose odds dialog is open:
    each detail request extends a window (`DATABET_FULL_MARKETS_TTL_MS`, 3 min; at most `DATABET_MAX_FULL_EVENTS`, 4).
  - Pushes are absolute event states (never deltas); a push is only applied to the event its subscription was opened for;
    finished events leave the feed; a reconnect discards the previous session's full market tree until the new one delivers.
  - Odds are stored exactly as received: `decimal` from `value` (null while a market/outcome is closed), plus the upstream
    `probability` and raw `rawValue` per outcome. Nothing is corrected or re-priced (asymmetric odd/even stays asymmetric).
  - Snapshot every 30 s, session/token refresh every 10 min, watchdog 90 s, exponential reconnect back-off, publish
    debounce 400 ms. All tunable through `DATABET_*` (see `src/config.js`); `DATABET_LIVE_ENABLED=0` turns it off.
- **LIVE odds provider selection**: `provider=ggbet|databet` on `/api/ui/live`, `/api/live`, `/api/ui/event-detail`
  (view=live) and `/api/feed-stream`. Each provider is a separate resolved LIVE variant (`live` / `live~databet`): the two
  providers are never merged, revisions/ETags carry the variant, and a feed stream only receives the LIVE patches of its own
  provider. The DataBet variant is resolved only while someone uses it (15 min idle → dropped from RAM). An unknown
  provider is `400`, a provider the server does not run is `503`.
- **Provider status**: `/health` and `/api/status` add `live.databet`, `databetCollector` and `oddsProviders`
  (`connectionState` connected / reconnecting / unavailable / disabled, `available`, events, markets, `lastUpdateAt`,
  `lastError`); `GET /api/ui/odds-providers` returns the same summary; UI LIVE payloads name `liveOddsProvider` and carry
  the provider status so the extension can show "DataBet временно недоступен" instead of a spinner.
- `GET /api/live/databet` (single-provider feed, like `/api/live/ggbet`).

## Unchanged on purpose

GGBET collector behaviour, Astek/Fonbet/Pinnacle/HLTV/Hawk, matching core (DataBet attaches like GGBET as an extra
provider and never enters the Astek/Fonbet core), Results/History/Leagues (DataBet is LIVE-only, like GGBET, and is not
part of league linking), odds/score journals (not recorded for DataBet).
