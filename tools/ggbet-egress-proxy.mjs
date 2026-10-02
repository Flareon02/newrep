#!/usr/bin/env node
// CONNECT-only proxy that runs INSIDE the isolated GGBET egress namespace (ops/staging/ggbet-egress.sh starts it there
// as the service user). It listens on a Unix socket only (no TCP port anywhere), accepts CONNECT to an allow-list of
// hosts on port 443 and pipes bytes; it never sees plaintext (TLS is end-to-end from the collector).
//   node ggbet-egress-proxy.mjs --socket /run/ggbet-egress/connect.sock
import net from 'node:net';
import fs from 'node:fs';
import dns from 'node:dns';
import { fileURLToPath } from 'node:url';

export const ALLOWED = [/^(?:[a-z0-9-]+\.)*gg\.bet$/i, /^score-board\.databet\.cloud$/i, /^ipinfo\.io$/i];
export function allowedTarget(target) {
  const m = /^([a-z0-9.-]+):(\d+)$/i.exec(String(target || '')); if (!m) return null;
  const [, host, port] = m; return Number(port) === 443 && ALLOWED.some((re) => re.test(host)) ? { host: host.toLowerCase(), port: 443 } : null;
}
// Names are resolved with the namespace's own DNS servers (--resolv file): a unit started with NetworkNamespacePath keeps
// the host /etc/resolv.conf, whose stub resolver (127.0.0.53) does not exist inside the namespace.
export function resolverFrom(file) {
  const servers = fs.readFileSync(file, 'utf8').split('\n').map((l) => /^\s*nameserver\s+(\S+)/.exec(l)?.[1]).filter(Boolean);
  const r = new dns.promises.Resolver({ timeout: 5000, tries: 2 }); if (servers.length) r.setServers(servers);
  return async (host) => (await r.resolve4(host))[0];
}
export function createProxy({ connect = (opts) => net.connect(opts), resolve = async (host) => host, log = () => {} } = {}) {
  return net.createServer((client) => {
    let head = Buffer.alloc(0);
    client.setTimeout(15000, () => client.destroy());
    const onData = (chunk) => {
      head = Buffer.concat([head, chunk]); const end = head.indexOf('\r\n\r\n');
      if (end < 0) { if (head.length > 8192) client.destroy(); return; }
      client.removeListener('data', onData);
      const line = head.subarray(0, end).toString('latin1').split('\r\n')[0], m = /^CONNECT (\S+) HTTP\/1\.[01]$/.exec(line), target = allowedTarget(m?.[1]);
      if (!target) { log({ event: 'refused', target: String(m?.[1] || line).slice(0, 100) }); client.end('HTTP/1.1 403 Forbidden\r\n\r\n'); return; }
      let upstream = null;
      resolve(target.host).then((address) => { upstream = connect({ host: address, port: target.port }); wire(); }, (e) => { log({ event: 'dns-error', target: target.host, code: e.code }); if (!client.destroyed) client.end('HTTP/1.1 502 Bad Gateway\r\n\r\n'); });
      const wire = () => {
      upstream.once('connect', () => { client.setTimeout(0); client.write('HTTP/1.1 200 Connection Established\r\n\r\n'); if (head.length > end + 4) upstream.write(head.subarray(end + 4)); client.pipe(upstream); upstream.pipe(client); log({ event: 'connected', target: target.host }); });
      upstream.once('error', (e) => { log({ event: 'upstream-error', target: target.host, code: e.code }); if (!client.destroyed) client.end('HTTP/1.1 502 Bad Gateway\r\n\r\n'); });
      client.once('error', () => upstream.destroy()); client.once('close', () => upstream.destroy()); upstream.once('close', () => client.destroy());
      };
    };
    client.on('data', onData); client.on('error', () => {});
  });
}
// Started as a program (also through the /opt/esports-monitor/current symlink, which import.meta.url resolves)?
const isMain = (() => { try { return fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url)); } catch { return false; } })();
if (isMain) {
  const i = process.argv.indexOf('--socket'), socket = i > 0 ? process.argv[i + 1] : '/run/ggbet-egress/connect.sock', j = process.argv.indexOf('--resolv');
  try { fs.unlinkSync(socket); } catch {}
  const server = createProxy({ ...(j > 0 ? { resolve: resolverFrom(process.argv[j + 1]) } : {}), log: (e) => process.stdout.write(JSON.stringify({ at: new Date().toISOString(), ...e }) + '\n') });
  server.listen(socket, () => { fs.chmodSync(socket, 0o600); process.stdout.write(JSON.stringify({ at: new Date().toISOString(), event: 'listening', socket }) + '\n'); });
  for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => server.close(() => process.exit(0)));
}
