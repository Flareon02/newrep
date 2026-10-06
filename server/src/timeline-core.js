// Match timeline / replay over the SQLite journal (odds_entries_v3 + score_entries), canonical markets (registry v2).
//
// Runs inside timeline-worker.js (never on the main event loop). Every function takes a read-only DatabaseSync.
//   timelineMeta(db, req)  - providers, time range, score marks, change density for the scrubber
//   timelineRange(db, req) - chronological changes in [from, to] (score, state, market appear/suspend/reopen, odds)
//   stateAt(db, req, cache)- the reconstructed state at one instant: score per bookmaker, canonical markets with every
//                            bookmaker's prices/status at that time, presence of each bookmaker, CS2 rounds so far
// Reconstruction replays the journal deltas of each bookmaker up to `at` (never later rows), starting from the nearest
// in-memory checkpoint (bounded LRU in `cache`). A GGBET Node↔Browser handoff starts a new baseline: the market set is
// reset there, so markets of the other publication context are not carried over.
import { inflateRawSync } from 'node:zlib';
import fs from 'node:fs';
import path from 'node:path';
import { describeMarket, splitLegacyMarket, MARKET_SEMANTICS_VERSION } from './market-registry.js';

export const TIMELINE_VERSION = 1;
const KEY = /^(astek|fonbet|pinnacle|ggbet):[\w-]{1,80}$/;
const bad = (m) => Object.assign(new Error(m), { status: 400 });
export function normalizeKeys(keys) { return [...new Set((keys || []).filter((k) => KEY.test(k)))].slice(0, 32); }
const split = (key) => { const i = key.indexOf(':'); return { key, provider: key.slice(0, i), id: key.slice(i + 1).replace(/[^\w-]/g, '') }; };
const inflate = (blob) => JSON.parse(inflateRawSync(blob).toString());

// ------------------------------------------------------------------------------------------- market state rows ----
function statusOf(s) { const v = String(s ?? '').toLowerCase(); return v === 'active' || v === 'open' ? 'open' : v === 'closed' || v === 'settled' || v === 'resulted' ? 'closed' : v === 'removed' ? 'removed' : 'suspended'; }
// One journal change → the market's full state (4.15+ rows carry the full outcome list; older rows their prices).
function marketState(c, at) {
  const outcomes = Array.isArray(c.outcomes) && c.outcomes.length
    ? c.outcomes.map((o) => ({ outcomeId: String(o.outcomeId ?? ''), outcomeName: o.outcomeName ?? null, line: o.line ?? null, odds: Number(o.decimalOdds) > 1 ? Number(o.decimalOdds) : null, active: o.isActive !== false }))
    : (c.prices || []).filter((p) => !p.removed).map((p, i) => ({ outcomeId: String(p.outcomeId ?? p.rawType ?? p.designation ?? i), outcomeName: p.outcomeName ?? p.label ?? p.designation ?? null, designation: p.designation ?? null, line: p.line ?? p.points ?? null, odds: Number(p.newOdds ?? p.odds ?? p.decimal) > 1 ? Number(p.newOdds ?? p.odds ?? p.decimal) : null, active: true }));
  return {
    marketId: String(c.marketId ?? c.key ?? ''), typeId: c.typeId ?? c.rawType ?? c.type ?? null, rawGroup: c.rawGroup ?? null, marketName: c.marketName ?? c.rawTitle ?? c.title ?? null,
    period: c.period ?? null, specifiers: c.specifiers || {}, status: statusOf(c.marketStatus ?? c.newStatus ?? c.status), outcomes, at,
  };
}
// Registry input in the provider's own shape (journal rows keep raw ids: GGBET outcome ids, Fonbet factors, Astek T…).
function registryMarket(provider, m) {
  return { marketId: m.marketId, key: m.marketId, typeId: m.typeId, rawType: provider === 'astek' ? undefined : m.typeId, rawGroup: provider === 'astek' ? m.typeId : undefined, type: m.typeId, marketName: m.marketName, period: m.period, specifiers: m.specifiers, outcomes: m.outcomes.map((o) => ({ outcomeId: o.outcomeId, outcomeName: o.outcomeName, line: o.line, designation: o.designation })) };
}
const sportOf = (rows) => rows.find((r) => r.sport)?.sport || '';

