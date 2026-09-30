# Server 4.2.0 — thin shell transport

This is a code-only upgrade on the existing SQLite schema 3 database. No data migration is performed.

## Thin UI transport

- Adds `GET /api/ui/live` so both LIVE and Line are server-resolved UI feeds.
- `thin=1` now returns a deliberately small projection for LIVE, Line, Results and History: no bookmaker `odds` trees, no duplicate provider logos, no empty/default fields, and only compact lifecycle timestamps needed by cards/history.
- Adds `GET /api/ui/event-detail?view=live|prematch&id=...` for full current match data only when a user opens odds/generator detail.
- Thin `/api/feed-stream?...&thin=1` patches never carry market trees. An odds change emits `detailChanged: true`; open detail UI reloads only that match.
- High-frequency thin patches also omit the full provider-status/league-rules metadata block; they carry only feed revision/freshness metadata needed to reconcile the in-memory list.
- Thin SSE hello advertises `thinClient: 2` and updater smoke tests require it.
- `/api/ui/results` and `/api/ui/history` remain server-filtered/paged and return only the requested rows.
- `/api/ui/leagues` keeps league-relation scoring and current-fixture metrics on the server.

## Manual generator

- Adds `POST /api/odds/manual`.
- Manual CS2 Monte Carlo generation moved from a browser worker to a bounded server worker using the existing odds job queue/status API.
- The browser keeps only instant repricing of an already returned result when display margin/max-odds settings are changed.

## Compatibility and safety

- Existing non-thin API responses remain for old clients/rollback.
- SQLite schema stays at version 3; migration is not run.
- The Warsaw GGBET relay bootstrap flow is unchanged.
- Upgrade preserves the current production container for rollback and verifies health, thin endpoints and thin SSE before accepting the release.
