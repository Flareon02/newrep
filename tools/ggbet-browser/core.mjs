// Pure logic of the GGBET Firefox browser worker (no browser, no I/O): frame parsing, market store (normalized rows and
// the raw GraphQL event/market objects), discovery lists, event selection and liveness. Kept separate so it can be tested
// without Firefox or GG.BET.
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
export const DEFAULTS = Object.freeze({ maxPages: 3, wsStaleMs: 90000, eventStaleMs: 180000, pageStaleMs: 600000, quietMs: 120000, endedGraceMs: 300000, lagMs: 60000,
  listFreshMs: 300000, diversityPresenceMs: 60000, diversityHoldMs: 180000, excludeMs: 1800000 });
export function config(env = process.env) {
  const n = (k, d, min) => { const v = Number(env[k]); return Number.isFinite(v) && v >= min ? Math.floor(v) : d; };
  return { maxPages: Math.min(3, n('GGBET_BROWSER_MAX_PAGES', DEFAULTS.maxPages, 1)), wsStaleMs: n('GGBET_BROWSER_WS_STALE_MS', DEFAULTS.wsStaleMs, 10000), eventStaleMs: n('GGBET_BROWSER_EVENT_STALE_MS', DEFAULTS.eventStaleMs, 20000), pageStaleMs: n('GGBET_BROWSER_PAGE_STALE_MS', DEFAULTS.pageStaleMs, 60000), quietMs: n('GGBET_BROWSER_QUIET_MS', DEFAULTS.quietMs, 10000), endedGraceMs: n('GGBET_BROWSER_ENDED_GRACE_MS', DEFAULTS.endedGraceMs, 30000), lagMs: n('GGBET_BROWSER_LAG_MS', DEFAULTS.lagMs, 10000),
    listFreshMs: n('GGBET_BROWSER_LIST_FRESH_MS', DEFAULTS.listFreshMs, 60000), diversityPresenceMs: n('GGBET_BROWSER_DIVERSITY_PRESENCE_MS', DEFAULTS.diversityPresenceMs, 0), diversityHoldMs: n('GGBET_BROWSER_DIVERSITY_HOLD_MS', DEFAULTS.diversityHoldMs, 0), excludeMs: n('GGBET_BROWSER_EXCLUDE_MS', DEFAULTS.excludeMs, 60000) };
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
  constructor({ now = () => Date.now() } = {}) { this.now = now; this.seq = 0; this.events = new Map(); this.stats = { frames: 0, dataFrames: 0, marketUpdates: 0, priceChanges: 0, duplicates: 0 }; this.updates = []; }
  ev(id) {
    if (!this.events.has(id)) this.events.set(id, { eventId: id, meta: {}, markets: new Map(), raw: null, rawMarkets: new Map(), catalog: null, lastEventUpdateAt: 0, lastEventVersionChangeAt: 0, lastMarketUpdateAt: 0, lastPriceChangeAt: 0, lastScoreUpdateAt: 0, lastStatusChangeAt: 0, version: null, versions: [], seq: 0 });
    return this.events.get(id);
  }
  // One incoming graphql-ws frame (already JSON-parsed). capturedAt = browser timestamp of the frame. allTab: the frame
  // answers the page's own "All" market-tab request/subscription (its marketIds = the event's full market catalog).
  ingest(msg, { capturedAt = this.now(), pageId = null, allTab = false } = {}) {
    const receivedAt = this.now(); this.stats.frames++;
    if (msg?.type !== 'data' || !msg.payload) return { events: [], changed: [] };
    this.stats.dataFrames++; const touched = new Set(), changed = [];
    const tab = msg.payload?.data?.compiledMarketsTab || msg.payload?.data?.onUpdateTab;
    if (allTab && tab?.sportEvent?.id && Array.isArray(tab.marketIds)) { const e = this.ev(String(tab.sportEvent.id)); e.catalog = new Set(tab.marketIds.map(String)); e.seq = ++this.seq; touched.add(e.eventId); }
    for (const item of walk(msg.payload)) {
      if (item.kind === 'event') {
        const e = this.ev(item.event.id), f = item.event.fixture || {}; touched.add(e.eventId); e.lastEventUpdateAt = receivedAt; e.pageId = pageId || e.pageId;
        const { markets: _m, ...head } = item.event; e.raw = mergeRawEvent(e.raw, head); e.seq = ++this.seq;
        if (item.event.version && item.event.version !== e.version) { e.version = item.event.version; e.lastEventVersionChangeAt = receivedAt; e.versions.push(e.version); if (e.versions.length > 64) e.versions.shift(); }
        const score = f.score != null ? String(f.score) : e.meta.score, status = f.status || e.meta.status;
        if (score !== e.meta.score && f.score != null) e.lastScoreUpdateAt = receivedAt;
        if (status !== e.meta.status && f.status) e.lastStatusChangeAt = receivedAt;
        e.meta = { ...e.meta, ...(f.title ? { eventName: f.title } : {}), ...(f.tournament?.name ? { league: f.tournament.name } : {}), ...(f.sportId ? { sport: f.sportId } : {}), ...(status ? { status } : {}), ...(f.score != null ? { score } : {}), ...(f.startTime ? { scheduledAt: f.startTime } : {}), ...(item.event.slug ? { slug: item.event.slug } : {}) };
      } else if (item.kind === 'market' && item.eventId) {
        const e = this.ev(item.eventId), m = item.market, id = String(m.id), old = e.markets.get(id), at = receivedAt; touched.add(e.eventId);
        e.rawMarkets.set(id, m); e.seq = ++this.seq;
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
  // The event as GG.BET's own GraphQL object (the same schema the Node collector parses): merged event fields plus every
  // market of the "All" catalog (when known) in ACTIVE/SUSPENDED state. Raw provider values, never corrected.
  rawEvent(eventId) {
    const e = this.events.get(eventId); if (!e?.raw?.fixture) return null;
    const markets = [...e.rawMarkets.values()].filter((m) => (!e.catalog || e.catalog.has(String(m.id))) && ['ACTIVE', 'SUSPENDED'].includes(String(m.status || '').toUpperCase()));
    return { ...e.raw, markets };
  }
  typeId96(eventId) { const e = this.events.get(eventId); return e ? [...e.markets.values()].filter((m) => Number(m.typeId) === 96) : []; }
}

// GG.BET pushes partial event objects: fields replace, the fixture merges, competitors merge by id (the Node collector's
// mergeGgbetEvent semantics).
export function mergeRawEvent(prev, patch) {
  if (!prev) return patch; const pf = prev.fixture || {}, nf = patch.fixture || {};
  const comp = nf.competitors ? (() => { const old = new Map((pf.competitors || []).map((c) => [String(c?.id), c])); return nf.competitors.map((c) => ({ ...old.get(String(c?.id)), ...c })).concat((pf.competitors || []).filter((c) => !nf.competitors.some((n) => String(n?.id) === String(c?.id)))); })() : pf.competitors;
  return { ...prev, ...patch, meta: patch.meta || prev.meta, fixture: { ...pf, ...nf, sport: nf.sport || pf.sport, tournament: nf.tournament || pf.tournament, competitors: comp } };
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

// ---------------------------------------------------------------- discovery and selection ------------------------------
// Target disciplines: the provider's own sport ids (GG.BET categorizer: esports_counter_strike "Counter-Strike",
// esports_dota_2 "Dota 2", esports_league_of_legends "League of Legends"). Array order = deterministic last tie-break.
export const TARGET_SPORTS = Object.freeze(['esports_counter_strike', 'esports_dota_2', 'esports_league_of_legends']);
export const SPORT_LABEL = Object.freeze({ esports_counter_strike: 'CS', esports_dota_2: 'Dota 2', esports_league_of_legends: 'LoL' });
const LIVE = ['LIVE', 'SUSPENDED'], OVER = ['ENDED', 'CLOSED', 'FINISHED', 'CANCELLED', 'ABANDONED'];
// A GetSportEventListByFilters answer in provider order (order: RANK_RECOMMENDED - the ranking GG.BET itself shows).
export function listRows(msg) {
  const m = msg?.payload?.data?.matches; if (!Array.isArray(m?.sportEvents)) return null;
  return { count: Number(m.count) || 0, rows: m.sportEvents.filter((e) => e?.id).map((e, index) => ({ eventId: String(e.id), slug: e.slug || null, sportId: e.fixture?.sportId || null, status: String(e.fixture?.status || '').toUpperCase(), title: e.fixture?.title || null, league: e.fixture?.tournament?.name || null, version: e.version || null, index })) };
}
// Lists seen by the discovery tab: one per target sport (its sport page) and the global LIVE list (cross-sport rank).
export class Discovery {
  constructor() { this.sports = new Map(); this.global = null; this.refs = new Map(); }
  applyList(sportIds, list, now) {
    if (!list) return; const one = sportIds?.length === 1 ? sportIds[0] : null;
    if (one) this.sports.set(one, { at: now, count: list.count, rows: list.rows }); else this.global = { at: now, rows: list.rows.filter((r) => LIVE.includes(r.status)) };
    for (const r of list.rows) { const p = this.refs.get(r.eventId); this.refs.set(r.eventId, { ...p, slug: r.slug || p?.slug, sportId: r.sportId || p?.sportId, title: r.title || p?.title, league: r.league || p?.league, status: r.status || p?.status, statusAt: now, version: r.version || p?.version || null, versionAt: r.version ? now : p?.versionAt || 0, firstSeenAt: p?.firstSeenAt || now, seenAt: one ? now : p?.seenAt || now }); }
  }
  // A pushed update of a listed event (the discovery page's own subscriptions): version and status only.
  applyUpdate(ev, now) { const p = this.refs.get(ev?.id); if (!p) return; this.refs.set(ev.id, { ...p, ...(ev.version ? { version: ev.version, versionAt: now } : {}), ...(ev.fixture?.status ? { status: String(ev.fixture.status).toUpperCase(), statusAt: now } : {}) }); }
  sportFresh(sportId, now, cfg) { const l = this.sports.get(sportId); return !!l && now - l.at <= cfg.listFreshMs; }
  // LIVE candidates per target sport from FRESH sport lists only, provider order; sportRank = position among the sport's
  // LIVE rows (1 = most popular), globalRank = position in the global LIVE list when it lists the event.
  candidates(now, cfg) {
    const out = new Map(), g = this.global && now - this.global.at <= cfg.listFreshMs ? new Map(this.global.rows.map((r, i) => [r.eventId, i + 1])) : new Map();
    for (const sportId of TARGET_SPORTS) {
      if (!this.sportFresh(sportId, now, cfg)) continue;
      const rows = this.sports.get(sportId).rows.filter((r) => r.sportId === sportId && r.slug && LIVE.includes(this.refs.get(r.eventId)?.status || r.status));
      out.set(sportId, rows.map((r, i) => ({ eventId: r.eventId, slug: r.slug, sportId, title: r.title, league: r.league, sportRank: i + 1, globalRank: g.get(r.eventId) ?? null, firstSeenAt: this.refs.get(r.eventId)?.firstSeenAt || now })));
    }
    return out;
  }
  ended(eventId) { return OVER.includes(this.refs.get(eventId)?.status); }
  // Gone = absent from its sport's fresh list for endedGraceMs, judged on the list's own clock (a silent or unreachable
  // discovery never ends anything).
  gone(page, now, cfg) {
    const l = this.sports.get(page.sportId), r = this.refs.get(page.eventId); if (!l || now - l.at > cfg.listFreshMs) return false;
    return !l.rows.some((x) => x.eventId === page.eventId) && l.at - Math.max(r?.seenAt || 0, page.openedAt) > cfg.endedGraceMs;
  }
}
// Which events the browser serves (max maxPages): CASE A one per sport; B one per available sport, then the next most
// popular among them; C the sport's top N; D everything available. Stable: a held event stays while it is LIVE; ranking
// changes alone never move a tab. The only replacement of a live, held event is diversity (a target sport with LIVE events
// and no tab while the set is full): at most one swap per round, only after the new sport has been listed for
// diversityPresenceMs and the replaced event (the worst-ranked of the most represented sport) was held diversityHoldMs.
// current: held events [{eventId, sportId, selectedAt}] (ended/gone/excluded already removed by the caller).
export function selectEvents({ current = [], candidates = new Map(), maxPages = DEFAULTS.maxPages, now = Date.now(), cfg = DEFAULTS, excluded = new Set() }) {
  maxPages = Math.min(3, maxPages);
  const keep = [...current], add = [], drop = [], taken = new Set(keep.map((k) => k.eventId)), order = (s) => TARGET_SPORTS.indexOf(s);
  const pool = (s) => (candidates.get(s) || []).filter((c) => !excluded.has(c.eventId) && !taken.has(c.eventId));
  const avail = TARGET_SPORTS.filter((s) => (candidates.get(s) || []).some((c) => !excluded.has(c.eventId)));
  const g = (c) => c?.globalRank ?? Infinity, rankNow = (k) => (candidates.get(k.sportId) || []).find((c) => c.eventId === k.eventId)?.sportRank ?? Infinity;
  const sportPriority = (a, b) => g(pool(a)[0]) - g(pool(b)[0]) || order(a) - order(b);
  const covered = () => new Set([...keep, ...add].map((x) => x.sportId));
  if (keep.length >= maxPages) {
    for (const s of avail.filter((x) => !covered().has(x)).sort(sportPriority)) {
      const top = pool(s)[0]; if (!top || now - top.firstSeenAt < cfg.diversityPresenceMs) continue;
      const per = new Map(); for (const k of keep) per.set(k.sportId, (per.get(k.sportId) || 0) + 1);
      const heavy = [...per].filter(([, n]) => n > 1).sort((a, b) => b[1] - a[1] || order(b[0]) - order(a[0]))[0]?.[0]; if (!heavy) continue;
      const victim = keep.filter((k) => k.sportId === heavy && now - (k.selectedAt || 0) >= cfg.diversityHoldMs).sort((a, b) => rankNow(b) - rankNow(a))[0]; if (!victim) continue;
      keep.splice(keep.indexOf(victim), 1); drop.push({ eventId: victim.eventId, reason: `diversity: ${SPORT_LABEL[s]} LIVE without a tab` });
      add.push({ ...top, reason: `diversity: top ${SPORT_LABEL[s]} (provider rank ${top.sportRank})` }); taken.add(top.eventId);
      break; // one swap per round
    }
  }
  while (keep.length + add.length < maxPages) {
    const open = avail.filter((s) => !covered().has(s) && pool(s).length).sort(sportPriority); let c, reason;
    if (open.length) { c = pool(open[0])[0]; reason = `top ${SPORT_LABEL[c.sportId]} (provider rank ${c.sportRank})`; }
    else { // Cross-sport slots require the provider's global order; wait for it rather than inventing a score.
      c = avail.flatMap(pool).filter((c) => avail.length === 1 || c.globalRank != null).sort((a, b) => avail.length === 1 ? a.sportRank - b.sportRank : g(a) - g(b))[0]; if (c) reason = `next most popular: ${SPORT_LABEL[c.sportId]} #${c.sportRank}${c.globalRank ? `, global #${c.globalRank}` : ''}`; }
    if (!c) break; add.push({ ...c, reason }); taken.add(c.eventId);
  }
  return { keep, add, drop };
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
