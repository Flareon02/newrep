import GameCategories from './game-categories.cjs';
import { canonicalCategory, englishize, eventKind } from './entity-resolver.js';
import { config } from './config.js';
import { canonicalizeGgbetMarket } from './market-semantics.js';
import {
  MATCH_STATUSES, LIVE_SPORTS, absoluteAsset, scoreParts, marketPeriod, marketType, localizedMarketTitle,
  outcomeDesignation, localizedOutcomeLabel, pricePoint, mergeGgbetEvent
} from './ggbet.js';

// DataBet LIVE collector (public https://demo.data.bet).
//
// DataBet is the DATA.BET sportsbook itself; GGBET runs on the same platform, so the GraphQL schema, market
// typeIds and outcome conventions are identical and the pure normalization helpers are shared with ggbet.js.
// What differs is everything around the session: DataBet publishes a guest token in its public SSR page
// (`window.bettingOptions`), the GraphQL endpoint carries the operator label (`?label=...`), and GGBET's
// persisted-query hashes are not registered there, so every operation below is sent as plain GraphQL text.
//
// Load model (1 CPU / small RAM): every LIVE event streams fixture + top markets; the complete market tree is
// pushed only for events whose odds dialog is open (each detail request extends the window). Every push is an
// absolute event state for the subscribed market set, never a delta, so a push simply replaces that set.
// Odds are kept exactly as received: `value` -> decimal (null while the market/outcome is closed), plus the
// upstream `probability` and the raw `value` string for diagnostics. Nothing is corrected or re-priced.

const MARKET_STATUSES = ['ACTIVE', 'SUSPENDED'];
const TOP_MARKETS = 3;
const USER_AGENT = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36';

const FIXTURE_FIELDS = 'id disabled providerId slug betStop version meta{name value} fixture{score title status type startTime sportId sport{id name tags slug} tournament{id name slug sportId countryCode} competitors{id name type homeAway logo score{id type points number}}}';
const MARKET_FIELDS = 'id name status typeId priority tags specifiers{name value} meta{name value} odds{id name value probability isActive status competitorIds}';
export const DATABET_LIST_QUERY = `query DatabetLiveList($offset:Int!,$limit:Int!,$sportIds:[String!],$matchStatuses:[SportEventStatus!],$marketStatuses:[MarketStatus!],$marketLimit:Int){matches:sportEventListByFilters(offset:$offset,limit:$limit,matchStatuses:$matchStatuses,sportIds:$sportIds,marketStatuses:$marketStatuses,sportEventTypes:[MATCH],order:RANK_RECOMMENDED){count sportEvents{${FIXTURE_FIELDS} markets(top:true,limit:$marketLimit,statuses:$marketStatuses){${MARKET_FIELDS}}}}}`;
export const DATABET_LIGHT_SUBSCRIPTION = `subscription DatabetLiveEvent($sportEventId:String!,$version:String,$marketStatuses:[MarketStatus!],$marketLimit:Int){onUpdateSportEvent(sportEventId:$sportEventId,marketStatuses:$marketStatuses,version:$version){${FIXTURE_FIELDS} markets(top:true,limit:$marketLimit,statuses:$marketStatuses){${MARKET_FIELDS}}}}`;
export const DATABET_FULL_SUBSCRIPTION = `subscription DatabetFullEvent($sportEventId:String!,$version:String,$marketStatuses:[MarketStatus!]){onUpdateSportEvent(sportEventId:$sportEventId,marketStatuses:$marketStatuses,version:$version){${FIXTURE_FIELDS} markets(statuses:$marketStatuses){${MARKET_FIELDS}}}}`;
export const DATABET_TABS_QUERY = 'query DatabetMarketTabs($sportEventID:String!,$marketStatuses:[MarketStatus!]){compiledMarketsTabs(sportEventID:$sportEventID,marketStatuses:$marketStatuses){tabs{id name marketIds}}}';

const text = (v) => String(v ?? '').trim();
const finite = (v) => { if (v == null || String(v).trim() === '') return null; const n = Number(v); return Number.isFinite(n) ? n : null; };
const safeUuid = (id) => text(id).replace(/^\d+:/, '').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 100);
const meta = (row, name) => text((row?.meta || []).find((x) => text(x?.name) === name)?.value);
const iso = (ms) => (ms ? new Date(ms).toISOString() : null);
const jitter = (ms) => Math.max(250, Math.round(ms * (0.85 + Math.random() * 0.3)));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const isAuthError = (value) => /auth|token|unauthor|forbidden|permission|401|403/i.test(text(value));
const backoff = (failures) => jitter(Math.min(config.databetMaxBackoffMs, 1000 * (2 ** Math.min(6, failures))));

