# Extension 9.2.0 — faster lists, Line hierarchy, canonical score, user capabilities

Works with server 4.7+; user capabilities and the Users editor need server 4.9.0 (an older server: everything except
administration, as before).

## Speed
- Arrow navigation: one frame per key repeat, cached row list, sticky-header aware scrolling; the detail follows after
  the key is released. Handler p95 13.1 ms → 2.7 ms (list), 204 ms → 3.3 ms (detail open); 302 detail + 151 lease
  requests per long key press → 2 + 2.
- Feed updates patch rows by key (no full list rebuild): a 200-match LIVE update 95.7 ms → ~20 ms; the shell is not
  re-rendered.

## Layout
- 360–1440 px without sideways scrolling: two-line rows in a narrow list, the tab strip on its own row, the detail as a
  drawer with a backdrop under 1180 px, one scroll container in the detail with sticky tabs; the settings menu becomes a
  strip above the section in a narrow window.
- The detail closes on Escape, a click on empty list space or on the backdrop; clicks inside it or on another row keep it.

## Score
- One score format everywhere: `1:0 (13:6, 5:3, 0:0)` with the current map in bold; the score is chosen across
  bookmakers (series first, then maps started, then recency); a disagreement is visible to administrators only.
- "Появился" (first seen, bookmaker and time) in the row title and the detail.
- CS2 (Crossbet) round timer never runs backwards; it freezes when the data goes stale.

## Line, comparison, logos
- Line: game › league groups with counts, expand/collapse all, the state survives refreshes and reopening, arrow keys
  walk the headers (Enter / Space toggle).
- Comparison: sort by arbitrage % (ascending / descending, numeric, stable, remembered).
- Team logos fall back to another bookmaker's logo of the same canonical team.

## Users and settings
- The GGBET / DataBet switch left the main screen: Settings → Источники → «Коэффициенты LIVE» (Авто / GGBET / DataBet);
  Auto keeps the working feed and returns to the server default when neither works.
- Sections, bookmakers, prices and tools the user may not use are not shown (`GET /api/me`, checked every minute and
  applied without reinstall). No sections → «Нет доступных разделов»; a key is required → «Нужен ключ доступа».
- Settings for a user: Отображение, Источники, Уведомления, Подключение («Ключ доступа»), Резервная копия, О программе.
  Administrators additionally get Лиги и связи, Пользователи and Диагностика.
- Settings → Пользователи (administrators): create a user (the key is shown once), pick capabilities and
  «Включить выбранные / Выключить выбранные / Выключить все» → «Сохранить», rotate the key, disable, delete (confirmed
  by a second click). The server enforces everything; the extension only hides.
- Error texts for users are plain («Сервер недоступен», «Нет доступа к этому разделу» …) — no addresses, proxies or internal reasons;
  administrators keep the technical detail.
- Notifications only for sections the user may see and with the `notifications` capability.

## Combined SQLite match history (server 4.15.0)
- Match detail **История**: score, market state and odds changes, exact old/new values, UTC timestamps.
- All/AstekBet/Fonbet/Pinnacle/GGBET filters; 100 changes per API page, **Показать ещё**.
- GGBET Browser/Node publication provenance is displayed separately; no diagnostic shadow prices.

## UX redesign (candidate, same version 9.2.0)
Frontend only: no server, collector or routing change. Details and measurements: `docs/EXTENSION-UX-9.2.md`.
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
