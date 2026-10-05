// Mock Esports Monitor API for the UX harness. History/results queries run through the server's own pure query code
// (server/src/ui-service.js), so filters, `hours`/`end`/`phase`, totals and facets behave like production.
// Simulated cost: each History request waits `historyLatencyMs` (the real server runs a matcher worker per page).
import http from 'node:http';
import { queryUiEvents, compactUiPayload } from '../../server/src/ui-service.js';
import { buildFixtures, cs2Stats } from './fixtures.mjs';

export function startMockServer({ port = 0, historyLatencyMs = 450, invalidateEveryMs = 0, fixtures = buildFixtures() } = {}) {
  const log = [];
  const sse = new Set();
  const svg = (h) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="7" fill="#${h.slice(0, 6)}"/><text x="16" y="21" font-size="13" text-anchor="middle" fill="#fff" font-family="sans-serif">${h.slice(0, 2).toUpperCase()}</text></svg>`;
  const send = (res, status, body, headers = {}) => { const text = typeof body === 'string' ? body : JSON.stringify(body); res.writeHead(status, { 'content-type': 'application/json', 'access-control-allow-origin': '*', 'access-control-expose-headers': 'etag', ...headers }); res.end(text); return text.length; };
  const meta = (kind) => ({ revision: `${kind}-1`, structureRevision: `${kind}-s1`, generatedAt: fixtures.now, providers: { astek: { lastSuccessfulUpdateAt: new Date().toISOString() }, fonbet: { lastSuccessfulUpdateAt: new Date().toISOString() }, pinnacle: { lastSuccessfulUpdateAt: new Date().toISOString() }, ggbet: { oddsProvider: { available: true, connectionState: 'connected' } } }, leagueRules: { revision: 1, links: [], visibility: {} } });
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
    invalidateHistory() { for (const res of sse) try { res.write(`event: ui-invalidate\ndata: ${JSON.stringify({ view: 'history', revision: Date.now(), reason: 'manual', at: Date.now() })}\n\n`); } catch {} },
    close() { clearInterval(timer); for (const res of sse) try { res.end(); } catch {} return new Promise((r) => { server.closeAllConnections?.(); server.close(r); }); },
  })));
}
