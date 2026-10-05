// HTTP client for the Esports Monitor server. Raw node:http (not fetch) so compressed bodies and event streams pass
// through byte for byte. The server's API token is attached here and nowhere else; it never reaches a browser.
import http from 'node:http';
import https from 'node:https';

export function createUpstream({ base, token, timeoutMs = 40_000 }) {
  const url = new URL(base);
  const lib = url.protocol === 'https:' ? https : http;
  const agent = new lib.Agent({ keepAlive: true, maxSockets: 64, maxFreeSockets: 16, keepAliveMsecs: 15_000 });
  const prefix = url.pathname.replace(/\/+$/, '');

  // Resolves with the IncomingMessage (headers received); the caller consumes or pipes the body.
  // auth: 'service' (the server token) or { bearer } (a user's key, only for /api/me during sign-in).
  function request(pathAndQuery, { method = 'GET', headers = {}, body = null, auth = 'service', signal = null, timeout = timeoutMs, stream = false } = {}) {
    return new Promise((resolve, reject) => {
      const outHeaders = { ...headers };
      const bearer = auth === 'service' ? token : auth?.bearer;
      if (bearer) outHeaders.authorization = 'Bearer ' + bearer;
      if (body != null) outHeaders['content-length'] = String(Buffer.byteLength(body));
      const req = lib.request({
        protocol: url.protocol, hostname: url.hostname, port: url.port || (url.protocol === 'https:' ? 443 : 80),
        method, path: prefix + pathAndQuery, headers: outHeaders, agent,
      }, (res) => {
        // A stream may stay open for hours; only the time to the response headers is limited.
        if (stream) req.setTimeout(0);
        resolve(res);
      });
      req.setTimeout(timeout, () => req.destroy(Object.assign(new Error('upstream timeout'), { code: 'UPSTREAM_TIMEOUT' })));
      req.on('error', reject);
      if (signal) {
        if (signal.aborted) { req.destroy(); return reject(Object.assign(new Error('aborted'), { name: 'AbortError' })); }
        signal.addEventListener('abort', () => req.destroy(Object.assign(new Error('aborted'), { name: 'AbortError' })), { once: true });
      }
      req.end(body ?? undefined);
    });
  }

  async function readAll(res, limit = 64 * 1024 * 1024) {
    const chunks = []; let size = 0;
    for await (const chunk of res) { size += chunk.length; if (size > limit) throw new Error('upstream response too large'); chunks.push(chunk); }
    return Buffer.concat(chunks);
  }

  async function json(pathAndQuery, options = {}) {
    const res = await request(pathAndQuery, { ...options, headers: { accept: 'application/json', 'accept-encoding': 'identity', ...(options.headers || {}) } });
    const raw = await readAll(res);
    let data = null;
    try { data = raw.length ? JSON.parse(raw.toString('utf8')) : null; } catch { data = null; }
    return { status: res.statusCode, data, headers: res.headers };
  }

  return { request, json, readAll, close: () => agent.destroy(), configured: !!token };
}
