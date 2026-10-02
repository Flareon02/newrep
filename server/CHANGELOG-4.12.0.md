# Server 4.12.0 — bounded pricing observer, operator session verification, transport qualification

## Pricing observer (ggbet.js, GGBET_PRICING_MONITOR=1)
- At most ONE LIVE Dota 2 event at a time: its EXISTING light `OnUpdateSportEvent` stream also lists `96m1..96m5`
  (Total kills odd/even per map). Same WebSocket, same session, no bootstrap, no extra subscription; re-subscribed only
  when the event's light market set changes (as before). The typeId 96 markets go to the forensic log/pricing guard
  raw and are stripped from the public row (UI unchanged).
- An event that delivers no typeId 96 within `GGBET_PRICING_MONITOR_NO_DATA_MS` (5 min) is skipped for 2 h; at most
  `GGBET_PRICING_MONITOR_MAX_MS` (3 h) per event; a user's full lease already has every market (no duplicate);
  event gone → monitor cleared with the normal unsubscribe. No eligible event → `waiting-for-eligible-event`.
- Caveat: LIVE odd/even of the map being played can legitimately become asymmetric near its end.

## Session vs egress diagnosis — operator triggered, observe only
- `esports-monitor-ggbet reset-session [reason]`: clean session on the SAME egress (token/agent/WS dropped, new
  bootstrap). The fresh session is classified from new samples only: SESSION_DEGRADED (≥ min samples over the window,
  none unusual), EGRESS_SUSPECT (anomaly confirmed again), INCONCLUSIVE (not enough samples in 15 min). Recorded in the
  log, the incident and per-egress statistics; nothing switches automatically. PRICING_CONFIRMED incidents carry the
  operator hint.

## Egress controller
- Transport qualification of the other configs in a SEPARATE namespace (`ggbet-egress.sh qualify`): WireGuard
  handshake + exit metadata, no proxy, no GGBET traffic, torn down after; one config per 10 min, only while the
  active egress is healthy, re-checked after 24 h. A failed check keeps a config out of selection for 6 h.

## Fixes
- A deactivated egress is shown INACTIVE (was still ACTIVE), also after a restart.

Tests: `server/test/ggbet-monitor.test.js` (9).
