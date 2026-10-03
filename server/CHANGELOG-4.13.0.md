# Server 4.13.0 — hybrid GGBET source (Firefox browser worker for 3 LIVE events + Node collector for the rest)

Based on 4.12.0 (4c6a5e3). The undeployed guard change 88b05eb is not part of this release.

## Hybrid source (src/ggbet-browser-source.js, src/ggbet.js)
- **Browser-selected events:** at most 3 LIVE GGBET events, chosen by the Firefox browser worker from GG.BET's own ranking:
  CS / Dota 2 / LoL, one per discipline first. Discovery uses the provider's dedicated sport `/live` pages and global `/live` order; truncated lists never expire a held page.
  - Published from the worker's parsed data: the raw GG.BET event and its full "All" market tree, read from Firefox's own
    WebSocket over `/run/ggbet-browser/data.sock`.
  - Parsed with the same `parseGgbetLiveEvent` as Node events, so the event id, schema and API/SSE are unchanged.
  - Raw provider values are published as received; no odds are corrected.
- **All other GGBET events:** the Node collector (light streams, leases, full markets). Browser updates cannot renew freshness for disconnected Node copies; old Node prices are removed and marked stale in hybrid publication.
- **Arbitration, per event:** `node` | `browser` | `browser-unavailable`. One row per event, never mixed: a
  browser-owned event has no Node markets.
  - Node → browser only when the worker reports the event ready (page healthy/quiet, identity confirmed, All tree
    received, fresh).
  - Browser → node only when the event was really deselected (settled selection) and the Node event is fresh in the current connection. A retiring LIVE page remains open until publication succeeds and the server acknowledges its worker/session/page identity.
  - Browser cannot serve an owned event (VPN_DOWN, page stale, browser restarting, IPC lost): the event stays visible with
    every price removed and `odds.stale`. Node odds are never silently substituted. Modes persist across server restarts
    (`DATA_DIR/ggbet-browser-arbiter.json`).
- **Full markets:**
  - A lease on a browser-owned event creates no Node full-market subscription; `detail()` returns the browser tree.
  - A Node full subscription that predates the handoff ends at the handoff.
  - The pricing monitor skips browser-owned events.
- **Admin:** `GET /api/admin/ggbet-browser` (admin.diagnostics + token) returns:
  - selected events: rank, selection reason, page state, market count, source, VPN exit;
  - Node event count and freshness;
  - handoff history and IPC state.

  `/health` for admins carries `ggbetCollector.browserSource`; anonymous `/health` is unchanged.
- Cold-start selection is not settled until the chosen pages are registered and global provider order has arrived. Persisted browser ownership remains fail-closed throughout asynchronous warm-up.
- Initial browser handoff requires the complete All snapshot. Later catalog additions do not suspend an otherwise fresh browser event while newly announced market prices are arriving. Reload/session changes clear the snapshot readiness evidence.
- Server validates feed timestamps, page identity, session changes, catalog completeness and freshness evidence independently. QUIET remains valid with a recent matching provider version; expired IPC/data fails closed.
- **Config:**
  - `GGBET_BROWSER_SOURCE=1` (default off);
  - `GGBET_BROWSER_SOCKET` (default `/run/ggbet-browser/data.sock`);
  - `GGBET_BROWSER_POLL_MS` (1000);
  - `GGBET_BROWSER_IPC_STALE_MS` (5000).

## Network
- The Node collector goes back to `GGBET_NETWORK_MODE=proxy` (the Czech HTTP proxy from server.env). The separate Node Mullvad
  egress controller is stopped and disabled after successful cutover.
- The Zagreb Mullvad tunnel is used only by Firefox in the `ggbet-browser` namespace.

## Rollback
1. Disable browser authority: `GGBET_BROWSER_SOURCE=0` in server.env, then `systemctl restart esports-monitor`. Every
   event is back on Node through the Czech proxy.
2. Or roll back the server release: `esports-monitor-rollback` (to 4c6a5e3). Keep `GGBET_NETWORK_MODE=proxy`; never
   direct, never Zagreb.
3. Stop the sidecar separately: `systemctl stop esports-monitor-ggbet-browser`.
