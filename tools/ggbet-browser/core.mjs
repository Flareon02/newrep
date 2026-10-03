// Pure logic of the experimental GGBET Firefox worker (no browser, no I/O): frame parsing, market store, page
// registry and liveness. Kept separate so it can be tested without Firefox or GG.BET.
//
// Liveness keeps three things apart (an unchanged price is NOT staleness):
//   transport  - any WebSocket frame of the page (incl. graphql-ws keep-alives)
//   data       - application data frames for the event (eventVersion/score/status/market updates)
//   price      - an outcome price actually changed
// States: HEALTHY (event data flowing, prices moving) | QUIET (event data flowing, prices unchanged - not a failure) |
// SUSPECT_STALE (LIVE, no event data for eventStaleMs) | STALE (no event data for eventStaleMs AND no transport for
// wsStaleMs, or no event data for pageStaleMs) | RECOVERING (after a reload, until event data returns) | ENDED.
// Independent reference: the discovery tab's list carries every event's current version. A page holding the same version
// as a fresh list is QUIET however long ago its last frame was (GG.BET is not pushing - e.g. a map break; reloading would
// not help); a page missing a version the list has shown for more than lagMs is STALE at once (it lags behind the source).
export const DEFAULTS = Object.freeze({ maxPages: 10, wsStaleMs: 90000, eventStaleMs: 180000, pageStaleMs: 600000, quietMs: 120000, endedGraceMs: 300000, lagMs: 60000 });
export function config(env = process.env) {
  const n = (k, d, min) => { const v = Number(env[k]); return Number.isFinite(v) && v >= min ? Math.floor(v) : d; };
  return { maxPages: n('GGBET_BROWSER_MAX_PAGES', DEFAULTS.maxPages, 1), wsStaleMs: n('GGBET_BROWSER_WS_STALE_MS', DEFAULTS.wsStaleMs, 10000), eventStaleMs: n('GGBET_BROWSER_EVENT_STALE_MS', DEFAULTS.eventStaleMs, 20000), pageStaleMs: n('GGBET_BROWSER_PAGE_STALE_MS', DEFAULTS.pageStaleMs, 60000), quietMs: n('GGBET_BROWSER_QUIET_MS', DEFAULTS.quietMs, 10000), endedGraceMs: n('GGBET_BROWSER_ENDED_GRACE_MS', DEFAULTS.endedGraceMs, 30000), lagMs: n('GGBET_BROWSER_LAG_MS', DEFAULTS.lagMs, 10000) };
}
const EVENT_ID = /^\d+:[0-9a-f-]{36}$/i;
// Every sport event and every market object inside a GraphQL payload (markets carry the nearest enclosing event id).
export function* walk(node, eventId = null, depth = 0) {
  if (!node || typeof node !== 'object' || depth > 16) return;
  if (Array.isArray(node)) { for (const v of node) yield* walk(v, eventId, depth + 1); return; }
  let ev = eventId;
  if (typeof node.id === 'string' && EVENT_ID.test(node.id) && ('fixture' in node || 'version' in node || 'markets' in node)) { ev = node.id; yield { kind: 'event', event: node }; }
  if (Array.isArray(node.odds) && node.id != null && ('typeId' in node || 'name' in node)) { yield { kind: 'market', eventId: ev, market: node }; return; }
  for (const v of Object.values(node)) if (v && typeof v === 'object') yield* walk(v, ev, depth + 1);
}
const spec = (m) => Object.fromEntries((m.specifiers || []).map((p) => [p?.name, p?.value]));

