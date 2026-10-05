# Extension 9.3.0 — known limitations

Frontend-only release; works with the existing production server (4.15.x). None of these block normal use.

## History
- A day is loaded page by page (100 first, then 200). "Загрузить <день>" moves to the next day; the rest of a big day
  stays behind that day's "Показать ещё".
- Server latency on real data: the "Сейчас в LIVE" query and sparse past days can take 5–11 s on the production server,
  because the server keeps widening its scan (up to 4 passes) when a page cannot be filled. 9.3.0 shows LIVE / line
  at once from its own feeds and keeps the UI responsive, but an "older day" step can wait longer than a 9.2.0 page
  (measured 2.3–10.5 s vs 2.7–5.7 s). Server-side fix (separate, optional): stop widening the scan once an `end`
  window or a `phase` cannot gain more rows.
- The server's archive count is often a lower bound (`totalExact:false`); 9.3.0 shows "ещё не менее N" and ends the
  list only on an exact count or after six empty days ("Искать раньше").
- Game counts in the game filter cover all phases and all time (the server counts facets before the phase/time
  filters) — same as 9.2.
- The archive end is detected from the server's total; matches without an appearance time cannot be placed on a day,
  so up to six empty days are probed before "Искать раньше" pauses the search.
- Optional server improvement (not required): a `day=` parameter and the oldest available day in the summary would
  remove the empty-day probing.

## Logos
- Thin list payloads carry team logos only at event level. Another bookmaker's logo appears once a full payload
  (match detail, CS2 board) has been seen; learned logos are kept (≤1,500 teams) for later sessions.

## Results
- Visually aligned with the other sections; it still grows one list with "Показать ещё" (no day sections).

## Native helper (optional)
- Opening links in another browser needs the separate `browser-host` helper (Windows) and the optional
  "nativeMessaging" permission, asked for in Settings. The helper compiles its included C# source at install time and
  writes three HKCU registry keys (documented in its README); a signed prebuilt installer would be better if the
  feature stays. Without it, links open in the current browser.
- After the update from 9.2, a user who had chosen another browser may have to re-grant that permission (Settings
  shows a note and asks when the browser is selected again); until then links open in the current browser. Not
  verified on a real Windows install with the helper.

## Platform
- Chrome / Edge 120+ (unchanged). `runtime.getContexts` (Chrome 116+) replaces the tabs permission.
- Distribution as a manual ZIP has no publisher reputation; see `docs/AV-TRUST-REPORT-9.3.0.md`.

## Testing
- Real-data acceptance ran while no CS2 match with statistics was live: the CS2 board, round timeline and stream
  chips are verified on synthetic data (unit + browser tests), not yet on a live production match.
- The service-worker idle/termination scenario (e2e E06) cannot be automated under Playwright (the worker is kept
  alive) — same as 9.2.
- Synthetic performance numbers come from a mock server with simulated latency; real-data numbers come from one
  read-only session against production (see the final report); both are labelled.
