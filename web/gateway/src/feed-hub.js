// Realtime feed for web clients.
//
// The monitor server limits event streams per remote address, and everything arriving through cloudflared comes from
// 127.0.0.1. Instead of one upstream stream per browser, the gateway holds ONE upstream /api/feed-stream per LIVE odds
// provider (as the service account, i.e. unfiltered) and fans every event out to its web clients, filtered per user
// with the server's own rules (filterSsePayload): the same bookmaker/odds restrictions the server would apply.
//
// Streams belong to sessions (StreamRegistry). Revoking a session sends `event: session` and closes all its streams
// at once, so a kicked profile stops receiving data immediately and its next request is refused.
import { can, filterSsePayload, PROVIDERS } from './vendor/entitlements.js';

const ALL_MODES = ['live', 'prematch', 'results', 'history', 'leagues'];
const MODE_CAPS = { live: ['live.view'], prematch: ['prematch.view'], results: ['results.view'], history: ['history.view'], leagues: ['live.view', 'prematch.view', 'results.view', 'compare.view', 'history.view'] };
export const allowedModes = (principal, requested) => requested.filter((m) => ALL_MODES.includes(m) && MODE_CAPS[m].some((k) => can(principal, k)));

const wire = (event, data) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

export function parseSseBlock(block) {
  let type = 'message'; const data = []; let comment = true;
  for (const raw of String(block || '').split(/\r?\n/)) {
    if (!raw) continue;
    if (raw.startsWith(':')) continue;
    comment = false;
    const i = raw.indexOf(':'), field = i < 0 ? raw : raw.slice(0, i), value = i < 0 ? '' : raw.slice(i + 1).replace(/^ /, '');
    if (field === 'event') type = value; else if (field === 'data') data.push(value);
  }
  if (comment || !data.length) return null;
  try { return { type, data: JSON.parse(data.join('\n')) }; } catch { return null; }
}

// ------------------------------------------------------------------------------------------------ registry -------
export class StreamRegistry {
  constructor() { this.bySession = new Map(); }
  add(sessionId, stream) {
    let set = this.bySession.get(sessionId);
    if (!set) this.bySession.set(sessionId, (set = new Set()));
    set.add(stream);
    return () => { set.delete(stream); if (!set.size && this.bySession.get(sessionId) === set) this.bySession.delete(sessionId); };
  }
  count(sessionId, kind) { let n = 0; for (const s of this.bySession.get(sessionId) || []) if (!kind || s.kind === kind) n++; return n; }
  // Ends every stream of the session: a final `session` event tells the client why, then the connection closes.
  close(sessionId, reason) {
    const set = this.bySession.get(sessionId);
    if (!set) return 0;
    this.bySession.delete(sessionId);
    for (const s of [...set]) s.end(reason);
    return set.size;
  }
  sessions() { return [...this.bySession.keys()]; }
  total() { let n = 0; for (const set of this.bySession.values()) n += set.size; return n; }
}

export function endStream(res, reason) {
  try { if (!res.writableEnded) { res.write(wire('session', { state: 'ended', reason })); res.end(); } } catch {}
}

// ------------------------------------------------------------------------------------------------ hub ------------
export class FeedHub {
  constructor({ upstream, log = console, lingerMs = 30_000, pingMs = 15_000, clock = Date.now }) {
    Object.assign(this, { upstream, log, lingerMs, pingMs, clock });
    this.channels = new Map();
    this.pinger = setInterval(() => this.ping(), pingMs);
    this.pinger.unref?.();
  }

  channel(provider) {
    let ch = this.channels.get(provider);
    if (!ch) {
      ch = { provider, clients: new Set(), hello: null, upstream: null, abort: null, retry: null, failures: 0, linger: null, connectedAt: 0, events: 0 };
      this.channels.set(provider, ch);
    }
    return ch;
  }

  // client: { res, principal, modes: Set, sessionId }
  subscribe(provider, client) {
    const ch = this.channel(provider);
    clearTimeout(ch.linger); ch.linger = null;
    ch.clients.add(client);
    if (ch.hello) this.sendHello(ch, client);
    if (!ch.upstream && !ch.retry) this.connect(ch);
    return () => {
      ch.clients.delete(client);
      if (!ch.clients.size && !ch.linger) {
        ch.linger = setTimeout(() => { ch.linger = null; if (!ch.clients.size) this.disconnect(ch); }, this.lingerMs);
        ch.linger.unref?.();
      }
    };
  }

  helloFor(ch, client) {
    const h = ch.hello || {};
    const out = { ...h, feeds: {}, ui: {} };
    for (const m of client.modes) {
      if ((m === 'live' || m === 'prematch') && h.feeds?.[m]) out.feeds[m] = h.feeds[m];
      if (h.ui?.[m]) out.ui[m] = h.ui[m];
    }
    return out;
  }
  sendHello(ch, client) { this.write(client, wire('hello', filterSsePayload(client.principal, this.helloFor(ch, client)))); }

