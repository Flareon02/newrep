# GGBET Firefox browser worker (experimental sidecar)

One real headless Firefox, up to `GGBET_BROWSER_MAX_PAGES` (10) GG.BET Dota 2 LIVE match tabs, each with the full
"All" market tree. Data comes from each page's own GG.BET WebSocket; the worker reads it and does not send anything on it.
It runs separately from esports-monitor and does not replace the Node collector.

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
ggbet-browser status | matches | markets <eventId> | stale | stats  [--json]
journalctl -u esports-monitor-ggbet-browser
```

- IPC: `/run/ggbet-browser/data.sock` (0660, dir 0750 ggbetfx:monitor), `GET /health /matches /markets?eventId= /stale /snapshot`.
- NDJSON logs: `/var/lib/esports-monitor-ggbet-browser/log` (hourly, gzip, 24 h). No cookies, tokens or headers are
  logged; `connection_init` is never forwarded out of the page.
- Env: `GGBET_BROWSER_{MAX_PAGES,WS_STALE_MS,EVENT_STALE_MS,PAGE_STALE_MS,QUIET_MS,ENDED_GRACE_MS,LAG_MS,CONTENT_PROCESSES,EXPECTED_EXIT}`.
  `GGBET_BROWSER_FILL_PREMATCH=1` is for capacity tests only: it fills free slots with upcoming matches.
