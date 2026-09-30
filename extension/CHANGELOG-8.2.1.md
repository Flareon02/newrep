# Extension 8.2.1 — stalled event-stream watchdog

## Fixed

- **A silent event stream was never torn down.** If the connection to the server stopped delivering bytes without being
  closed (frozen server, vanished NAT/firewall entry, a proxy that accepts but never answers), the service worker kept
  waiting on it forever and still considered the stream *healthy*. Because a healthy stream relaxes background polling to
  60-120 s, the UI could show stale data for minutes with no error. The worker now aborts a stream that has delivered
  nothing for 50 s (the server pings every 15 s), counts it as a failure and reconnects with the normal exponential
  backoff. The same timer also covers a server that accepts the connection but never sends response headers.
  Reproduced first by the new browser scenario E17 (`tools/e2e/extension-suite.mjs`); it fails on 8.2.0 and passes now.

- **Changing the server address/token no longer lets the old server's answers leak into the new one.** A request that was
  already in flight when the settings changed could finish afterwards and write its data (or its failure and the resulting
  back-off) into the cache of the new server, leaving the UI without data for up to a retry interval. Responses from an older
  configuration epoch are now discarded and in-flight requests are dropped on a change. Found by the browser suite (E08 then
  E09 failed before the change, pass after).
