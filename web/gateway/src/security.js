// Response hardening, client metadata, origin checks and rate limits.

// Team logo CDNs the UI may load directly (extension/logo-resolver.js allowedRemote) - images only.
const LOGO_HOSTS = ['https://v2l.traincdn.com', 'https://cdn.cross.bet', 'https://hawk.live', 'https://cdn.gin.bet'];

export const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  // The UI sets inline style attributes (widths, colours from data); no inline <style>/<script> is executed.
  "style-src 'self' 'unsafe-inline'",
  `img-src 'self' data: blob: ${LOGO_HOSTS.join(' ')}`,
  "font-src 'self' data:",
  "connect-src 'self'",
  "worker-src 'self' blob:",
  "frame-src 'none'",
  "frame-ancestors 'none'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "manifest-src 'self'",
].join('; ');

export function securityHeaders(res, { hsts = false, html = false } = {}) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=()');
  if (hsts) res.setHeader('Strict-Transport-Security', 'max-age=31536000');
  if (html) {
    res.setHeader('Content-Security-Policy', CSP);
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  }
}

// ------------------------------------------------------------------------------------------------ client info ----
export function clientAddress(req, trustCloudflare) {
  const cf = trustCloudflare ? String(req.headers['cf-connecting-ip'] || '').trim() : '';
  return cf || String(req.socket?.remoteAddress || '').replace(/^::ffff:/, '');
}
// Stored for administrators as a network, not an address: IPv4 /24, IPv6 /48.
export function networkOf(address) {
  const a = String(address || '');
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.\d{1,3}$/.exec(a);
  if (v4) return `${v4[1]}.${v4[2]}.${v4[3]}.0/24`;
  if (a.includes(':')) {
    const parts = a.split('::')[0].split(':').filter(Boolean).slice(0, 3);
    while (parts.length < 3) parts.push('0');
    return parts.join(':') + '::/48';
  }
  return '';
}
export function countryOf(req, trustCloudflare) {
  const c = trustCloudflare ? String(req.headers['cf-ipcountry'] || '').toUpperCase() : '';
  return /^[A-Z]{2}$/.test(c) && c !== 'XX' && c !== 'T1' ? c : '';
}

// A short, non-identifying description of the client: "Chrome 141", "Windows". The full User-Agent is not stored.
export function describeClient(req, clientType) {
  const ua = String(req.headers['user-agent'] || '').slice(0, 512);
  const hint = String(req.headers['sec-ch-ua-platform'] || '').replace(/"/g, '');
  let platform = '';
  if (/^(Windows|macOS|Linux|Android|iOS|Chrome OS|ChromeOS)$/i.test(hint)) platform = hint.replace(/^Chrome ?OS$/i, 'ChromeOS');
  else if (/Android/i.test(ua)) platform = 'Android';
  else if (/iPhone|iPad|iPod/i.test(ua)) platform = 'iOS';
  else if (/Windows/i.test(ua)) platform = 'Windows';
  else if (/Mac OS X|Macintosh/i.test(ua)) platform = 'macOS';
  else if (/CrOS/i.test(ua)) platform = 'ChromeOS';
  else if (/Linux/i.test(ua)) platform = 'Linux';
  const m = (re) => re.exec(ua)?.[1]?.split('.')[0] || '';
  let browser = '';
  if (/YaBrowser\/(\d+)/.test(ua)) browser = 'Yandex ' + m(/YaBrowser\/(\d+)/);
  else if (/Edg(?:A|iOS)?\/(\d+)/.test(ua)) browser = 'Edge ' + m(/Edg(?:A|iOS)?\/(\d+)/);
  else if (/OPR\/(\d+)/.test(ua)) browser = 'Opera ' + m(/OPR\/(\d+)/);
  else if (/Firefox\/(\d+)/.test(ua)) browser = 'Firefox ' + m(/Firefox\/(\d+)/);
  else if (/Chrome\/(\d+)/.test(ua)) browser = 'Chrome ' + m(/Chrome\/(\d+)/);
  else if (/Version\/(\d+).*Safari/.test(ua)) browser = 'Safari ' + m(/Version\/(\d+)/);
  if (clientType === 'tauri') browser = 'Desktop app' + (browser ? ` (${browser.split(' ')[0] === 'Edge' ? 'WebView2' : 'WebView'})` : '');
  return { platform: platform || 'Unknown', userAgentSummary: [browser || 'Unknown browser', platform].filter(Boolean).join(' · ') };
}

// ------------------------------------------------------------------------------------------------ origins --------
export function originAllowed(req, config) {
  const origin = String(req.headers.origin || '');
  if (origin) return origin === config.publicOrigin || config.appOrigins.includes(origin);
  // No Origin header: a same-origin navigation/GET or a non-browser client. State-changing browser requests always
  // carry Origin, so for them a missing header is refused by the caller; Sec-Fetch-Site is a second signal.
  const site = String(req.headers['sec-fetch-site'] || '');
  return !site || site === 'same-origin' || site === 'none';
}
export const isAppOrigin = (req, config) => config.appOrigins.includes(String(req.headers.origin || ''));

// Cookie-authenticated requests that change state must come from the site itself (CSRF): Origin must match.
export function sameSiteWrite(req, config) {
  const origin = String(req.headers.origin || '');
  if (origin) return origin === config.publicOrigin || config.appOrigins.includes(origin);
  const site = String(req.headers['sec-fetch-site'] || '');
  return site === 'same-origin';
}

// CORS only for the desktop app's bundled frontend; the website itself is same-origin and needs none.
export function applyCors(req, res, config) {
  if (!isAppOrigin(req, config)) return false;
  res.setHeader('Access-Control-Allow-Origin', req.headers.origin);
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Expose-Headers', 'ETag, Retry-After');
  return true;
}

// ------------------------------------------------------------------------------------------------ rate limits ----
export class SlidingCounter {
  constructor({ windowMs, limit, max = 50_000, clock = Date.now }) { Object.assign(this, { windowMs, limit, max, clock }); this.hits = new Map(); }
  count(key) { const now = this.clock(), list = (this.hits.get(key) || []).filter((t) => now - t < this.windowMs); if (list.length) this.hits.set(key, list); else this.hits.delete(key); return list.length; }
  blocked(key) { return this.count(key) >= this.limit; }
  retryAfter(key) { const list = this.hits.get(key) || []; return list.length ? Math.max(1, Math.ceil((list[0] + this.windowMs - this.clock()) / 1000)) : 1; }
  add(key) {
    const now = this.clock(), list = (this.hits.get(key) || []).filter((t) => now - t < this.windowMs);
    list.push(now); this.hits.set(key, list);
    if (this.hits.size > this.max) this.hits.delete(this.hits.keys().next().value);
    return list.length;
  }
  reset(key) { this.hits.delete(key); }
}

// ------------------------------------------------------------------------------------------------ cookies --------
export function readCookie(req, name) {
  const header = String(req.headers.cookie || '');
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return '';
}
export function sessionCookie(config, token, maxAgeSeconds) {
  return [`${config.cookieName}=${token}`, 'Path=/', `Max-Age=${Math.max(0, Math.floor(maxAgeSeconds))}`, 'HttpOnly', 'SameSite=Lax', config.cookieSecure ? 'Secure' : ''].filter(Boolean).join('; ');
}
export const clearCookie = (config) => sessionCookie(config, '', 0);