// ---------------------------------------------------------------------------------------------------- replay ------
// cache: { events: Map<key, {checkpoints:[{at,seq,source,markets:Map}], size, used}>, budget, used }
export function createCache({ budgetOutcomes = 120000 } = {}) { return { events: new Map(), budget: budgetOutcomes, used: 0 }; }
const outcomeCount = (markets) => { let n = 0; for (const m of markets.values()) n += m.outcomes.length + 1; return n; };
function evict(cache) {
  while (cache.used > cache.budget && cache.events.size) {
    const [oldKey, entry] = [...cache.events.entries()].sort((a, b) => a[1].usedAt - b[1].usedAt)[0];
    cache.used -= entry.size; cache.events.delete(oldKey);
  }
}
function replay(db, { provider, id, key }, at, cache, { checkpointEvery = 150 } = {}) {
  const entry = cache?.events.get(key) || { checkpoints: [], size: 0, usedAt: 0 };
  entry.usedAt = Date.now();
  let cp = null;
  for (const c of entry.checkpoints) if (c.at < at || (c.at === at)) cp = c; else break;
  const markets = new Map(cp ? [...cp.markets].map(([k, v]) => [k, v]) : []);
  let source = cp?.source ?? null, lastAt = cp?.at ?? 0, lastSeq = cp?.seq ?? 0, rows = 0, meta = cp?.meta || null;
  const stmt = db.prepare('SELECT seq, at, payload, publication_source FROM odds_entries_v3 WHERE source=? AND event_id=? AND (at>? OR (at=? AND seq>?)) AND at<=? ORDER BY at, seq LIMIT 2000');
  for (;;) {
    const batch = stmt.all(provider, id, lastAt, lastAt, lastSeq, at);
    for (const r of batch) {
      let e; try { e = inflate(r.payload); } catch { lastAt = r.at; lastSeq = r.seq; continue; }
      const pub = r.publication_source || e.publicationSource || provider;
      if (provider === 'ggbet' && source && pub !== source) markets.clear(); // handoff = new baseline
      source = pub;
      for (const c of e.changes || []) {
        const m = marketState(c, r.at);
        if (!m.marketId) continue;
        if (m.status === 'removed') markets.delete(m.marketId); else markets.set(m.marketId, m);
      }
      meta = { sport: e.sport || meta?.sport || '', team1: e.team1 || meta?.team1 || '', team2: e.team2 || meta?.team2 || '', phase: e.phase || meta?.phase || '', bestOf: Number(e.bestOf) || meta?.bestOf || 0, units: e.units || meta?.units || '' };
      lastAt = r.at; lastSeq = r.seq; rows++;
      if (cache && rows % checkpointEvery === 0 && !entry.checkpoints.some((x) => x.seq === r.seq)) {
        const copy = new Map(markets), size = outcomeCount(copy);
        entry.checkpoints.push({ at: r.at, seq: r.seq, source, meta, markets: copy, size });
        entry.checkpoints.sort((a, b) => a.at - b.at || a.seq - b.seq);
        entry.size += size; cache.used += size;
      }
    }
    if (batch.length < 2000) break;
  }
  if (cache) { if (!cache.events.has(key)) cache.events.set(key, entry); evict(cache); }
  return { markets, source, lastAt, meta, rowsReplayed: rows, fromCheckpoint: cp ? cp.at : null };
}

