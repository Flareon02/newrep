// GGBET egress pool: one active Mullvad WireGuard egress at a time, chosen from /root/.secrets/mullvad/*.conf, with the
// existing HTTP proxy as last resort. Pure decision logic (tools/ggbet-egressd.mjs supplies the actions).
//
// What may move GGBET to another egress is TRANSPORT health only: namespace/WireGuard missing, a stale WireGuard
// handshake, or the exit probe failing while the service itself reports network-level failures. GGBET's own answers
// (403 region page, missing token, pricing anomalies) are recorded by the service but never trigger a switch here.
// No scheduled rotation: a healthy egress is kept indefinitely. Retry budget, re-establish once, cooldown with
// exponential growth, max switches per hour, last-known-good preference, slow retries while on the fallback.
export const POOL_DEFAULTS = Object.freeze({
  failTicks: 3,                 // consecutive failing checks before acting (tick = 30 s -> >= 90 s of failure)
  reestablishGapMs: 30 * 60000, // re-create the same egress at most once per 30 min before giving up on it
  cooldownMs: 30 * 60000,       // first cooldown; doubles per consecutive network failure, capped
  maxCooldownMs: 6 * 3600000,
  maxSwitchesPerHour: 3,
  minFallbackMs: 30 * 60000,    // stay on the last-resort proxy at least this long
  fallbackRetryMs: 30 * 60000,  // then try one Mullvad candidate per this interval
  qualifyMs: 60 * 60000,        // healthy runtime before an egress counts as qualified (HEALTHY)
  handshakeMaxS: 300,
});

export const vpnId = (configFile) => `mullvad:${String(configFile).replace(/\.conf$/, '')}`;

