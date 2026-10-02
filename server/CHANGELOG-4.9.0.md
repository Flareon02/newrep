# Server 4.9.0 — users and capabilities enforced by the server

API addition for extension 9.2. SQLite schema unchanged, odds history stays off, collectors unchanged (Astek polling,
GGBET session lifecycle, DataBet lifecycle are not touched).

## Users
- `users.json` in `DATA_DIR`: id, name, role (`user` / `admin`), disabled flag, capabilities, SHA-256 hash of the key
  (keys look like `emu_…`, shown once on create / rotate, never stored or logged in clear).
- `API_TOKEN` stays the administrator key. With it set (`ACCESS_CONTROL=auto`, default) every API read needs a key;
  without it the server behaves as before (open, no administration).
- A new user has **every capability off**; a missing capability means denied. Changes apply on the next request
  (no reinstall, no restart); disabling a user or rotating the key cuts the old key off at once.

## Capability registry (25 stable keys)
Sections `live.view prematch.view results.view compare.view history.view`; bookmakers `provider.astek provider.fonbet
provider.pinnacle provider.ggbet provider.databet`; data `odds.live odds.prematch odds.fullMarkets odds.history
scores.history statistics.view`; tools `compare.arbitrage compare.schedule tools.generator leagues.manage`; functions
`notifications favorites`; administration `admin.panel admin.diagnostics admin.users`.

## Enforcement
- Every route has a requirement (`routeRequirement`); a route not in the table needs `admin.diagnostics` (closed by
  default). 401 without a valid key, 403 without the capability or the bookmaker.
- Responses are filtered per user: bookmaker refs, per-bookmaker lists, provider status/errors and odds of bookmakers
  the user may not see are removed; without `odds.live` / `odds.prematch` prices are stripped and fixtures stay.
  ETags include the user's capability set.
- SSE: each client carries its user; patches, hello and invalidations are filtered the same way.
- Full markets (`/api/ui/full-markets`) need `odds.fullMarkets` and `provider.ggbet`.
- `/health` without an administrator key is a bare `{ok}`; `/api/status` and diagnostics need `admin.diagnostics`.
- A key in `?access_token=` is accepted only on stream endpoints (EventSource cannot send headers).

## New endpoints
- `GET /api/me` — the caller's capabilities and role (anonymous with no capabilities when a key is required).
- `GET /api/admin/capabilities` — the registry with labels and groups.
- `GET/POST /api/admin/users`, `POST /api/admin/users/<id>` (name, role, disabled, capabilities),
  `POST /api/admin/users/<id>/token` (rotate), `POST /api/admin/users/<id>/delete`. An administrator cannot disable,
  demote or delete themselves (409).

Tests: `server/test/entitlements.test.js`.