function scoreAt(db, key, at) {
  const row = db.prepare('SELECT at, payload, publication_source FROM score_entries WHERE identity=? AND at<=? ORDER BY at DESC, seq DESC LIMIT 1').get(key, at);
  if (!row) return null;
  try {
    const e = JSON.parse(row.payload), s = e.newState || {};
    return { at: row.at, publicationSource: row.publication_source || e.publicationSource || null, score: s.score ?? e.scoreText ?? null, seriesScore: s.seriesScore ?? e.seriesScore ?? null, mapScores: s.mapScores ?? e.mapScores ?? null, map: s.map ?? e.map ?? null, period: s.period ?? e.period ?? null, gameState: s.gameState ?? e.eventStatus ?? null, betStop: s.betStop ?? e.betStop ?? null, clock: e.clock ?? null, team1: e.team1 || null, team2: e.team2 || null };
  } catch { return null; }
}
function rangeOf(db, { provider, id, key }) {
  const o = db.prepare('SELECT MIN(at) AS a, MAX(at) AS b, COUNT(*) AS n FROM odds_entries_v3 WHERE source=? AND event_id=?').get(provider, id);
  const s = db.prepare('SELECT MIN(at) AS a, MAX(at) AS b, COUNT(*) AS n FROM score_entries WHERE identity=?').get(key);
  const first = [o.a, s.a].filter((x) => x != null), last = [o.b, s.b].filter((x) => x != null);
  return { firstAt: first.length ? Math.min(...first) : null, lastAt: last.length ? Math.max(...last) : null, oddsRows: Number(o.n) || 0, scoreRows: Number(s.n) || 0 };
}

// ---------------------------------------------------------------------------------------------------- canonical ---
function describe(provider, m, ctx) {
  const parts = provider === 'fonbet' ? splitLegacyMarket('fonbet', registryMarket(provider, m)) : [registryMarket(provider, m)];
  return parts.map((part) => {
    const d = describeMarket(provider, part, ctx, { record: false });
    const outcomes = {};
    part.outcomes.forEach((o, i) => {
      const full = m.outcomes.find((x) => x.outcomeId === o.outcomeId && String(x.line) === String(o.line)) || o;
      const k = d.outcomes[i]?.eventKey || `raw:${o.outcomeId}`;
      outcomes[k] = { odds: full.active === false ? null : full.odds ?? null, active: full.active !== false, outcomeId: o.outcomeId, name: o.outcomeName, line: o.line };
    });
    return { d, outcomes, raw: { marketId: part.marketId, typeId: m.typeId, name: m.marketName, period: m.period, specifiers: m.specifiers } };
  });
}
const contextFor = (req, key, meta) => ({ sport: meta?.sport || req.sport || '', team1: meta?.team1 || '', team2: meta?.team2 || '', reversed: (req.reversed || []).includes(key), bestOf: Number(req.bestOf) || Number(meta?.bestOf) || 0, units: meta?.units || '', eventTeam1: req.team1 || '', eventTeam2: req.team2 || '' });

