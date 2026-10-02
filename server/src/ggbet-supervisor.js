// GGBET session/egress supervisor: tracks the active egress (proxy / direct / one Mullvad netns egress) and every GGBET
// session (one bootstrap = one session; its WebSocket connects/reconnects), feeds RAW typeId 96 markets to the
// observe-only pricing guard, writes the forensic log and persists state.json for the CLI. It changes nothing on its
// own: the only action is a clean session after the OPERATOR selected another egress (status file changed).
import fs from 'node:fs';
import path from 'node:path';
import { ForensicLog } from './ggbet-forensics.js';
import { PricingGuard, guardConfig, TYPE_ODD_EVEN } from './ggbet-pricing-guard.js';

const JWE_FIELDS = ['alg', 'enc', 'currency', 'locale', 'isAuthorized', 'label', 'exp'];
// Allow-listed fields of the token's public protected header; the token itself is never kept.
export function jweMeta(token) {
  try { const h = JSON.parse(Buffer.from(String(token || '').split('.')[0], 'base64url').toString('utf8')); return Object.fromEntries(JWE_FIELDS.filter((k) => k in h).map((k) => [k, h[k]])); } catch { return null; }
}
export function readEgressStatus(file, mode) {
  if (mode === 'netns') { try { const s = JSON.parse(fs.readFileSync(file, 'utf8')); return { id: String(s.id || 'netns'), kind: 'mullvad-netns', configFile: s.configFile || null, exitIp: s.exitIp || null, country: s.country || null, city: s.city || null, hostname: s.hostname || null, activatedAt: s.activatedAt || null, namespace: s.namespace || null }; } catch { return { id: 'netns:unavailable', kind: 'mullvad-netns', error: 'status file unreadable' }; } }
  return { id: mode || 'direct', kind: mode || 'direct' };
}
// Walk a GraphQL payload; yield every market with its nearest enclosing sport event (id/version/status/start).
export function* marketsWithEvent(node, event = null, depth = 0) {
  if (!node || typeof node !== 'object' || depth > 14) return;
  if (Array.isArray(node)) { for (const v of node) yield* marketsWithEvent(v, event, depth + 1); return; }
  let ev = event;
  if (typeof node.id === 'string' && /^\d+:[0-9a-f-]{36}$/i.test(node.id) && ('version' in node || 'fixture' in node || 'markets' in node)) ev = { eventId: node.id, eventVersion: node.version ?? event?.eventVersion ?? null, eventStatus: node.fixture?.status ?? node.status ?? null, scheduledAt: node.fixture?.startTime ?? null, slug: node.slug ?? null };
  if (Array.isArray(node.odds) && 'typeId' in node && node.id != null) { yield { market: node, event: ev }; return; }
  for (const v of Object.values(node)) if (v && typeof v === 'object') yield* marketsWithEvent(v, ev, depth + 1);
}

