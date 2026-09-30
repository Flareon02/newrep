# Server 4.4.0 — production hardening

Built on 4.3.5 without changing its data model: SQLite schema stays at 3 and no migration is performed.
Every new behaviour is either additive or off by default. See `docs/AUDIT.md` for the findings behind each item.

## Added

- **Leveled logger** (`LOG_LEVEL`, default `info`). Per-poll chatter moved to `debug`, repeated identical lines
  are collapsed, secrets are redacted, long lines are truncated.
- **Unified error envelope** `{ok:false,error,code,requestId}` for every status >= 400 (the legacy `error` string and
  fields such as `matched`/`retryable` are kept). Internal JavaScript/SQLite error text is logged, not sent to clients.
  `X-Request-Id` is set on every response.
- **Optional API token** (`API_TOKEN`, >= 16 chars): required for POST endpoints, league-rule publishing and HLTV
  lookups. Unset = open, exactly like 4.3.5. Read-only feeds and `/health` stay open.
- **`POST /api/ui/odds-watch`**: accepted again (extension 8.1.x sends it; 4.3.5 answered 405). The list is validated and
  reported in `/health`; full-odds warming stays removed (it caused the 4.3.2 regression).
- **SSE protection**: global cap (`API_SSE_LIMIT_TOTAL`), `server.maxConnections` (`API_MAX_CONNECTIONS`), and slow
  readers are dropped once their buffer exceeds `API_SSE_MAX_BUFFER_BYTES`.
- **Opt-in retention** (`ODDS_RETENTION_DAYS`, `SCORE_RETENTION_DAYS`, `STATISTICS_RETENTION_DAYS`; default 0 = keep
  everything; fixtures still in a feed are never pruned; shutdown waits for a running pass) and `/health` `storage.diskLevel` with throttled low-disk warnings.
- `package-lock.json` and `npm ci` in the Dockerfile; `.dockerignore` keeps `.env`/`secrets`/`test` out of the build context.
- `prune-old-releases.sh`: dry-run-by-default cleanup of old backups, failed containers and unused images.

## Unchanged on purpose

API routes and payloads, collectors, matching, SQLite schema, container hardening, 1 vCPU / 1 GiB tuning
(`PREMATCH_CONCURRENCY=1`, 320 MiB heap, worker heap limits), updater/rollback logic (only version strings changed).

## History no longer lives entirely in RAM

Every History row used to be resident (~1.1 KB each, seven snapshots, up to 100 000 rows per snapshot), so memory grew
with the retention period and ~280 000 rows no longer fit the 320 MiB heap at startup. SQLite was already storing every
row with indexed time columns, so it is now the source of truth and RAM keeps only a hot window:

- `HISTORY_HOT_DAYS` (default 7; 0 = old behaviour) rows with recent activity stay resident; older rows are read from
  SQLite on demand (`publicHistory`, `recentHistory`, new `historyByStart`, `hasHistoryId`) and overlaid with resident rows,
  so answers are identical to the fully-resident model (differential test with random data).
- Re-entering an old fixture reads its row by primary key, so first-seen time and lifecycle are preserved.
- Results' day archive and Pinnacle's "already started" check query SQLite instead of scanning/copying every row.
- Two additive indexes (`snapshot_history(name,first_seen_at)` and `(name,removed_at)`) are created on first start; no
  migration of data. Older servers ignore them.
- Fixes an ordering bug: after the periodic prune the resident list was newest-first, so `recentHistory` could return
  the oldest rows instead of the newest ones.
- Measured (synthetic, heap cap 320 MiB): 7 x 100 000 persisted rows -> 14 112 resident, RSS 101 MiB, load 0.6 s
  (before: 7 x 40 000 rows crashed the heap).