export function stateAt(db, req, cache = null) {
  const at = Number(req.at);
  if (!Number.isFinite(at) || at <= 0) throw bad('Неверное время');
  const keys = normalizeKeys(req.keys).map(split);
  const providers = {}, groups = new Map(), unknown = [], hidden = {};
  // Categories to return (default: all but per-player markets, which are hundreds per map); `market` overrides.
  const wanted = req.cats ? new Set(String(req.cats).split(',')) : null, cats = (c) => (wanted ? wanted.has(c) : c !== 'players');
  let replayed = 0;
  for (const k of keys) {
    if (req.provider && req.provider !== k.provider) continue;
    const range = rangeOf(db, k);
    const score = req.includeScores === false ? null : scoreAt(db, k.key, at);
    let markets = new Map(), meta = null, info = null;
    if (req.includeOdds !== false) { info = replay(db, k, at, cache); markets = info.markets; meta = info.meta; replayed += info.rowsReplayed; }
    const ctx = contextFor(req, k.key, meta || score);
    const present = range.firstAt != null && range.firstAt <= at && at <= (range.lastAt ?? 0) + 120000;
    const prev = providers[k.provider];
    const row = { key: k.key, present, firstAt: range.firstAt, lastAt: range.lastAt, publicationSource: info?.source || score?.publicationSource || null, lastOddsAt: info?.lastAt || null, markets: markets.size, score, reversed: ctx.reversed };
    providers[k.provider] = prev && prev.present && !present ? prev : row;
    for (const m of markets.values()) {
      for (const { d, outcomes, raw } of describe(k.provider, m, ctx)) {
        if (req.market && !(d.eventKey === req.market || d.family === req.market)) continue;
        if (!req.market && !cats(d.category)) { hidden[d.category] = (hidden[d.category] || 0) + 1; continue; }
        if (d.unknown) { unknown.push({ provider: k.provider, title: d.title, status: m.status, at: m.at, raw, outcomes: Object.values(outcomes).map((o) => ({ name: o.name, odds: o.odds, line: o.line })) }); continue; }
        let g = groups.get(d.eventKey);
        if (!g) { g = { key: d.eventKey, family: d.family, params: d.eventParams || d.params, title: d.title, category: d.category, books: {} }; groups.set(d.eventKey, g); }
        // Compact by default (a GGBET LIVE match has ~1,000 markets): prices per canonical outcome + the bookmaker's own
        // market name; ids/specifiers/outcome names only with detail=1 (the tooltip "raw" view).
        g.books[k.provider] = req.detail ? { status: m.status, at: m.at, outcomes, raw, rule: d.rule } : { status: m.status, at: m.at, o: Object.fromEntries(Object.entries(outcomes).map(([ok, ov]) => [ok, ov.odds])), name: raw.name };
      }
    }
  }
  const markets = [...groups.values()].sort((a, b) => (a.params.map || 0) - (b.params.map || 0) || a.family.localeCompare(b.family) || a.key.localeCompare(b.key));
  return { at, timelineVersion: TIMELINE_VERSION, semanticsVersion: MARKET_SEMANTICS_VERSION, providers, markets, unknown: req.detail ? unknown : unknown.map(({ raw, outcomes, ...u }) => ({ ...u, name: raw.name, outcomes })), hiddenCategories: hidden, stats: statisticsAt(req, at), replayedRows: replayed };
}

// ---------------------------------------------------------------------------------------------------- meta --------
export function timelineMeta(db, req) {
  const keys = normalizeKeys(req.keys).map(split), providers = {}, marks = [];
  let from = null, to = null;
  const buckets = Math.max(20, Math.min(240, Number(req.buckets) || 120));
  for (const k of keys) {
    const r = rangeOf(db, k);
    providers[k.provider] = providers[k.provider] ? { ...r, oddsRows: providers[k.provider].oddsRows + r.oddsRows, scoreRows: providers[k.provider].scoreRows + r.scoreRows, firstAt: Math.min(providers[k.provider].firstAt ?? Infinity, r.firstAt ?? Infinity), lastAt: Math.max(providers[k.provider].lastAt ?? 0, r.lastAt ?? 0) } : { ...r, keys: [] };
    providers[k.provider].keys = [...(providers[k.provider].keys || []), k.key];
    if (r.firstAt != null) from = from == null ? r.firstAt : Math.min(from, r.firstAt);
    if (r.lastAt != null) to = to == null ? r.lastAt : Math.max(to, r.lastAt);
    if (req.includeScores !== false)
      for (const row of db.prepare('SELECT at, payload FROM score_entries WHERE identity=? ORDER BY at, seq LIMIT 2000').all(k.key)) {
        try { const e = JSON.parse(row.payload), s = e.newState || {}; marks.push({ at: row.at, provider: k.provider, kind: e.baseline ? 'baseline' : JSON.stringify(e.oldScore) === JSON.stringify(e.newScore) ? 'state' : 'score', score: s.score ?? e.scoreText ?? null, map: s.map ?? e.map ?? null, gameState: s.gameState ?? null }); } catch {}
      }
  }
  const density = new Array(buckets).fill(0);
  if (from != null && to != null && to > from && req.includeOdds !== false) {
    const span = to - from;
    for (const k of keys) for (const row of db.prepare('SELECT at FROM odds_entries_v3 WHERE source=? AND event_id=?').iterate(k.provider, k.id)) density[Math.min(buckets - 1, Math.floor(((row.at - from) / span) * buckets))]++;
  }
  marks.sort((a, b) => a.at - b.at);
  const maps = [];
  for (const m of marks) if (m.map != null && (!maps.length || maps.at(-1).map !== m.map)) maps.push({ map: m.map, at: m.at, provider: m.provider });
  return { timelineVersion: TIMELINE_VERSION, semanticsVersion: MARKET_SEMANTICS_VERSION, from, to, providers, marks: marks.slice(0, 1500), maps, density: { buckets, counts: density }, statistics: statisticsInfo(req) };
}

