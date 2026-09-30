# Server 4.3.0 — GGBET market semantics

- GGBET market meaning is now determined server-side from stable `typeId` + specifiers instead of localized market text or outcome shape.
- Added canonical families for the CS2 market types observed in the supplied GGBET HAR, including race-to-rounds, map 1X2 without overtime, map winner with overtime, round handicaps/totals, pistol markets, exact scores and combined markets.
- Unknown GGBET `typeId` values are preserved as `special` with the bookmaker raw title. They are never guessed to be Winner merely because they contain home/away outcomes.
- GGBET native tabs (`Popular`, `All`, `Rounds`, `Match`, `Map N`, `Half N`) are fetched from `GetMarketsTabs` / `GetMarketsTab` and attached to each market separately from the monitor's universal semantic categories.
- `/api/ui/event-detail` is now the single detail-hydration boundary for the thin client: full Astek and GGBET LIVE markets are hydrated server-side on demand.
- GGBET signed handicap outcomes preserve their individual +/- points.
- New odds-history writes persist `rawType`, `rawTitle`, specifiers, native tabs and canonical semantics for audit-safe replay.
- SQLite schema remains 3. No data migration is required.
