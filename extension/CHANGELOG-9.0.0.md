# Extension 9.0.0 — product redesign

Esports Monitor becomes an everyday monitoring product: one dark, dense, readable interface; LIVE first; odds,
History and the match detail are part of the product. Requires server ≥ 4.7.0 for prices in lists and the odds
comparison (older servers still work: rows then show bookmakers instead of prices).

## Interface
- Calm header: product name, five sections (LIVE · Линия · Результаты · Сравнение · История), one "Источники 3/4"
  status with a popover (state, last update and visibility switch per bookmaker), Settings.
- LIVE: grouped by league (or newest/oldest first); two-line team rows with series and current-map score, Bo/map
  status and the match-winner price of every bookmaker in aligned columns. The best price of a side is marked (and
  announced to screen readers); a change shows ▲/▼ for 20 s — never colour alone.
- Match detail is a persistent right panel (an overlay drawer below 1180 px): header with score and status; tabs
  Коэффициенты / Статистика / Матч. Bookmaker switch, native GGBET/DataBet tabs or Матч/Карта N, market types,
  search. The main market appears instantly from the list; the full tree is patched in when it arrives. Refreshes
  keep the bookmaker, tab, search and scroll position.
- Line: grouped by game and league (expanded; collapsed leagues are remembered) or by time, with start time and prices.
- Results: compact rows with final score, maps, verification and end time; date navigation; cached per date.
- Compare: odds comparison (main market across bookmakers, best prices, margin, arbitrage) — LIVE or Line; the
  schedule-file tool of 8.x is the second mode.
- History: first page from the bounded fast path, further pages while scrolling.
- Settings is a full view: Отображение, Источники, Уведомления, Сервер, Лиги и связи (moved from the main
  navigation), Диагностика (no longer behind a password), Резервная копия, О программе.
- Keyboard: Ctrl+1…5 sections, ↑/↓ matches, Enter opens the detail, Esc closes it; visible focus everywhere.

## Speed (see docs/UI-PERFORMANCE-9.0.md)
- Navigation never waits for the network: every section keeps its own rendered list and scroll position; feeds,
  results and history are served from memory and refreshed in the background (stale-while-revalidate).
- The last-known LIVE/Line lists, today's results and the first History page are saved and shown at start-up, marked
  "сохранено … · обновляем", then patched with fresh data — also when the service worker had been stopped.
- Event details: LRU cache (40), deduplicated requests, prefetch on hover/focus, cancellation of requests nobody needs.
- Switching GGBET ↔ DataBet keeps AstekBet/Fonbet/Pinnacle rows on screen instead of clearing LIVE.

## Behaviour changes
- Odds and History are shown by default (8.x hid them behind password dialogs). Odds can be hidden in Settings.
- A bookmaker's upstream failure no longer reports "нет связи с сервером": server unavailable and provider unavailable
  are separate states (service worker fix for SSE `status` events).
- The theme selector is gone (dark interface). League links and diagnostics are Settings sections.
- Notifications, server/token settings, favourites, hidden leagues, statistics panels, score history, odds timeline
  and the CS2 generator are unchanged.
