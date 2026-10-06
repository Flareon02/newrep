// Gateway configuration from the environment. Secrets are never read from the command line and never logged:
// the monitor server's API token comes from a file (systemd LoadCredential= or UPSTREAM_TOKEN_FILE).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DAY = 86_400_000;

function int(env, name, fallback, min = 0) {
  const n = Number(env[name]);
  return env[name] !== undefined && env[name] !== '' && Number.isFinite(n) && n >= min ? Math.floor(n) : fallback;
}
function bool(env, name, fallback) {
  const v = env[name];
  return v === undefined || v === '' ? fallback : /^(1|true|yes|on)$/i.test(v);
}
function list(env, name, fallback) {
  return String(env[name] ?? fallback).split(',').map((s) => s.trim()).filter(Boolean);
}
function readSecret(file) {
  try { return fs.readFileSync(file, 'utf8').trim(); } catch { return ''; }
}

export function loadConfig(env = process.env, overrides = {}) {
  const credentials = env.CREDENTIALS_DIRECTORY ? path.join(env.CREDENTIALS_DIRECTORY, 'upstream-token') : '';
  const tokenFile = env.UPSTREAM_TOKEN_FILE || credentials;
  const cookieSecure = bool(env, 'COOKIE_SECURE', true);
  const config = {
    host: env.GATEWAY_HOST || '127.0.0.1',
    port: int(env, 'GATEWAY_PORT', 8090),
    dataDir: env.DATA_DIR || '/var/lib/esportsdata-web',
    staticDir: env.STATIC_DIR || fileURLToPath(new URL('../../../dist/web', import.meta.url)),
    downloadsDir: env.DOWNLOADS_DIR || '',
    upstreamBase: String(env.UPSTREAM_BASE || 'http://127.0.0.1:80').replace(/\/+$/, ''),
    upstreamToken: tokenFile ? readSecret(tokenFile) : '',
    publicOrigin: String(env.PUBLIC_ORIGIN || 'https://esportsdata.online').replace(/\/+$/, ''),
    // Origins of the desktop app's bundled frontend (Tauri 2: tauri://localhost on macOS/Linux, http(s)://tauri.localhost on Windows).
    appOrigins: list(env, 'APP_ORIGINS', 'tauri://localhost,http://tauri.localhost,https://tauri.localhost'),
    cookieSecure,
    // __Host- cookies are pinned to this exact host, Path=/ and Secure: no subdomain can set or read them.
    cookieName: cookieSecure ? '__Host-eds_session' : 'eds_session',
    sessionIdleMs: int(env, 'SESSION_IDLE_DAYS', 30, 1) * DAY,
    sessionMaxMs: int(env, 'SESSION_MAX_DAYS', 90, 1) * DAY,
    adminSessionMaxMs: int(env, 'ADMIN_SESSION_MAX_DAYS', 7, 1) * DAY,
    // cloudflared is the only client of the gateway (it listens on loopback), so CF-Connecting-IP can be trusted.
    trustCloudflare: bool(env, 'TRUST_CLOUDFLARE_HEADERS', true),
    directorySyncMs: int(env, 'DIRECTORY_SYNC_MS', 15_000, 500),
    sweepMs: int(env, 'SESSION_SWEEP_MS', 15_000, 200),
    upstreamTimeoutMs: int(env, 'UPSTREAM_TIMEOUT_MS', 40_000, 1000),
    verifyFailuresPerWindow: int(env, 'VERIFY_FAILURES_PER_WINDOW', 10, 1),
    verifyWindowMs: int(env, 'VERIFY_WINDOW_MS', 15 * 60_000, 1000),
    verifyGlobalPerMinute: int(env, 'VERIFY_GLOBAL_PER_MINUTE', 120, 1),
    apiRequestsPerMinute: int(env, 'API_REQUESTS_PER_MINUTE', 1200, 10),
    detailStreamsPerSession: int(env, 'DETAIL_STREAMS_PER_SESSION', 4, 1),
    feedLingerMs: int(env, 'FEED_LINGER_MS', 30_000, 0),
    hsts: bool(env, 'HSTS', cookieSecure),
    ...overrides,
  };
  if (overrides.cookieSecure !== undefined && overrides.cookieName === undefined) config.cookieName = overrides.cookieSecure ? '__Host-eds_session' : 'eds_session';
  return config;
}
