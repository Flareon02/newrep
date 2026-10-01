// Outbound network path of the LIVE odds platform collectors (GGBET, DataBet).
//
//   <PROVIDER>_NETWORK_MODE=proxy   bootstrap page AND GraphQL WebSocket go through the HTTP CONNECT proxy
//                                   (CZECH_PROXY_*). One agent, one credential set: every request of a session
//                                   leaves through the same sticky proxy session. Never falls back to direct.
//   GGBET_NETWORK_MODE=relay        guest token from the bootstrap relay, WebSocket direct (4.4/4.5 behaviour)
//   <PROVIDER>_NETWORK_MODE=direct  everything direct
// Unset: GGBET = relay when GGBET_BOOTSTRAP_RELAY_URL is set, otherwise direct; DataBet = direct.
//
// Proxy credentials are read from the environment when the agent is created and are never logged, returned in
// diagnostics or put into error messages (see redact()).
import http from 'node:http';
import https from 'node:https';
import zlib from 'node:zlib';
import { HttpsProxyAgent } from 'https-proxy-agent';

const MODES = { ggbet: ['proxy', 'relay', 'direct'], databet: ['proxy', 'direct'] };
const truthy = (value) => /^(?:1|true|on|yes)$/i.test(String(value ?? '').trim());

// The explicitly configured mode, or '' when unset/invalid (the provider's legacy default then applies).
export function explicitNetworkMode(provider, env = process.env) {
  const raw = String(env[`${provider.toUpperCase()}_NETWORK_MODE`] || '').trim().toLowerCase();
  return (MODES[provider] || []).includes(raw) ? raw : '';
}

function readProxySettings(env = process.env) {
  const host = String(env.CZECH_PROXY_HOST || '').trim(), port = Number(env.CZECH_PROXY_PORT);
  return {
    enabled: truthy(env.CZECH_PROXY_ENABLED), host, port: Number.isInteger(port) && port > 0 && port < 65536 ? port : 0,
    username: String(env.CZECH_PROXY_USERNAME || ''), password: String(env.CZECH_PROXY_PASSWORD || '')
  };
}

let agentCache = null; // {signature, agent}
let secrets = [];      // strings that must never leave the process (credentials and their encodings)
let egress = { ip: '', country: '', asn: '', org: '', checkedAt: null, error: '' };

function rememberSecrets({ username, password }) {
  const list = [];
  for (const value of [username, password]) if (value.length >= 3) list.push(value, encodeURIComponent(value));
  if (username || password) list.push(Buffer.from(`${username}:${password}`).toString('base64'));
  secrets = [...new Set(list)].sort((a, b) => b.length - a.length);
}

// Replaces any credential (plain, URL-encoded or as the Basic token) by ***.
export function redact(value) {
  let out = String(value ?? '');
  for (const secret of secrets) if (secret && out.includes(secret)) out = out.split(secret).join('***');
  return out.replace(/(\/\/)[^/@\s]+@/g, '$1***@');
}

// The single proxy agent of this process. Throws (fail closed) when proxy mode is requested but not configured.
export function proxyAgent(env = process.env) {
  const settings = readProxySettings(env);
  rememberSecrets(settings);
  if (!settings.enabled) throw Error('Czech proxy disabled (CZECH_PROXY_ENABLED is not 1)');
  if (!settings.host || !settings.port) throw Error('Czech proxy not configured (CZECH_PROXY_HOST / CZECH_PROXY_PORT)');
  const signature = JSON.stringify([settings.host, settings.port, settings.username, settings.password]);
  if (agentCache?.signature === signature) return agentCache.agent;
  const url = new URL(`http://${settings.host}:${settings.port}`);
  if (settings.username) url.username = encodeURIComponent(settings.username);
  if (settings.password) url.password = encodeURIComponent(settings.password);
  agentCache = { signature, agent: new HttpsProxyAgent(url, { keepAlive: false }) };
  return agentCache.agent;
}

export function resetEgressForTests() { agentCache = null; secrets = []; egress = { ip: '', country: '', asn: '', org: '', checkedAt: null, error: '' }; }

