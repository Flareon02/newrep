# Collectors: upstream requests (AstekBet, Fonbet, Pinnacle) — 2026-10-02

Dev report. Baseline from two `/health` snapshots on staging (server 2adf06b, 5-minute window). The API limits below
were observed with a handful of ordinary requests, not load tests. Browser analysis was stopped for astekbet.com (it shows
"Доступ к сайту ограничен") and for fon.bet (the page did not load), so the API evidence below comes from the collectors' own endpoints.

## Baseline (staging, before)

| Group | req/min | MB/min (decompressed) | notes |
|---|---|---|---|
| astekPrematch | 19 | 0.10 | 46 requests / 9.2 s per 60 s cycle, 48 leagues, ~42 one-league requests, 1 HTTP 406 per cycle |
| astekLive | 12 | 0.73 | fingerprint short path when unchanged |
| astekLiveDetail | 4.8 | 0.36 | 2.4 failures/min (50 %) |
| fonbetBase | 0.2 in the window (one per 15 min) | 2.11 in the window | ~11 MB per listBase |
| fonbetDelta | 11 | 1.50 | ~113 KB per delta |
| pinnacleLive / pinnaclePrematch | 8 / 2 | ~0 / 0.82 | |

## AstekBet line (prematch)

Observed limits of `LineFeed/Get1x2_VZip`:
- at most **50 rows** per answer whatever `count` says (50, 200, 500, 1000 → the same 50 rows);
- `count` accepts only some values (50 and 100 work; 51, 56 → **HTTP 406**);
- `champs=` accepts **1–4** league ids; 5 or more → HTTP 406.

Before: catalog + aggregate (50 soonest games, ~4 complete leagues) + **one request per remaining league** (~42). A
league with ≥ 50 games was requested with `count=GC+1` (55 → 56 → HTTP 406 every cycle), so each cycle ended as a
partial failure and rotated the origin.

After (`server/src/prematch.js`):
- the remaining leagues are packed into `champs=` groups of ≤ 4 leagues and < 50 expected games (stalest first),
  always `count=50`; a complete group answer can never reach the cap;
- an incomplete/invalid group is retried league by league in the same cycle; an HTTP 4xx for a group splits the rest
  of the cycle into single leagues and pauses grouping for `PREMATCH_BULK_RETRY_MS` (one extra request, not one per cycle);
- a league with ≥ 50 games is read once with `count=50`; its games beyond the 50-row window are kept from the previous
  cycle (only later than the last returned game, at most GC − 50). No HTTP 406, no partial failure, no origin rotation;
- grouping only runs when the aggregate answered in that cycle; otherwise the old one-league path is used.

Test `server/test/astek-requests-perf.test.js` (mock enforcing the limits above, staging catalog of 50 leagues):
**47 → 14 requests per cycle** (11 grouped), the same events as the one-league path (id, teams, league, start, status, URL,
market count). Leagues of up to 49 games: identical output. The league with 54 games now gets 50 fresh games plus the
known later ones instead of an HTTP 406.

## AstekBet LIVE detail

`astekbet-0021.pro` does not answer from the staging host ("fetch failed" after ~0.8 s); `astekbet.com` answers in ~0.1 s.
Every detail read started with -0021, so every read cost a failed request plus ~0.8 s → the 50 % failure rate.

After (`server/src/astek-detail.js`): the mirror that answered last goes first; a mirror with a mirror-level fault
(unreachable, timeout, 5xx, 403/429) waits 5 minutes behind the healthy ones and stays the last fallback. A reply
without the match does not count against the mirror. No extra retries; odds are unchanged. Test: 6 reads → 7 requests
(before: 12), and when the working mirror fails the other one is still tried.

## Fonbet

Capture: listBase → 70 deltas over 6 minutes (every 5 s) → listBase.

| | wire (gzip) | decompressed |
|---|---|---|
| listBase | 1.17 MB | 11.05 MB (11 989 events, all sports; esports 329) |
| one delta (avg) | 17.6 KB | 113 KB |
| 70 deltas (6 min) | 1.23 MB | 7.92 MB |

No ETag/Last-Modified (`cache-control: no-cache`); both endpoints cover all sports.

Replaying the 70 deltas on the first listBase with the collector's own `mergeFonbetPayload` and comparing with the
second listBase:
- esports prematch (173 events): **identical** apart from timestamps;
- esports LIVE (4 events): same events, 2 differ by one market (the replayed state has a newer `packetVersion` than the
  second listBase, so this may be timing);
- raw state: the replay keeps **86 events, 17 sports rows, 82 factor rows, 70 misc rows** that the new listBase no longer has —
  deltas do not carry deletions. One of them is in the esports tree (a finished "2nd map", `notActive`, filtered by the
  parser today).

Delta → full is therefore **not** equivalent: removed rows accumulate until the next listBase. The periodic full resync
(`FONBET_FULL_RESYNC_MS`, 15 min) is what removes them and stays unchanged. Fonbet code: no change.

## Pinnacle

Live list every 15 s (matchups + markets = 2 requests), line every 60 s (2 requests), match detail only while a match is
open (single-flight per id, 2 s cache, metadata every 30 s, 40-entry LRU). 8 + 2 req/min; the near-zero LIVE bytes are
an almost empty live list. Nothing to gain; no change.
