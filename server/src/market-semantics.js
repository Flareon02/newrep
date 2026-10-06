// Market semantics: compatibility entry points over the canonical market registry (market-registry.js, semantics v2).
// The registry is the single authority; these wrappers keep the v1 call sites and field names working.
import { canonicalMarket, canonicalOdds, marketContext, MARKET_SEMANTICS_VERSION } from './market-registry.js';

export { MARKET_SEMANTICS_VERSION };
// GGBET and DataBet are both DATA.BET sportsbook platform feeds: one typeId table serves both.
export function canonicalizeGgbetMarket(market = {}, teams = {}, provider = 'ggbet') {
  return canonicalMarket(provider === 'databet' ? 'databet' : 'ggbet', market, { team1: teams.team1, team2: teams.team2, sport: teams.sport || '' });
}
export function canonicalizeMarket(market = {}, source = '', teams = {}) {
  return canonicalMarket(source, market, { team1: teams.team1, team2: teams.team2, sport: teams.sport || '' });
}
export function enrichOddsSemantics(odds = {}, source = '', ctx = {}) {
  return canonicalOdds(odds, source, ctx);
}
// Every market of every bookmaker of one event gets `canonical` (semantics v2 + v1 fields), oriented to the event.
export function enrichEventMarketSemantics(event = {}) {
  const refs = event?.sourceRefs?.length ? event.sourceRefs : [event];
  const next = refs.map((r) => (r?.odds?.markets ? { ...r, odds: canonicalOdds(r.odds, r.source, marketContext(r, event)) } : r));
  if (event?.sourceRefs?.length) return { ...event, sourceRefs: next };
  return next[0] || event;
}
