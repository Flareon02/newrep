# Extension 9.1.0 — GGBET full markets for the open match only

Needs server 4.8.0 for GGBET full markets in the detail panel (with an older server the panel works as in 9.0).

- The detail panel leases the GGBET full market tree of the match it shows (`POST /api/ui/full-markets`): acquired when a
  LIVE match is opened, moved on a switch to another match, released when the odds provider is switched away from GGBET,
  renewed every 10 s while the panel is visible, released when the panel is closed (and on page close, best effort).
  A hidden tab stops renewing; the server lets the lease expire and the panel takes it again when the tab is shown.
- The panel's own detail requests carry the lease; the hover/focus prefetch does not, so hovering a row never makes the
  server subscribe full markets. The list, the main-market quotes, Compare and History are unchanged.
