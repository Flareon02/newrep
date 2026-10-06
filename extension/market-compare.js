'use strict';
/* Cross-bookmaker market comparison (server market semantics v2).

   Groups markets by their canonical identity oriented to this event (`canonical.eventKey`), so "Map 1 Winner",
   "1st map - winner", "Mapa 1 zwycięzca" and Fonbet factor 921/923 of map 1 are ONE row, and outcomes by canonical
   outcome (home/away/over/under/draw/score:2-1/…) oriented to the event's team order. The title comes from the
   canonical identity; each bookmaker's own market name stays available as `raw` (tooltip / details).
   Markets the server could not classify are never merged: they are listed per bookmaker in `unknown`.
   Pure JavaScript, unit-tested in Node. */
(function (root) {
  const BOOKS = ['astek', 'fonbet', 'pinnacle', 'ggbet'];
  const OUTCOME_ORDER = ['home', 'home-draw', 'over', 'yes', 'odd', 'draw', 'exact', 'home-away', 'away', 'draw-away', 'under', 'no', 'even'];
  const CATEGORY_ORDER = { winners: 0, rounds: 1, handicaps: 2, totals: 3, scores: 4, combined: 5, players: 6, specials: 7 };
  // Markets whose unit the bookmaker does not state (handicap/total/team_total) come after the proven ones.
  const FAMILY_ORDER = ['match_winner', 'match_1x2', 'map_winner', 'map_1x2', 'map_handicap', 'map_total', 'round_handicap', 'asian_round_handicap', 'round_handicap_3way', 'round_total', 'asian_round_total', 'round_total_3way', 'team_round_total', 'handicap', 'total', 'team_total'];
  const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : null);
  const fmt = (n) => { const r = Math.round(n * 1000) / 1000; return String(Object.is(r, -0) ? 0 : r); };
  const v2 = (m) => (m?.canonical && m.canonical.v >= 2 && m.canonical.eventKey ? m.canonical : null);

  function outcomeRank(key) {
    const base = String(key).split('+')[0];
    const i = OUTCOME_ORDER.indexOf(base);
    if (i >= 0) return i * 10 + (String(key).includes('+odd') ? 0 : String(key).includes('+even') ? 1 : 0);
    const s = /^score:(\d+)-(\d+)$/.exec(key);
    if (s) return 200 + Number(s[1]) * 20 + Number(s[2]);
    return 500;
  }
  function outcomeLabel(key, group = {}, teams = {}) {
    const p = group.params || {}, line = num(p.line);
    const t1 = teams.team1 || 'Команда 1', t2 = teams.team2 || 'Команда 2';
    const hcp = (side) => (line == null ? '' : ` (${side === 'home' ? (line > 0 ? '+' : '') + fmt(line) : (-line > 0 ? '+' : '') + fmt(-line)})`);
    const handicap = /handicap/.test(group.family || '');
    if (key === 'home') return t1 + (handicap ? hcp('home') : '');
    if (key === 'away') return t2 + (handicap ? hcp('away') : '');
    if (key === 'draw') return 'Ничья';
    if (key === 'exact') return line == null ? 'Ровно' : `Ровно ${handicap ? (line > 0 ? '+' : '') + fmt(line) : fmt(line)}`;
    if (key === 'over') return `Больше${line != null ? ' ' + fmt(line) : ''}`;
    if (key === 'under') return `Меньше${line != null ? ' ' + fmt(line) : ''}`;
    if (key === 'yes') return 'Да';
    if (key === 'no') return 'Нет';
    if (key === 'odd') return 'Нечёт';
    if (key === 'even') return 'Чёт';
    if (key === 'home-draw') return `${t1} или ничья`;
    if (key === 'draw-away') return `Ничья или ${t2}`;
    if (key === 'home-away') return `${t1} или ${t2}`;
    const s = /^score:(\d+)-(\d+)$/.exec(key);
    if (s) return `${s[1]}:${s[2]}`;
    const wp = /^(home|away)\+(odd|even)$/.exec(key);
    if (wp) return `${wp[1] === 'home' ? t1 : t2} + ${wp[2] === 'odd' ? 'нечёт' : 'чёт'}`;
    return null; // opaque (id:…): the caller shows the bookmaker's own outcome name
  }
  const sortGroups = (a, b) => (a.params.map || 0) - (b.params.map || 0)
    || (a.params.half || 0) - (b.params.half || 0)
    || (CATEGORY_ORDER[a.category] ?? 9) - (CATEGORY_ORDER[b.category] ?? 9)
    || ((FAMILY_ORDER.indexOf(a.family) + 1) || 99) - ((FAMILY_ORDER.indexOf(b.family) + 1) || 99)
    || (a.params.round || 0) - (b.params.round || 0)
    || String(a.params.side || '').localeCompare(String(b.params.side || ''))
    || (num(a.params.line) ?? 0) - (num(b.params.line) ?? 0)
    || a.key.localeCompare(b.key);

  // refs: the event's bookmaker refs with odds.markets (from /api/ui/event-detail). Returns null when no market carries
  // v2 semantics (older server): the caller keeps the per-bookmaker view.
  function build(refs = [], { books = BOOKS, visible = () => true } = {}) {
    const groups = new Map(), unknown = [];
    let seen = false;
    for (const ref of refs) {
      const source = ref?.source;
      if (!books.includes(source) || !visible(source) || !Array.isArray(ref?.odds?.markets)) continue;
      for (const m of ref.odds.markets) {
        const c = v2(m);
        if (!c) continue;
        seen = true;
        if (c.unknown || c.market === 'unknown') { unknown.push({ source, title: c.raw?.title || m.rawTitle || m.title || 'Рынок', status: m.status || 'open', prices: (m.prices || []).map((p) => ({ label: p.rawLabel || p.label || p.designation || '', value: num(p.decimal) })), raw: c.raw }); continue; }
        let g = groups.get(c.eventKey);
        if (!g) { g = { key: c.eventKey, family: c.market, params: c.eventParams || c.params || {}, title: c.label || c.title, category: c.category === 'specials' && c.market?.startsWith('player') ? 'players' : c.category, books: {}, outcomes: new Set() }; groups.set(c.eventKey, g); }
        const prices = {};
        (m.prices || []).forEach((p, i) => {
          const o = c.outcomes?.[i]?.eventKey;
          const k = o || `raw:${p.rawLabel || p.label || p.designation || i}`;
          prices[k] = { value: m.status && m.status !== 'open' ? null : num(p.decimal) > 1 ? num(p.decimal) : null, label: p.rawLabel || p.label || '' };
          g.outcomes.add(k);
        });
        // One bookmaker can list the same bet twice (e.g. main + alternative line feed): keep the open one.
        const old = g.books[source];
        if (!old || (old.status !== 'open' && m.status === 'open')) g.books[source] = { status: m.status || 'open', prices, raw: { title: c.raw?.title || m.rawTitle || m.title || '', rawType: c.raw?.rawType ?? m.rawType ?? null, specifiers: c.raw?.specifiers || m.specifiers || null, rule: c.rule || '' } };
      }
    }
    if (!seen) return null;
    const list = [...groups.values()].map((g) => finish(g)).sort(sortGroups);
    return { groups: list, unknown, books: books.filter((b) => list.some((g) => g.books[b]) || unknown.some((u) => u.source === b)) };
  }
  // Timeline state (server-grouped, compact): {key,family,params,title,category,books:{src:{status,o:{outcome:odds},name}}}
  function fromState(state, { books = BOOKS, visible = () => true } = {}) {
    const list = (state?.markets || []).map((m) => {
      const g = { key: m.key, family: m.family, params: m.params || {}, title: m.title, category: m.category, books: {}, outcomes: new Set() };
      for (const [source, b] of Object.entries(m.books || {})) {
        if (!books.includes(source) || !visible(source)) continue;
        const prices = {};
        for (const [k, v] of Object.entries(b.o || {})) { prices[k] = { value: num(v), label: '' }; g.outcomes.add(k); }
        g.books[source] = { status: b.status, at: b.at, prices, raw: { title: b.name || '' } };
      }
      return finish(g);
    }).filter((g) => Object.keys(g.books).length).sort(sortGroups);
    return { groups: list, unknown: (state?.unknown || []).filter((u) => visible(u.provider)).map((u) => ({ source: u.provider, title: u.name || u.title, status: u.status, prices: (u.outcomes || []).map((o) => ({ label: o.name, value: num(o.odds) })) })), books: books.filter((b) => list.some((g) => g.books[b])) };
  }
  function finish(g) {
    const outcomes = [...g.outcomes].sort((a, b) => outcomeRank(a) - outcomeRank(b) || a.localeCompare(b));
    const best = {};
    for (const o of outcomes) {
      let top = null;
      for (const b of Object.values(g.books)) { const v = b.prices[o]?.value; if (v != null && (top == null || v > top)) top = v; }
      best[o] = top;
    }
    const open = Object.values(g.books).filter((b) => b.status === 'open').length;
    return { ...g, outcomes, best, bookCount: Object.keys(g.books).length, openCount: open };
  }
  function scopeLabel(g) {
    const p = g.params || {};
    return p.map ? `Карта ${p.map}${p.half ? ` · половина ${p.half}` : ''}` : 'Матч';
  }
  const api = { build, fromState, outcomeLabel, outcomeRank, scopeLabel, BOOKS };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.MarketCompare = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
