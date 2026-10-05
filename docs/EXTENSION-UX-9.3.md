# Extension 9.3.0 — UX / performance redesign

Frontend only. No server, collector, routing or protocol change: everything below uses parameters the current API
already supports (`/api/ui/history` with `phase`, `hours`, `end`, `limit`, `offset`; `queryUiEvents` in
`server/src/ui-service.js`). Works with the existing production backend (server 4.15.x).

## 1. Why History froze (measured, not guessed)

Profiled with `tools/ux/ux-harness.mjs profile` (CDP CPU profile, real Chromium, the unpacked extension, a mock API
running the server's own `queryUiEvents` over 1,900 synthetic matches, 450 ms simulated server time per History page,
a server History invalidation every 10 s like the production SSE stream sends on structural feed changes).

1. **Full re-render of every accumulated row on every page arrival.** `renderHistory()` rebuilt the HTML of *all*
   loaded rows (no per-row memo), parsed it through one big `<template>` and diffed the whole subtree with
   `morphInto()`. Profile of the old build: `morphInto` 3.5 s self time, ~6.4 s native parse/style/layout, `logoUrl`
   1.3 s (a `new URL()` per logo per row per render), `stamp`/`Intl` 0.7 s.
2. **Refetch storms.** Every render called `loadHistoryPage(i)` for every page that was not "fresh" (60 s), and every
   server `ui-invalidate` for History (sent on each structural feed change) marked **all** pages stale. Result: all
   loaded pages re-requested, each response triggering another full re-render → single long tasks of 8.6 s (loading)
   and 22.9 s (idle).
3. **Chained auto-loading.** The IntersectionObserver was disconnected/re-observed after each render, so a sentinel
   near the viewport immediately fired again.
4. **"Показать ещё" did nothing** while the last page was still loading or had failed (`showMoreHistory()` returned
   silently), and the old UI could not get past ~1,000 rows within 15 s per step.

## 2. Before / after (same harness, same data, same machine)

| Phase | Metric | Before | After |
|---|---|---|---|
| Open History | first rows visible (ms) | 2378 | 1231 |
| Open History | requests / bytes | 1 req / 208 KB | 4 req / 199 KB |
| Open History | longest task (ms) | 285 | 418 |
| Open History | list DOM nodes | 5305 | 3291 |
| Load older | rows reachable | 1000 | 1128 |
| Load older | requests / bytes | 12 req / 2534 KB | 14 req / 1234 KB |
| Load older | total long tasks (ms) | 23991 | 1296 |
| Load older | longest task (ms) | 8600 | 336 |
| Load older | max main-thread lag (ms) | 16919 | 337 |
| Load older | list DOM nodes | 26120 | 1822 |
| Load older | JS heap (MB) | 43.1 | 7.3 |
| Idle 40 s, invalidation every 10 s | requests / bytes | 2 req / 430 KB | 8 req / 398 KB |
| Idle 40 s, invalidation every 10 s | total long tasks (ms) | 23859 | 54 |
| Idle 40 s, invalidation every 10 s | longest task (ms) | 22909 | 54 |
| Switch to LIVE while History loads | LIVE paint (ms) | 147 | 50 |
| Switch to LIVE while History loads | longest task (ms) | 161 | 0 |
Notes: "rows reachable" after = the harness clicks *"Загрузить <следующий день>"* (one page per day); the rest of each
day is behind that day's "Показать ещё", and the unit test `older days load one at a time … until the archive ends`
proves every one of the 1,900 matches is reachable exactly once. The machine is a shared single-core VM that also runs
the production server; run-to-run variance of a single long task on History open is 0.4–0.9 s, which is native
style/layout work (JS in that task ≈ 0.1 s).

## 3. History architecture (`extension/history-loader.js`)

Sections, each a small query; nothing loads the whole archive:

| Section | Query | First page |
|---|---|---|
| Сейчас в LIVE | `phase=live` | 100 |
| Сейчас в линии | `phase=line` | 50 |
| Today, yesterday, … (removed from line/LIVE) | `phase=removed&hours=<day>&end=<end of day>` | 100 |
| Summary (remaining count, game facets) | `phase=removed&limit=1` | 1 |

- First screen: LIVE + line + today + summary (4 requests). Older days: one at a time, newest first, on scroll
  (IntersectionObserver + a rAF scroll check) or the explicit button "Загрузить <день> · осталось N"; a day with more
  matches has its own "Показать ещё" (offset paging). Empty days are skipped automatically; six empty days in a row
  pause with "Искать раньше". The end shows "Это вся история по фильтрам".
- Cache per query (LRU 4) and per section; a filter/search change aborts the previous query's requests (late
  responses are ignored); returning to a query is instant. Past days are fresh for 15 min, current sections for 60 s.