// Public metadata of the guest token: the JWE protected header is plain base64url JSON (label, locale,
// currency, isAuthorized). The encrypted payload is never touched.
export function databetTokenMetadata(token) {
  try {
    const header = JSON.parse(Buffer.from(String(token).split('.')[0], 'base64url').toString('utf8'));
    return { label: text(header.label), locale: text(header.locale), currency: text(header.currency), isAuthorized: header.isAuthorized === true };
  } catch { return { label: '', locale: '', currency: '', isAuthorized: false }; }
}

export function normalizeDatabetWsUrl(endpoint) {
  const raw = text(endpoint), normalized = raw.startsWith('//') ? 'wss:' + raw : raw.replace(/^https:/i, 'wss:');
  let url; try { url = new URL(normalized); } catch { throw Error('DataBet: неожиданный betting endpoint'); }
  if (url.protocol !== 'wss:' || !/^([a-z0-9-]+\.)*databet\.cloud$/i.test(url.hostname) || url.pathname.replace(/\/+$/, '') !== '/graphql' || url.port) throw Error('DataBet: неожиданный betting endpoint');
  const label = url.searchParams.get('label') || '';
  if (label && !/^[a-z0-9_-]{1,40}$/i.test(label)) throw Error('DataBet: неожиданный label endpoint');
  return `wss://${url.hostname.toLowerCase()}/graphql${label ? `?label=${label}` : ''}`;
}

export function databetBootstrapFromHtml(html, { origin = config.databetOrigin, at = Date.now() } = {}) {
  const page = String(html || ''), marker = page.indexOf('window.bettingOptions');
  if (marker < 0) throw Error('DataBet: bettingOptions не найден на странице');
  const block = page.slice(marker, marker + 20000);
  const token = block.match(/"token"\s*:\s*"([^"]+)"/)?.[1] || '', endpoint = block.match(/"gqlEndpoint"\s*:\s*"([^"]+)"/)?.[1] || '';
  if (token.length < 100 || !/^eyJ[\w-]+(?:\.[\w-]*){2,4}$/.test(token)) throw Error('DataBet: guest token не найден');
  const wsUrl = normalizeDatabetWsUrl(endpoint), info = databetTokenMetadata(token), label = new URL(wsUrl).searchParams.get('label') || info.label;
  if (info.label && label && info.label !== label) throw Error('DataBet: label токена не совпадает с endpoint');
  return { token, wsUrl, origin, label, locale: info.locale, currency: info.currency, isAuthorized: info.isAuthorized, at: Number(at) || Date.now() };
}

function databetOdds(raw, home, away, at, providerTabs = null) {
  const homeId = text(home?.id), awayId = text(away?.id), markets = [];
  for (const m of Array.isArray(raw?.markets) ? raw.markets : []) {
    const status = text(m?.status).toUpperCase() === 'ACTIVE' && !raw?.betStop ? 'open' : 'suspended', type = marketType(m), period = marketPeriod(m), title = localizedMarketTitle(m, type, period);
    const prices = (m?.odds || []).map((o, index) => {
      const ids = (o?.competitorIds || []).map(String), name = text(o?.name), points = pricePoint(o, m);
      let designation = ids.includes(homeId) ? 'home' : ids.includes(awayId) ? 'away' : '';
      designation = outcomeDesignation(name, designation);
      if (!designation && (m?.odds || []).length === 2) {
        if (['total', 'map-total', 'team-round-total', 'asian-round-total'].includes(type)) designation = index === 0 ? 'over' : 'under';
        else designation = index === 0 ? 'home' : 'away';
      }
      const decimal = finite(o?.value), open = status === 'open' && o?.isActive !== false && text(o?.status || 'NOT_RESULTED') === 'NOT_RESULTED' && decimal > 1;
      return { designation: designation || `outcome-${o?.id || index + 1}`, label: localizedOutcomeLabel(name, designation, points), rawLabel: name, outcomeId: text(o?.id), points, decimal: open ? decimal : null, rawValue: text(o?.value), probability: finite(o?.probability), rawType: Number(m?.typeId) || 0 };
    });
    const row = { key: `databet:${text(m?.id) || Number(m?.typeId) || markets.length}`, marketId: text(m?.id), type, title, rawTitle: text(m?.name), period, status, prices, rawType: Number(m?.typeId) || 0, tags: [...(m?.tags || [])].map(text), specifiers: Object.fromEntries((m?.specifiers || []).map((x) => [text(x?.name), text(x?.value)]).filter(([k]) => k)), upstreamProvider: meta(m, 'provider_source') };
    row.providerTabs = [...(providerTabs?.marketToTabs?.get(text(m?.id)) || ['all'])];
    row.canonical = canonicalizeGgbetMarket(row, { team1: text(home?.name), team2: text(away?.name) }, 'databet');
    row.title = row.canonical.title;
    markets.push(row);
  }
  return markets.length ? { provider: 'DataBet', team1: text(home?.name), team2: text(away?.name), mode: 'live', updatedAt: at, checkedAt: at, stale: false, transport: 'graphql-ws', providerTabs: (providerTabs?.catalog || []).map((t) => ({ id: t.id, name: t.name, count: Number(t.count) || 0 })), markets } : null;
}

