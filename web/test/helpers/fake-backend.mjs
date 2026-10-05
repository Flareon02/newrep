// A stand-in for the Esports Monitor server in gateway tests: users with keys and capabilities (the real
// entitlements code decides /api/me), the admin users API, a few data routes with diagnostics fields, an event
// stream the test can push into, and an optional fallback to tools/ux/mock-server.mjs for the full UI data set.
import http from 'node:http';
import { randomBytes } from 'node:crypto';
import { createAccess, CAPABILITY_KEYS, filterForPrincipal } from '../../gateway/src/vendor/entitlements.js';

export const ALL_USER_CAPS = CAPABILITY_KEYS.filter((k) => !k.startsWith('admin.'));

export async function startFakeBackend({ masterToken = 'master-' + randomBytes(16).toString('hex'), fallback = '' } = {}) {
  const users = [];
  const seen = { authorizations: [], paths: [] };
  const feedClients = new Set(), detailClients = new Set();
  let now = Date.now();
  const store = { ready: Promise.resolve(), byToken: (t) => users.find((u) => u.token === t) || null };
  const access = createAccess({ masterToken, users: store });

  function addUser({ name, role = 'user', capabilities = ALL_USER_CAPS, disabled = false } = {}) {
    const u = { id: 'u_' + randomBytes(6).toString('hex'), name, role, capabilities: [...capabilities], disabled, token: 'emu_' + randomBytes(24).toString('hex'), createdAt: now, updatedAt: now, tokenUpdatedAt: now++ };
    users.push(u);
    return u;
  }
  const view = (u) => ({ id: u.id, name: u.name, role: u.role, disabled: u.disabled, capabilities: [...u.capabilities], createdAt: u.createdAt, updatedAt: u.updatedAt, tokenUpdatedAt: u.tokenUpdatedAt });
  const send = (res, status, data, headers = {}) => { const b = JSON.stringify(data); res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', ...headers }); res.end(b); };

  const liveSnapshot = () => ({
    revision: 'r1', structureRevision: 's1', serverVersion: 'fake-4.15',
    events: [
      { id: 'm1', team1: 'Alpha', team2: 'Beta', category: 'Dota 2', sourceRefs: [{ source: 'astek', id: 'a1', quote: { p1: 1.5 }, odds: { markets: [{ k: 1 }, { k: 2 }] } }, { source: 'pinnacle', id: 'p1', quote: { p1: 1.6 } }] },
      { id: 'm2', team1: 'Gamma', team2: 'Delta', category: 'CS2', sourceRefs: [{ source: 'pinnacle', id: 'p2', quote: { p1: 2.1 } }] },
    ],
    providers: { astek: { lastError: 'socket hang up http://internal', lastUrl: 'http://internal/x', events: [] }, pinnacle: { events: [] } },
  });

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x'), p = url.pathname;
    seen.authorizations.push(String(req.headers.authorization || ''));
    seen.paths.push(req.method + ' ' + p + url.search);
    let body = ''; for await (const c of req) body += c;
    const principal = await access.resolve(req, url);
    const isMaster = principal.builtin === true;

    if (p === '/api/me') return send(res, 200, { ok: true, serverVersion: 'fake-4.15', access: 'enforce', principal: { id: principal.id, name: principal.name, role: principal.role, anonymous: principal.anonymous }, capabilities: [...principal.caps].sort() });
    if (p.startsWith('/api/admin/users')) {
      if (!isMaster && principal.role !== 'admin') return send(res, principal.anonymous ? 401 : 403, { error: 'no' });
      const parts = p.split('/').filter(Boolean), id = parts[3], action = parts[4];
      if (req.method === 'GET') return send(res, 200, { users: users.map(view) });
      const patch = body ? JSON.parse(body) : {};
      if (!id) { const u = addUser({ name: patch.name, role: patch.role === 'admin' ? 'admin' : 'user', capabilities: [] }); return send(res, 200, { ok: true, user: view(u), token: u.token }); }
      const u = users.find((x) => x.id === id); if (!u) return send(res, 404, { error: 'Пользователь не найден' });
      if (action === 'token') { u.token = 'emu_' + randomBytes(24).toString('hex'); u.tokenUpdatedAt = ++now; return send(res, 200, { ok: true, user: view(u), token: u.token }); }
      if (action === 'delete') { users.splice(users.indexOf(u), 1); return send(res, 200, { ok: true }); }
      if (patch.disabled != null) u.disabled = !!patch.disabled;
      if (Array.isArray(patch.capabilities)) u.capabilities = patch.capabilities;
      if (patch.name) u.name = patch.name;
      return send(res, 200, { ok: true, user: view(u) });
    }
    if (fallback) {
      // Full UI data set (tools/ux/mock-server.mjs): every data route goes there; users and keys stay here.
      const up = http.request(fallback + req.url, { method: req.method, headers: { ...req.headers, host: new URL(fallback).host } }, (r) => { res.writeHead(r.statusCode, r.headers); res.flushHeaders(); r.pipe(res); });
      up.on('error', () => send(res, 502, { error: 'fallback down' }));
      req.on('close', () => up.destroy());
      return up.end(body || undefined);
    }
    if (!isMaster && principal.anonymous) return send(res, 401, { error: 'unauthorized' });
    if (p === '/api/ui/live') {
      const etag = 'W/"feed-r1"';
      if (req.headers['if-none-match'] === etag) { res.writeHead(304, { etag }); return res.end(); }
      return send(res, 200, isMaster ? liveSnapshot() : filterForPrincipal(principal, liveSnapshot()), { etag });
    }
    if (/^\/api\/events\/[^/]+\/history$/.test(p)) {
      const entries = [
        { provider: 'astek', kind: 'score', at: 3 }, { provider: 'astek', kind: 'odds', at: 2 }, { provider: 'pinnacle', kind: 'odds', at: 1 }, { provider: 'pinnacle', kind: 'state', at: 0 },
      ];
      return send(res, 200, { entries, scoreTimeline: entries.filter((e) => ['score', 'state'].includes(e.kind)), oddsTimeline: entries.filter((e) => !['score', 'state'].includes(e.kind)), hasMore: false });
    }
    if (p === '/api/feed-stream' || p === '/api/statistics/stream') {
      res.writeHead(200, { 'content-type': 'text/event-stream' }); res.flushHeaders();
      const set = p === '/api/feed-stream' ? feedClients : detailClients;
      const client = { res, query: url.search };
      set.add(client); req.on('close', () => set.delete(client));
      if (p === '/api/feed-stream') res.write(`event: hello\ndata: ${JSON.stringify({ serverVersion: 'fake-4.15', feeds: { live: { revision: 'r1', providers: { astek: { lastError: 'secret-diag' } } }, prematch: { revision: 'p1' } }, ui: { history: { revision: 1 }, results: { revision: 1 } } })}\n\n`);
      return;
    }
    if (p.startsWith('/api/team-logos/')) { res.writeHead(200, { 'content-type': 'image/svg+xml' }); return res.end('<svg xmlns="http://www.w3.org/2000/svg"/>'); }
    return send(res, 404, { error: 'not found' });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    base, masterToken, users, seen, addUser, feedClients, detailClients,
    push(event, data) { for (const c of feedClients) c.res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); },
    close: () => new Promise((r) => { for (const s of [...feedClients, ...detailClients]) s.res.destroy(); server.closeAllConnections?.(); server.close(r); }),
  };
}
