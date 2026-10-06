'use strict';
/* «Таймлайн» tab of the match detail: one history of the match (score, maps, rounds, every bookmaker's markets and
   prices, suspensions, appearance) with a replay scrubber.

   - meta (GET /api/events/:id/timeline/meta): time range, score marks and change density for the scrubber;
   - state (GET …/state-at?at=): the reconstructed match at one instant, shown as the canonical comparison grid;
   - changes (GET …/timeline?from&to): what happened around the instant.
   Dragging never floods the server: the time label follows the pointer at once, the state request is debounced and
   the previous one aborted; states are kept in a small LRU (rounded to the second), so stepping back and forth or
   replaying is mostly local. LIVE: «Сейчас» follows the newest record (meta refreshed every 15 s). */
const TimelinePanel = (() => {
  const SPEEDS = [1, 10, 60, 300];
  const CATS = [['main', 'Основные', 'winners,handicaps,totals'], ['rounds', 'Раунды', 'rounds'], ['scores', 'Счёт', 'scores'], ['combined', 'Комбо', 'combined,specials'], ['players', 'Игроки', 'players']];
  const BOOK_NAME = { astek: 'AstekBet', fonbet: 'Fonbet', pinnacle: 'Pinnacle', ggbet: 'GGBET' };
  let ctx = null, st = null;
  const configure = (c) => { ctx = c; };
  const esc = (s) => ctx.esc(s);
  const fmtTime = (at, withDate = false) => (at ? ctx.stamp(at, withDate, true) : '—');

  function keysOf(event) {
    const refs = ctx.refsOf(event);
    const id = (r) => r.source + ':' + String(r.sourceEventId || r.id || '').replace(/^fonbet-(?:result-)?/, '');
    const ids = [...new Set(refs.flatMap((r) => [id(r), ...(r.aliases || [])]))].slice(0, 32);
    const rev = [...new Set(refs.filter((r) => r.scoreReversed === true).flatMap((r) => [id(r), ...(r.aliases || [])]))];
    const bestOf = Number(event.bestOf) || Number(refs.find((r) => r.bestOf)?.bestOf) || 0;
    return { ids, rev, bestOf };
  }
  function query(extra = {}) {
    const k = keysOf(st.event);
    return new URLSearchParams({ ids: k.ids.join(','), ...(k.rev.length ? { rev: k.rev.join(',') } : {}), team1: st.event.team1 || '', team2: st.event.team2 || '', sport: st.event.category || '', ...(k.bestOf ? { bestOf: String(k.bestOf) } : {}), ...extra });
  }
  const base = () => `/api/events/${encodeURIComponent(st.event.id)}`;

  // ------------------------------------------------------------------------------------------------ lifecycle ----
  function open(body, event, view) {
    if (st && st.id === String(event.id) && body.contains(st.root)) { st.event = event; return; }
    close();
    st = { id: String(event.id), event, view, root: null, meta: null, at: 0, follow: view === 'live', range: view === 'live' ? 'live' : 'all', win: null, density: null, playing: false, speed: 10, mode: 'state', provider: '', cat: 'main', market: '', state: null, changes: null, error: '', loading: false, cache: new Map(), timers: {}, controller: null, metaController: null, scrubbing: false };
    body.innerHTML = `<div class="tl" id="tlRoot"><div class="tl-head" id="tlHead"></div><div class="tl-scrub" id="tlScrub" tabindex="0" role="slider" aria-label="Время матча" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0"><div class="tl-density" id="tlDensity" aria-hidden="true"></div><div class="tl-marks" id="tlMarks" aria-hidden="true"></div><div class="tl-thumb" id="tlThumb" aria-hidden="true"></div></div><div class="tl-axis" id="tlAxis"></div><div class="tl-controls" id="tlControls"></div><div class="tl-body" id="tlBody"></div></div>`;
    st.root = body.querySelector('#tlRoot');
    bind();
    loadMeta(true);
    st.timers.meta = setInterval(() => { if (st && !document.hidden && (st.view === 'live' || st.follow)) loadMeta(false); }, 15000);
  }
  function close() {
    if (!st) return;
    clearInterval(st.timers.meta); clearInterval(st.timers.play); clearTimeout(st.timers.fetch);
    st.controller?.abort(); st.metaController?.abort();
    st = null;
  }
  const isOpen = (id) => !!st && st.id === String(id);
  const $ = (id) => st?.root?.querySelector('#' + id);

  // Scrubber window: the whole journal, the LIVE part, or a zoom (1 h / 15 min) around the current instant.
  const RANGES = [['all', 'Всё'], ['live', 'LIVE'], ['60', '1 ч'], ['15', '15 мин']];
  function windowOf() {
    const m = st.meta;
    if (!m?.from) return null;
    if (st.range === 'all') return { from: m.from, to: m.to };
    if (st.range === 'live') return { from: m.liveFrom && m.liveFrom < m.to ? m.liveFrom : m.from, to: m.to };
    const span = Number(st.range) * 60000;
    if (st.win && st.at >= st.win.from + span * 0.1 && st.at <= st.win.to - span * 0.1 && st.win.span === span) return st.win;
    let from = Math.max(m.from, st.at - span / 2), to = Math.min(m.to, from + span);
    from = Math.max(m.from, to - span);
    st.win = { from, to, span };
    loadDensity(st.win);
    return st.win;
  }
  async function loadDensity(w) {
    const mine = st;
    try {
      const meta = await ctx.request(`${base()}/timeline/meta?${query({ from: String(Math.round(w.from)), to: String(Math.round(w.to)), buckets: '90' })}`);
      if (st === mine && mine.win === w) { mine.density = meta.density; renderScrub(true); }
    } catch {}
  }
  // --------------------------------------------------------------------------------------------------- data -----
  async function loadMeta(first) {
    if (!st) return;
    const mine = st;
    mine.metaController?.abort();
    const controller = (mine.metaController = new AbortController());
    try {
      const meta = await ctx.request(`${base()}/timeline/meta?${query()}`, { signal: controller.signal });
      if (st !== mine) return;
      mine.meta = meta;
      mine.error = '';
      if (!meta.from) { renderAll(); return; }
      mine.density = meta.density;
      if (first || mine.follow) { mine.at = mine.follow || !mine.at ? meta.to : mine.at; mine.win = null; }
      if (mine.range === 'live') { mine.win = windowOf(); loadDensity(mine.win); }
      renderControls();
      setAt(mine.at, { fetch: first || mine.follow });
    } catch (error) {
      if (st !== mine || error?.name === 'AbortError') return;
      mine.error = error.status === 401 ? 'Нужен действующий ключ доступа.' : error.status === 403 ? 'Таймлайн недоступен для вашего ключа: нужна «История коэффициентов» или «История счёта».' : ctx.errorText(error);
      clearInterval(mine.timers.meta);
      renderAll();
    }
  }
  const cacheKey = (at) => [Math.round(at / 1000), st.provider, st.cat, st.market].join('|');
  function scheduleFetch(delay = 220) {
    clearTimeout(st.timers.fetch);
    const hit = st.cache.get(cacheKey(st.at));
    if (hit) { st.cache.delete(cacheKey(st.at)); st.cache.set(cacheKey(st.at), hit); st.state = hit; st.loading = false; renderBody(); if (st.mode === 'changes') st.timers.fetch = setTimeout(fetchChanges, delay); return; }
    st.loading = true; renderStatus();
    st.timers.fetch = setTimeout(() => (st.mode === 'changes' ? fetchChanges() : fetchState()), delay);
  }
  async function fetchState() {
    if (!st?.meta?.from) return;
    const mine = st, at = mine.at, key = cacheKey(at);
    mine.controller?.abort();
    const controller = (mine.controller = new AbortController());
    const cats = CATS.find((c) => c[0] === mine.cat)?.[2] || '';
    try {
      const state = await ctx.request(`${base()}/state-at?${query({ at: String(at), ...(mine.provider ? { provider: mine.provider } : {}), ...(mine.market ? { market: mine.market } : { cats }) })}`, { signal: controller.signal });
      if (st !== mine || mine.at !== at) return;
      mine.cache.set(key, state);
      while (mine.cache.size > 24) mine.cache.delete(mine.cache.keys().next().value);
      mine.state = state; mine.loading = false; mine.error = '';
      renderBody();
    } catch (error) {
      if (st !== mine || error?.name === 'AbortError') return;
      mine.loading = false;
      mine.error = error.status === 503 ? 'Сервер занят LIVE, повторите через секунду.' : ctx.errorText(error);
      renderStatus();
    }
  }
  async function fetchChanges() {
    if (!st?.meta?.from) return;
    const mine = st, at = mine.at;
    mine.controller?.abort();
    const controller = (mine.controller = new AbortController());
    const from = Math.max(mine.meta.from, at - 3 * 60000), to = Math.min(mine.meta.to, at + 7 * 60000);
    try {
      const data = await ctx.request(`${base()}/timeline?${query({ from: String(from), to: String(to), limit: '300', ...(mine.provider ? { provider: mine.provider } : {}), ...(mine.market ? { market: mine.market } : {}) })}`, { signal: controller.signal });
      if (st !== mine || mine.at !== at) return;
      mine.changes = data; mine.loading = false; mine.error = '';
      renderBody();
    } catch (error) {
      if (st !== mine || error?.name === 'AbortError') return;
      mine.loading = false; mine.error = ctx.errorText(error); renderStatus();
    }
  }
  // Next/previous change of a kind, relative to the current instant (score marks are local; market changes ask the
  // server for one item after / the last item before).
  async function jump(direction, kind) {
    if (!st?.meta?.from) return;
    if (kind === 'score') {
      const marks = (st.meta.marks || []).filter((m) => m.kind === 'score' || m.kind === 'baseline');
      const hit = direction > 0 ? marks.find((m) => m.at > st.at) : [...marks].reverse().find((m) => m.at < st.at);
      if (hit) setAt(hit.at, { fetch: true, stopFollow: true });
      return;
    }
    const mine = st;
    try {
      const window = 30 * 60000;
      const from = direction > 0 ? mine.at + 1 : Math.max(mine.meta.from, mine.at - window), to = direction > 0 ? Math.min(mine.meta.to, mine.at + window) : mine.at - 1;
      const data = await ctx.request(`${base()}/timeline?${query({ from: String(from), to: String(to), kinds: 'market,odds', limit: direction > 0 ? '1' : '500', ...(mine.provider ? { provider: mine.provider } : {}), ...(mine.market ? { market: mine.market } : {}) })}`);
      if (st !== mine) return;
      const item = direction > 0 ? data.items[0] : data.items.at(-1);
      if (item) setAt(item.at, { fetch: true, stopFollow: true }); else ctx.toast?.(direction > 0 ? 'Дальше изменений рынков нет' : 'Раньше изменений рынков нет (в пределах 30 минут)');
    } catch (error) { ctx.toast?.(ctx.errorText(error)); }
  }

  // ------------------------------------------------------------------------------------------------- time ----------
  function setAt(at, { fetch = false, stopFollow = false, delay } = {}) {
    if (!st?.meta?.from) return;
    st.at = Math.max(st.meta.from, Math.min(st.meta.to, Math.round(at)));
    if (st.range !== 'all' && st.range !== 'live') { const before = st.win; windowOf(); if (st.win !== before) renderScrub(true); }
    if (stopFollow) st.follow = false;
    renderScrub();
    renderStatus();
    if (fetch) scheduleFetch(delay);
  }
  function togglePlay() {
    if (!st?.meta?.from) return;
    st.playing = !st.playing;
    clearInterval(st.timers.play);
    if (st.playing) {
      st.follow = false;
      if (st.at >= st.meta.to) st.at = st.meta.from;
      let last = performance.now();
      st.timers.play = setInterval(() => {
        if (!st) return;
        const now = performance.now(), next = st.at + (now - last) * st.speed;
        last = now;
        if (next >= st.meta.to) { setAt(st.meta.to, { fetch: true }); togglePlay(); return; }
        // One state request at a time while playing: the next one starts when the previous has landed.
        setAt(next, { fetch: !st.loading, delay: 0 });
      }, 500);
    }
    renderControls();
  }

  // ------------------------------------------------------------------------------------------------ events -------
  function bind() {
    const scrub = $('tlScrub');
    const fraction = (x) => { const r = scrub.getBoundingClientRect(); return Math.max(0, Math.min(1, (x - r.left) / r.width)); };
    const toAt = (f) => { const w = windowOf(); return w.from + f * (w.to - w.from); };
    scrub.addEventListener('pointerdown', (e) => {
      if (!st?.meta?.from) return;
      scrub.setPointerCapture(e.pointerId); st.scrubbing = true;
      if (st.playing) togglePlay();
      setAt(toAt(fraction(e.clientX)), { stopFollow: true });
    });
    scrub.addEventListener('pointermove', (e) => { if (st?.scrubbing) setAt(toAt(fraction(e.clientX))); });
    const end = () => { if (st?.scrubbing) { st.scrubbing = false; scheduleFetch(); } };
    scrub.addEventListener('pointerup', end); scrub.addEventListener('pointercancel', end);
    scrub.addEventListener('keydown', (e) => {
      if (!st?.meta?.from) return;
      const step = e.shiftKey ? 60000 : 10000;
      if (e.key === 'ArrowRight') { e.preventDefault(); setAt(st.at + step, { fetch: true, stopFollow: true }); }
      else if (e.key === 'ArrowLeft') { e.preventDefault(); setAt(st.at - step, { fetch: true, stopFollow: true }); }
      else if (e.key === 'Home') { e.preventDefault(); setAt(st.meta.from, { fetch: true, stopFollow: true }); }
      else if (e.key === 'End') { e.preventDefault(); setAt(st.meta.to, { fetch: true }); }
      else if (e.key === ' ') { e.preventDefault(); togglePlay(); }
    });
    st.root.addEventListener('click', (e) => {
      const b = e.target.closest('[data-tl]');
      if (!b || !st) return;
      const a = b.dataset.tl;
      if (a === 'play') togglePlay();
      else if (a === 'now') { st.follow = true; if (st.playing) togglePlay(); loadMeta(false); setAt(st.meta.to, { fetch: true }); }
      else if (a === 'range') { st.range = b.dataset.range; st.win = null; st.density = st.meta.density; if (st.range === 'live') { st.win = windowOf(); loadDensity(st.win); } renderControls(); renderScrub(true); }
      else if (a === 'speed') { st.speed = SPEEDS[(SPEEDS.indexOf(st.speed) + 1) % SPEEDS.length]; renderControls(); }
      else if (a === 'prev-score') jump(-1, 'score');
      else if (a === 'next-score') jump(1, 'score');
      else if (a === 'prev-market') jump(-1, 'market');
      else if (a === 'next-market') jump(1, 'market');
      else if (a === 'back') setAt(st.at - 10000, { fetch: true, stopFollow: true });
      else if (a === 'fwd') setAt(st.at + 10000, { fetch: true, stopFollow: true });
      else if (a === 'mode') { st.mode = b.dataset.mode; renderControls(); scheduleFetch(0); }
      else if (a === 'cat') { st.cat = b.dataset.cat; st.market = ''; renderControls(); scheduleFetch(0); }
      else if (a === 'book') { st.provider = st.provider === b.dataset.book ? '' : b.dataset.book; renderControls(); scheduleFetch(0); }
      else if (a === 'goto') setAt(Number(b.dataset.at), { fetch: true, stopFollow: true });
      else if (a === 'market-only') { st.market = st.market === b.dataset.market ? '' : b.dataset.market; renderControls(); scheduleFetch(0); }
    });
  }

  // ---------------------------------------------------------------------------------------------- rendering ------
  function renderAll() { renderScrub(true); renderControls(); renderStatus(); renderBody(); }
  function renderScrub(full = false) {
    if (!st) return;
    const m = st.meta, w = windowOf();
    if (!m?.from || !w) { $('tlDensity').innerHTML = ''; $('tlMarks').innerHTML = ''; $('tlThumb').style.left = '0%'; $('tlAxis').innerHTML = ''; return; }
    const span = Math.max(1, w.to - w.from), pct = (at) => Math.max(0, Math.min(100, ((at - w.from) / span) * 100)), inside = (at) => at >= w.from && at <= w.to;
    const d = st.density && st.density.from <= w.from + 1 && st.density.to >= w.to - 1 ? st.density : m.density;
    const sig = `${w.from}:${w.to}:${d?.from}:${d?.to}`;
    if (full || $('tlDensity').dataset.sig !== sig) {
      // Bars are placed by time, so a density computed for a wider range still lines up under a zoomed window.
      const dSpan = Math.max(1, (d.to ?? m.to) - (d.from ?? m.from)), bw = dSpan / d.counts.length, max = Math.max(1, ...d.counts);
      $('tlDensity').innerHTML = d.counts.map((n, i) => { const at = (d.from ?? m.from) + i * bw; return inside(at + bw / 2) ? `<i style="height:${n ? Math.max(8, Math.round((n / max) * 100)) : 0}%"></i>` : ''; }).join('');
      $('tlMarks').innerHTML = (m.marks || []).filter((x) => x.kind === 'score' && inside(x.at)).map((x) => `<b class="${x.provider}" style="left:${pct(x.at).toFixed(3)}%" title="${esc(fmtTime(x.at))} · ${esc(BOOK_NAME[x.provider] || x.provider)} · ${esc(x.score || '')}"></b>`).join('') + (m.maps || []).filter((x) => inside(x.at)).map((x) => `<u style="left:${pct(x.at).toFixed(3)}%" title="Карта ${esc(x.map)} · ${esc(fmtTime(x.at))}"></u>`).join('');
      $('tlDensity').dataset.sig = sig;
      $('tlAxis').innerHTML = `<span>${esc(fmtTime(w.from, true))}</span><span>${esc(fmtTime(w.to, true))}</span>`;
    }
    $('tlThumb').style.left = pct(st.at).toFixed(3) + '%';
    const scrub = $('tlScrub');
    scrub.setAttribute('aria-valuenow', String(Math.round(pct(st.at))));
    scrub.setAttribute('aria-valuetext', fmtTime(st.at, true));
  }
  function renderControls() {
    if (!st) return;
    const books = Object.keys(st.meta?.providers || {}), live = st.view === 'live';
    const btn = (a, label, title, extra = '') => `<button type="button" class="btn sm" data-tl="${a}" title="${esc(title)}" aria-label="${esc(title)}" ${extra}>${label}</button>`;
    ctx.patch($('tlControls'), `<div class="tl-row">${btn('prev-score', '⏮︎ счёт', 'Предыдущее изменение счёта')}${btn('prev-market', '◀ рынок', 'Предыдущее изменение рынков')}${btn('back', '−10 с', 'Назад на 10 секунд (←, Shift+← — минута)')}${btn('play', st.playing ? '❚❚' : '▶', st.playing ? 'Пауза (пробел)' : 'Воспроизвести (пробел)', `aria-pressed="${st.playing}"`)}${btn('fwd', '+10 с', 'Вперёд на 10 секунд (→)')}${btn('next-market', 'рынок ▶', 'Следующее изменение рынков')}${btn('next-score', 'счёт ⏭︎', 'Следующее изменение счёта')}${btn('speed', `${st.speed}×`, 'Скорость воспроизведения')}${live || st.follow ? btn('now', 'Сейчас', 'Последнее состояние, следить за LIVE', `aria-pressed="${st.follow}"`) : btn('now', 'Конец', 'Последняя запись')}</div>
    <div class="tl-row"><span class="segmented" role="group" aria-label="Период шкалы">${RANGES.map(([r, l]) => `<button type="button" data-tl="range" data-range="${r}" aria-pressed="${st.range === r}">${l}</button>`).join('')}</span><span class="segmented" role="group" aria-label="Режим">${[['state', 'Состояние'], ['changes', 'Изменения']].map(([m, l]) => `<button type="button" data-tl="mode" data-mode="${m}" aria-pressed="${st.mode === m}">${l}</button>`).join('')}</span>
    <span class="tl-books" role="group" aria-label="Конторы">${books.map((b) => `<button type="button" class="chip book ${esc(b)}" data-tl="book" data-book="${esc(b)}" aria-pressed="${st.provider === b}" title="Только ${esc(BOOK_NAME[b] || b)}">${esc(BOOK_NAME[b] || b)}</button>`).join('')}</span></div>
    ${st.mode === 'state' ? `<div class="tl-row market-tabs" role="tablist" aria-label="Тип рынка">${CATS.map(([id, label]) => `<button type="button" role="tab" data-tl="cat" data-cat="${id}" aria-selected="${!st.market && st.cat === id}">${label}</button>`).join('')}${st.market ? `<button type="button" role="tab" data-tl="market-only" data-market="${esc(st.market)}" aria-selected="true">только выбранный рынок ✕</button>` : ''}</div>` : ''}`);
  }
  function renderStatus() {
    if (!st) return;
    const m = st.meta, head = $('tlHead');
    if (!m) { ctx.patch(head, `<div class="tl-time">${st.error ? `<span class="warn">${esc(st.error)}</span>` : 'Загружаем таймлайн…'}</div>`); return; }
    if (!m.from) { ctx.patch(head, `<div class="tl-time"><span class="muted">${st.error ? esc(st.error) : 'Для этого матча ещё нет записей в журнале (счёт и коэффициенты пишутся с момента появления матча у контор).'}</span></div>`); return; }
    const state = st.state, score = state ? bestScore(state) : null;
    ctx.patch(head, `<div class="tl-time"><b class="num">${esc(fmtTime(st.at, true))}</b>${st.follow ? '<span class="chip live"><span class="dot bad" aria-hidden="true"></span>сейчас</span>' : ''}${score ? `<span class="tl-score num" title="Счёт в этот момент">${esc(score)}</span>` : ''}${st.loading ? '<span class="refreshing">восстанавливаем…</span>' : ''}${st.error ? `<span class="warn">${esc(st.error)}</span>` : ''}</div>`);
  }
  function bestScore(state) {
    const rows = Object.values(state.providers || {}).filter((p) => p.score).sort((a, b) => (b.score.at || 0) - (a.score.at || 0));
    return rows[0]?.score?.score || '';
  }
  function renderBody() {
    if (!st) return;
    renderStatus();
    const body = $('tlBody');
    if (!st.meta?.from) { ctx.patch(body, ''); return; }
    if (st.mode === 'changes') return ctx.patch(body, changesHtml());
    const s = st.state;
    if (!s) { ctx.patch(body, '<div class="skeleton" style="height:160px;margin:12px 16px"></div>'); return; }
    const teams = { team1: st.event.team1, team2: st.event.team2 };
    const providers = Object.entries(s.providers || {});
    const scores = `<div class="tl-section" data-market-key="tl-scores"><h4>Счёт и присутствие контор</h4><table class="src-table"><tbody>${providers.map(([p, x]) => `<tr><td><span class="book-mark ${esc(p)}" aria-hidden="true"></span> ${esc(BOOK_NAME[p] || p)}</td><td>${x.present ? '<span class="pill on">в линии</span>' : '<span class="pill off">нет матча</span>'}</td><td class="num">${esc(x.score?.score || '—')}</td><td class="muted">${x.score?.map ? 'карта ' + esc(x.score.map) : ''}${x.score?.betStop ? ' · приём ставок остановлен' : ''}</td><td class="muted">${x.markets ? x.markets + ' рынков' : ''}</td></tr>`).join('') || '<tr><td class="muted">Нет данных</td></tr>'}</tbody></table>${statsHtml(s.stats)}</div>`;
    const model = MarketCompare.fromState(s, { visible: ctx.bookVisible });
    const grid = model.groups.length ? ctx.compareHtml(model, { teams, at: st.at, idPrefix: 'tl', pickMarket: true, track: false }) : `<p class="muted tl-empty">${s.markets?.length === 0 ? 'В этот момент рынков этой категории не было.' : 'Нет рынков для выбранных контор.'}${Object.keys(s.hiddenCategories || {}).length ? ' Другие категории: ' + Object.entries(s.hiddenCategories).map(([c, n]) => `${esc(c)} — ${n}`).join(', ') : ''}</p>`;
    const unknown = model.unknown.length ? `<details class="detail-section fold" data-market-key="tl-unknown"><summary>${UiKit.chevron('caret')}<span>Нераспознанные рынки</span><span class="n">${model.unknown.length}</span></summary><table class="src-table"><tbody>${model.unknown.slice(0, 200).map((u) => `<tr><td>${esc(BOOK_NAME[u.source] || u.source)}</td><td>${esc(u.title)}</td><td class="num">${u.prices.map((p) => `${esc(p.label)} ${p.value ?? '—'}`).join(' · ')}</td></tr>`).join('')}</tbody></table></details>` : '';
    ctx.patch(body, scores + `<div class="tl-section" data-market-key="tl-markets"><h4>Рынки в ${esc(fmtTime(st.at))}</h4>${grid}</div>` + unknown);
  }
  function statsHtml(stats) {
    if (!stats?.maps?.length) return '';
    const cur = stats.current;
    return `<p class="tl-stats">CS2 · ${stats.maps.map((m) => `${esc(m.map || 'карта ' + (m.mapNum ?? ''))}: ${m.roundScore[0]}:${m.roundScore[1]}`).join(' · ')}${cur?.lastRound ? ` · последний раунд ${cur.lastRound.number}${cur.lastRound.type ? ' (' + esc(cur.lastRound.type) + ')' : ''}` : ''}</p>`;
  }
  function changesHtml() {
    const data = st.changes;
    if (!data) return '<div class="skeleton" style="height:160px;margin:12px 16px"></div>';
    if (!data.items.length) return '<p class="muted tl-empty">В этом окне (−3 / +7 минут) изменений нет.</p>';
    const label = (x) => x.kind === 'score' ? `Счёт ${esc(fmtVal(x.old))} → <b>${esc(fmtVal(x.new))}</b>` : x.kind === 'state' ? 'Состояние матча' + (x.map ? ` · карта ${esc(x.map)}` : '') + (x.betStop ? ' · приём ставок остановлен' : '')
      : x.event === 'appeared' ? `Появился рынок <b>${esc(x.title)}</b>` : x.event === 'suspended' ? `Приостановлен: <b>${esc(x.title)}</b>` : x.event === 'reopened' ? `Открыт снова: <b>${esc(x.title)}</b>` : x.event === 'closed' ? `Закрыт: <b>${esc(x.title)}</b>` : `<b>${esc(x.title)}</b>`;
    const diff = (x) => (x.changes || []).filter((c) => c.old != null || c.new != null).slice(0, 6).map((c) => `<span class="tl-chg"><span>${esc(MarketCompare.outcomeLabel(c.outcome, { family: x.family, params: {} }, { team1: st.event.team1, team2: st.event.team2 }) || c.name || '')}</span> ${c.old != null ? esc(c.old) + ' → ' : ''}<b class="${c.old != null && c.new != null ? (c.new > c.old ? 'up' : c.new < c.old ? 'down' : '') : ''}">${c.new ?? '—'}</b></span>`).join('');
    return `<ol class="tl-changes">${data.items.map((x) => `<li class="${x.at <= st.at ? 'past' : 'future'} ${x.kind}" data-market-key="tlc:${esc(x.id)}"><button type="button" class="link-btn num" data-tl="goto" data-at="${x.at}" title="Перейти к этому моменту">${esc(fmtTime(x.at))}</button><span class="book-mark ${esc(x.provider)}" aria-hidden="true" title="${esc(BOOK_NAME[x.provider] || x.provider)}"></span><span class="tl-what">${label(x)} ${x.kind === 'market' || x.kind === 'odds' ? diff(x) : ''}${x.market && !x.unknown ? ` <button type="button" class="link-btn small" data-tl="market-only" data-market="${esc(x.market)}">только этот рынок</button>` : ''}</span></li>`).join('')}</ol>${data.hasMore ? '<p class="muted tl-empty">Показаны первые 300 изменений окна.</p>' : ''}`;
  }
  const fmtVal = (v) => (v == null ? '—' : typeof v === 'object' ? v.score ?? JSON.stringify(v) : String(v));
  return { configure, open, close, isOpen, keysOf };
})();
