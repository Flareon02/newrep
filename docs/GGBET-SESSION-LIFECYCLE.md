# GGBET session lifecycle (server 4.8.0)

Code/protocol analysis and mocks only; no upstream requests were made for it.

## What one session is in the collector

| Step | When | Through |
|---|---|---|
| Bootstrap: one GET of the public LIVE page (`/ru/live`), guest token + GraphQL endpoint from `bettingClientOptions` | new session only (a token ≤ `GGBET_BOOTSTRAP_CACHE_MS` old is reused **only through the same proxy agent**) | proxy agent of the session |
| WebSocket `graphql-ws`, `connection_init` with `X-Auth-Token` | new session only | the same agent (= the same egress IP) |
| `GetSportEventListByFilters` snapshot (all LIVE events, top 3 markets) | every 30 s | that WebSocket |
| One `OnUpdateSportEvent` stream per LIVE event — **light**: the snapshot's top market ids | while the event is LIVE | that WebSocket |
| Leased event (open detail panel): `GetMarketsTab "all"` + `OnUpdateTab` + `OnUpdateSportEvent` with every market id (replaces the light one) | lease acquire … last release / TTL | that WebSocket |

Bootstrap origins are an exact static allowlist (`https://gg.bet`); redirects are followed by the collector only to
trusted hosts, and every attempt is recorded for operators (`GET /api/admin/ggbet-bootstrap`, token required).

There is no cookie and no root-page step: the token comes from the server-rendered LIVE page and the socket authenticates
with the header. That path produced working, acknowledged sessions (saved diagnostics of the last proxied session).

**Score and odds travel in the same GraphQL subscription**: an `OnUpdateSportEvent` patch carries `fixture` (score,
status) and `markets` together, one stream per event, all streams on one WebSocket; the 30 s snapshot also carries
both. The bootstrap additionally publishes a `scoreboardEndpoint` (`score-board.databet.cloud`) that the collector does
not use; the site can use it, so in a browser score and odds may come from **different connections**.

The subscription variables are only `sportEventId`, `marketIds`, `marketStatuses`, `version`, `isTopMarkets`,
`skipMarkets` — no locale, currency, label or region. Whatever account/pricing context the platform applies can only
come from the token (issued at bootstrap, on the egress that fetched the page) and/or the connection that presented it.
On the same platform the DataBet guest token publishes part of such a context in its public header (`label`, `locale`,
`currency`, `isAuthorized`); for GGBET no token header was ever stored (tokens are never logged), so its content is
unknown.

## The browser observation (2026-10-02)

1. Page open, VPN off: score 3:3, Winner 1.55 / 2.36, Odd/Even 1.84 / 1.90.
2. Another egress enabled **without reload**: the score kept moving (3:3 → 4:4), prices stayed exactly the same.
3. Reload on the new egress: new page → new token → new WebSocket → new subscriptions: Winner 1.71 / 2.00,
   Odd/Even 1.85 / 1.85.

What it shows:
- A network change alone does not create a new token, socket or subscriptions; only the reload (a new bootstrap) does.
  In the browser an established socket either keeps its old route or dies; the page did not rebuild it.
- Score and odds behaved differently, so on the site they did not come through one healthy stream: consistent with the
  score arriving over the scoreboard connection while the odds stream (or its subscriptions) stopped delivering.
- The prices after the reload can be ordinary market movement over the rounds played meanwhile; the observation alone
  cannot tell "a frozen stream showed old prices" from "the new session has another pricing context". That would need two fresh
  sessions from two egresses at the same moment — not done (no upstream tests). No evidence of manipulation or a
  blacklist; none is assumed.

## What the collector does about it

- A healthy session is never torn down on a timer (`GGBET_SESSION_REFRESH_MS` = 0): a new token/socket/subscription
  generation happens only on a real reason (close, auth rejection, network error, watchdog, a declared token expiry).
- Token and socket always share one egress: the token is fetched through the session's proxy agent and a cached token
  is never presented through another agent; the agent is pinned per process and changes only after repeated failed
  sessions, and then the next session bootstraps again on the new egress.
- Opening/closing a match only starts/stops streams inside the existing session.
- A quiet stream cannot freeze prices unnoticed: light events get fresh top-market prices from every 30 s snapshot;
  for a leased full stream, if two snapshots at least 10 s apart show other prices for its markets and the stream pushed
  nothing in between, that one stream is restarted inside the same socket and the snapshot prices are applied
  (`ggbetFullStreamResyncs`). A dead socket is caught by the watchdog (no message for `GGBET_WATCHDOG_MS`).

Tests: `server/test/ggbet-full-markets.test.js`.