export class GgbetSupervisor {
  constructor({ dir, mode = 'direct', statusFile = '/run/ggbet-egress/status.json', version = '', release = '', now = () => Date.now(), log = null, guard = null, raw = false, maxBytes, minFreeMiB } = {}) {
    Object.assign(this, { dir, mode, statusFile, version, release, now });
    this.log = log || new ForensicLog({ dir, now, raw, ...(maxBytes ? { maxBytes } : {}), ...(minFreeMiB ? { minFreeMiB } : {}) });
    this.guard = guard || new PricingGuard({ config: guardConfig(), now, onTransition: (t) => this.guardTransition(t), onIncident: (i) => this.incident(i) });
    this.stateFile = path.join(dir, 'state.json');
    const saved = (() => { try { return JSON.parse(fs.readFileSync(this.stateFile, 'utf8')); } catch { return {}; } })();
    this.egresses = saved.egresses || {}; this.sessions = saved.sessions || []; this.history = saved.history || []; this.seq = Number(saved.seq) || 0;
    for (const s of this.sessions) if (!s.endedAt) { s.endedAt = saved.updatedAt || new Date(now()).toISOString(); s.endReason = s.endReason || 'process restart'; }
    this.session = null; this.collector = null; this.egress = null; this.lastMessageAt = 0;
    if (this.guard.config.enforceIgnored) this.log.write('guard', { note: 'GGBET_PRICING_GUARD_MODE=enforce requested but this release only observes' });
    this.checkEgress('startup');
  }
  attach(collector) { this.collector = collector; return this; }
  iso(ms = this.now()) { return new Date(ms).toISOString(); }
  age(iso) { return iso ? Math.max(0, this.now() - Date.parse(iso)) : null; }
  egressStats(id) { return this.egresses[id] || (this.egresses[id] = { id, firstSeenAt: this.iso(), activationCount: 0, totalActiveDurationMs: 0, sessions: 0, bootstrapSuccesses: 0, bootstrapFailures: 0, wsConnectSuccesses: 0, wsConnectFailures: 0, reconnects: 0, pricingSuspects: 0, pricingConfirmed: 0, lastGoodPricingAt: null, firstSuspectAt: null, lastFailureAt: null, lastFailureReason: null, state: 'UNTESTED' }); }
  context() {
    return { egressId: this.egress?.id || null, egressAgeMs: this.age(this.egress?.activatedAt), sessionId: this.session?.id || null, sessionAgeMs: this.age(this.session?.startedAt), wsAgeMs: this.age(this.session?.wsConnectedAt) };
  }
  // Poll the egress status (netns mode); an OPERATOR switch closes the old session and forces a clean one.
  checkEgress(reason = 'poll') {
    const next = readEgressStatus(this.statusFile, this.mode), prev = this.egress;
    const changed = !prev || prev.id !== next.id || (next.activatedAt && prev.activatedAt !== next.activatedAt);
    if (!changed) return false;
    const at = this.iso();
    if (prev) { const st = this.egressStats(prev.id); st.totalActiveDurationMs += this.age(prev.activatedAtLocal) || 0; st.lastDeactivatedAt = at; st.currentActive = false; }
    this.egress = { ...next, activatedAtLocal: at, activatedAt: next.activatedAt || at };
    const st = this.egressStats(next.id); Object.assign(st, { configFile: next.configFile ?? st.configFile ?? null, exitIp: next.exitIp ?? null, country: next.country ?? null, city: next.city ?? null, hostname: next.hostname ?? null, lastActivatedAt: this.egress.activatedAt, currentActive: true, state: st.state === 'UNTESTED' ? 'ACTIVE' : st.state }); st.activationCount++;
    const entry = { at, from: prev?.id || null, to: next.id, reason: prev ? 'operator selected another egress' : reason, oldSessionId: this.session?.id || null, oldSessionAgeMs: this.age(this.session?.startedAt), oldEgressAgeMs: prev ? this.age(prev.activatedAtLocal) : null, pricingState: this.guard.state };
    this.history.push(entry); if (this.history.length > 500) this.history.shift();
    this.log.write('egress', { ...entry, egress: { id: next.id, configFile: next.configFile, exitIp: next.exitIp, country: next.country, city: next.city, hostname: next.hostname } });
    if (prev && this.collector?.resetForEgressChange) { this.endSession('egress changed by operator'); this.collector.resetForEgressChange(`egress ${prev.id} -> ${next.id}`); }
    this.persist(); return true;
  }
  // --- collector hooks (called inside try/catch by ggbet.js) ---------------------------------------------------
  bootstrap(diag = {}, data = null) {
    const ctx = this.context(), safe = { via: diag.via, requestedHost: diag.requestedHost, finalHost: diag.finalHost, status: diag.status, redirects: diag.redirects, redirectChain: diag.redirectChain, setCookie: diag.setCookie, cookieOnRedirect: diag.cookieOnRedirect, contentType: diag.contentType, bodyKind: diag.bodyKind, bodyBytes: diag.bodyBytes, tokenExtraction: diag.tokenExtraction, reason: diag.reason, elapsedMs: diag.elapsedMs };
    const st = this.egress ? this.egressStats(this.egress.id) : null;
    if (data?.token) {
      this.endSession('new bootstrap'); const id = `S${++this.seq}`, jwe = jweMeta(data.token);
      this.session = { id, egressId: this.egress?.id || null, startedAt: this.iso(), bootstrap: safe, jwe, wsConnects: 0, reconnects: 0, wsCloses: 0, wsConnectedAt: null, lastClose: null, firstGoodAt: null, lastGoodAt: null, pricingSuspects: 0, pricingConfirmed: 0, guardState: 'HEALTHY', endedAt: null, endReason: null };
      this.sessions.push(this.session); if (this.sessions.length > 200) this.sessions.shift();
      this.guard.reset('new session', id); if (st) { st.bootstrapSuccesses++; st.sessions++; }
      this.log.write('session', { event: 'started', sessionId: id, egressId: this.session.egressId, bootstrap: safe, jwe });
    } else {
      if (st) { st.bootstrapFailures++; st.lastFailureAt = this.iso(); st.lastFailureReason = `bootstrap ${safe.reason || 'failed'} (${safe.status || 0})`; }
      this.log.write('bootstrap', { ...ctx, result: 'failed', bootstrap: safe });
      if (safe.reason === 'geo-blocked' || (safe.status === 403 && safe.bodyKind === 'html')) this.incident({ classification: 'BOOTSTRAP_HARD_FAILURE', decision: 'observe-only: recorded; no automatic egress change', bootstrap: safe });
    }
    this.persist();
  }
  wsConnected() {
    const s = this.session; if (!s) return; s.wsConnects++; if (s.wsConnects > 1) s.reconnects++; s.wsConnectedAt = this.iso();
    const st = this.egressStats(s.egressId || 'unknown'); st.wsConnectSuccesses++; if (s.wsConnects > 1) st.reconnects++;
    this.log.write('ws', { event: 'connected', ...this.context(), wsConnects: s.wsConnects, reconnects: s.reconnects }); this.persist();
  }
  wsFailed(error) { const st = this.egress ? this.egressStats(this.egress.id) : null; if (st) { st.wsConnectFailures++; st.lastFailureAt = this.iso(); st.lastFailureReason = String(error?.message || error).slice(0, 200); } this.log.write('ws', { event: 'connect-failed', ...this.context(), error: String(error?.message || error).slice(0, 300) }); }
  wsClosed(code, reason) {
    const s = this.session; const ctx = this.context(); if (s) { s.wsCloses++; s.lastClose = `${code || 0} ${reason || ''}`.trim(); s.wsConnectedAt = null; }
    this.log.write('ws', { event: 'closed', ...ctx, code, reason: String(reason || '').slice(0, 200), subscriptions: this.collector?.fullMarketStatus?.() ? (({ ggbetLightSubscriptions: light, ggbetActiveFullMarketSubscriptions: full, ggbetActiveFullMarketLeases: leases }) => ({ light, full, leases }))(this.collector.fullMarketStatus()) : null });
    this.persist();
  }
  // Every inbound frame: RAW typeId 96 markets go to the guard (cheap string pre-check); raw frames only if enabled.
  message(rawText, msg) {
    this.lastMessageAt = this.now();
    if (this.log.raw && msg?.type === 'data') this.log.write('raw', { ...this.context(), id: msg.id, payload: msg.payload });
    if (msg?.type !== 'data' || !String(rawText).includes(`"typeId":${TYPE_ODD_EVEN}`)) return;
    for (const { market, event } of marketsWithEvent(msg.payload)) {
      if (Number(market.typeId) !== TYPE_ODD_EVEN) continue;
      const obs = this.guard.observe(market, { ...(event || {}), ...this.context(), subscriptionId: msg.id || null });
      if (!obs) continue;
      this.log.write('pricing', obs);
      const s = this.session; if (s && !obs.unusual) { s.firstGoodAt = s.firstGoodAt || obs.at; s.lastGoodAt = obs.at; if (this.egress) this.egressStats(this.egress.id).lastGoodPricingAt = obs.at; }
      if (s) s.guardState = this.guard.state;
    }
  }
  guardTransition(t) {
    const s = this.session, st = this.egress ? this.egressStats(this.egress.id) : null;
    if (t.to === 'SUSPECT') { if (s) s.pricingSuspects++; if (st) { st.pricingSuspects++; st.firstSuspectAt = st.firstSuspectAt || t.at; } }
    if (t.to === 'CONFIRMED') { if (s) s.pricingConfirmed++; if (st) st.pricingConfirmed++; }
    this.log.write('transition', { machine: 'pricing-guard', ...t, ...this.context() }); this.persist();
  }
  incident(record) {
    const c = this.collector, s = this.session;
    const id = this.log.incident({ ...record, ...this.context(), egress: this.egress && { id: this.egress.id, configFile: this.egress.configFile, exitIp: this.egress.exitIp, country: this.egress.country, city: this.egress.city, activatedAt: this.egress.activatedAt },
      session: s && { id: s.id, startedAt: s.startedAt, jwe: s.jwe, bootstrap: s.bootstrap, wsConnects: s.wsConnects, reconnects: s.reconnects, lastClose: s.lastClose, firstGoodAt: s.firstGoodAt, lastGoodAt: s.lastGoodAt },
      collector: c && { connected: !!c.lastAckAt, lastMessageAgeMs: c.lastMessageAt ? this.now() - c.lastMessageAt : null, failures: c.failures, reconnects: c.reconnects, bootstrapFetches: c.bootstrapFetches, bootstrapFailures: c.bootstrapFailures, wsConnectionsCreated: c.wsConnectionsCreated, ...(c.fullMarketStatus ? c.fullMarketStatus() : {}) },
      recentOddEven: this.guard.recent.slice(-20), guard: this.guard.snapshot() });
    (this.incidents = this.incidents || []).push(id); this.persist(); return id;
  }
  endSession(reason) { const s = this.session; if (!s || s.endedAt) return; s.endedAt = this.iso(); s.endReason = reason; this.log.write('session', { event: 'ended', sessionId: s.id, egressId: s.egressId, reason, ageMs: this.age(s.startedAt), reconnects: s.reconnects, firstGoodAt: s.firstGoodAt, lastGoodAt: s.lastGoodAt, guardState: s.guardState }); }
  stateSnapshot() {
    const c = this.collector;
    return { updatedAt: this.iso(), version: this.version, release: this.release, mode: this.mode, seq: this.seq,
      egress: this.egress && { ...this.egress, ageMs: this.age(this.egress.activatedAt) }, session: this.session && { ...this.session, ageMs: this.age(this.session.startedAt), wsAgeMs: this.age(this.session.wsConnectedAt) },
      collector: c && { connected: !!c.lastAckAt && !!c.ws, dataAgeMs: c.lastMessageAt ? this.now() - c.lastMessageAt : null, reconnects: c.reconnects, failures: c.failures, bootstrapFetches: c.bootstrapFetches, wsConnectionsCreated: c.wsConnectionsCreated, ...(c.fullMarketStatus ? (({ ggbetLightSubscriptions: light, ggbetActiveFullMarketSubscriptions: full, ggbetActiveFullMarketLeases: leases }) => ({ light, full, leases }))(c.fullMarketStatus()) : {}) },
      guard: this.guard.snapshot(), log: this.log.status(), egresses: this.egresses, sessions: this.sessions.slice(-100), history: this.history.slice(-200) };
  }
  persist() {
    try { const tmp = `${this.stateFile}.${process.pid}.tmp`; fs.writeFileSync(tmp, JSON.stringify(this.stateSnapshot(), null, 1), { mode: 0o600 }); fs.renameSync(tmp, this.stateFile); } catch {}
  }
  start(intervalMs = 15000) { this.timer = setInterval(() => { try { this.checkEgress(); this.persist(); } catch {} }, intervalMs); this.timer.unref?.(); return this; }
  stop() { clearInterval(this.timer); this.endSession('process stop'); this.persist(); }
}