export function parseDatabetLiveEvent(raw, { origin = config.databetOrigin, locale = config.databetLocale, at = Date.now(), providerTabs = null } = {}) {
  if (!raw?.id || !raw?.fixture) return null;
  const fixture = raw.fixture, status = text(fixture.status).toUpperCase();
  if (!MATCH_STATUSES.includes(status) || raw.disabled === true) return null;
  const sport = fixture.sport || {}, tags = (sport.tags || []).map((x) => text(x).toUpperCase());
  if (tags.includes('PLASTIC')) return null;
  const score = scoreParts(fixture), team1 = englishize(score.home?.name), team2 = englishize(score.away?.name);
  if (!team1 || !team2) return null;
  const sportId = text(fixture.sportId || sport.id), league = englishize(fixture.tournament?.name) || 'Unknown league', category = canonicalCategory(GameCategories.resolve(englishize(sport.name) || sportId, league));
  const upstreamEventId = text(raw.id), sourceEventId = safeUuid(upstreamEventId);
  if (!sourceEventId) return null;
  const bestOf = Math.max(0, Number(meta(raw, 'bo')) || 0), base = String(origin || config.databetOrigin).replace(/\/+$/, ''), lang = /^[a-z]{2}$/.test(locale) ? locale : 'en';
  return {
    id: `databet-${sourceEventId}`, sourceEventId, upstreamEventId, source: 'databet', provider: 'DataBet', category,
    categoryKey: `databet:sport:${sportId || category.toLowerCase()}`, subSportId: sportId, league, leagueId: text(fixture.tournament?.id),
    leagueKey: `databet:id:${text(fixture.tournament?.id) || league.toLowerCase()}`, team1, team2,
    team1Logo: absoluteAsset(score.home?.logo), team2Logo: absoluteAsset(score.away?.logo), sportName: englishize(sport.name) || category,
    marketKind: eventKind({ league, team1, team2 }), startAt: Date.parse(fixture.startTime) || Date.now(), updatedAt: at,
    bestOf, bestOfSource: bestOf ? 'databet:meta.bo' : 'unknown', bestOfEvidence: bestOf ? String(bestOf) : '',
    seriesScore: score.seriesScore, mapScores: score.mapScores, activeMap: score.activeMap, scoreText: score.scoreText, scoreObserved: score.scoreObserved,
    odds: databetOdds(raw, score.home, score.away, at, providerTabs),
    url: raw.slug ? `${base}/${lang}/esports/live/match/${encodeURIComponent(raw.slug)}` : `${base}/${lang}/esports/live`
  };
}

export class DatabetLiveCollector {
  constructor(state, { fetchImpl = globalThis.fetch, WebSocketImpl = null, now = () => Date.now() } = {}) {
    this.state = state; this.fetch = fetchImpl; this.WebSocket = WebSocketImpl; this.WebSocketPromise = null; this.now = now;
    this.ws = null; this.stopped = true; this.connecting = null; this.bootstrap = null; this.connectCount = 0; this.seq = 0;
    this.events = new Map();        // upstream event id -> merged raw event
    this.subscriptions = new Map(); // upstream event id -> {id, mode: 'light'|'full', delivered}
    this.requests = new Map();      // operation id -> {kind, id, eventId, mode, at}
    this.fullMarkets = new Map();   // upstream event id -> {until, requestedAt}
    this.tabs = new Map();          // upstream event id -> {at, pending, requestedAt, catalog, marketToTabs}
    this.failures = 0; this.reconnects = 0; this.snapshots = 0; this.pushes = 0; this.publishes = 0; this.mismatchedPushes = 0; this.finishedEvents = 0;
    this.bootstrapFetches = 0; this.bootstrapFailures = 0; this.authRefreshes = 0; this.scheduledRefreshes = 0;
    this.lastMessageAt = 0; this.lastConnectAt = 0; this.lastAckAt = 0; this.lastSnapshotAt = 0; this.lastPushAt = 0; this.lastPublishAt = 0;
    this.lastError = ''; this.lastClose = '';
    this.publishTimer = null; this.snapshotSoon = null; this.reconnectTimer = null; this.maintenanceTimer = null;
  }

