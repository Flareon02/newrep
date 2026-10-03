// Unix-only local IPC. The process runs with the shared group's primary gid; no TCP address is accepted.
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';

export function serveIpc({ socketPath, handle }) {
  const dir = path.dirname(socketPath);
  fs.mkdirSync(dir, { recursive: true, mode: 0o750 });
  fs.chmodSync(dir, 0o750);
  try { fs.unlinkSync(socketPath); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://local');
      let body = null;
      if (req.method === 'POST') {
        let text = '';
        for await (const chunk of req) {
          text += chunk;
          if (text.length > 8192) { res.writeHead(413); res.end('{}'); return; }
        }
        try { body = JSON.parse(text); } catch { res.writeHead(400); res.end('{}'); return; }
      } else if (req.method !== 'GET') { res.writeHead(405); res.end('{}'); return; }
      const result = await handle({ method: req.method, url, body });
      res.writeHead(result?.status || 200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(result?.body ?? {}));
    } catch { if (!res.headersSent) res.writeHead(500); res.end('{}'); }
  });
  // Restrictive even between bind and chmod. Worker startup also sets umask 0077.
  const mask = process.umask(0o077);
  server.listen(socketPath, () => fs.chmodSync(socketPath, 0o660));
  process.umask(mask);
  server.requestTimeout = 5000;
  server.headersTimeout = 5000;
  return server;
}