// ---------------------------------------------------------------------------------------------------- range -------
// Chronological, paginated by (at, order, seq, index). kinds: score,state,market,odds. One call scans ≤ maxRows rows.
const cmp = (a, b) => a.at - b.at || a.order - b.order || a.seq - b.seq || a.index - b.index;
export function timelineRange(db, req) {
  const keys = normalizeKeys(req.keys).map(split);
  const from = Number(req.from) || 0, to = Number(req.to) || Date.now(), limit = Math.max(1, Math.min(500, Number(req.limit) || 200));
  if (from > to) throw bad('from позже to');
  const kinds = new Set(String(req.kinds || 'score,state,market,odds').split(',').filter(Boolean));
  let cursor = null;
  if (req.cursor) { try { cursor = JSON.parse(Buffer.from(String(req.cursor), 'base64url')); } catch { throw bad('Неверный cursor'); } }
  const after = (x) => !cursor || cmp(x, cursor) > 0;
  const items = [], maxRows = Math.max(limit + 1, 1500);
  for (const k of keys) {
    if (req.provider && req.provider !== k.provider) continue;
    const startAt = cursor ? Math.max(from, cursor.at) : from;
    if (req.includeScores !== false && (kinds.has('score') || kinds.has('state')) && !req.market)
      for (const r of db.prepare('SELECT seq, at, payload, publication_source FROM score_entries WHERE identity=? AND at>=? AND at<=? ORDER BY at, seq LIMIT ?').all(k.key, startAt, to, maxRows)) {
        let e; try { e = JSON.parse(r.payload); } catch { continue; }
        const stateOnly = !e.baseline && JSON.stringify(e.oldScore) === JSON.stringify(e.newScore);
        const kind = stateOnly ? 'state' : 'score';
        const x = { at: r.at, order: 0, seq: r.seq, index: 0 };
        if (!kinds.has(kind) || !after(x)) continue;
        items.push({ ...x, provider: k.provider, publicationSource: r.publication_source || null, kind, baseline: !!e.baseline, old: stateOnly ? e.oldState : e.oldScore ?? null, new: stateOnly ? e.newState : e.newScore ?? e.scoreText ?? null, map: e.map ?? null, gameState: e.newState?.gameState ?? null, betStop: e.newState?.betStop ?? null });
      }
    if (req.includeOdds === false || !(kinds.has('market') || kinds.has('odds'))) continue;
    let ctxMeta = null;
    for (const r of db.prepare('SELECT seq, at, payload, publication_source FROM odds_entries_v3 WHERE source=? AND event_id=? AND at>=? AND at<=? ORDER BY at, seq LIMIT ?').all(k.provider, k.id, startAt, to, maxRows)) {
      let e; try { e = inflate(r.payload); } catch { continue; }
      ctxMeta = ctxMeta || { sport: e.sport, team1: e.team1, team2: e.team2, bestOf: e.bestOf, units: e.units };
      const ctx = contextFor(req, k.key, ctxMeta);
      let index = 0;
      for (const c of e.changes || []) {
        const m = marketState(c, r.at);
        for (const { d, outcomes, raw } of describe(k.provider, m, ctx)) {
          const i = index++;
          if (req.market && !(d.eventKey === req.market || d.family === req.market)) continue;
          const x = { at: r.at, order: 1, seq: r.seq, index: i };
          if (!after(x)) continue;
          const baseline = !!c.baseline, oldStatus = c.oldStatus != null ? statusOf(c.oldStatus) : null, status = m.status;
          const changes = (c.prices || []).filter((p) => !p.baseline || baseline).map((p) => {
            const hit = Object.entries(outcomes).find(([, o]) => o.outcomeId === String(p.outcomeId ?? p.rawType ?? p.designation) && String(o.line) === String(p.line ?? p.points ?? null));
            return { outcome: hit?.[0] || `raw:${p.outcomeId ?? p.designation}`, name: p.outcomeName ?? p.label ?? null, old: p.oldOdds ?? null, new: p.removed ? null : p.newOdds ?? p.odds ?? null };
          });
          const kind = baseline ? 'market' : oldStatus && oldStatus !== status ? 'market' : 'odds';
          if (!kinds.has(kind)) continue;
          items.push({ ...x, provider: k.provider, publicationSource: r.publication_source || null, kind, event: baseline ? 'appeared' : oldStatus && oldStatus !== status ? (status === 'open' ? 'reopened' : status === 'closed' ? 'closed' : 'suspended') : 'odds', market: d.eventKey, family: d.family, title: d.title, unknown: d.unknown, status, oldStatus, changes: changes.slice(0, 40), raw: { marketId: raw.marketId, name: raw.name, typeId: raw.typeId } });
        }
      }
    }
  }
  items.sort(cmp);
  const take = items.slice(0, limit), more = items.length > limit, last = take.at(-1);
  return {
    timelineVersion: TIMELINE_VERSION, semanticsVersion: MARKET_SEMANTICS_VERSION, from, to,
    items: take.map(({ order, seq, index, ...x }) => ({ id: `${order}:${seq}:${index}`, ...x })),
    hasMore: more, nextCursor: more && last ? Buffer.from(JSON.stringify({ at: last.at, order: last.order, seq: last.seq, index: last.index })).toString('base64url') : null,
  };
}

