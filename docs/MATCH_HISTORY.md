# SQLite match history

Server 4.15.1 and the updated extension 9.2.0 use the primary `monitor-v2.sqlite3` database.
The match detail **История** button opens a newest-first UTC score/odds timeline with bookmaker filters,
100 visible changes per page, and **Показать ещё**. Latest-page refresh runs every five seconds; older pages stay in place. Existing score and odds snapshot views remain available.
Updating/reloading the extension files is required to get the new button; a server deployment cannot install UI code on a user's device.

## Storage and publication

The additive schema v4 migration preserves `score_entries`, `score_meta`, `odds_entries_v3` (DEFLATE level 1)
and `odds_state`. `publication_source` columns and time/context indexes are added. `odds_history_market_refs`
indexes native/derived market identities without decompressing all event payloads. Legacy rows are explicitly
`legacy-unspecified`: missing raw precision or provenance cannot be recovered retrospectively.

Only publication observations are recorded. GGBET input is taken from the arbiter's resulting rows;
unpublished Node shadows and unavailable browser prices are excluded. Logical provider `ggbet` remains compatible
with old endpoints; `publicationSource` is `ggbet-node` or `ggbet-browser`. Each handoff starts a new source baseline,
so the two contexts are never joined into an artificial price movement. Authority and network routing are unchanged.

Odds payloads include observation/receive/update UTC times (with receive semantics), provider/event IDs,
eventVersion when available, sport, marketId/typeId/status/period/specifiers, outcome ID/name, raw provider odds,
odds format, decimal odds, old/new values and baseline flag. Pinnacle raw American values and decimal values are
stored separately. Astek/Fonbet factor-derived IDs are labeled as derived where native IDs do not exist.
Score payloads include previous/new score and event state, map/period, clock, status, betStop, version and provenance.
Version-only/clock metadata is attached to relevant changes; identical snapshots do not create journal rows.
Map/period, event status and betStop changes are shown as event-state observations even if the score is unchanged.
Browser `sourceReceivedAt` is server Unix IPC receipt; worker event-update time is separate. It is not claimed to be
Firefox's actual network timestamp, which the production IPC does not expose.

## Writer and retention

`SQLITE_HISTORY_ENABLED=1` selects the asynchronous SQLite worker and bypasses legacy per-snapshot journals.
`ODDS_HISTORY_ENABLED=1` explicitly enables odds history. Keep `SNAPSHOT_CURRENT_ENABLED=0` and
`HISTORY_TOUCH_PERSIST_MS=900000` to avoid re-enabling large current-snapshot writes.
Set `ODDS_RETENTION_DAYS=7`, `SCORE_RETENTION_DAYS=7`, `HISTORY_MIN_FREE_MIB=4096`.
The SQLite worker uses bounded observation credits, 250 ms buffered transactions, a 150 ms busy timeout,
and independent error/drop counters. SQLITE_BUSY/LOCKED batches retry for up to five seconds,
with at most 4,096 queued change records and an 8 MiB queue; permanent errors fail open. Disk failure must not reject a collector update.
Every 30 seconds, up to 500 old odds rows and 500 old score rows are deleted using time indexes,
including rows belonging to active events. Market reference rows cascade on deletion; old dedup metadata is pruned.
Free SQLite pages are reused; no production VACUUM or separate raw/file journal is needed.
Below the minimum-free guard, history observations are dropped and diagnostics show `diskBlocked`; collectors continue.
This emergency behavior may create history gaps. Short-term guard/queue drops are visible under admin health
`persistence.sqliteHistory`. Seven-day retention is configured, not a promise during disk outages.

## API

`GET /api/events/:eventId/history?from=ISO-or-ms&to=ISO-or-ms&provider=fonbet&marketId=ID&limit=100&cursor=OPAQUE`

Provider filters: astek, fonbet, pinnacle, ggbet, ggbet-node, ggbet-browser. Limits 1–500.
Response: `entries`, `scoreTimeline`, `oddsTimeline`, `hasMore`, `nextCursor`, window and retention.
Entries have stable IDs and carry old/new values; initial values are marked `baseline`.
Cursor pagination also covers outcomes inside one large market update. The first page freezes the upper timestamp;
changing filters invalidates a cursor. A market filter uses the new reference index; legacy rows without native IDs
cannot be retrospectively mapped to it. Score rows are omitted when a market filter is active.
Merged live/line IDs resolve through the server views. Archived cards supply bounded `ids` from the previously
returned provider refs/aliases. Direct provider identities such as `fonbet:123` are also accepted.
Existing `scores.history`, `odds.history` and bookmaker capabilities govern individual returned timelines.
No source fetch, full-market lease or public SSE change is required by a history request.

## Validation and load measurement

Use `tools/history-loadtest.mjs` on an isolated SQLite backup for local API/Unix IPC capture, then
`tools/history-replay.mjs` to separate migration/baseline growth from steady updates.
The initial two-minute all-provider capture had 5,391 observations, no API/capture errors;
corrected replay estimated 185,774 rows/day, 437 MiB/day DB growth, 0.41 transactions/second,
0.43% of one CPU and 4.1 MiB peak WAL. Threefold seven-day planning estimate: 9.0 GiB.
These are short-window estimates; polling can miss fast intermediate updates, and production metadata may add rows.
Monitor actual writer counters, DB/WAL size, event loop and source freshness after enabling.

`tools/history-ui-proof.mjs` loads the real unpacked extension in Chromium, uses the normal authenticated
request client, and checks saved real API changes render as old → new with bookmaker filtering.
Disposable profiles containing the API token are removed and never packaged.

## Rollback

Restore the previous server release and its saved environment (history disabled), then restart only
`esports-monitor`. The additive database migration needs no reversal. Keep Node on the Czech proxy;
do not change authority, restart Firefox or touch cloudflared. Previously stored history remains in SQLite.
