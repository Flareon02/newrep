# Server 4.7.0 — main-market quotes in thin feeds

API addition for extension 9.0; nothing is removed or renamed, SQLite schema unchanged.

- Thin UI feeds (`/api/ui/live`, `/api/ui/prematch`, `/api/live*?thin=1`) carry `quote` on every bookmaker ref that has a
  match-winner market: `{h, a, d?, s?, at?, stale?}` — prices of the bookmaker's own team order (home = its team1;
  clients flip it with `scoreReversed`, exactly like score patches), `s` = `s` suspended / `c` closed. About 40 bytes
  instead of a market tree: list rows and the odds comparison show prices without one request per match.
- Thin feed pushes (`/api/feed-stream?thin=1`): when a bookmaker's odds change, the patch adds the `quote` field (or
  `quote: null` when the main market is gone) next to `detailChanged`. Market trees still never travel in thin pushes.