  write(client, text) {
    try { if (!client.res.writableEnded) client.res.write(text); } catch {}
  }

  ping() {
    const line = `: ping ${this.clock()}\n\n`;
    for (const ch of this.channels.values()) for (const c of ch.clients) this.write(c, line);
  }

  async connect(ch) {
    const controller = new AbortController();
    ch.abort = controller;
    ch.upstream = 'connecting';
    const query = `/api/feed-stream?modes=${ALL_MODES.join(',')}&thin=1&provider=${encodeURIComponent(ch.provider)}`;
    try {
      const res = await this.upstream.request(query, { headers: { accept: 'text/event-stream', 'accept-encoding': 'identity' }, signal: controller.signal, stream: true, timeout: 20_000 });
      if (res.statusCode !== 200) { res.resume(); throw new Error(`HTTP ${res.statusCode}`); }
      ch.upstream = res; ch.connectedAt = this.clock(); ch.failures = 0;
      res.setEncoding('utf8');
      let buffer = '';
      res.on('data', (chunk) => {
        buffer += chunk;
        let index;
        while ((index = buffer.search(/\r?\n\r?\n/)) >= 0) {
          const sep = buffer.match(/\r?\n\r?\n/)[0].length, block = buffer.slice(0, index);
          buffer = buffer.slice(index + sep);
          const event = parseSseBlock(block);
          if (event) this.dispatch(ch, event.type, event.data);
        }
        if (buffer.length > 8 * 1024 * 1024) buffer = '';
      });
      await new Promise((resolve) => { res.on('end', resolve); res.on('close', resolve); res.on('error', resolve); });
      throw new Error('upstream stream closed');
    } catch (error) {
      if (ch.abort !== controller) return;
      ch.upstream = null; ch.abort = null;
      if (controller.signal.aborted) return;
      ch.failures++;
      if (!ch.clients.size) return;
      const delay = Math.min(30_000, 500 * 2 ** Math.min(6, ch.failures)) + Math.floor(Math.random() * 400);
      this.log.warn?.(`[feed] ${ch.provider} upstream lost (${error.message}); retry in ${delay} ms`);
      ch.retry = setTimeout(() => { ch.retry = null; if (ch.clients.size) this.connect(ch); }, delay);
      ch.retry.unref?.();
    }
  }

  disconnect(ch) {
    clearTimeout(ch.retry); ch.retry = null;
    const controller = ch.abort; ch.abort = null; ch.upstream = null; ch.hello = null;
    controller?.abort();
  }

  // Keeps the cached hello current so a client that connects later starts from fresh revisions.
  remember(ch, type, data) {
    if (type === 'hello') { ch.hello = data; return; }
    if (!ch.hello) return;
    if ((type === 'patch' || type === 'invalidate' || type === 'status') && (data?.mode === 'live' || data?.mode === 'prematch') && data.meta) {
      ch.hello = { ...ch.hello, feeds: { ...ch.hello.feeds, [data.mode]: { ...(ch.hello.feeds?.[data.mode] || {}), ...data.meta } } };
    }
    if (type === 'ui-invalidate' && data?.view && Number(data.revision)) {
      ch.hello = { ...ch.hello, ui: { ...ch.hello.ui, [data.view]: { ...(ch.hello.ui?.[data.view] || {}), revision: Number(data.revision) } } };
    }
  }

  dispatch(ch, type, data) {
    ch.events++;
    this.remember(ch, type, data);
    if (type === 'hello') { for (const c of ch.clients) this.sendHello(ch, c); return; }
    const mode = type === 'ui-invalidate' ? String(data?.view || '') : String(data?.mode || '');
    const provider = String(data?.provider || '');
    const wires = new Map();
    for (const c of ch.clients) {
      if (mode && !c.modes.has(mode)) continue;
      // A bookmaker the user may not see sends nothing (server: broadcastFeed).
      if (PROVIDERS.includes(provider) && !can(c.principal, 'provider.' + provider)) continue;
      const key = c.principal.role === 'admin' ? 'admin' : c.principal.sig;
      if (!wires.has(key)) wires.set(key, wire(type, filterSsePayload(c.principal, data, mode === 'prematch' ? 'prematch' : 'live')));
      this.write(c, wires.get(key));
    }
  }

  status() {
    return [...this.channels.values()].map((ch) => ({ provider: ch.provider, clients: ch.clients.size, connected: !!ch.upstream && ch.upstream !== 'connecting', since: ch.connectedAt || null, failures: ch.failures, events: ch.events }));
  }

  close() { clearInterval(this.pinger); for (const ch of this.channels.values()) { clearTimeout(ch.linger); this.disconnect(ch); } }
}
