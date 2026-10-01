# Server 4.6.0 — proxy egress for GGBET/DataBet, odds history switch

SQLite schema stays at 3, no migration. Without the new variables the server behaves exactly like 4.5.0.

## Added

- **Network mode per LIVE odds platform collector** (`src/egress.js`). `GGBET_NETWORK_MODE=proxy|relay|direct`,
  `DATABET_NETWORK_MODE=proxy|direct`. In `proxy` mode the whole session goes through one HTTP CONNECT proxy
  (`CZECH_PROXY_ENABLED/HOST/PORT/USERNAME/PASSWORD`): the bootstrap page that issues the guest token **and** the GraphQL
  WebSocket, including reconnects and token refreshes. One `https-proxy-agent` instance per process with the credentials
  exactly as configured, so a sticky proxy session keeps one egress IP. Proxy mode fails closed: if the proxy is disabled or
  incomplete the collector reports an error and never connects directly. GGBET without an explicit mode keeps the 4.5.0
  rule (relay when `GGBET_BOOTSTRAP_RELAY_URL` is set, otherwise direct); the relay code is unchanged and still used in
  `relay` mode.
- Proxy credentials are never logged or returned: `/health` shows host/port and `credentials: set|missing` only; error
  texts are redacted. Optional diagnostics: the proxy's public IP/country/ASN (`network.proxy.egress`, checked at start and
  every 30 min through the same proxy; collectors do not depend on it).
- **`ODDS_HISTORY_ENABLED`** (default `1`). With `0`: no odds journal (`odds_entries_v3`, `odds_state`) for any source, no
  current-snapshot rows with market trees (`snapshot_current` is neither rewritten nor deleted), and LIVE/Line states are
  not restored from SQLite at start — they start empty and stale and fill from upstream within seconds. Current odds are
  served from memory as before. The ids that were current are kept in `snapshot_meta` so the first update after a restart
  still records the correct entered/removed lifecycle for History and Results. Stored history is not deleted and stays
  readable.
- `/health` → `persistence` (`oddsHistoryEnabled`, `dbWritesSinceStart` = SQLite `total_changes()`,
  `dbOddsWritesSinceStart`, `writesByCategory`), `network`, and per provider `networkMode`, `freshnessMs`,
  `lastMessageAt`, `reconnects`.

## Still written with `ODDS_HISTORY_ENABLED=0`

`snapshot_meta` (one row per feed, at most once a minute), `snapshot_history` (compact fixture rows without odds: History
page and Results), `score_entries`/`score_meta` (score changes only: score history), `archive_blobs` (Results archive),
`meta` (markers).

## Dependency

`https-proxy-agent` 7.0.6 (with `agent-base`, `debug`, `ms`).
