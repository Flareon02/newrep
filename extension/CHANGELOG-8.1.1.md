# Extension 8.1.1 — odds hydration + progressive history

- Fixes the 0 / 0 bookmaker dialog when `/api/ui/event-detail` already contains full markets.
- Hydrated source refs are no longer discarded just because thin/live phase flags are absent.
- The odds dialog prefers its hydrated refs and falls back safely if a live selector returns an empty array.
- Full Astek/GGBET detail is no longer downloaded every 15 seconds; push invalidation is primary and a 60-second fallback remains.
- History opens with the newest 500 rows. Remaining 500-row pages are prefetched at low priority in the background and revealed instantly as the user scrolls.