  connectionState() {
    if (!config.databetLiveEnabled) return 'disabled';
    if (this.ws?.readyState === 1 && this.lastAckAt) return 'connected';
    if (this.stopped) return 'stopped';
    return this.connecting || this.reconnectTimer ? 'reconnecting' : 'unavailable';
  }

  status() {
    let markets = 0; for (const raw of this.events.values()) markets += Array.isArray(raw?.markets) ? raw.markets.length : 0;
    const full = [...this.subscriptions.values()].filter((s) => s.mode === 'full').length;
    return {
      enabled: config.databetLiveEnabled, provider: 'databet', transport: 'graphql-ws', connectionState: this.connectionState(),
      connected: this.ws?.readyState === 1, acknowledged: !!this.lastAckAt && this.ws?.readyState === 1,
      origin: this.bootstrap?.origin || config.databetOrigin, endpoint: (this.bootstrap?.wsUrl || '').replace(/\?.*$/, '').replace(/\/graphql$/, ''),
      label: this.bootstrap?.label || '', locale: this.bootstrap?.locale || '', currency: this.bootstrap?.currency || '', authorized: this.bootstrap?.isAuthorized === true,
      tokenRefreshedAt: iso(this.bootstrap?.at), sessionStartedAt: iso(this.lastConnectAt), lastMessageAt: iso(this.lastMessageAt), lastSnapshotAt: iso(this.lastSnapshotAt), lastPushAt: iso(this.lastPushAt), lastPublishAt: iso(this.lastPublishAt),
      events: this.events.size, markets, subscriptions: this.subscriptions.size, fullMarketEvents: full, lightEvents: this.subscriptions.size - full,
      reconnects: this.reconnects, failures: this.failures, snapshots: this.snapshots, pushes: this.pushes, publishes: this.publishes, mismatchedPushes: this.mismatchedPushes, finishedEvents: this.finishedEvents,
      bootstrapFetches: this.bootstrapFetches, bootstrapFailures: this.bootstrapFailures, authRefreshes: this.authRefreshes, scheduledRefreshes: this.scheduledRefreshes,
      lastError: this.lastError, lastClose: this.lastClose,
      snapshotIntervalMs: config.databetSnapshotIntervalMs, sessionRefreshMs: config.databetSessionRefreshMs, fullMarketsTtlMs: config.databetFullMarketsTtlMs, maxFullEvents: config.databetMaxFullEvents
    };
  }

  async fetchBootstrap(force = false) {
    if (!force && this.bootstrap && this.now() - this.bootstrap.at < config.databetBootstrapCacheMs) return this.bootstrap;
    const ctrl = new AbortController(), timer = setTimeout(() => ctrl.abort(), config.databetRequestTimeoutMs); timer.unref?.();
    try {
      const res = await this.fetch(`${config.databetOrigin}/${config.databetLocale}/esports/live`, { headers: { 'user-agent': USER_AGENT, accept: 'text/html,application/xhtml+xml', 'accept-language': `${config.databetLocale},en;q=0.8` }, redirect: 'follow', signal: ctrl.signal });
      if (!res?.ok) throw Object.assign(Error(`DataBet bootstrap HTTP ${res?.status || 0}`), { status: res?.status || 0 });
      const html = await res.text();
      if (html.length > 4_000_000) throw Error('DataBet: bootstrap HTML слишком большой');
      const data = databetBootstrapFromHtml(html, { origin: config.databetOrigin, at: this.now() });
      this.bootstrap = data; this.bootstrapFetches++;
      return data;
    } catch (error) {
      this.bootstrapFailures++;
      throw error?.name === 'AbortError' ? Error('DataBet: таймаут загрузки страницы') : error;
    } finally { clearTimeout(timer); }
  }