export class MarketStore {
  constructor({ now = () => Date.now() } = {}) { this.now = now; this.events = new Map(); this.stats = { frames: 0, dataFrames: 0, marketUpdates: 0, priceChanges: 0, duplicates: 0 }; this.updates = []; }
  ev(id) {
    if (!this.events.has(id)) this.events.set(id, { eventId: id, meta: {}, markets: new Map(), lastEventUpdateAt: 0, lastEventVersionChangeAt: 0, lastMarketUpdateAt: 0, lastPriceChangeAt: 0, lastScoreUpdateAt: 0, lastStatusChangeAt: 0, version: null, versions: [] });
    return this.events.get(id);
  }
  // One incoming graphql-ws frame (already JSON-parsed). capturedAt = browser timestamp of the frame.
  ingest(msg, { capturedAt = this.now(), pageId = null } = {}) {
    const receivedAt = this.now(); this.stats.frames++;
    if (msg?.type !== 'data' || !msg.payload) return { events: [], changed: [] };
    this.stats.dataFrames++; const touched = new Set(), changed = [];
    for (const item of walk(msg.payload)) {
      if (item.kind === 'event') {
        const e = this.ev(item.event.id), f = item.event.fixture || {}; touched.add(e.eventId); e.lastEventUpdateAt = receivedAt; e.pageId = pageId || e.pageId;
        if (item.event.version && item.event.version !== e.version) { e.version = item.event.version; e.lastEventVersionChangeAt = receivedAt; e.versions.push(e.version); if (e.versions.length > 64) e.versions.shift(); }
        const score = f.score != null ? String(f.score) : e.meta.score, status = f.status || e.meta.status;
        if (score !== e.meta.score && f.score != null) e.lastScoreUpdateAt = receivedAt;
        if (status !== e.meta.status && f.status) e.lastStatusChangeAt = receivedAt;
        e.meta = { ...e.meta, ...(f.title ? { eventName: f.title } : {}), ...(f.tournament?.name ? { league: f.tournament.name } : {}), ...(f.sportId ? { sport: f.sportId } : {}), ...(status ? { status } : {}), ...(f.score != null ? { score } : {}), ...(f.startTime ? { scheduledAt: f.startTime } : {}), ...(item.event.slug ? { slug: item.event.slug } : {}) };
      } else if (item.kind === 'market' && item.eventId) {
        const e = this.ev(item.eventId), m = item.market, id = String(m.id), old = e.markets.get(id), at = receivedAt; touched.add(e.eventId);
        const outcomes = m.odds.map((o) => ({ outcomeId: String(o.id), outcomeName: o.name ?? null, rawPrice: o.value != null ? String(o.value) : null, active: o.isActive !== false, status: o.status ?? null }));
        const sig = JSON.stringify([m.status, outcomes.map((o) => [o.outcomeId, o.rawPrice, o.active])]);
        if (old && old.sig === sig) { this.stats.duplicates++; old.lastSeenAt = at; e.lastMarketUpdateAt = at; e.lastEventUpdateAt = at; continue; }
        const priceChanged = !old || JSON.stringify(old.outcomes.map((o) => [o.outcomeId, o.rawPrice])) !== JSON.stringify(outcomes.map((o) => [o.outcomeId, o.rawPrice]));
        const s = spec(m), row = { eventId: e.eventId, marketId: id, typeId: m.typeId ?? null, specifier: s, mapnr: s.mapnr ?? null, marketName: m.name ?? old?.marketName ?? null, marketStatus: m.status ?? null, outcomes, sig, capturedAt, receivedAt: at, lastSeenAt: at, priceChangedAt: priceChanged ? at : old.priceChangedAt, pageId, source: 'firefox-browser' };
        e.markets.set(id, row); e.lastMarketUpdateAt = at; e.lastEventUpdateAt = at; this.stats.marketUpdates++; changed.push(row);
        if (priceChanged && old) { e.lastPriceChangeAt = at; this.stats.priceChanges++; }
        if (!old) e.lastPriceChangeAt = e.lastPriceChangeAt || at;
      }
    }
    this.updates.push(receivedAt); while (this.updates.length && this.updates[0] < receivedAt - 60000) this.updates.shift();
    return { events: [...touched], changed }; // changed = new or changed market rows (price, status or activity)
  }
  // A browser session ended (VPN loss, crash, restart): nothing it delivered may be served once a new session starts.
  reset() { this.events.clear(); this.updates = []; }
  updatesPerMinute() { const t = this.now(); return this.updates.filter((x) => x >= t - 60000).length; }
  typeId96(eventId) { const e = this.events.get(eventId); return e ? [...e.markets.values()].filter((m) => Number(m.typeId) === 96) : []; }
}

