# Extension 9.3.0 — new UI: progressive History, themes, CS2 board

Works with the current production server (4.15.x); no server change. Rollback: extension 9.2.0.
Frontend only: no server, collector or routing change. Details and measurements: `docs/EXTENSION-UX-9.3.md`.
- History loads progressively: «Сейчас в LIVE», «Сейчас в линии», then one section per day (today first); older days
  load one at a time on scroll or by an explicit button; per-query cache, obsolete requests are cancelled, server
  invalidations refresh only LIVE / line / today (at most every 30 s). Far-away sections are unmounted (bounded DOM).
- One collapse model: the Line's single fold toggle; reopening always gives games open and leagues collapsed.
- Clicking the open match again closes the detail; another match switches to it.
- Detail: one status line, icon actions, one bookmaker table (link, start, first seen, LIVE/end, score); logs folded.
- CS2 board redesigned: sides, alive players, economy, round timeline with side-coloured outcome icons and a legend;
  the event log is collapsed by default. One stream-link component for CS2 and Dota.
- Right click / Menu key: copy «Team A - Team B», either team, or the bookmaker's match URL (only when the feed has one).
- Game filter with local game icons; stable shared filter bar on every tab.
- GGBET is switched on/off like the other bookmakers; DataBet is no longer shown anywhere.
- Light theme (and «Как в системе») through design tokens; new extension icon (16/32/48/128).
- Team logos: merged → bookmaker refs → logos learned in other views; broken URLs are never requested twice.