  send(data) { if (this.ws?.readyState !== 1) throw Error('DataBet: WebSocket не подключён'); this.ws.send(JSON.stringify(data)); }
  nextId(prefix) { return `${prefix}${++this.seq}`; }
  ready() { return this.ws?.readyState === 1 && !!this.lastAckAt; }

  requestSnapshot() {
    if (!this.ready()) return;
    const now = this.now();
    if ([...this.requests.values()].some((r) => r.kind === 'snapshot' && now - r.at < config.databetRequestTimeoutMs * 2)) return;
    for (const [id, r] of this.requests) if (r.kind === 'snapshot') this.requests.delete(id);
    const id = this.nextId('s'); this.requests.set(id, { kind: 'snapshot', id, at: now });
    this.send({ id, type: 'start', payload: { operationName: 'DatabetLiveList', query: DATABET_LIST_QUERY, variables: { offset: 0, limit: 250, sportIds: LIVE_SPORTS, matchStatuses: MATCH_STATUSES, marketStatuses: MARKET_STATUSES, marketLimit: TOP_MARKETS } } });
  }

  wantsFull(eventId, now = this.now()) { const row = this.fullMarkets.get(eventId); return !!row && row.until > now; }

  syncSubscription(eventId) {
    if (!this.ready()) return;
    const raw = this.events.get(eventId); if (!raw) return;
    const mode = this.wantsFull(eventId) ? 'full' : 'light', current = this.subscriptions.get(eventId);
    if (current?.mode === mode) return;
    if (current) this.stopSubscription(eventId);
    const id = this.nextId(mode === 'full' ? 'f' : 'e');
    this.subscriptions.set(eventId, { id, mode, delivered: false, startedAt: this.now() });
    this.requests.set(id, { kind: 'event', id, eventId, mode, at: this.now() });
    const variables = { sportEventId: eventId, version: text(raw.version) || null, marketStatuses: MARKET_STATUSES, ...(mode === 'full' ? {} : { marketLimit: TOP_MARKETS }) };
    this.send({ id, type: 'start', payload: { operationName: mode === 'full' ? 'DatabetFullEvent' : 'DatabetLiveEvent', query: mode === 'full' ? DATABET_FULL_SUBSCRIPTION : DATABET_LIGHT_SUBSCRIPTION, variables } });
  }

  stopSubscription(eventId) {
    const row = this.subscriptions.get(eventId); if (!row) return;
    this.subscriptions.delete(eventId); this.requests.delete(row.id);
    try { this.send({ id: row.id, type: 'stop' }); } catch {}
  }

  forgetEvent(eventId) { this.stopSubscription(eventId); this.fullMarkets.delete(eventId); this.tabs.delete(eventId); this.events.delete(eventId); }

  requestTabs(eventId, { force = false } = {}) {
    if (!this.ready() || !this.events.has(eventId)) return;
    const now = this.now(), row = this.tabs.get(eventId) || { at: 0, pending: false, requestedAt: 0, catalog: [], marketToTabs: new Map() };
    this.tabs.set(eventId, row);
    if (row.pending && now - row.requestedAt < config.databetRequestTimeoutMs) return;
    if (!force && row.at && now - row.at < 30000) return;
    const id = this.nextId('t'); row.pending = true; row.requestedAt = now;
    this.requests.set(id, { kind: 'tabs', id, eventId, at: now });
    this.send({ id, type: 'start', payload: { operationName: 'DatabetMarketTabs', query: DATABET_TABS_QUERY, variables: { sportEventID: eventId, marketStatuses: MARKET_STATUSES } } });
  }

  applyTabs(eventId, tabs) {
    const row = this.tabs.get(eventId); if (!row) return;
    const catalog = [], marketToTabs = new Map();
    for (const tab of Array.isArray(tabs) ? tabs : []) {
      const id = text(tab?.id), name = text(tab?.name); if (!id || !name) continue;
      const ids = [...new Set((tab?.marketIds || []).map(text).filter(Boolean))];
      catalog.push({ id, name, count: ids.length });
      for (const marketId of ids) { if (!marketToTabs.has(marketId)) marketToTabs.set(marketId, []); marketToTabs.get(marketId).push(id); }
    }
    if (!catalog.some((t) => t.id === 'all')) catalog.unshift({ id: 'all', name: 'All', count: 0 });
    Object.assign(row, { at: this.now(), pending: false, catalog, marketToTabs });
    this.schedulePublish();
  }

  providerTabInfo(eventId) { const row = this.tabs.get(eventId); return row?.at ? { catalog: row.catalog, marketToTabs: row.marketToTabs } : null; }