// One page (tab) = one LIVE event. Transport/data/price liveness -> state.
// ref = { version, versionAt } of the same event from the discovery list (optional).
export function pageState(page, event, cfg, now = Date.now(), ref = null) {
  if (page.ended || ['ENDED', 'CLOSED', 'FINISHED', 'CANCELLED'].includes(String(event?.meta?.status || '').toUpperCase())) return 'ENDED';
  const dataAge = now - (event?.lastEventUpdateAt || page.openedAt), wsAge = now - (page.lastWsFrameAt || page.openedAt), priceAge = now - (event?.lastPriceChangeAt || page.openedAt);
  // A tab without any event data yet (still loading) has nothing fresh to serve.
  if (!event?.lastEventUpdateAt) return now - page.openedAt > cfg.eventStaleMs ? 'STALE' : 'RECOVERING';
  if (page.recovering && !(event?.lastEventUpdateAt > page.recoveringSince)) return now - page.recoveringSince > cfg.eventStaleMs ? 'STALE' : 'RECOVERING';
  const refFresh = !!ref?.version && now - ref.versionAt <= cfg.eventStaleMs, lag = cfg.lagMs ?? DEFAULTS.lagMs;
  if (refFresh && !event.versions?.includes(ref.version) && ref.versionAt - event.lastEventUpdateAt > lag) return 'STALE';
  if (refFresh && ref.version === event.version) { if (dataAge > cfg.eventStaleMs && wsAge > cfg.wsStaleMs) return 'STALE'; }
  else if (dataAge > cfg.pageStaleMs || (dataAge > cfg.eventStaleMs && wsAge > cfg.wsStaleMs)) return 'STALE';
  else if (dataAge > cfg.eventStaleMs) return 'SUSPECT_STALE';
  return priceAge > cfg.quietMs ? 'QUIET' : 'HEALTHY';
}

// Deterministic page set: keep every open, non-ended page (no rotation); fill free slots with the earliest LIVE events.
// An ended event is never reopened, even while the discovery list still (lagging) shows it as LIVE: `exclude` carries the
// ids of pages closed as ended earlier.
// allowPrematch (capacity testing only, GGBET_BROWSER_FILL_PREMATCH=1): free slots left after every LIVE event are filled
// with upcoming events, LIVE always first.
export function planPages({ open = [], candidates = [], maxPages = DEFAULTS.maxPages, exclude = [], allowPrematch = false }) {
  const keep = open.filter((p) => !p.ended), have = new Set([...open.map((p) => p.eventId), ...exclude]), live = (c) => (c.status === 'LIVE' ? 0 : 1);
  const add = candidates.filter((c) => (c.status === 'LIVE' || allowPrematch) && c.slug && !have.has(c.eventId)).sort((a, b) => live(a) - live(b) || String(a.scheduledAt || '').localeCompare(String(b.scheduledAt || '')) || a.eventId.localeCompare(b.eventId)).slice(0, Math.max(0, maxPages - keep.length));
  return { keep, add, close: open.filter((p) => p.ended) };
}

// "Gone from the list" is judged against the list's own clock (candidatesAt = last list data): while discovery receives
// nothing (GG.BET unreachable) no candidate expires and no page is ended for being absent.
export function pruneCandidates(candidates, candidatesAt, cfg) { for (const c of [...candidates.values()]) if (candidatesAt - c.seenAt > cfg.endedGraceMs) candidates.delete(c.eventId); }
export function goneFromList(page, candidates, candidatesAt, cfg, now = Date.now()) {
  return now - candidatesAt < cfg.eventStaleMs && !candidates.has(page.eventId) && candidatesAt > page.openedAt + cfg.endedGraceMs;
}

// LIVE Dota events from the discovery page's own list frames (plus upcoming ones when includePrematch).
export function liveDotaCandidates(msg, { includePrematch = false } = {}) {
  const out = [];
  for (const item of walk(msg?.payload)) {
    if (item.kind !== 'event') continue; const f = item.event.fixture || {};
    if (f.sportId === 'esports_dota_2' && (f.status === 'LIVE' || (includePrematch && f.status === 'NOT_STARTED')) && item.event.slug) out.push({ eventId: item.event.id, slug: item.event.slug, status: f.status, scheduledAt: f.startTime || null, eventName: f.title || null, version: item.event.version || null });
  }
  return out;
}

// Published view with freshness; everything is stale when the VPN or the browser is not up.
export function publish(store, pages, { vpnState = 'UP', browserUp = true, cfg = DEFAULTS, now = Date.now(), refs = null } = {}) {
  const down = vpnState !== 'UP' || !browserUp;
  return pages.map((p) => {
    const e = store.events.get(p.eventId), state = down ? 'UNAVAILABLE' : pageState(p, e, cfg, now, refs?.get(p.eventId));
    const ref = refs?.get(p.eventId);
    return { pageId: p.pageId, eventId: p.eventId, ...(e?.meta || {}), eventVersion: e?.version || null, listVersion: ref?.version || null, listVersionAgeMs: ref?.versionAt ? now - ref.versionAt : null, state, fresh: !down && ['HEALTHY', 'QUIET'].includes(state),
      markets: e ? [...e.markets.values()].map(({ sig, ...m }) => ({ ...m, ageMs: now - m.receivedAt, stale: down || !['HEALTHY', 'QUIET'].includes(state) })) : [] };
  });
}
