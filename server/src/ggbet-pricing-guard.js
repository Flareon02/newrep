// Observe-only pricing guard for the Dota 2 "Total kills odd/even" market family (GGBET typeId 96), fed with RAW
// upstream markets. It classifies, records and reports - it NEVER changes the egress or the session (there is no
// enforce mode in this release; GGBET_PRICING_GUARD_MODE=enforce is ignored and reported as observe).
//
// Odd == even is not a rule. A sample is "unusual" when max(odd,even)/min(odd,even) exceeds maxRatio (default 1.04:
// healthy samples seen 1.85/1.85, 1.86/1.86, 1.87/1.87; suspicious 1.91/1.83 = 1.044, 2.02/1.74, 3.23/1.32). The
// threshold is NOT validated against long-run data yet - that is exactly why the guard only observes.
//   HEALTHY --unusual--> SUSPECT --(>= minSamples unusual, spanning >= windowMs, >= minEvents events)--> CONFIRMED
//   SUSPECT --normal sample--> HEALTHY (a one-off is forgotten); CONFIRMED --recoverSamples normal in a row--> HEALTHY
export const TYPE_ODD_EVEN = 96;

export function guardConfig(env = process.env) {
  const int = (k, d, min) => { const v = Number(env[k]); return Number.isFinite(v) && v >= min ? Math.floor(v) : d; };
  const requested = String(env.GGBET_PRICING_GUARD_MODE || 'observe').trim().toLowerCase();
  return {
    enabled: !/^(?:0|false|off|no)$/i.test(String(env.GGBET_PRICING_GUARD_ENABLED ?? '1')),
    mode: 'observe', requestedMode: requested, enforceIgnored: requested === 'enforce',
    minSamples: int('GGBET_PRICING_GUARD_MIN_SAMPLES', 3, 2),
    windowMs: int('GGBET_PRICING_GUARD_WINDOW_MS', 120000, 10000),
    minEvents: int('GGBET_PRICING_GUARD_MIN_EVENTS', 1, 1),
    cooldownMs: int('GGBET_PRICING_GUARD_COOLDOWN_MS', 600000, 0),
    recoverSamples: int('GGBET_PRICING_GUARD_RECOVER_SAMPLES', 2, 1),
    maxRatio: Math.max(1.0, Number(env.GGBET_PRICING_GUARD_MAX_RATIO) || 1.04),
  };
}

const num = (v) => { const n = Number(v); return Number.isFinite(n) && n > 1 ? n : null; };
// Outcome ids 1 = odd, 2 = even (same in en and ru sessions: "odd"/"Нечет", "even"/"Чёт").
export function oddEvenPrices(market) {
  const odds = Array.isArray(market?.odds) ? market.odds : [];
  const odd = odds.find((o) => String(o?.id) === '1'), even = odds.find((o) => String(o?.id) === '2');
  if (!odd || !even) return null;
  const o = num(odd.value), e = num(even.value); if (!o || !e) return null;
  return { odd: { id: '1', name: odd.name ?? null, price: String(odd.value), active: odd.isActive !== false }, even: { id: '2', name: even.name ?? null, price: String(even.value), active: even.isActive !== false }, ratio: Math.max(o, e) / Math.min(o, e) };
}

