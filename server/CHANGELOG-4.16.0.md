# Server 4.16.0 (with extension 9.4.0)

Audit release: canonical markets, match timeline/replay, access fixes, per-user settings. LIVE, collectors, authority
and network routing are unchanged.

## Root causes fixed

| Symptom | Root cause | Fix |
|---|---|---|
| «История счёта» → HTTP 401 | `score-cache.js` requested `/api/score-history` without the `Authorization` header; the statistics and Pinnacle live streams (EventSource) were opened without `access_token` | the request carries the key; streams use `ServerConfig.streamUrl()`; 401/403 show a clear message and stop polling (no endless error) |
| Granted «Лиги и связи» not shown | `filterForPrincipal` spread the league catalog lists (`providers.astek = [...]`) into objects for every user without `admin.diagnostics`; the screen could not read them | lists under a bookmaker key stay arrays; regression test with two users |
| Rights changed by the administrator not applied to an open session | feed streams kept the principal of connect time | the server sends `entitlements` to that user's streams and closes them; the extension reloads `/api/me` and refetches the feeds under the new rights |
| Settings shared between keys/users on one browser | prefs lived in one global `prefs` key | profiles per user + key, synced with the server (`/api/me/settings`) |
| Fonbet handicaps shown on the wrong team / mixed lines | unknown factor ids were classified by guesswork (side = sign of the line; "opposite points ⇒ handicap"; "adjacent ids ⇒ total") and handicaps were grouped by `|line|`, so home -2.5 and home +2.5 shared a row | verified factor table (price monotonicity on the journal, >99 %); unknown factors stay unknown; rows keyed by the home line |
| Same bet split into rows by bookmaker wording | the extension guessed market families from localized titles (incl. "two outcomes ⇒ winner") | server-side canonical registry from structured ids only (see below) |
| Event history blocked the LIVE thread | `/api/events/:id/history` inflated journal rows synchronously on the main event loop | runs in the timeline worker (nice 19, own heap limit, idle stop) |
| `/health` stalls | a cold `COUNT(*)` over the odds journal on the main thread (~0.5 s) | counted in the history writer worker every 5 min |
| History observations on the LIVE thread | every collector update posted every event (full market tree, structured clone) to the writer | unchanged events (score state + markets) are not posted |

## Canonical markets (semantics v2) — `server/src/market-registry.js`

- Identity = family + parameters that change the bet: map, half, round, target (race-to N, Nth kill…), side, line
  (home perspective for handicaps), overtime (`included` / `excluded` / `unspecified`), unit, variant (player…).
  `eventKey` is the same identity oriented to the merged event (reversed bookmakers swap sides and mirror lines).
- Mapping from structured provider data only: GGBET/DataBet typeId + specifiers + outcome ids (verified on 231k
  journal observations); Fonbet factor ids; Pinnacle type/period/side/`units`/bestOf; Astek group + outcome templates.
  Anything else is `unknown` with its raw identity, recorded in a bounded unknown-market log; never a winner by
  guesswork. Overtime is never assumed: Fonbet/Astek generic handicaps/totals are `unspecified` and are not merged with
  `included`.
- Every market keeps its raw data (`canonical.raw`: provider type, title, specifiers) and the mapping rule; journal rows
  are re-normalized when read, so a corrected rule applies to stored history without rewriting the database.
- Coverage on the production journal: `docs/MARKET-COVERAGE.md` (tool: `tools/market-coverage.mjs`).

## Timeline / replay

`GET /api/events/:id/timeline/meta`, `GET /api/events/:id/timeline?from&to&cursor&limit&kinds&provider&market`,
`GET /api/events/:id/state-at?at&provider&market&cats&detail` (aliases under `/api/ui/event/:id/…`). Reconstruction
replays journal deltas up to the instant only (never later rows), from in-memory checkpoints (bounded LRU). A GGBET
Node↔Browser handoff starts a new baseline. CS2 statistics rounds observed by the instant are included.

## Settings

`GET /api/me/settings?ns=ui`, `POST /api/me/settings {namespace, baseVersion, payload}` → 409 with the current row on a
stale base. Storage: `DATA_DIR/user-settings.sqlite3` (new, separate file; WAL; created on first use). A rotated key
starts from the same user's settings (`inheritedFrom`); other users never see them. `/api/me` adds `keyId`,
`entitlementsRevision`, `features`.

## Data / compatibility

- `monitor-v2.sqlite3`: no schema change. New journal rows carry `bestOf` and `units` (optional JSON fields).
- New file `user-settings.sqlite3`. Rollback to 4.15.1 needs no data restore.
- Market keys of Fonbet handicaps change (home line instead of |line|): their history starts a new baseline after the
  update.
- Older extensions keep working (semantics v1 fields kept: `canonical.family/title/category/...`).

## Deployment

`server/upgrade-systemd.sh` / `server/rollback-systemd.sh` for the systemd layout (`/opt/esports-monitor/releases`),
with backup, health check and automatic rollback. The Docker scripts (`upgrade.sh`, `rollback.sh`) are unchanged.