- Server invalidations mark only LIVE / line / today; they are refreshed at most every 30 s and only while History is
  on screen. A render never triggers a refresh.
- Rendering: keyed `patchTree` per section with a per-row HTML memo (only changed rows are parsed). Sections more than
  ~1.5 screens away are parked (rows unmounted, placeholder of the measured height) → a few hundred rows in the DOM.
- Last-known first sections are persisted (≤300 rows) for an instant first paint after a restart.

## 4. Other changes

- **Collapse/expand** (`line-collapse.js`): one icon toggle at the right of the Line tools row; closed games are
  remembered, open leagues are session-only and forgotten when their game or everything collapses → every reopen is
  "games open, leagues collapsed". Chevron disclosure everywhere (Line, detail logs, CS2 players/log).
- **Match panel**: the open match clicked again (or Enter) closes the panel; another match switches; a price cell of
  another bookmaker in the open match switches the bookmaker.
- **Detail**: compact header (game · league, teams + logos, score, one status line, icon actions); «Матч» tab = one
  bookmaker table (link, start, first seen, LIVE/end, score) + tools; the lifecycle log and admin score diagnostics are
  folded. Removed duplicates: "Появился" chip, separate first-seen table, second copy button.
- **CS2**: board (map, round, clock, bomb state; per team side badge, alive pips, economy, round score), round timeline
  with side-coloured outcome icons (elimination, explosion, defuse, timeout; "способ не передан" when the data has no
  type — never guessed), half separators, current-round marker, legend; players folded open; **event log collapsed by
  default**. The dead "×" close button and the duplicated "Статистика CS2" title are gone.
- **Streams**: `UiKit.streamLinks` for CS2 and Dota — same height/radius/type, service icon, truncated name, full name
  in the tooltip, unusable URLs dropped.
- **Context menu**: right click / Menu key / Shift+F10 on a match: copy "Team A - Team B", either team, or the long
  form; on a bookmaker badge, price or bookmaker button: open / copy that bookmaker's match URL — disabled with an
  explanation when the feed has no URL. "Скопировано: …" toast.
- **Game filter**: keyboard-accessible listbox with local SVG glyph tiles (`game-icons.css`, generated by
  `tools/ux/build-game-icons.py`; no remote assets) and counts. Hearthstone, Apex, EA FC, NBA 2K, TFT, Wild Rift added
  to the categories.
- **Toolbar**: one grid in every tab (search · game · section filters · favourites/reset); section filters never wrap
  (they scroll sideways), fixed control widths; two fixed rows under 900 px. Verified identical boxes on all 5 tabs.
- **GGBET / DataBet**: GGBET has its own show/hide switch (popover and Settings) like the other bookmakers — a display
  preference only; the service worker still requests `provider=ggbet`. DataBet: no filter, setting, badge, column or
  label; a stored DataBet preference resolves to GGBET; DataBet refs are never visible.
- **Logos** (`logo-resolver.js`): merged logo → bookmaker refs → logos learned in other views (match detail, CS2
  board, other lists; persisted, ≤1,500) → placeholder. A URL that failed is never requested again (verified: each
  broken logo requested once). Validation is memoised (the old per-render `new URL()` cost).
- **Theme**: tokens in `ui.css` for dark and light (`:root[data-theme="light"]`), «Как в системе» follows the OS;
  top-bar toggle + Settings → Отображение → Тема; applied before first paint by `theme-boot.js`.
- **Icon**: pulse + converging feeds + live dot on a dark tile (sources in `tools/ux/icon/`, rendered by
  `tools/ux/render-icons.mjs` to 16/32/48/128; the 16/32 variant has heavier strokes).

## 5. Verification

- `node --test extension/test/*.test.mjs` — unit tests incl. `history-loader.test.mjs` and `ux-930.test.mjs`.
- `node tools/ux/ux-harness.mjs verify` — real-browser acceptance checks (panel toggle, CS2 log collapsed, copy match
  name, bookmaker URL available/unavailable, History request plan, toolbar stability, game menu keyboard, Line fold
  semantics, GGBET toggle + no DataBet, broken-logo retry storm, theme persistence).
- `node tools/ux/ux-harness.mjs measure|screens|profile` — the numbers and screenshots above.

## 6. Known limitations / backend notes

- No backend change was needed. The day query uses `hours` + `end` (the server's existing window filter); a dedicated
  `day=` parameter and a `minClock` in the summary would make the requests self-describing and let the UI show the
  oldest available day without probing — optional, not required.
- The server counts game facets before the phase/time filters, so game counts in History are over all phases and all
  time (same as before).
- Thin payloads carry logos only at event level; per-bookmaker logos appear once a full payload (match detail,
  statistics) has been seen.
- Results still grows its single list with "Показать ещё" (not part of this task's History redesign).
- Measurements come from a synthetic dataset and a mock server, not production data.
