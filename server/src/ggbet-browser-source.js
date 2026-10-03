// Hybrid GGBET source (4.13.0). At most three LIVE events are served by the GGBET Firefox browser worker
// (esports-monitor-ggbet-browser: real headless Firefox in its own fail-closed Mullvad namespace); every other GGBET event
// stays with the Node collector. This module reads ONLY the worker's parsed data over its local Unix socket
// (/run/ggbet-browser/data.sock) - it never contacts GG.BET - and arbitrates, per event, which source is published:
//
//   node                 the Node collector's event (default)
//   browser              the event is browser-selected AND the worker confirms it ready (page healthy/quiet, identity
//                        confirmed, "All" tree received, fresh): the whole event comes from Firefox - never mixed
//   browser-unavailable  the event was handed to the browser and the browser cannot serve it now (VPN down, page stale,
//                        IPC lost...): its last browser state is published with every price removed and odds.stale, so
//                        Node odds are never silently substituted inside a browser-owned event
//
// Handoff node -> browser happens only once the worker reports the event ready (until then the Node event stays: no
// empty transition). Handoff browser -> node (the event left the browser selection while still LIVE) happens only once
// the Node event is fresh; until then a healthy retiring browser page remains authoritative (otherwise unavailable). One event id is published once, by one source.
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

export const MODES = Object.freeze(['node', 'browser', 'browser-unavailable']);
const uuidOf = (id) => String(id ?? '').replace(/^ggbet-/, '').replace(/^\d+:/, '').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 100);

export function ipcGet(socketPath, p, timeoutMs = 3000, body = null) {
  return new Promise((resolve, reject) => {
    const payload = body == null ? null : JSON.stringify(body);
    const req = http.request({ socketPath, path: p, timeout: timeoutMs, method: payload ? 'POST' : 'GET', ...(payload ? { headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } } : {}) }, (res) => {
      const chunks = []; let size = 0;
      res.on('data', (c) => { size += c.length; if (size > 32 * 1024 * 1024) req.destroy(Error('browser IPC response too large')); else chunks.push(c); });
      res.on('end', () => { if (res.statusCode !== 200) return reject(Error(`browser IPC HTTP ${res.statusCode}`)); try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch { reject(Error('browser IPC invalid JSON')); } });
    });
    req.on('timeout', () => req.destroy(Error('browser IPC timeout'))); req.on('error', reject); req.end(payload);
  });
}

// The last browser state of an event with every price removed: shown as suspended/stale, never as fresh odds.
export function unavailableRow(row, at) {
  if (!row) return null;
  return { ...row, odds: row.odds ? { ...row.odds, stale: true, unavailableSince: at, markets: (row.odds.markets || []).map((m) => ({ ...m, status: 'suspended', prices: (m.prices || []).map((p) => ({ ...p, decimal: null })) })) } : null };
}