  async applySnapshot(list) {
    const now = this.now(), next = new Map();
    for (const raw of Array.isArray(list) ? list : []) {
      const id = text(raw?.id); if (!id) continue;
      const old = this.events.get(id), sub = this.subscriptions.get(id);
      // A delivered full-market push is richer than the top-market snapshot row; keep it, take the fixture.
      const keepMarkets = sub?.mode === 'full' && sub.delivered && Array.isArray(old?.markets);
      const merged = mergeGgbetEvent(old, keepMarkets ? { ...raw, markets: undefined } : raw);
      merged.__updatedAt = old && old.version === merged.version ? (old.__updatedAt || now) : now;
      next.set(id, merged);
    }
    for (const id of [...this.events.keys()]) if (!next.has(id)) this.forgetEvent(id);
    this.events = next;
    for (const id of next.keys()) { try { this.syncSubscription(id); } catch (error) { this.lastError = error?.message || String(error); } }
    this.snapshots++; this.lastSnapshotAt = now; this.failures = 0; this.lastError = '';
    await this.publish(now);
  }

  async applyPush(req, patch) {
    const id = text(patch?.id);
    // A push is only ever applied to the event its subscription was opened for.
    if (!id || id !== req.eventId) { this.mismatchedPushes++; return; }
    const old = this.events.get(id); if (!old) return;
    const status = text(patch?.fixture?.status).toUpperCase();
    if (status && !MATCH_STATUSES.includes(status)) { this.finishedEvents++; this.forgetEvent(id); this.schedulePublish(); return; }
    const sub = this.subscriptions.get(id); if (sub?.id === req.id) sub.delivered = true;
    const merged = mergeGgbetEvent(old, patch); merged.__updatedAt = this.now();
    this.events.set(id, merged); this.pushes++; this.lastPushAt = this.now(); this.failures = 0; this.lastError = '';
    this.schedulePublish();
  }

  rows(at = this.now()) {
    const out = [];
    for (const raw of this.events.values()) {
      try { const row = parseDatabetLiveEvent(raw, { at: raw.__updatedAt || at, providerTabs: this.providerTabInfo(text(raw.id)) }); if (row) out.push(row); }
      catch (error) { this.lastError = `DataBet: событие ${text(raw?.id).slice(0, 60)} пропущено: ${error?.message || error}`; }
    }
    return out;
  }

  schedulePublish() {
    if (this.publishTimer) return;
    this.publishTimer = setTimeout(() => { this.publishTimer = null; this.publish().catch((error) => { this.lastError = error?.message || String(error); }); }, config.databetPublishDebounceMs);
    this.publishTimer.unref?.();
  }

  async publish(at = this.now()) {
    clearTimeout(this.publishTimer); this.publishTimer = null;
    this.publishes++; this.lastPublishAt = at;
    await this.state.success(this.rows(at), { status: 200, elapsedMs: 0 });
  }

  async onMessage(data) {
    this.lastMessageAt = this.now();
    let msg; try { msg = JSON.parse(typeof data === 'string' ? data : String(data)); } catch { return; }
    if (msg.type === 'connection_ack') { this.lastAckAt = this.now(); this.failures = 0; this.requestSnapshot(); return; }
    if (msg.type === 'ka' || msg.type === 'connection_keep_alive') return;
    const id = text(msg.id), req = this.requests.get(id);
    if (!req) return; // late frames of a stopped operation
    if (msg.type === 'data' && !msg.payload?.errors) {
      if (req.kind === 'snapshot') { const list = msg.payload?.data?.matches?.sportEvents; if (Array.isArray(list)) { this.requests.delete(id); await this.applySnapshot(list); } return; }
      if (req.kind === 'tabs') { this.requests.delete(id); this.applyTabs(req.eventId, msg.payload?.data?.compiledMarketsTabs?.tabs); return; }
      if (req.kind === 'event') { const patch = msg.payload?.data?.onUpdateSportEvent; if (patch) await this.applyPush(req, patch); }
      return;
    }
    if (msg.type === 'error' || msg.payload?.errors) {
      const detail = JSON.stringify(msg.payload || msg).slice(0, 600);
      this.requests.delete(id);
      if (req.kind === 'event' && this.subscriptions.get(req.eventId)?.id === id) this.subscriptions.delete(req.eventId);
      if (req.kind === 'tabs') { const row = this.tabs.get(req.eventId); if (row) row.pending = false; }
      if (isAuthError(detail)) { this.lastError = 'DataBet: guest token отклонён'; this.authRefreshes++; this.bootstrap = null; try { this.ws?.close(4401, 'refresh-token'); } catch {} return; }
      this.lastError = 'DataBet GraphQL: ' + detail;
      if (req.kind === 'snapshot') await this.state.failure(Error(this.lastError));
      return;
    }
    if (msg.type === 'complete') {
      this.requests.delete(id);
      if (req.kind === 'event' && this.subscriptions.get(req.eventId)?.id === id) { this.subscriptions.delete(req.eventId); this.scheduleSnapshot(1000); }
      if (req.kind === 'tabs') { const row = this.tabs.get(req.eventId); if (row) row.pending = false; }
    }
  }