export class VpnPool {
  constructor({ state = {}, now = () => Date.now(), options = {}, preferred = 'ggbet-good.conf' } = {}) {
    this.o = { ...POOL_DEFAULTS, ...options }; this.now = now; this.preferred = preferred;
    this.vpns = state.vpns || {}; this.history = state.history || []; this.mode = state.mode || 'starting';
    this.active = state.active || null; this.fallback = state.fallback || null; this.failing = 0; this.switches = state.switches || [];
    this.lastFallbackTryAt = state.lastFallbackTryAt || 0;
  }
  iso(ms = this.now()) { return new Date(ms).toISOString(); }
  // Configs present now; vanished configs are kept (history) but marked missing.
  discover(files) {
    const at = this.iso();
    for (const f of files) { const id = vpnId(f); this.vpns[id] = { id, configFile: f, state: 'UNTESTED', firstSeenAt: at, activationCount: 0, currentHealthyRunMs: 0, longestHealthyRunMs: 0, totalHealthyRuntimeMs: 0, networkFailures: 0, consecutiveNetworkFailures: 0, reestablishes: 0, cooldownUntil: 0, lastFailureReason: null, exitIp: null, country: null, city: null, hostname: null, ...this.vpns[id], missing: false }; }
    for (const v of Object.values(this.vpns)) if (!files.includes(v.configFile)) v.missing = true;
    return Object.values(this.vpns);
  }
  event(type, data = {}) { const e = { at: this.iso(), type, ...data }; this.history.push(e); if (this.history.length > 1000) this.history.shift(); return e; }
  available(excludeId = null) {
    const now = this.now();
    // A failed transport qualification (separate namespace) keeps a config out of selection for 6 h.
    return Object.values(this.vpns).filter((v) => !v.missing && v.id !== excludeId && !(v.cooldownUntil > now) && !(v.transport && v.transport.ok === false && now - Date.parse(v.transport.checkedAt) < 6 * 3600000));
  }
  // 1 last known good, 2 longest proven healthy run, 3 fewest network failures, 4 the preferred config, 5 untested.
  rank(list) {
    const lkg = this.lastKnownGood();
    return list.slice().sort((a, b) => (b.id === lkg) - (a.id === lkg) || (b.longestHealthyRunMs || 0) - (a.longestHealthyRunMs || 0) || (a.networkFailures || 0) - (b.networkFailures || 0) || (b.configFile === this.preferred) - (a.configFile === this.preferred) || ((a.state === 'UNTESTED') - (b.state === 'UNTESTED')) || a.id.localeCompare(b.id));
  }
  lastKnownGood() { const good = Object.values(this.vpns).filter((v) => v.lastHealthyAt && !(v.lastFailureAt > v.lastHealthyAt)); good.sort((a, b) => Date.parse(b.lastHealthyAt) - Date.parse(a.lastHealthyAt)); return good[0]?.id || null; }
  candidate(excludeId = null) { return this.rank(this.available(excludeId))[0] || null; }
  switchesLastHour() { const since = this.now() - 3600000; return this.switches.filter((t) => t >= since).length; }
  activated(id, exit = {}) {
    const v = this.vpns[id], at = this.now(); if (!v) return;
    if (this.active && this.active !== id) this.deactivated(this.active, 'replaced');
    Object.assign(v, { ...pick(exit), lastActivatedAt: this.iso(at), state: v.longestHealthyRunMs >= this.o.qualifyMs ? 'HEALTHY' : 'QUALIFYING', currentHealthyRunMs: 0, healthySince: null }); v.activationCount++;
    this.active = id; this.mode = 'mullvad'; this.fallback = null; this.failing = 0;
  }
  deactivated(id, reason) { const v = this.vpns[id]; if (!v) return; this.closeRun(v); v.lastDeactivatedAt = this.iso(); if (!['COOLDOWN', 'UNHEALTHY'].includes(v.state)) v.state = v.longestHealthyRunMs >= this.o.qualifyMs ? 'HEALTHY' : v.state === 'QUALIFYING' ? 'UNTESTED' : v.state; v.lastDeactivationReason = reason; if (this.active === id) this.active = null; }
  closeRun(v) { if (v.healthySince) { const run = this.now() - v.healthySince; v.totalHealthyRuntimeMs += run - (v.countedRunMs || 0); v.longestHealthyRunMs = Math.max(v.longestHealthyRunMs, run); } v.healthySince = null; v.countedRunMs = 0; v.currentHealthyRunMs = 0; }
  // One check of the active egress. health: {netns, wg, handshakeAgeS, probeOk, exitIp, serviceHealthy, serviceTransportFailures}
  // Returns the action to take: none | reestablish | switch | fallback.
  tick(health = {}) {
    const now = this.now(), v = this.active ? this.vpns[this.active] : null;
    if (this.mode === 'fallback') return this.fallbackTick();
    if (!v) return { action: 'select', reason: 'no active egress' };
    v.lastCheckedAt = this.iso(now);
    const hard = !health.netns || !health.wg ? 'namespace or WireGuard interface missing' : health.handshakeAgeS != null && health.handshakeAgeS > this.o.handshakeMaxS ? `WireGuard handshake stale (${health.handshakeAgeS} s)` : '';
    const soft = !health.serviceHealthy && (health.probeOk === false || (health.serviceTransportFailures || 0) >= 2) ? `no connectivity (probe ${health.probeOk === false ? 'failed' : 'n/a'}, service network failures ${health.serviceTransportFailures || 0})` : '';
    const reason = hard || soft;
    if (!reason) {
      this.failing = 0; v.consecutiveNetworkFailures = 0;
      if (health.serviceHealthy) { if (!v.healthySince) v.healthySince = now; const run = now - v.healthySince; v.totalHealthyRuntimeMs += run - (v.countedRunMs || 0); v.countedRunMs = run; v.currentHealthyRunMs = run; v.longestHealthyRunMs = Math.max(v.longestHealthyRunMs, run); v.lastHealthyAt = this.iso(now); if (v.state === 'QUALIFYING' && v.totalHealthyRuntimeMs >= this.o.qualifyMs) { v.state = 'HEALTHY'; this.event('qualified', { id: v.id, totalHealthyRuntimeMs: v.totalHealthyRuntimeMs }); } }
      return { action: 'none' };
    }
    this.closeRun(v);
    if (++this.failing < this.o.failTicks) return { action: 'none', reason: `transport check failed ${this.failing}/${this.o.failTicks}: ${reason}` };
    this.failing = 0;
    if (!v.lastReestablishAt || now - Date.parse(v.lastReestablishAt) >= this.o.reestablishGapMs) { v.lastReestablishAt = this.iso(now); v.reestablishes++; this.event('reestablish', { id: v.id, reason }); return { action: 'reestablish', id: v.id, reason }; }
    this.networkFailure(v.id, reason);
    return this.nextEgress(reason, v.id);
  }
  networkFailure(id, reason) {
    const v = this.vpns[id], now = this.now(); if (!v) return;
    v.networkFailures++; v.consecutiveNetworkFailures++; v.lastFailureAt = this.iso(now); v.lastFailureReason = reason;
    v.cooldownUntil = now + Math.min(this.o.maxCooldownMs, this.o.cooldownMs * 2 ** (v.consecutiveNetworkFailures - 1)); v.state = 'COOLDOWN';
    this.event('network-failure', { id, reason, cooldownUntil: this.iso(v.cooldownUntil) });
  }
  nextEgress(reason, fromId) {
    if (this.switchesLastHour() >= this.o.maxSwitchesPerHour) return this.enterFallback(`switch budget exhausted (${this.o.maxSwitchesPerHour}/h) after: ${reason}`, fromId);
    const c = this.candidate(fromId); if (!c) return this.enterFallback(`no usable Mullvad config after: ${reason}`, fromId);
    this.switches.push(this.now()); this.mode = 'switching';
    this.event('switch', { from: fromId, to: c.id, reason });
    return { action: 'switch', from: fromId, to: c.id, configFile: c.configFile, reason };
  }
  // A candidate that failed its pre-activation transport verification.
  candidateFailed(id, reason) { this.networkFailure(id, `verification: ${reason}`); return this.nextEgress(`candidate ${id} failed verification`, this.active); }
  enterFallback(reason, fromId = this.active) {
    if (fromId) this.deactivated(fromId, 'fallback');
    this.mode = 'fallback'; this.active = null; this.fallback = { reason, startedAt: this.iso(), lastTryAt: null };
    this.event('fallback', { from: fromId, reason }); return { action: 'fallback', reason };
  }
  fallbackTick() {
    const now = this.now(), f = this.fallback || { startedAt: this.iso() };
    if (now - Date.parse(f.startedAt) < this.o.minFallbackMs) return { action: 'none', reason: 'minimum fallback time' };
    if (f.lastTryAt && now - Date.parse(f.lastTryAt) < this.o.fallbackRetryMs) return { action: 'none', reason: 'fallback retry interval' };
    const c = this.candidate(); if (!c) return { action: 'none', reason: 'all Mullvad configs in cooldown/missing' };
    f.lastTryAt = this.iso(now); this.fallback = f; this.event('restore-attempt', { to: c.id });
    return { action: 'restore', to: c.id, configFile: c.configFile, reason: 'retry Mullvad after fallback' };
  }
  // Transport qualification result (handshake + exit metadata, no GGBET traffic) for a config that is not active.
  transportChecked(id, r = {}) { const v = this.vpns[id]; if (!v) return; v.transport = { checkedAt: r.checkedAt || this.iso(), ok: !!r.ok, exitIp: r.exitIp || null, country: r.country || null, city: r.city || null, hostname: r.hostname || null, error: r.error || null }; this.event('transport-check', { id, ok: !!r.ok, exitIp: r.exitIp || null }); }
  // Next config to transport-check: not active, never checked or checked > 24 h ago.
  nextTransportCheck() { const now = this.now(); return Object.values(this.vpns).filter((v) => !v.missing && v.id !== this.active && (!v.transport || now - Date.parse(v.transport.checkedAt) > 24 * 3600000)).sort((a, b) => a.id.localeCompare(b.id))[0] || null; }
  snapshot() { return { mode: this.mode, active: this.active, fallback: this.fallback, preferred: this.preferred, switchesLastHour: this.switchesLastHour(), switches: this.switches.slice(-50), lastKnownGood: this.lastKnownGood(), nextCandidate: this.candidate(this.active)?.id || null, options: this.o, vpns: this.vpns, history: this.history.slice(-500), updatedAt: this.iso() }; }
}
const pick = (e) => Object.fromEntries(['exitIp', 'country', 'city', 'hostname'].filter((k) => e[k] != null).map((k) => [k, e[k]]));
