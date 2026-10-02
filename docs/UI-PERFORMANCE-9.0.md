# Extension 9.0 — UI performance (BEFORE 8.3.0 / AFTER 9.0.0)

Measured on 2026-10-02 on the staging host (1 vCPU, 1 GiB RAM shared with the live server, swap in use), headless
Chromium with the private STAGING build, against `https://api.esportsdata.online` (Cloudflare Tunnel, real feeds).
Interaction numbers are taken inside the page: `performance.now()` at the click, then every animation frame until the
expected DOM is there. Medians of 3 (8.3.0) and 5 (9.0.0) runs. Tool: `tools/bench/ui-bench.mjs`.

## Where the time went in 8.3.0

Tracing the boot (script load → storage → port → first card) and every click showed:

| Bottleneck | Evidence | 9.0 change |
|---|---|---|
| First paint waited for the service worker's in-memory feed; after the worker was stopped (Chrome does that when idle) it waited for the network | page ready at ~0.3 s, first card only after `initial`/snapshot message (0.6–2 s) | last-known LIVE/Line lists, today's results and the first History page are saved and painted first, then patched |
| Event detail = one network request per open (server fetches the bookmaker detail upstream) | 1.1–2 s first open | main market painted at once from the list quote (server 4.7.0), full tree patched in; LRU cache + prefetch on hover/focus |
| Provider switch cleared LIVE and waited for the new feed | 0.6–1.3 s | other bookmakers' rows stay; last list of the chosen provider is reused |
| Every navigation re-rendered the whole list | 30–60 ms per switch, more on big lists | one DOM + scroll position per section; data changes applied after the switch has painted |
| History/Results first open waited for the server | 0.3 s / 4.8 s | skeleton at once; saved page shown on later opens |

## Results

| Interaction | 8.3.0 | 9.0.0 | Target |
|---|---|---|---|
| Section switch → LIVE | 27 ms | **2 ms** | < 100 ms |
| Section switch → Results (visited) | 47 ms | **2 ms** | < 100 ms |
| Section switch → Line | 34 ms ¹ | 64 ms | < 100 ms |
| Results, first open in a page | 297 ms | 227 ms (29 ms when saved) | skeleton at once |
| History, first open (server query) | 4 812 ms | 7 653 ms ² (38 ms when saved) | skeleton at once |
| Event detail, first open — first useful paint | 1 155 ms | **127 ms** | — |
| Event detail, first open — full market tree (network) | (same request) | 954 ms | background |
| Event detail, cached reopen | 21 ms | 22 ms | < 100 ms |
| Market tab / bookmaker switch in detail | 16 / 60 ms | **13 / 6 ms** | < 100 ms |
| LIVE odds provider switch (GGBET ↔ DataBet) | 907 ms | **106 ms** | — |
| Start, page reopened (service worker alive) ³ | 594 ms | **335 ms** | — |
| Start after browser restart (cold worker) ³ | 1 270 ms | **927 ms** | — |
| Start, first install (nothing saved, network-bound) ³ | 1 413 ms | 1 688 ms | — |

¹ 8.3 rendered the Line as collapsed league headers only; 9.0 renders expanded leagues with prices (first screen
synchronously, the rest after the switch has painted).
² Same server endpoint in both versions (`/api/ui/history?fast=1`); its cost dominates and varies with the host load.
9.0 shows the skeleton immediately and, after the first visit, the saved page (38 ms).
³ First LIVE row, measured from navigation start with an init script (the 8.3 tool polled after `page.goto()` and
over-reported already-painted rows; both versions were re-measured the same way).

## Regression guards
- E2E `E19` instant navigation (< 100 ms per visited section), `E20` cached detail (< 100 ms),
  `E22` cold start with the server down renders the saved LIVE list; unit tests `test/store.test.mjs`
  (SWR, dedup, cancellation, LRU, persistence) and `test/match-format.test.mjs`.
- In the app: `localStorage.devPerf = '1'` prints interaction timings; Settings → Диагностика lists the latest ones.