  findRawEvent(sourceEventId) {
    const key = safeUuid(sourceEventId);
    for (const raw of this.events.values()) if (safeUuid(raw?.id) === key) return raw;
    return null;
  }

  // Detail hydration boundary for the odds dialog: upgrade the event to the complete market tree (for a TTL
  // window), fetch the native DataBet tabs, and wait briefly for the first complete push.
  async detail(sourceEventId, { timeoutMs = 6500 } = {}) {
    const raw = this.findRawEvent(sourceEventId); if (!raw) return null;
    if (!this.ready()) throw Error('DataBet временно недоступен: нет соединения с источником');
    const id = text(raw.id), now = this.now();
    this.fullMarkets.set(id, { until: now + config.databetFullMarketsTtlMs, requestedAt: now });
    this.enforceFullLimit();
    this.syncSubscription(id); this.requestTabs(id);
    const start = this.now();
    while (this.now() - start < timeoutMs) {
      if (!this.events.has(id) || !this.ready()) break;
      const sub = this.subscriptions.get(id), tabs = this.tabs.get(id);
      if (sub?.mode === 'full' && sub.delivered && tabs && !tabs.pending) break;
      await sleep(50);
    }
    const current = this.events.get(id) || raw;
    return parseDatabetLiveEvent(current, { at: current.__updatedAt || this.now(), providerTabs: this.providerTabInfo(id) });
  }

  enforceFullLimit() {
    const now = this.now();
    for (const [id, row] of [...this.fullMarkets]) if (row.until <= now) this.fullMarkets.delete(id);
    const newest = [...this.fullMarkets].sort((a, b) => b[1].requestedAt - a[1].requestedAt);
    for (const [id] of newest.slice(config.databetMaxFullEvents)) { this.fullMarkets.delete(id); try { this.syncSubscription(id); } catch {} }
  }

  scheduleSnapshot(delay) { clearTimeout(this.snapshotSoon); this.snapshotSoon = setTimeout(() => { try { this.requestSnapshot(); } catch (error) { this.lastError = error?.message || String(error); } }, delay); this.snapshotSoon.unref?.(); }
  scheduleReconnect(delay) { if (this.stopped) return; clearTimeout(this.reconnectTimer); this.reconnectTimer = setTimeout(() => { this.reconnectTimer = null; this.connect().catch(() => {}); }, delay); this.reconnectTimer.unref?.(); }
  async webSocketClass() { if (this.WebSocket) return this.WebSocket; if (!this.WebSocketPromise) this.WebSocketPromise = import('ws').then((m) => m.WebSocket || m.default); return this.WebSocketPromise; }

