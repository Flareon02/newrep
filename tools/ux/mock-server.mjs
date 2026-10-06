// Mock Esports Monitor API for the UX harness. History/results queries run through the server's own pure query code
// (server/src/ui-service.js), so filters, `hours`/`end`/`phase`, totals and facets behave like production.
// Simulated cost: each History request waits `historyLatencyMs` (the real server runs a matcher worker per page).
import http from 'node:http';
import { queryUiEvents, compactUiPayload } from '../../server/src/ui-service.js';
import { buildFixtures, cs2Stats } from './fixtures.mjs';

// Optional `realEvent` ({ db, at, team1, team2, category, refs: [{ source, id, reversed }] }): one LIVE event backed by the
// production journal (a read-only SQLite copy) - its detail markets come from the journal state through the server's own
// canonical semantics, and the timeline endpoints run the real timeline worker. Nothing is fetched from bookmakers.
let liveRevision = 1;
export async function startMockServer({ port = 0, historyLatencyMs = 450, invalidateEveryMs = 0, fixtures = buildFixtures(), realEvent = null } = {}) {
  const real = realEvent ? await realBackend(realEvent, fixtures) : null;
  const log = [];
  const sse = new Set();
  const svg = (h) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="7" fill="#${h.slice(0, 6)}"/><text x="16" y="21" font-size="13" text-anchor="middle" fill="#fff" font-family="sans-serif">${h.slice(0, 2).toUpperCase()}</text></svg>`;
  const send = (res, status, body, headers = {}) => { const text = typeof body === 'string' ? body : JSON.stringify(body); res.writeHead(status, { 'content-type': 'application/json', 'access-control-allow-origin': '*', 'access-control-expose-headers': 'etag', ...headers }); res.end(text); return text.length; };
  const meta = (kind) => ({ revision: kind === 'live' ? `live-${liveRevision}` : `${kind}-1`, structureRevision: `${kind}-s1`, generatedAt: fixtures.now, providers: { astek: { lastSuccessfulUpdateAt: new Date().toISOString() }, fonbet: { lastSuccessfulUpdateAt: new Date().toISOString() }, pinnacle: { lastSuccessfulUpdateAt: new Date().toISOString() }, ggbet: { oddsProvider: { available: true, connectionState: 'connected' } } }, leagueRules: { revision: 1, links: [], visibility: {} } });
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x'), p = url.pathname, started = Date.now();
    if (req.method === 'OPTIONS') { res.writeHead(204, { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'GET,POST,OPTIONS', 'access-control-allow-headers': 'Content-Type, Authorization, If-None-Match, X-API-Token', 'access-control-max-age': '86400' }); return res.end(); }
    let body = ''; for await (const chunk of req) body += chunk;
    const done = (bytes, status = 200) => log.push({ at: started, path: p, query: url.search, status, bytes, ms: Date.now() - started });
    if (p === '/api/me') return done(send(res, 404, { error: 'not found' }), 404);
    if (p === '/api/ui/live' || p === '/api/ui/prematch') {
      const kind = p.endsWith('live') ? 'live' : 'prematch', m = meta(kind);
      if (url.searchParams.get('meta') === '1') return done(send(res, 200, m));
      // The real server keeps each ref's main-market quote in the thin feed (uiQuote); compactUiPayload alone drops it.
      const source = kind === 'live' ? fixtures.liveEvents : fixtures.lineEvents, thin = compactUiPayload({ ...m, events: source });
      thin.events.forEach((e, i) => e.sourceRefs.forEach((r, j) => { r.quote = source[i].sourceRefs[j]?.quote; }));
      return done(send(res, 200, thin));
    }
    if (p === '/api/feed-stream') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', 'access-control-allow-origin': '*' });
      res.write(`event: hello\ndata: ${JSON.stringify({ feeds: { live: { revision: 'live-1' }, prematch: { revision: 'prematch-1' } }, ui: {}, serverVersion: 'mock' })}\n\n`);
      sse.add(res); req.on('close', () => sse.delete(res)); return;
    }
    if (p === '/api/ui/history') {
      await new Promise((r) => setTimeout(r, historyLatencyMs));
      const params = Object.fromEntries(url.searchParams.entries());
      const page = queryUiEvents(fixtures.events, params, { links: [] }, 'history');
      const out = compactUiPayload({ ...page, count: page.total, totalExact: true, generatedAt: Date.now(), serverUi: true, uiRevision: 1, leagueRules: { revision: 1, links: [] } });
      return done(send(res, 200, out));
    }
    if (p === '/api/ui/results') {
      const params = Object.fromEntries(url.searchParams.entries());
      const removed = fixtures.events.filter((e) => e.removedAt && e.removedAt < Date.now()).map((e) => ({ ...e, sourceRefs: e.sourceRefs.filter((r) => r.source !== 'pinnacle').map((r) => ({ ...r, resultVerified: true })) })).filter((e) => e.sourceRefs.length);
      const page = queryUiEvents(removed, params, { links: [] }, 'results');
      return done(send(res, 200, compactUiPayload({ ...page, complete: true, status: 'ready', uiRevision: 1, count: page.total })));
    }
    if (real && p === '/api/ui/event-detail' && url.searchParams.get('id') === real.event.id) return done(send(res, 200, real.detail()));
    if (real && /^\/api\/events\/[^/]+\/(timeline\/meta|timeline|state-at)$/.test(p)) {
      try { return done(send(res, 200, await real.timeline(p, url.searchParams))); } catch (error) { return done(send(res, error.status || 500, { error: error.message }), error.status || 500); }
    }
    if (p === '/api/ui/event-detail') {
      const id = url.searchParams.get('id'), e = [...fixtures.liveEvents, ...fixtures.lineEvents].find((x) => String(x.id) === id);
      if (!e) return done(send(res, 404, { error: 'нет матча' }), 404);
      const markets = (k) => [{ key: 'w', type: 'moneyline', period: 0, title: 'Победитель', status: 'open', prices: [{ designation: 'home', label: e.team1, decimal: 1.7 + k / 10 }, { designation: 'away', label: e.team2, decimal: 2.1 - k / 20 }] }, ...[1, 2].map((m) => ({ key: 'w' + m, type: 'moneyline', period: m, title: 'Победитель', status: 'open', prices: [{ designation: 'home', label: e.team1, decimal: 1.8 }, { designation: 'away', label: e.team2, decimal: 1.95 }] })), ...[24.5, 26.5].map((line) => ({ key: 't' + line, type: 'total', period: 1, title: 'Тотал раундов', line, status: 'open', prices: [{ designation: 'over', label: 'Больше ' + line, decimal: 1.85, points: line }, { designation: 'under', label: 'Меньше ' + line, decimal: 1.9, points: line }] }))];
      return done(send(res, 200, { event: { ...e, sourceRefs: e.sourceRefs.map((r, k) => ({ ...r, odds: { markets: markets(k), updatedAt: Date.now() } })) } }));
    }
    if (p === '/api/statistics/availability') {
      let events = []; try { events = JSON.parse(body).events || []; } catch {}
      const out = {}; for (const e of events) if (/counter|cs2/i.test(e.category || '') && fixtures.liveEvents.some((x) => x.id === e.id)) out[e.id] = { provider: 'cs2', id: 'cs-' + e.id };
      return done(send(res, 200, out));
    }
    if (p === '/api/statistics/match') { const id = String(url.searchParams.get('id') || '').replace(/^cs-/, ''), e = fixtures.liveEvents.find((x) => x.id === id); return done(send(res, 200, e ? cs2Stats(e) : { matched: false })); }
    if (p === '/api/statistics/stream') { res.writeHead(200, { 'content-type': 'text/event-stream', 'access-control-allow-origin': '*' }); sse.add(res); req.on('close', () => sse.delete(res)); return; }
    if (p.startsWith('/api/team-logos/')) {
      const h = p.split('/').pop();
      if (fixtures.logos.good.includes(h)) { res.writeHead(200, { 'content-type': 'image/svg+xml', 'cache-control': 'max-age=3600', 'access-control-allow-origin': '*' }); res.end(svg(h)); return done(1); }
      return done(send(res, 404, { error: 'нет логотипа' }), 404);
    }
    if (p === '/api/ui/odds-providers') return done(send(res, 200, { defaultProvider: 'ggbet', providers: { ggbet: { available: true, connectionState: 'connected' }, databet: { available: true, connectionState: 'connected' } } }));
    if (p === '/api/ui/odds-watch' || p === '/api/ui/full-markets') return done(send(res, 200, { ok: true }));
    if (p === '/api/ui/leagues') return done(send(res, 200, { schemaVersion: 2, revision: 1, links: [], visibility: {}, providers: {}, totals: {} }));
    return done(send(res, 404, { error: 'not mocked' }), 404);
  });
  let timer = 0;
  if (invalidateEveryMs > 0) timer = setInterval(() => { for (const res of sse) try { res.write(`event: ui-invalidate\ndata: ${JSON.stringify({ view: 'history', revision: Date.now(), reason: 'feed:live:astek', at: Date.now() })}\n\n`); } catch {} }, invalidateEveryMs);
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve({
    url: `http://127.0.0.1:${server.address().port}`, log, fixtures,
    // Realtime simulation: change the main-market quotes of `count` LIVE events and tell the clients (as the server's feed
    // stream does after a structural/odds change), so the extension refetches and patches its rows.
    tickLive(count = 6) {
      const list = fixtures.liveEvents;
      for (let i = 0; i < Math.min(count, list.length); i++) {
        const e = list[Math.floor(Math.random() * list.length)];
        for (const r of e.sourceRefs) if (r.quote) r.quote = { ...r.quote, h: +(1.3 + Math.random() * 1.5).toFixed(2), a: +(1.3 + Math.random() * 1.5).toFixed(2), at: Date.now() };
      }
      liveRevision++;
      for (const res of sse) try { res.write(`event: invalidate\ndata: ${JSON.stringify({ mode: 'live', provider: 'ggbet', meta: { revision: 'live-' + liveRevision }, at: Date.now() })}\n\n`); } catch {}
    },
    invalidateHistory() { for (const res of sse) try { res.write(`event: ui-invalidate\ndata: ${JSON.stringify({ view: 'history', revision: Date.now(), reason: 'manual', at: Date.now() })}\n\n`); } catch {} },
    close() { clearInterval(timer); real?.close(); for (const res of sse) try { res.end(); } catch {} return new Promise((r) => { server.closeAllConnections?.(); server.close(r); }); },
  })));
}

