# Extension 8.2.0 — configurable server and access token

Behaviour is unchanged until the new settings are used: the extension still talks to the
original production server by default.

## Added

- **Settings → Сервер:** server address and an optional access token. The address is no longer
  hardcoded in five files; `server-config.js` is the single place that knows it. Changing it
  reloads the page and makes the service worker drop its cache and reconnect.
- The token (when set) is sent as `Authorization: Bearer …` with every request, which is what a
  server started with `API_TOKEN` requires for POST endpoints, league-rule publishing and HLTV
  lookups. A missing/wrong token shows the server's own message instead of a silent failure.
- `optional_host_permissions` (http/https): the browser asks for access to a custom server
  address only when the user saves one. The default host permission is unchanged.
- Tests for the address/token logic and for the extension package (`node --test test/*.test.mjs`).

## Fixed

- Settings dialog: the "Показывать логотипы команд" checkbox always appeared unchecked because its
  `checked` attribute was built outside the template expression; toggling it once had no effect.
- The service worker now waits for the stored configuration before opening the SSE stream.

## Compatibility

Works with server 4.3.5 and with the `refactor/production-hardening` server. The `POST /api/ui/odds-watch`
request is accepted again by the hardened server; 4.3.5 answered 405, which the extension always ignored.
