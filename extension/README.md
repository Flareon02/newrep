# Esports Monitor Extension 9.0.0 — product redesign

Dark, dense monitoring interface: LIVE · Линия · Результаты · Сравнение · История, a right-side match detail with
bookmaker odds, and Settings (sources, notifications, server, league links, diagnostics). See `CHANGELOG-9.0.0.md`
and `docs/UI-PERFORMANCE-9.0.md`. Prices in lists and the odds comparison need server ≥ 4.7.0.

Code map:
- `app.html`, `ui.css` (design system + layout), `panels.css` (styles of the reused statistics/score/timeline modules)
- `store.js` — data layer: deduplicated/cancellable requests, stale-while-revalidate resources, last-known snapshots
- `app.js` — shell, feeds from the service worker, LIVE/Line/Results/History views, selection, keyboard
- `detail-panel.js` — match detail (odds, statistics, sources); `app-compare.js` — odds comparison + schedule tool;
  `app-settings.js` — settings, league links, diagnostics; `match-format.js` — pure score/price helpers
- `background.js` — service worker: feeds (poll + SSE), notifications, windows (unchanged protocol)

Tests: `node --test extension/test/*.test.mjs`; browser: `tools/e2e/extension-suite.mjs`; speed: `tools/bench/ui-bench.mjs`.