async function realBackend({ db: file, at, team1, team2, category, refs }, fixtures) {
  const { DatabaseSync } = await import('node:sqlite');
  const { marketsAt } = await import('../../server/src/timeline-core.js');
  const { TimelineClient } = await import('../../server/src/timeline-client.js');
  const { enrichEventMarketSemantics } = await import('../../server/src/market-semantics.js');
  const path = await import('node:path');
  const db = new DatabaseSync(file, { readOnly: true });
  const client = new TimelineClient({ dataDir: path.dirname(file), file, idleMs: 60000 });
  const sourceRefs = refs.map((r) => ({ id: `${r.source}:${r.id}`, sourceEventId: r.id, source: r.source, category, league: 'Real journal', team1, team2, inLive: true, enteredLiveAt: at - 3600000, startAt: at - 3600000, scoreReversed: !!r.reversed, quote: null }));
  const event = { id: 'real-1', ui: true, category, league: 'Real journal (production copy)', leagueKey: 'real|journal', team1, team2, inLive: true, enteredLiveAt: at - 3600000, startAt: at - 3600000, bestOf: 3, sourceRefs };
  fixtures.liveEvents.unshift(event);
  return {
    event,
    detail() {
      const full = { ...event, sourceRefs: sourceRefs.map((r) => { const m = marketsAt(db, `${r.source}:${r.sourceEventId}`, at); return { ...r, odds: { team1: m.meta?.team1 || (r.scoreReversed ? team2 : team1), team2: m.meta?.team2 || (r.scoreReversed ? team1 : team2), updatedAt: at, markets: m.markets } }; }) };
      return { ok: true, view: 'live', event: enrichEventMarketSemantics(full), marketDetailErrors: {} };
    },
    async timeline(p, q) {
      const op = p.endsWith('/meta') ? 'meta' : p.endsWith('/state-at') ? 'stateAt' : 'range';
      const req = { keys: String(q.get('ids') || '').split(',').filter(Boolean), reversed: String(q.get('rev') || '').split(',').filter(Boolean), includeOdds: true, includeScores: true, provider: q.get('provider') || '', market: q.get('market') || '', team1: q.get('team1') || '', team2: q.get('team2') || '', sport: q.get('sport') || '', bestOf: Number(q.get('bestOf')) || 0, at: Number(q.get('at')) || undefined, from: Number(q.get('from')) || (op === 'meta' ? undefined : 0), to: Number(q.get('to')) || (op === 'meta' ? undefined : Date.now()), cursor: q.get('cursor') || '', limit: Number(q.get('limit')) || 200, kinds: q.get('kinds') || undefined, cats: q.get('cats') || undefined };
      return { eventId: event.id, keys: req.keys, ...(await client.request(op, req)) };
    },
    close() { client.stop(); db.close(); },
  };
}
