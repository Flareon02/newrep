# Extension 8.3.0 — LIVE odds provider: GGBET or DataBet

Needs server 4.5.0 for DataBet. With an older server the GGBET choice keeps working unchanged; choosing DataBet shows the
server's answer ("DataBet не подключён…") in the LIVE notice instead of data.

## Added

- **"Коэф. LIVE [GGBET | DataBet]"** in the bookmaker toggles. Exactly one LIVE odds provider is active; clicking the
  other one switches, clicking the active one hides/shows it (the old GGBET toggle behaviour). The choice is stored in
  `prefs.liveOddsProvider` (default GGBET), survives closing/reopening and browser restarts, and takes effect at once:
  the service worker drops the previous provider's LIVE feed, refetches LIVE with `provider=…` and reconnects the event
  stream for the new provider. The first snapshot after a switch only seeds "seen" fixtures, so switching never fires a
  burst of "new match" notifications.
- **No mixing**: LIVE cards, the source status pills, the "Только …" filter, the odds dialog and event-detail requests
  (and their cache) all follow the selected provider; refs of the other provider are never shown. DataBet, like GGBET,
  stays out of Results and History, and League linking keeps its four bookmakers.
- **Odds dialog for DataBet**: full markets come from the server detail (as for GGBET), with DataBet's native tabs
  (Популярные / Матч / Карта N / Kills …).
- **Unavailable provider is explicit**: when the selected provider is disconnected, stale, disabled on the server or the
  server refuses it, LIVE shows "DataBet временно недоступен — причина" with a button to switch back. A reconnect inside
  the server's 45 s grace window (token refresh) does not flash the notice.
