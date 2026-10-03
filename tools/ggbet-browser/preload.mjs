// Browser-side instrumentation (BiDi preload script, page realm): Firefox's BiDi has no WebSocket frame events, so the
// page's own GG.BET betting WebSocket is observed here and forwarded through the BiDi channel to the controller.
// Only connections to gg-b-gql.gg.bet are touched; the socket itself is the browser's native WebSocket (same
// prototype, same session). Forwarded: incoming text frames, open/close, and outgoing `start`/`stop` operations.
// NEVER forwarded: connection_init (it carries the session token) or anything else the page sends.
export const PRELOAD = `(send) => {
  const Native = window.WebSocket;
  if (!Native || Native.__ggObserved) return;
  const watched = (u) => /^wss:\\/\\/([a-z0-9-]+\\.)*gg-b-gql\\.gg\\.bet\\//i.test(String(u));
  function Observed(url, protocols) {
    const ws = protocols === undefined ? new Native(url) : new Native(url, protocols);
    if (!watched(url)) return ws;
    const id = Math.random().toString(36).slice(2, 10);
    const post = (o) => { try { send(JSON.stringify(o)); } catch (e) {} };
    post({ k: 'open', id, t: Date.now(), url: String(url).split('?')[0] });
    ws.addEventListener('message', (e) => { if (typeof e.data === 'string') post({ k: 'in', id, t: Date.now(), d: e.data }); });
    ws.addEventListener('close', (e) => post({ k: 'close', id, t: Date.now(), code: e.code }));
    const nativeSend = ws.send.bind(ws);
    ws.send = function (data) {
      if (typeof data === 'string' && /"type"\\s*:\\s*"(start|stop)"/.test(data) && !/connection_init/.test(data)) post({ k: 'out', id, t: Date.now(), d: data });
      return nativeSend(data);
    };
    return ws;
  }
  Observed.prototype = Native.prototype;
  for (const k of ['CONNECTING', 'OPEN', 'CLOSING', 'CLOSED']) Observed[k] = Native[k];
  Observed.__ggObserved = true;
  window.WebSocket = Observed;
}`;