// Safe diagnostics: host and port only, never the username or password.
export function proxyDiagnostics(env = process.env) {
  const s = readProxySettings(env);
  return { proxyEnabled: s.enabled, proxyHost: s.host, proxyPort: s.port || null, credentials: s.username || s.password ? 'set' : 'missing', egress: { ...egress } };
}

function decode(res, body) {
  const encoding = String(res.headers['content-encoding'] || '').toLowerCase().trim();
  if (encoding === 'gzip' || encoding === 'x-gzip') return zlib.gunzipSync(body);
  if (encoding === 'deflate') { try { return zlib.inflateSync(body); } catch { return zlib.inflateRawSync(body); } }
  if (encoding === 'br') return zlib.brotliDecompressSync(body);
  return body;
}

// Minimal fetch() for GET requests through the proxy agent: follows redirects (each hop is a new CONNECT through the
// same agent), decodes gzip/deflate/br, enforces a size limit. Returns {ok, status, url, headers, text()}.
export function proxyFetch(target, { headers = {}, timeoutMs = 12000, maxBytes = 8 * 1024 * 1024, maxRedirects = 5, signal = null, agent = null } = {}) {
  const viaAgent = agent || proxyAgent();
  const run = (url, redirectsLeft) => new Promise((resolve, reject) => {
    let parsed; try { parsed = new URL(url); } catch { reject(Error('proxy fetch: invalid URL')); return; }
    const lib = parsed.protocol === 'https:' ? https : parsed.protocol === 'http:' ? http : null;
    if (!lib) { reject(Error(`proxy fetch: unsupported protocol ${parsed.protocol}`)); return; }
    const fail = (error) => reject(Error(redact(error?.message || String(error))));
    const req = lib.request(parsed, { method: 'GET', agent: viaAgent, headers: { 'accept-encoding': 'gzip, deflate, br', ...headers } }, (res) => {
      const status = res.statusCode || 0;
      if ([301, 302, 303, 307, 308].includes(status) && res.headers.location) {
        res.resume();
        if (redirectsLeft <= 0) { fail(Error('proxy fetch: too many redirects')); return; }
        resolve(run(new URL(res.headers.location, parsed).href, redirectsLeft - 1)); return;
      }
      const chunks = []; let size = 0;
      res.on('data', (chunk) => { size += chunk.length; if (size > maxBytes) { req.destroy(Error('proxy fetch: response too large')); return; } chunks.push(chunk); });
      res.on('error', fail);
      res.on('end', () => {
        let body; try { body = decode(res, Buffer.concat(chunks)); } catch (error) { fail(error); return; }
        const textBody = body.toString('utf8');
        resolve({ ok: status >= 200 && status < 300, status, url: parsed.href, headers: res.headers, text: async () => textBody, json: async () => JSON.parse(textBody) });
      });
    });
    req.setTimeout(timeoutMs, () => req.destroy(Error('proxy fetch: timeout')));
    req.on('error', fail);
    if (signal) { if (signal.aborted) req.destroy(Error('proxy fetch: aborted')); else signal.addEventListener('abort', () => req.destroy(Error('proxy fetch: aborted')), { once: true }); }
    req.end();
  });
  return run(String(target), maxRedirects);
}

// Optional diagnostics: the public IP/country/ASN the proxy presents. Never required by the collectors.
export async function checkProxyEgress({ fetchImpl = proxyFetch, url = 'https://ipinfo.io/json', now = () => Date.now() } = {}) {
  try {
    const res = await fetchImpl(url, { headers: { accept: 'application/json', 'user-agent': 'esports-monitor-egress-check' }, timeoutMs: 10000, maxBytes: 64 * 1024 });
    if (!res.ok) throw Error(`HTTP ${res.status}`);
    const data = JSON.parse(await res.text());
    const org = String(data.org || ''), asn = org.match(/^AS\d+/)?.[0] || String(data.asn?.asn || '');
    egress = { ip: String(data.ip || ''), country: String(data.country || ''), asn, org: org.replace(/^AS\d+\s*/, '').slice(0, 80), checkedAt: new Date(now()).toISOString(), error: '' };
  } catch (error) {
    egress = { ...egress, checkedAt: new Date(now()).toISOString(), error: redact(error?.message || String(error)).slice(0, 200) };
  }
  return { ...egress };
}
