# Extension 9.4.0 (with server 4.16.0)

## New
- **Таймлайн** tab in the match detail: one history of the match — score, maps, CS2 rounds, every bookmaker's
  markets and prices, appearance, suspension and reopening. Replay scrubber with change density and score/map marks,
  play/pause (1×/10×/60×/300×), ±10 s steps (←/→, Shift — a minute), previous/next score change and market change,
  ranges «Всё / LIVE / 1 ч / 15 мин», bookmaker/category/market filters, «Состояние» (the match at the chosen instant)
  and «Изменения» (what happened around it). LIVE: «Сейчас» follows the newest record.
- **Коэффициенты → Сравнение контор**: one row per canonical bet across bookmakers (best price highlighted,
  suspended/absent shown as such); the bookmaker's own market name is in the tooltip; unclassified markets are listed
  separately per bookmaker. «Одна контора» keeps the previous per-bookmaker view. «история» on a market opens the
  Timeline for that market.
- Finished matches: final result, confirmation and end time in the detail header.
- Settings follow the user and key (Настройки → Подключение → «Настройки профиля»): favourites, hidden leagues,
  filters, columns, theme and display options; window mode and link browser stay per device. Pre-9.4 settings are
  imported once for the first user of the device.

## Fixed
- History of the score: HTTP 401 (request without the key); statistics and Pinnacle live streams without the key.
  Access errors show a clear message and stop retrying.
- Rights changed by an administrator apply at once (sections, bookmakers, «Лиги и связи»); cached feeds of another
  key are dropped on a key change.
- Rows no longer rebuild on a price tick (synced in place: logos, hover and scroll position stay); the change arrow does
  not shift the price; map scores never wrap; list groups no longer resize while scrolling.
- Narrow windows: toolbar, section tabs and the settings menu wrap instead of hiding controls; Results/History rows use
  the narrow layout on narrow lists; the odds list switches to two lines at its real minimum width.

Works with server 4.15.x (comparison and Timeline then fall back to the previous views/table).