export class BrowserGgbetSource {
  constructor({ socketPath = '/run/ggbet-browser/data.sock', pollMs = 1000, ipcStaleMs = 5000, stateFile = null, now = () => Date.now(), request = ipcGet, onChange = () => {}, log = null } = {}) {
    Object.assign(this, { socketPath, pollMs, ipcStaleMs, stateFile, now, request, onChange, log });
    this.worker = null; this.sessionId = null; this.lastSignature = ''; this.seq = 0; this.feed = null; this.selected = new Map(); this.retiring = new Map(); this.pendingAcks = new Set(); this.raws = new Map(); this.modes = new Map(); this.history = []; this.lastRows = new Map(); this.published = new Map();
    this.ipc = { ok: false, lastOkAt: 0, lastError: '', failures: 0, polls: 0 }; this.timer = null; this.polling = false;
    this.loadState();
  }
  loadState() {
    if (!this.stateFile) return;
    try { const j = JSON.parse(fs.readFileSync(this.stateFile, 'utf8')); for (const [id, m] of Object.entries(j.modes || {})) if (MODES.includes(m?.mode) && m.mode !== 'node') this.modes.set(id, { mode: m.mode, since: Number(m.since) || this.now() }); this.history = Array.isArray(j.history) ? j.history.slice(-100) : []; } catch {}
  }
  saveState() {
    if (!this.stateFile) return;
    try { fs.mkdirSync(path.dirname(this.stateFile), { recursive: true }); const tmp = `${this.stateFile}.tmp`; fs.writeFileSync(tmp, JSON.stringify({ modes: Object.fromEntries(this.modes), history: this.history.slice(-100) }), { mode: 0o600 }); fs.renameSync(tmp, this.stateFile); } catch (e) { this.log?.warn?.('[ggbet-browser] state save failed', e?.message); }
  }
  start() { if (this.timer) return; const tick = () => { this.poll().catch(() => {}).finally(() => { if (this.timer) { this.timer = setTimeout(tick, this.pollMs); this.timer.unref?.(); } }); }; this.timer = setTimeout(tick, 0); this.timer.unref?.(); }
  stop() { clearTimeout(this.timer); this.timer = null; }
  // One feed read: health, the selected set and the raw events changed since the last read.
  async poll() {
    if (this.polling) return; this.polling = true; this.ipc.polls++;
    try {
      let f = await this.request(this.socketPath, `/feed?since=${this.seq}`);
      if (f.worker !== this.worker || f.sessionId !== this.sessionId || Number(f.seq) < this.seq) { this.worker = f.worker; this.seq = 0; this.raws.clear(); f = await this.request(this.socketPath, '/feed?since=0'); this.worker = f.worker; }
      this.sessionId = f.sessionId; this.apply(f);
      this.ipc = { ...this.ipc, ok: true, lastOkAt: this.now(), lastError: '', failures: 0 };
    } catch (e) { this.ipc = { ...this.ipc, ok: false, lastError: String(e?.message || e).slice(0, 200), failures: this.ipc.failures + 1 }; }
    finally { this.polling = false; }
    const signature = this.signature();
    if (signature !== this.lastSignature || this.retiring.size > 0) { this.lastSignature = signature; try { this.onChange(); } catch {} }
  }
  apply(f) {
    const now = this.now();
    if (!f?.worker || !Number.isFinite(Number(f.seq)) || !Array.isArray(f.selected) || f.selected.length > 3 || !Number.isFinite(Date.parse(f.at))) throw Error('browser IPC invalid feed');
    this.feed = { at: f.at, worker: f.worker, sessionId: f.sessionId, vpnState: f.vpnState, browserRunning: !!f.browserRunning, selectionReady: !!f.selectionReady, vpnExit: f.vpnExit || null, maxPages: f.maxPages };
    this.selected = new Map((f.selected || []).map((s) => [String(s.eventId), s]));
    this.retiring = new Map((f.retiring || []).map((s) => [String(s.eventId), s]));
    for (const [id, raw] of Object.entries(f.events || {})) { const s = this.selected.get(id) || this.retiring.get(id); if (raw?.id === id && s) this.raws.set(id, { raw, at: now, seq: s.seq, pageId: s.pageId }); }
    this.seq = Number(f.seq) || this.seq;
    // Keep raw state only for events the browser selects or still owns.
    for (const id of [...this.raws.keys()]) if (!this.selected.has(id) && !this.retiring.has(id) && !this.modes.has(id)) this.raws.delete(id);
  }
  signature() { return JSON.stringify([this.ipc.ok, this.ipcFresh(), this.seq, [...this.retiring.keys()], this.feed?.vpnState, this.feed?.browserRunning, [...this.selected.values(), ...this.retiring.values()].map((s) => [s.eventId, this.ready(s.eventId), s.state, !!s.retiring])]); }
  ipcFresh(now = this.now()) {
    const at = Date.parse(this.feed?.at || '');
    return this.ipc.ok && now - this.ipc.lastOkAt <= this.ipcStaleMs && Number.isFinite(at) && now - at <= this.ipcStaleMs && at - now <= 2000;
  }
  // Validate the worker's readiness evidence independently, including the exact raw snapshot and page/session epoch.
  ready(id, now = this.now(), retirement = false) {
    const s = this.selected.get(id) || (retirement ? this.retiring.get(id) : null), src = this.raws.get(id);
    const evidence = Date.parse(s?.validatedAt || ''), updated = Date.parse(s?.lastUpdateAt || '');
    const maxAge = Math.min(180000, Number(s?.dataFreshMs) || 180000);
    return this.ipcFresh(now) && this.feed?.vpnState === 'UP' && this.feed?.browserRunning && !!s?.ready && !!s?.fresh && !!s?.identity && !!s?.allLoaded && !!s?.catalogComplete &&
      ['HEALTHY', 'QUIET'].includes(s.state) && src?.raw?.id === id && src.raw.fixture?.sportId === s.sportId &&
      (!src.raw.slug || src.raw.slug === s.slug) && Number(src.seq) >= Number(s.seq) && src.pageId === s.pageId &&
      (!s.version || src.raw.version === s.version) && src.raw.markets?.length > 0 &&
      Number.isFinite(updated) && updated <= now + 2000 && Number.isFinite(evidence) && evidence <= now + 2000 && now - evidence <= maxAge;
  }
  mode(id) { return this.modes.get(id)?.mode || 'node'; }
  owns(id) { const key = uuidOf(id); for (const [eid, m] of this.modes) if (m.mode !== 'node' && uuidOf(eid) === key) return eid; return null; }
  // Arbitration over one publish. nodeRows: Map(upstreamEventId -> parsed Node row | null). parse(raw, at) builds the
  // event row from a raw GraphQL event exactly as the Node collector does. Returns the rows to publish (one per event)
  // and the ids the browser owns.
  merge(nodeRows, { nodeFresh = () => false, parse, at = this.now() } = {}) {
    const now = this.now(), fresh = this.ipcFresh(now), rows = [], owned = new Set(), changed = [];
    this.pendingAcks.clear();
    const settled = fresh && this.feed?.vpnState === 'UP' && this.feed?.browserRunning && this.feed?.selectionReady;
    const ids = new Set([...nodeRows.keys(), ...(fresh ? this.selected.keys() : []), ...this.modes.keys()]);
    for (const id of ids) {
      const prev = this.mode(id), sel = fresh ? this.selected.get(id) : null; let next;
      if (this.ready(id, now)) next = 'browser';
      else if (prev === 'node') next = 'node';
      // Deselected = absent from a SETTLED selection (worker up, VPN up, discovery warmed up). A VPN loss or a browser
      // restart empties the selection without deselecting anything: the event stays browser-unavailable.
      else if (settled && !sel && nodeFresh(id)) next = 'node'; // deselected, still LIVE, Node fresh: hand back
      else if (settled && !nodeRows.has(id) && !sel) next = 'gone'; // left LIVE (Node no longer lists it) and the browser does not serve it
      else if (prev !== 'node' && !sel && this.ready(id, now, true)) next = 'browser'; // hold the retiring browser copy until Node is fresh
      else next = 'browser-unavailable';
      if (next === 'gone') { this.modes.delete(id); this.lastRows.delete(id); this.published.delete(id); this.raws.delete(id); changed.push({ eventId: id, from: prev, to: 'gone', reason: 'event left LIVE' }); continue; }
      if (next !== prev) { changed.push({ eventId: id, from: prev, to: next, reason: this.reason(id, next, sel, fresh) }); if (next === 'node') this.modes.delete(id); else this.modes.set(id, { mode: next, since: now }); }
      if (next === 'node') { if (this.retiring.has(id) && nodeFresh(id)) this.pendingAcks.add(id); this.lastRows.delete(id); this.published.delete(id); const r = nodeRows.get(id); if (r) rows.push(r); continue; }
      owned.add(id);
      const src = this.raws.get(id), sAt = Date.parse((sel || this.retiring.get(id))?.lastUpdateAt || '') || src?.at || at;
      const built = src ? parse(src.raw, sAt) : null;
      if (built) this.lastRows.set(id, built); // last priced browser state (never published once unavailable)
      // Unavailable: the last browser state without any price; with no browser state at all (e.g. after a server restart)
      // the event card without any price - never Node odds.
      const row = next === 'browser' ? built : unavailableRow(built || this.lastRows.get(id) || nodeRows.get(id) || null, now);
      if (row) { this.published.set(id, row); rows.push(row); } else this.published.delete(id);
    }
    if (changed.length) { for (const c of changed) { const s = this.selected.get(c.eventId); this.history.push({ at: new Date(now).toISOString(), ...c, title: s?.title || null, sport: s?.sport || null }); this.log?.info?.(`[ggbet-browser] ${c.eventId} ${c.from} -> ${c.to} (${c.reason})`); } this.history = this.history.slice(-200); this.saveState(); }
    return { rows, browserIds: owned };
  }
  reason(id, next, sel, fresh) {
    if (next === 'browser') return 'browser ready (healthy, identity confirmed, All tree, fresh)';
    if (next === 'node') return 'deselected; Node event fresh';
    if (!fresh) return `browser IPC unavailable${this.ipc.lastError ? `: ${this.ipc.lastError}` : ''}`;
    if (this.feed?.vpnState !== 'UP') return `browser VPN ${this.feed?.vpnState || 'unknown'}`;
    if (!this.feed?.browserRunning) return 'browser not running';
    if (!sel && !this.feed?.selectionReady) return 'browser selection not settled (browser starting)';
    if (!sel) return 'deselected; waiting for a fresh Node event';
    return `page ${sel.state}${sel.ready ? '' : ' (not ready)'}`;
  }
  // The published browser-owned row (the full "All" tree when browser; prices removed when unavailable) for a detail
  // panel, or null when the browser does not own the event.
  detailRow(id) { const eid = this.owns(id); if (!eid) return null; const row = this.published.get(eid) || null; return this.mode(eid) === 'browser' && this.ready(eid, this.now(), true) ? row : unavailableRow(row, this.now()); }
  // Called only after state.success resolves: the extension now sees the fresh Node copy. Failed acknowledgements
  // are retried on later polls; stale worker/session/page acknowledgements cannot close a new page.
  async acknowledgeHandoffs() {
    if (!this.ipcFresh()) return;
    for (const s of this.retiring.values()) if (this.mode(s.eventId) === 'node' && this.pendingAcks.has(s.eventId)) {
      try { await this.request(this.socketPath, '/handoff', 3000, { worker: this.feed.worker, sessionId: this.feed.sessionId, eventId: s.eventId, pageId: s.pageId }); } catch (e) { this.log?.warn?.('[ggbet-browser] handoff acknowledgement failed', String(e?.message || e).slice(0, 160)); }
    }
  }
  status(now = this.now()) {
    const count = (m) => [...this.modes.values()].filter((x) => x.mode === m).length;
    return { enabled: true, socket: this.socketPath, ipc: { ok: this.ipc.ok, fresh: this.ipcFresh(now), lastOkAgoMs: this.ipc.lastOkAt ? now - this.ipc.lastOkAt : null, lastError: this.ipc.lastError, failures: this.ipc.failures, polls: this.ipc.polls },
      worker: this.feed ? { id: this.feed.worker, sessionId: this.feed.sessionId, vpnState: this.feed.vpnState, browserRunning: this.feed.browserRunning, vpnExit: this.feed.vpnExit, maxPages: this.feed.maxPages } : null,
      browserBackedEvents: count('browser'), browserUnavailableEvents: count('browser-unavailable'),
      retiring: [...this.retiring.values()].map((s) => ({ eventId: s.eventId, pageId: s.pageId, reason: s.retiring, pageState: s.state, source: this.mode(s.eventId) })),
      selected: [...this.selected.values()].map((s) => ({ eventId: s.eventId, title: s.title, sport: s.sport, league: s.league, status: s.status, score: s.score, sportRank: s.sportRank, globalRank: s.globalRank, selectionReason: s.reason, selectedAt: s.selectedAt, pageState: s.state, ready: !!this.ready(s.eventId, now), marketCount: s.marketCount, lastUpdateAt: s.lastUpdateAt, source: this.mode(s.eventId) === 'browser' ? 'browser' : this.mode(s.eventId), vpnExit: this.feed?.vpnExit?.hostname || null })),
      owned: [...this.modes].map(([eventId, m]) => ({ eventId, mode: m.mode, since: new Date(m.since).toISOString() })) };
  }
}
