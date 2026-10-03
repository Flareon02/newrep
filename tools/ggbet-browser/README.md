# GGBET Firefox browser worker (sidecar of esports-monitor 4.13+)

One real headless Firefox serves at most 3 (hard limit, even if `GGBET_BROWSER_MAX_PAGES` is higher) GG.BET LIVE match tabs, each with the full
"All" market tree. Their data comes from each page's own GG.BET WebSocket; the worker reads it and does not send anything
on it. esports-monitor reads the parsed data over the local socket (`server/src/ggbet-browser-source.js`) and publishes
those events from the browser; every other GGBET event stays with the Node collector.

## Selection (core.selectEvents)

- **Disciplines:** the provider sport ids from GG.BET's categorizer: `esports_counter_strike`, `esports_dota_2`,
  `esports_league_of_legends`.
- **Popularity:** GG.BET's own `RANK_RECOMMENDED` order, read by one discovery tab cycling through `/counter-strike/live`,
  `/dota2/live`, `/league-of-legends/live` (per-sport order) and `/live` (cross-sport order).
- **Cases:**
  - A: one top event per sport;
  - B: one per available sport, then the next most popular among them;
  - C: a single sport's top 3;
  - D: all available when there are fewer than 3.
- **Stability:** a held event stays while LIVE; rank changes never move a tab. A tab is replaced when its event:
  - ended;
  - is gone from its fresh sport list for `ENDED_GRACE_MS`;
  - was excluded as unrecoverable (3 reloads + 2 recreates within 30 min);
  - or for diversity: one swap per round, after `DIVERSITY_PRESENCE_MS` / `DIVERSITY_HOLD_MS`.
- **Warm-up:** the first selection waits for all sport lists (or two discovery cycles if a page fails). `selectionReady` is declared only after the selected pages are registered and the global provider order has arrived; a restarting worker never relinquishes old browser authority through an intermediate empty set. Cross-sport extra slots wait for the provider global order; no synthetic popularity score is used.
- **Safe handback:** a LIVE page marked `retiring` remains open until the server has published a fresh Node Czech-proxy copy and acknowledges its worker/session/page identity with `POST /handoff`. The slot remains occupied until that acknowledgement. Ended pages can close immediately.

## Network (fail-closed)

`ops/staging/ggbet-browser-netns.sh` builds the `ggbet-browser` namespace with **only** `lo` and the WireGuard interface
`wgbr0`. There is no veth or bridge, so the host's network is unreachable. An nftables killswitch inside the namespace
drops anything that is not `lo` or `wgbr0`, and DNS goes to the VPN resolver through the tunnel. If the tunnel goes
down, nothing can leave: there is no direct path, no host route and no proxy.

- `leaktest`: proves the above (exit IP, DNS path, tunnel-down result, host route unchanged).
- `ensure`: the unit's ExecStartPre. It keeps an intact namespace and rebuilds anything else.

The VPN config (`/root/.secrets/mullvad-browser/`) is used only by this worker. The production egress controller never
sees it.

## Liveness

| state | meaning |
|---|---|
| HEALTHY | event data flowing, prices moving |
| QUIET | event data flowing (or the discovery list confirms the page holds the current event version), prices unchanged; **not** a failure |
| SUSPECT_STALE | no event data for `EVENT_STALE_MS` and no list confirmation |
| STALE | no event data for `EVENT_STALE_MS` and no transport frame for `WS_STALE_MS`; or no data for `PAGE_STALE_MS`; or the list has shown a version the page never got for over `LAG_MS` |
| RECOVERING | loading, or after a reload until event data returns |
| ENDED | finished/closed, or absent from a *fresh* discovery list for `ENDED_GRACE_MS` |

Transport is only frames received from GG.BET (keep-alives included). Socket open/close does not count.

Self-healing order: page reload + "All" → after 3 reloads in 30 min, recreate the tab → if BiDi is lost, restart the browser. If
the VPN fails 2 probes, the state becomes VPN_DOWN: the browser is stopped and every page is published as UNAVAILABLE (all
markets stale). Recovery starts a new browser session with a fresh profile and an empty store, so pre-outage prices are
never served again.

The watchdog runs in its own loop, so a hanging navigation never stops staleness detection.

## Operations

```
ops/staging/ggbet-browser-install.sh [commit]   # /opt/ggbet-browser/releases/<sha>, unit, CLI; never touches esports-monitor
ggbet-browser status | selected | matches | markets <eventId> | stale | stats  [--json]
journalctl -u esports-monitor-ggbet-browser
```

- IPC: `/run/ggbet-browser/data.sock` (0660 ggbetfx:esports-ggbet-browser, dir 0750; members: ggbetfx, monitor). Endpoints:
  `GET /feed?since=` and `POST /handoff` (server), `/selected /health /matches /markets?eventId= /stale /snapshot /debug/frames`.
- NDJSON logs: `/var/lib/esports-monitor-ggbet-browser/log` (hourly, gzip, 24 h). No cookies, tokens or headers are
  logged; `connection_init` is never forwarded out of the page.
- Env: `GGBET_BROWSER_{MAX_PAGES,WS_STALE_MS,EVENT_STALE_MS,PAGE_STALE_MS,QUIET_MS,ENDED_GRACE_MS,LAG_MS,LIST_FRESH_MS,
  DIVERSITY_PRESENCE_MS,DIVERSITY_HOLD_MS,EXCLUDE_MS,DISCOVERY_STEP_MS,CONTENT_PROCESSES,EXPECTED_EXIT}`. LIVE only.
