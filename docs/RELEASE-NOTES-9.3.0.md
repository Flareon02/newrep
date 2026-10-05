# Esports Monitor Extension 9.3.0

Works with the current server (4.15.x) — no server update needed. The previous version 9.2.0 stays available for
rollback.

## What's new
- A redesigned interface for every section: one consistent filter bar, game icons, cleaner rows and match details.
- Light theme and "Как в системе", next to the dark theme (top-bar button or Settings → Отображение → Тема).
- A new extension icon.

## Performance
- History no longer freezes the extension: it opens with what matters now and loads the archive gradually.
  In our measurements the longest freeze while loading older history dropped from 8.6 s to about 0.3 s, and while
  History stays open from 22.9 s to about 0.05 s.
- Switching sections stays instant while History is loading.

## History
- Order: «Сейчас в LIVE», «Сейчас в линии», then one block per day — today, yesterday, and so on.
- Older days load as you scroll (or with «Загрузить <день>»); each day has its own «Показать ещё».
- Changing a filter or search cancels the previous request; going back to an earlier filter is instant.
- The end of the archive is shown clearly: «Это вся история по фильтрам».

## Match details
- Click the open match again to close it; click another match to switch.
- One status line, icon buttons, and a single bookmaker table (link, start, first seen, LIVE / end, score).
- Right click a match to copy «Команда A - Команда B» or one team; right click a bookmaker to open or copy its match
  link (when the bookmaker provides one).

## CS2
- New scoreboard: sides (CT/T), players alive, economy, round score, clock and bomb state.
- Round timeline with clear icons (elimination, bomb exploded, bomb defused, time ran out) in the side colours, a
  current-round marker and a legend.
- The event log is collapsed until you open it.

## Streams
- One compact style for all stream links (Twitch, YouTube, Kick, VK, …): icon, channel name, full name on hover.

## Themes
- Dark, light and system; every screen, chart, icon and status colour is tuned for both.

## Filters
- Game filter with icons and counts, keyboard friendly.
- The filter bar keeps the same size and position on every tab.
- Line: one button collapses / expands all games; reopening always shows games open and leagues collapsed.

## Bookmakers
- GGBET can be switched on and off like the other bookmakers (Sources).
- DataBet is no longer shown.

## Fixes
- CS2 round icons were black and hard to read.
- History «Показать ещё» sometimes did nothing.
- History and Results columns were not aligned.
- Duplicate times and copy buttons in match details.
- Team logos missing although another bookmaker had one; broken logos are no longer retried.
- Results rows match the rest of the interface.

## Privacy and permissions
- Fewer permissions: the extension no longer asks for access to your tabs or to the clipboard.
- Opening links in another browser (Chrome/Edge/Firefox) is optional: it needs the separate «browser-host» helper and
  asks for permission only when you choose that setting. By default links open in the current browser.