export class PricingGuard {
  constructor({ config = guardConfig(), now = () => Date.now(), onTransition = () => {}, onIncident = () => {}, keep = 60 } = {}) {
    Object.assign(this, { config, now, onTransition, onIncident, keep });
    this.reset('init');
  }
  reset(reason = 'reset', sessionId = null) {
    this.state = 'HEALTHY'; this.sessionId = sessionId; this.suspects = []; this.recovering = 0; this.firstSuspect = null; this.confirmedAt = null;
    this.lastGood = null; this.recent = []; this.seen = new Map(); this.samples = 0; this.unusual = 0; this.inPlaySamples = 0; this.resetReason = reason;
  }
  transition(to, ctx) { const from = this.state; if (from === to) return; this.state = to; this.onTransition({ from, to, at: new Date(this.now()).toISOString(), sessionId: this.sessionId, ...ctx }); }
  // market: raw GGBET market {id,typeId,specifiers,status,odds}; context: {eventId,eventVersion,eventStatus,scheduledAt,
  // sessionId,sessionAgeMs,egressId,egressAgeMs,...}. Returns the stored observation (or null when not applicable).
  observe(market, context = {}) {
    if (!this.config.enabled || Number(market?.typeId) !== TYPE_ODD_EVEN) return null;
    if (market.status && market.status !== 'ACTIVE') return null;
    const prices = oddEvenPrices(market); if (!prices || !prices.odd.active || !prices.even.active) return null;
    // A sample is a PRICE observation: the same prices of the same market count at most once per 60 s (every push carries a
    // new event version, so the version is not part of the identity).
    const at = this.now(), key = `${context.eventId}|${market.id}`, sig = `${prices.odd.price}|${prices.even.price}`;
    const prev = this.seen.get(key); if (prev && prev.sig === sig && at - prev.at < 60000) return null;
    this.seen.set(key, { sig, at }); if (this.seen.size > 500) this.seen.delete(this.seen.keys().next().value);
    const specifiers = Object.fromEntries((market.specifiers || []).map((p) => [p?.name, p?.value]));
    const unusual = prices.ratio > this.config.maxRatio;
    // The map being played (LIVE, mapnr <= current map, or current map unknown) is priced in play: its odd/even legitimately
    // drifts with the kill count. Recorded, but it never moves the guard state.
    const mapnr = Number(specifiers.mapnr), inPlay = context.eventStatus === 'LIVE' && (!(context.liveMap > 0) || !(mapnr > context.liveMap));
    const obs = { at: new Date(at).toISOString(), ...context, marketId: market.id, typeId: TYPE_ODD_EVEN, specifiers, mapnr: specifiers.mapnr ?? null, odd: prices.odd, even: prices.even, ratio: Number(prices.ratio.toFixed(4)), unusual, inPlay };
    this.recent.push(obs); if (this.recent.length > this.keep) this.recent.shift();
    if (inPlay) { this.inPlaySamples = (this.inPlaySamples || 0) + 1; obs.guardState = this.state; obs.excluded = 'in-play map'; return obs; }
    this.samples++;
    if (!unusual) {
      this.lastGood = obs;
      if (this.state === 'SUSPECT') { this.suspects = []; this.firstSuspect = null; this.transition('HEALTHY', { reason: 'normal sample after a one-off', observation: obs }); }
      else if (this.state === 'CONFIRMED' && ++this.recovering >= this.config.recoverSamples) { this.suspects = []; this.firstSuspect = null; this.recovering = 0; this.transition('HEALTHY', { reason: `${this.config.recoverSamples} normal samples in a row`, observation: obs }); }
      obs.guardState = this.state; return obs;
    }
    this.unusual++; this.recovering = 0;
    this.suspects.push(obs); this.suspects = this.suspects.filter((s) => at - Date.parse(s.at) <= Math.max(this.config.windowMs * 3, 600000));
    if (this.state === 'HEALTHY') { this.firstSuspect = obs; this.transition('SUSPECT', { reason: `unusual odd/even ratio ${obs.ratio} > ${this.config.maxRatio}`, observation: obs }); }
    if (this.state === 'SUSPECT') {
      const span = at - Date.parse(this.suspects[0].at), events = new Set(this.suspects.map((s) => s.eventId)).size;
      if (this.suspects.length >= this.config.minSamples && span >= this.config.windowMs && events >= this.config.minEvents) {
        this.confirmedAt = obs.at;
        this.transition('CONFIRMED', { reason: `${this.suspects.length} unusual samples over ${Math.round(span / 1000)} s on ${events} event(s)`, observation: obs });
        this.onIncident({ classification: 'PRICING_CONFIRMED', decision: 'observe-only: no egress or session change', guard: this.snapshot(), lastGood: this.lastGood, firstSuspect: this.firstSuspect, confirmedBad: obs });
      }
    }
    obs.guardState = this.state; return obs;
  }
  snapshot() { return { state: this.state, mode: this.config.mode, enforceIgnored: this.config.enforceIgnored, thresholds: { maxRatio: this.config.maxRatio, minSamples: this.config.minSamples, windowMs: this.config.windowMs, minEvents: this.config.minEvents, recoverSamples: this.config.recoverSamples }, samples: this.samples, unusual: this.unusual, inPlaySamples: this.inPlaySamples || 0, suspects: this.suspects.length, firstSuspectAt: this.firstSuspect?.at || null, confirmedAt: this.confirmedAt, lastGoodAt: this.lastGood?.at || null, last: this.recent.at(-1) || null }; }
}
