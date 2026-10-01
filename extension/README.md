# Esports Monitor Extension 8.3.0 — priority realtime, LIVE odds provider GGBET or DataBet

New in 8.3.0: the LIVE odds provider selector (GGBET | DataBet), see `CHANGELOG-8.3.0.md` (DataBet needs server 4.5.0).

Designed for Server 4.3.x (4.3.5 or later recommended). Client scheduling is LIVE-first, visible LIVE fixtures (maximum 8) are registered for bounded server-side odds warming, Results refresh through deltas while stale rows remain visible, and History paints the newest 500 first before canonical/older pages are fetched in idle gaps.

See `CHANGELOG-8.2.0.md` (configurable server address and access token) and `CHANGELOG-8.1.2.md` for details.
