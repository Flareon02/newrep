# Extension 8.1.0 — server-authoritative sportsbook markets

- The odds dialog trusts server canonical market semantics and no longer infers GGBET meaning from translated text or the number/shape of outcomes.
- GGBET's real bookmaker tabs are displayed as a dedicated row: Popular, All, Rounds, Match, Map N and Half N.
- Universal monitor categories (Winners, Rounds, Handicaps, Totals, Score, Combo, Special) remain a separate semantic filter.
- Selecting Astek or GGBET with missing detail now rehydrates the whole selected event through `/api/ui/event-detail`; the extension no longer calls the Astek provider-specific markets endpoint directly.
- Unknown legacy GGBET markets without canonical metadata are shown as Special with their raw bookmaker title rather than guessed as Winner.
- The operational bookmaker indicators introduced for 8.0.0 are retained: no misleading age-seconds/red state when a source simply has no new fixture update.