// ------------------------------------------------------------------------------------------------ statistics -----
// CS2 statistics (statistics/<id>.json) keep each map's rounds with the time they were observed: the rounds known at
// `at` and the round score derived from them. Matched to the event through statistics/index.json refs.
let statsIndex = { at: 0, value: null };
function statisticsFile(req) {
  if (!req.dataDir) return null;
  try {
    if (!statsIndex.value || Date.now() - statsIndex.at > 60000) statsIndex = { at: Date.now(), value: JSON.parse(fs.readFileSync(path.join(req.dataDir, 'statistics', 'index.json'), 'utf8')) };
  } catch { return null; }
  const keys = new Set(normalizeKeys(req.keys));
  const hit = Object.values(statsIndex.value || {}).find((x) => (x.refs || []).some((r) => keys.has(r)) && x.provider === 'crossbet');
  return hit ? path.join(req.dataDir, 'statistics', hit.id.replace(/[^\w-]/g, '') + '.json') : null;
}
function statisticsInfo(req) {
  const file = statisticsFile(req);
  if (!file) return null;
  try { const d = JSON.parse(fs.readFileSync(file, 'utf8')); return { provider: 'cs2', team1: d.team1, team2: d.team2, maps: (d.maps || [d]).map((m) => ({ map: m.map, mapNum: m.mapNum, rounds: (m.timeline || []).length, firstAt: m.timeline?.[0]?.observedAt ?? null, lastAt: m.timeline?.at(-1)?.observedAt ?? null })) }; } catch { return null; }
}
function statisticsAt(req, at) {
  const file = statisticsFile(req);
  if (!file) return null;
  try {
    const d = JSON.parse(fs.readFileSync(file, 'utf8'));
    const maps = (d.maps?.length ? d.maps : [d]).map((m) => {
      const rounds = (m.timeline || []).filter((r) => Number(r.observedAt) <= at);
      const won = [0, 0];
      for (const r of rounds) if (r.team === '1' || r.team === 1) won[0]++; else if (r.team === '2' || r.team === 2) won[1]++;
      return { map: m.map || null, mapNum: m.mapNum ?? null, rounds: rounds.length, roundScore: won, lastRound: rounds.at(-1) || null, started: rounds.length > 0 };
    }).filter((m) => m.started);
    return { provider: 'cs2', team1: d.team1, team2: d.team2, maps, current: maps.at(-1) || null };
  } catch { return null; }
}
