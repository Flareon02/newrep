# Web / Tauri UI handoff — reference: Esports Monitor Extension 9.3.0

The approved extension 9.3.0 UI is the visual and functional reference for the new web app (https://esportsdata.online)
and the Tauri portable desktop app. This document lists what can be taken over and how.

Legend — **REUSABLE DIRECTLY**: copy the file/logic as is (pure JS/CSS, no Chrome APIs).
**PORT WITH ADAPTATION**: same design/behaviour, rewrite the glue (framework, routing, storage, transport).
**EXTENSION-SPECIFIC**: exists only because of the browser-extension platform; do not port.

Source of truth: `extension/` at the 9.3.0 commit. Data contract: the same server API (`docs/API-CONTRACT.md`);
no new endpoint is needed for parity.

## 1. Design tokens — REUSABLE DIRECTLY
`extension/ui.css` → the two blocks `:root{…}` (dark) and `:root[data-theme="light"]{…}`. Copy them verbatim into a
`tokens.css` (or generate a Tailwind/TS token map from them). Groups:

| Group | Tokens |
|---|---|
| Surfaces | `--bg --surface --raised --surface-hover --control --overlay --group-bg --selected --mkt-head` |
| Lines | `--line --line-strong --line-soft --line-hover` |
| Text | `--text --text-2 --muted --faint --on-accent` (contrast on `--surface`: ≈14:1 / 8:1 / 5:1 dark, 15:1 / 9:1 / 4.8:1 light) |
| Accent | `--accent --accent-strong --accent-hover --accent-soft --accent-line` (one accent only) |
| Semantics | `--good/-soft/-text --warn/-soft/-text/-line --bad/-soft/-text/-line --up --down --best-text --best-line` |
| Bookmakers | `--astek --fonbet --pinnacle --ggbet` (markers only, never large fills) |
| CS2 / streams | `--ct --ct-soft --t --t-soft --twitch --youtube --kick --vk` |
| Shape / motion | `--radius-s 6 --radius 8 --radius-l 12 --focus-ring --ease --shadow` |

Rule: components reference tokens only (no hex in component CSS). The light theme is a re-tuned palette, not an
inversion.

## 2. Spacing and sizing — REUSABLE DIRECTLY
Spacing scale `--s1..--s5` = 4 / 8 / 12 / 16 / 24 px. Controls: `--control-h` 32 px (buttons, inputs, selects,
listbox button), `--control-h-s` 26 px (segmented, small), toolbar `--toolbar-h` 48 px, top bar 52 px, list rows
≥ 56 px, icon buttons 32 px (28 px inside rows), minimum hit target 28 px. Row grid: `.cols` templates in `ui.css`.

## 3. Typography — REUSABLE DIRECTLY
System font stack (`--font`), base 14 px / 1.45, scale `--fs-xs 12 · s 13 · m 14 · l 16 · xl 20`; 12 px is the
minimum for secondary text; numbers use `font-variant-numeric: tabular-nums` (scores, odds, clocks). Column headers:
12 px, 600, uppercase, letter-spacing .04em.

## 4. Themes — PORT WITH ADAPTATION
Three modes: dark (default) · light · system (`prefers-color-scheme`, live-updated). Resolved scheme is
`html[data-theme]`. Apply before first paint (extension: `theme-boot.js` + localStorage mirror). Web: inline the same
5-line boot script in `<head>`; Tauri: read the stored mode and set `data-theme` before mounting.

## 5. Game icons — REUSABLE DIRECTLY
`tools/ux/build-game-icons.py` → `game-icons.css`: one-node tiles, CSS-mask SVG glyphs, colour per game via
`--gc-<key>` for both themes; key mapping from `extension/game-categories.js` (`GameCategories.info(name).key`).
Unknown games fall back to the abbreviation tile. All glyphs are generic local shapes (no trademarked logos, no
remote assets). Copy both files.

## 6. Bookmaker marks and team logos
- Bookmaker marks (`.book-mark`, `.chip.book`, coloured 3 px bar + short name) — REUSABLE DIRECTLY.
- Team logo resolution `extension/logo-resolver.js` — REUSABLE DIRECTLY (pure): merged logo → bookmaker refs →
  learned logos → placeholder; only server-cached `/api/team-logos/<hash>` and the CDNs the server allows; a failed
  URL is never requested again. Persistence of learned logos — PORT WITH ADAPTATION (extension uses
  `chrome.storage.local`; web: IndexedDB/localStorage; Tauri: app data store).
- Extension icon / brand mark: `tools/ux/icon/icon.svg` (≥48 px) and `icon-small.svg` (16/32 px) — REUSABLE
  DIRECTLY (favicon, Tauri app icon; generate .ico/.icns from the SVGs).

## 7. Reusable components
| Component | Source | Verdict |
|---|---|---|
| Listbox with icons (game filter) | `ui-kit.js` `listbox()` | PORT WITH ADAPTATION (keep keyboard model: arrows, Home/End, Enter, Esc, typeahead, `aria-activedescendant`) |
| Context menu | `ui-kit.js` `contextMenu()` | PORT WITH ADAPTATION (Tauri: may use native menu; keep the same items) |
| Chevron / fold toggle | `ui-kit.js` `chevron()`, `foldIcon()` | REUSABLE DIRECTLY |
| Stream links | `ui-kit.js` `streamLinks()`, `service()` | REUSABLE DIRECTLY |
| Panel click decision, copy model | `ui-kit.js` `panelClick()`, `matchName()`, `matchCopies()`, `bookLink()` | REUSABLE DIRECTLY |
| Keyed list patching (`patchTree`, row memo) | `app.js` | PORT WITH ADAPTATION (a framework's keyed list gives the same; keep "unchanged row = untouched node") |
| Toast "Скопировано: …" | `app.js` `toast()` | PORT WITH ADAPTATION |
| Empty / loading / error states (`.state`, skeleton rows) | `app.js` `renderState()`, `skeleton()` | PORT WITH ADAPTATION |

## 8. LIVE rows — PORT WITH ADAPTATION
Row = favourite star · game/league meta · two team lines (logo + name) · score cell (series bold + map scores, current
map bold, "Карта N · BoX") · one price column per visible bookmaker (best price highlighted only when ≥2 books price
that side; ▲▼ change marks for 20 s) · chevron. Group by league (sticky game/league header with count and league
star) or flat by time. Narrow (<620 px container): teams+score on line 1, bookmaker prices on line 2 with short labels.
Click toggles the detail (see §10); right click opens the copy menu.

## 9. Collapse behaviour — REUSABLE DIRECTLY
`extension/line-collapse.js`: closed games remembered; open leagues session-only and forgotten when the game or
everything collapses → reopening always yields "games open, leagues collapsed". One icon toggle at the right of the
tools row ("Свернуть все игры" / "Развернуть все игры"). Search/favourites filter expands everything.

## 10. Match details — PORT WITH ADAPTATION
Header: game · league · icon actions (history, favourite, copy, close) · two team lines with logos · big score + map
scores · one status line (LIVE chip, BoX, map, start / in LIVE since). Tabs: Коэффициенты · Статистика (when
available) · Матч. «Матч» = one bookmaker table (link, start, first seen, LIVE/end, score) + tools; lifecycle log and
admin score diagnostics folded. Behaviour: same match clicked again closes; another switches; Escape / backdrop
closes; drawer under 1180 px. Markets: bookmaker switch, search, provider tabs/scopes, category chips, sticky period
headers. Extension-only part: the GGBET full-market *lease* is a server contract (`/api/ui/full-markets`) — keep it.

## 11. History architecture — REUSABLE DIRECTLY (logic) / PORT WITH ADAPTATION (rendering)
`extension/history-loader.js` is framework-free: sections LIVE (`phase=live`, 100) · line (`phase=line`, 50) · one
per day (`phase=removed&hours=…&end=<end of day>`, 100, offset paging) · summary (`limit=1`). Older days one at a time
(scroll or button), empty days skipped (pause after 6), per-query LRU cache, AbortController per query, invalidations
mark only current sections and are applied by the caller (throttle 30 s, only while visible). Rendering must keep:
per-section keyed updates, row memo, windowing of far sections (or a virtual list). Unit tests:
`extension/test/history-loader.test.mjs` (run them against the web build too).

## 12. Filters / toolbar — PORT WITH ADAPTATION
One grid in every section: search · game listbox · section-specific filters (never wrap; scroll sideways) ·
favourites / reset (reset keeps its slot). Two fixed rows under 900 px. Section filters: LIVE sort; Line mode
(leagues/time) + time window; Results date navigator + time window; History phase + time window; Comparison
mode/scope/sort. Filters live in per-section state, never read back from the DOM. Search debounce: 60 ms (local),
250 ms (server-backed).

## 13. CS2 components — REUSABLE DIRECTLY (markup/CSS) / PORT WITH ADAPTATION (data wiring)
`cs2-panel.js` + `stats.css`: map pills; board (map · round · clock · bomb/phase; per team side badge CT/T, alive
pips, economy, round score); round timeline (side-coloured outcome icons: elimination, explosion, defuse, timeout;
"способ не передан" when the data has no type; half separators; current-round marker; legend); players table
(K/A/D, alive/dead); event log collapsed by default. Clock: `cs2-clock.js` (monotonic, freezes when stale) — REUSABLE
DIRECTLY. Data: `/api/statistics/*` (stream via SSE, max 2 concurrent detail streams).

## 14. Stream components — REUSABLE DIRECTLY
`UiKit.streamLinks(links)` + `.stream` CSS: 28 px chips, service icon (Twitch/YouTube/Kick/VK/Trovo/other) tinted
by `--svc`, truncated name, full name in the tooltip, non-http(s) links dropped. Opening: web `window.open` with
`noopener`; Tauri `shell.open` — PORT WITH ADAPTATION.

## 15. Settings — PORT WITH ADAPTATION
Sections: Отображение (theme, odds, logos, extras, Dota stats, window mode, link browser) · Источники (one switch
per bookmaker incl. GGBET; at least one stays on) · Уведомления · Подключение · Лиги и связи · Резервная копия ·
О программе · Диагностика (admin) · Пользователи (admin). EXTENSION-SPECIFIC items: window mode (popup/tab), link
browser + native helper, optional host permission prompt for a custom server.

## 16. Accessibility rules — REUSABLE DIRECTLY
- Every icon button has `aria-label` + `title`; status never colour-only (text or glyph too).
- Listbox/menu roles with full keyboard support; Menu key / Shift+F10 opens the context menu on the focused row.
- Rows are focusable (`tabindex=0`), Arrow keys move, Enter toggles the detail, Escape closes overlays.
- Visible focus ring `--focus-ring` on every interactive element; minimum 28 px targets; `prefers-reduced-motion`
  respected (skeleton shimmer, spinners slowed).
- Contrast targets in §1; both themes verified on real data.

## 17. EXTENSION-SPECIFIC (do not port)
Service worker feeds/port protocol (`background.js`; web/Tauri talk to the API directly: poll + SSE `feed-stream`),
`chrome.storage`, `runtime.getContexts` window focusing, notifications via `chrome.notifications` (web: Notification
API; Tauri: notification plugin), optional `nativeMessaging` + `browser-host/` helper (Tauri can open URLs natively),
manifest permissions, `server-config.js` localStorage mirror.

## 18. Verification assets to reuse
`tools/ux/mock-server.mjs` + `fixtures.mjs` (mock API with the server's own query code and 1,900 synthetic matches)
and the `measure` / `verify` flows in `tools/ux/ux-harness.mjs` can drive a web build with Playwright unchanged
except for the page URL.
