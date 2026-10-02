# Server 4.11.0 — GGBET through a Mullvad pool (transport failover, proxy last resort), richer 24 h forensics

Builds on 4.10.0. Astek, Fonbet, Pinnacle, DataBet, odds history, users/capabilities and the extension are unchanged.
The GGBET session model is unchanged: one bootstrap, one long-lived WebSocket, light catalog streams, leased full
markets; a healthy session and a healthy egress are never replaced on a timer.

## Egress pool (server/src/ggbet-vpn-pool.js, tools/ggbet-egressd.mjs, esports-monitor-ggbet-egressd.service)
- Root controller; every `/root/.secrets/mullvad/*.conf` is a pool member (discovered, not hard-coded; dir 0700 and
  files 0600 enforced; contents only ever read inside ggbet-egress.sh). One active egress at a time.
- Selection: last known good → longest healthy run → fewest network failures → preferred (`ggbet-good.conf`) → untested.
- Switching is driven by TRANSPORT health only: namespace/WireGuard missing, WireGuard handshake older than 300 s, or
  the exit probe failing while the service itself reports network-level failures. 3 failing checks (≥ 90 s) →
  re-establish the same egress once per 30 min → otherwise cooldown (30 min, doubling, ≤ 6 h) and next config;
  ≤ 3 switches/hour. GGBET's own answers (403 region page, token missing) and pricing anomalies are recorded by the
  service and never move the egress.
- A candidate is brought up and verified (exit probe through its socket) before the service sees it in status.json;
  re-establishing the same exit keeps the published status (the service keeps its session).
- Last resort: the existing HTTP proxy (`CZECH_PROXY_*`) when no Mullvad config is usable or the switch budget is
  spent; at least 30 min, then one Mullvad candidate per 30 min is verified and restored.
- The collector chooses its agent per connect (`networkMode()`): netns, or proxy while the controller runs the
  fallback; every egress change ends the session and starts a clean one (no token, cookie or WebSocket carried over).

## Forensics
- GraphQL operations sent (name, id, event/tab, market count), stats every minute (data age, WS, subscriptions,
  leases, reconnects, log volume), transport signals; buffered asynchronous writes for high-volume kinds.
- Incidents: the last 10 min of timeline (pricing, WS, session, operations, egress) and, 5 min later, the after-window.
- Pricing guard unchanged: observe only.

## CLI
`esports-monitor-ggbet status` (egress type Mullvad / fallback proxy, VPN healthy run, bootstrap/WS counters, next
candidate), `vpns` (pool statistics), `switches`, `qualification`, plus sessions/history/incidents/tail, `--json`.

Tests: `server/test/ggbet-vpn-pool.test.js` (11) + `ggbet-forensics.test.js` (12).
