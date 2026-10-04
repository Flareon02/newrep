# 4.15.0 — SQLite score/odds history in the match card

- Asynchronous buffered history for AstekBet, Fonbet, Pinnacle and authoritative GGBET publication rows.
- Raw prices, old/new changes, receive/update timestamps, event version and Browser/Node provenance.
- Additive schema v4, indexed market/time/context queries, seven-day sliding row cleanup and minimum-free guard.
- Read-only `/api/events/:eventId/history`, bounded cursor pagination and bookmaker/market/time filters.
- Extension 9.2.0 **История** button with 100 recent changes, bookmaker filters and load-more.
- Current-snapshot persistence can remain disabled while odds history is enabled; DataBet remains opt-in/off.

See `docs/MATCH_HISTORY.md` in the repository for load-test limits and rollback.