  async connect() {
    if (this.stopped || !config.databetLiveEnabled || this.connecting) return this.connecting;
    this.connecting = (async () => {
      try {
        const bootstrap = await this.fetchBootstrap(!this.bootstrap); if (this.stopped) return;
        const WebSocketClass = await this.webSocketClass();
        const ws = new WebSocketClass(bootstrap.wsUrl, 'graphql-ws', { headers: { Origin: bootstrap.origin, 'User-Agent': USER_AGENT }, handshakeTimeout: config.databetRequestTimeoutMs, perMessageDeflate: false, maxPayload: config.upstreamMaxBytes });
        this.ws = ws; this.lastAckAt = 0; this.lastConnectAt = this.now(); this.lastMessageAt = this.now(); this.requests.clear(); this.subscriptions.clear();
        for (const row of this.tabs.values()) row.pending = false;
        await new Promise((resolve, reject) => {
          let settled = false;
          const timer = setTimeout(() => { try { ws.close(); } catch {} reject(Error('DataBet: таймаут подключения WebSocket')); }, config.databetRequestTimeoutMs); timer.unref?.();
          const open = () => { try { ws.send(JSON.stringify({ type: 'connection_init', payload: { headers: { 'X-Auth-Token': bootstrap.token } } })); } catch (e) { reject(e); } };
          const message = (e) => {
            this.onMessage(e?.data).catch((err) => { this.lastError = err?.message || String(err); });
            if (settled) return;
            try {
              const x = JSON.parse(String(e?.data));
              if (x.type === 'connection_ack') { settled = true; clearTimeout(timer); resolve(); }
              else if (x.type === 'connection_error') {
                settled = true; clearTimeout(timer); this.authRefreshes++; this.bootstrap = null;
                const detail = text(x?.payload?.message || x?.payload || 'init rejected').slice(0, 200);
                try { ws.close(4401, 'refresh-token'); } catch {}
                reject(Error(`DataBet connection_init rejected: ${detail}`));
              }
            } catch {}
          };
          const error = () => { if (!settled) { settled = true; clearTimeout(timer); reject(Error('DataBet: ошибка WebSocket')); } };
          const close = (e) => { this.handleClose(e); if (!settled) { settled = true; clearTimeout(timer); reject(Error(`DataBet: WebSocket закрыт ${e?.code || ''}`.trim())); } };
          ws.addEventListener('open', open); ws.addEventListener('message', message); ws.addEventListener('error', error); ws.addEventListener('close', close);
        });
        if (this.connectCount++ > 0) this.reconnects++;
        this.failures = 0; this.lastError = '';
      } catch (error) {
        this.failures++; this.lastError = error?.message || String(error);
        await this.state.failure(error);
        if (isAuthError(this.lastError)) this.bootstrap = null;
        this.scheduleReconnect(backoff(this.failures));
        throw error;
      } finally { this.connecting = null; }
    })();
    return this.connecting;
  }

  handleClose(event) {
    if (this.ws && event?.target && this.ws !== event.target) return;
    this.lastClose = `${event?.code || 0} ${event?.reason || ''}`.trim(); this.lastAckAt = 0; this.ws = null; this.requests.clear(); this.subscriptions.clear();
    for (const row of this.tabs.values()) row.pending = false;
    if (this.stopped) return;
    this.failures++;
    const code = Number(event?.code);
    if ([4401, 4403, 1008].includes(code) || isAuthError(event?.reason)) { this.authRefreshes++; this.bootstrap = null; this.scheduleReconnect(jitter(500)); }
    else if (code === 4001) { this.bootstrap = null; this.scheduleReconnect(jitter(500)); }
    else this.scheduleReconnect(backoff(this.failures));
  }

  maintenance() {
    if (this.stopped || !config.databetLiveEnabled) return;
    const now = this.now();
    if (this.ready()) {
      if (now - this.lastSnapshotAt >= config.databetSnapshotIntervalMs) try { this.requestSnapshot(); } catch (error) { this.lastError = error?.message || String(error); }
      // Downgrade expired complete-market subscriptions back to fixture + top markets.
      for (const [id, sub] of [...this.subscriptions]) if (sub.mode === 'full' && !this.wantsFull(id, now)) try { this.syncSubscription(id); } catch {}
      for (const [id, row] of [...this.fullMarkets]) if (row.until <= now) this.fullMarkets.delete(id);
      if (now - this.lastMessageAt > config.databetWatchdogMs) { this.lastError = 'DataBet: watchdog reconnect'; try { this.ws.close(4001, 'watchdog'); } catch {} }
      else if (now - this.lastConnectAt > config.databetSessionRefreshMs) { this.scheduledRefreshes++; this.bootstrap = null; try { this.ws.close(4001, 'scheduled-token-refresh'); } catch {} }
    } else if (!this.connecting && !this.reconnectTimer) this.scheduleReconnect(0);
  }

  start() {
    if (!config.databetLiveEnabled) return;
    this.stopped = false;
    this.maintenanceTimer = setInterval(() => this.maintenance(), 1000); this.maintenanceTimer.unref?.();
    this.connect().catch(() => {});
  }

  async stop() {
    this.stopped = true;
    clearInterval(this.maintenanceTimer); clearTimeout(this.reconnectTimer); clearTimeout(this.snapshotSoon); clearTimeout(this.publishTimer);
    this.reconnectTimer = null; this.snapshotSoon = null; this.publishTimer = null;
    try { if (this.ws?.readyState === 1) this.ws.close(1000, 'shutdown'); } catch {}
    if (this.connecting) await this.connecting.catch(() => {});
    this.ws = null;
  }
}
