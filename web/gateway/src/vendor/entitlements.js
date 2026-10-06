// Server-side capabilities ("entitlements"): who may see which section, bookmaker and data. The client only mirrors
// them to hide what it cannot use; every request is authorized here, and data of a bookmaker a user may not see never
// leaves the server (REST, SSE, full markets).
//
// Model: explicit allow. A user starts with nothing; a capability that is not granted is denied. The holder of the
// server's API_TOKEN is the built-in administrator (all capabilities, cannot be edited or locked out). Users get their
// own tokens from the admin panel; only a SHA-256 of a token is stored.
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
// [gateway] vendored from server/src/entitlements.js by web/gateway/scripts/vendor-entitlements.mjs - do not edit.
const readJson = async () => { throw new Error('UserStore file storage is not available in the gateway'); };
const writeJson = readJson;

export const CAPABILITIES = Object.freeze([
  { key: 'live.view', group: 'main', label: 'LIVE' },
  { key: 'prematch.view', group: 'main', label: 'Линия' },
  { key: 'results.view', group: 'main', label: 'Результаты' },
  { key: 'compare.view', group: 'main', label: 'Сравнение' },
  { key: 'history.view', group: 'main', label: 'История' },
  { key: 'provider.astek', group: 'providers', label: 'AstekBet' },
  { key: 'provider.fonbet', group: 'providers', label: 'Fonbet' },
  { key: 'provider.pinnacle', group: 'providers', label: 'Pinnacle' },
  { key: 'provider.ggbet', group: 'providers', label: 'GGBET' },
  { key: 'provider.databet', group: 'providers', label: 'DataBet' },
  { key: 'odds.live', group: 'data', label: 'Коэффициенты LIVE' },
  { key: 'odds.prematch', group: 'data', label: 'Коэффициенты линии' },
  { key: 'odds.fullMarkets', group: 'data', label: 'Все рынки матча' },
  { key: 'odds.history', group: 'data', label: 'История коэффициентов' },
  { key: 'scores.history', group: 'data', label: 'История счёта' },
  { key: 'statistics.view', group: 'data', label: 'Статистика матчей (CS2, Dota 2)' },
  { key: 'compare.arbitrage', group: 'tools', label: 'Вилки в сравнении' },
  { key: 'compare.schedule', group: 'tools', label: 'Сравнение расписания из файла' },
  { key: 'tools.generator', group: 'tools', label: 'Генератор коэффициентов' },
  { key: 'leagues.manage', group: 'tools', label: 'Редактирование связей лиг' },
  { key: 'notifications', group: 'user', label: 'Уведомления' },
  { key: 'favorites', group: 'user', label: 'Избранное' },
  { key: 'admin.panel', group: 'admin', label: 'Админ-панель' },
  { key: 'admin.diagnostics', group: 'admin', label: 'Диагностика сервера' },
  { key: 'admin.users', group: 'admin', label: 'Управление пользователями' },
]);
export const CAPABILITY_KEYS = Object.freeze(CAPABILITIES.map((c) => c.key));
export const CAPABILITY_GROUPS = Object.freeze({ main: 'Разделы', providers: 'Конторы', data: 'Данные', tools: 'Инструменты', user: 'Функции', admin: 'Администрирование' });
const ALL = new Set(CAPABILITY_KEYS);
export const PROVIDERS = Object.freeze(['astek', 'fonbet', 'pinnacle', 'ggbet', 'databet']);

const digest = (value) => createHash('sha256').update(String(value)).digest('hex');
const sameDigest = (a, b) => a.length === b.length && timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
const cleanCaps = (list) => [...new Set((Array.isArray(list) ? list : []).map(String).filter((k) => ALL.has(k)))].sort();
export const newToken = () => 'emu_' + randomBytes(24).toString('hex');

// ------------------------------------------------------------------------------------------------ users ----------
export class UserStore {
  // users.json holds key hashes: owner-only (0600) for the file and its .bak, whatever the service umask is.
  constructor({ read = readJson, write = (file, data) => writeJson(file, data, { mode: 0o600 }), file = 'users.json', now = () => Date.now() } = {}) {
    Object.assign(this, { read, write, file, now, users: [] });
    this.ready = Promise.resolve(this.read(this.file, { users: [] })).then((d) => { this.users = Array.isArray(d?.users) ? d.users : []; }).catch(() => { this.users = []; });
    this.saving = Promise.resolve();
  }
  persist() { const data = { version: 1, users: this.users }; this.saving = this.saving.catch(() => {}).then(() => this.write(this.file, data)); return this.saving; }
  view(u) { return { id: u.id, name: u.name, role: u.role, disabled: !!u.disabled, capabilities: [...u.capabilities], createdAt: u.createdAt, updatedAt: u.updatedAt, tokenUpdatedAt: u.tokenUpdatedAt, keyId: keyIdOf(u.tokenHash) }; }
  list() { return this.users.map((u) => this.view(u)); }
  get(id) { return this.users.find((u) => u.id === String(id)) || null; }
  byToken(token) { const d = digest(token); return this.users.find((u) => u.tokenHash && sameDigest(u.tokenHash, d)) || null; }
  async create({ name, role = 'user' } = {}) {
    const clean = String(name || '').trim().slice(0, 80); if (!clean) throw Object.assign(Error('Укажите имя пользователя'), { status: 400 });
    const token = newToken(), at = this.now();
    // New users have every capability OFF (explicit allow); an administrator grants what they need.
    const user = { id: 'u_' + randomBytes(6).toString('hex'), name: clean, role: role === 'admin' ? 'admin' : 'user', disabled: false, capabilities: [], tokenHash: digest(token), createdAt: at, updatedAt: at, tokenUpdatedAt: at };
    this.users.push(user); await this.persist(); return { user: this.view(user), token };
  }
  async update(id, patch = {}) {
    const u = this.get(id); if (!u) throw Object.assign(Error('Пользователь не найден'), { status: 404 });
    if (patch.name != null) { const name = String(patch.name).trim().slice(0, 80); if (name) u.name = name; }
    if (patch.capabilities != null) u.capabilities = cleanCaps(patch.capabilities);
    if (patch.disabled != null) u.disabled = !!patch.disabled;
    if (patch.role != null) u.role = patch.role === 'admin' ? 'admin' : 'user';
    u.updatedAt = this.now(); await this.persist(); return this.view(u);
  }
  async rotateToken(id) { const u = this.get(id); if (!u) throw Object.assign(Error('Пользователь не найден'), { status: 404 }); const token = newToken(); u.tokenHash = digest(token); u.tokenUpdatedAt = this.now(); await this.persist(); return { user: this.view(u), token }; }
  async remove(id) { const before = this.users.length; this.users = this.users.filter((u) => u.id !== String(id)); if (this.users.length === before) throw Object.assign(Error('Пользователь не найден'), { status: 404 }); await this.persist(); return true; }
}

// ------------------------------------------------------------------------------------------------ principal ------
export function extractRequestToken(req, url) {
  const auth = String(req?.headers?.authorization || ''), bearer = /^Bearer\s+(\S+)$/i.exec(auth);
  const header = bearer ? bearer[1] : String(req?.headers?.['x-api-token'] || '').trim();
  if (header) return header;
  // EventSource cannot send headers: the token may come as a query parameter on stream endpoints only.
  if (url && /^\/api\/(?:pinnacle\/live-stream|statistics\/stream|feed-stream)$/.test(url.pathname)) return String(url.searchParams.get('access_token') || '').trim();
  return '';
}
// keyId: a stable, non-reversible id of the key in use (changes when the key is rotated), so per-user data such as
// settings can be bound to user + key. rev: changes whenever an administrator edits the user.
const keyIdOf = (tokenDigest) => (tokenDigest ? createHash('sha256').update('key:' + tokenDigest).digest('hex').slice(0, 16) : '');
function principal({ id, name, role, caps, anonymous = false, builtin = false, keyId = '', rev = 0 }) {
  const set = new Set(caps);
  const all = PROVIDERS.every((p) => set.has('provider.' + p)) && set.has('odds.live') && set.has('odds.prematch') && set.has('odds.fullMarkets');
  return { id, name, role, anonymous, builtin, caps: set, unrestricted: all, keyId, rev: Number(rev) || 0, sig: role === 'admin' ? 'admin' : [...set].sort().join(',') };
}
export function createAccess({ masterToken = '', users = null, mode = 'auto' } = {}) {
  const master = String(masterToken || '').trim(), masterDigest = master ? digest(master) : '';
  // Without a server token there is no way to administer users: the server runs open (legacy behaviour).
  const enforce = mode === 'open' ? false : !!master;
  async function resolve(req, url) {
    const token = extractRequestToken(req, url);
    if (token && masterDigest && sameDigest(digest(token), masterDigest)) return principal({ id: 'admin', name: 'Администратор', role: 'admin', caps: ALL, builtin: true, keyId: keyIdOf(masterDigest) });
    if (token && users) { await users.ready; const u = users.byToken(token); if (u && !u.disabled) return principal({ id: u.id, name: u.name, role: u.role, caps: u.role === 'admin' ? ALL : u.capabilities, keyId: u.keyId || keyIdOf(u.tokenHash), rev: u.updatedAt }); }
    // Open mode (no server token): everything as before except managing users, which needs an administrator.
    return enforce ? principal({ id: 'anonymous', name: '', role: 'anonymous', caps: [], anonymous: true }) : principal({ id: 'anonymous', name: '', role: 'anonymous', caps: [...ALL].filter((k) => k !== 'admin.users' && k !== 'admin.panel'), anonymous: true });
  }
  return { enforce, resolve, mode: enforce ? 'enforce' : 'open' };
}
export const can = (p, key) => !!p && p.caps.has(key);
export const canAny = (p, keys) => keys.some((k) => can(p, k));

// ------------------------------------------------------------------------------------------------ routes ---------
// Capability a request needs (any one of the list). null = open to everyone (logos, own identity, the bare health).
const VIEW_CAPS = ['live.view', 'prematch.view', 'results.view', 'compare.view', 'history.view'];
export function routeRequirement(method, pathname, params = new URLSearchParams()) {
  const p = pathname;
  if (p === '/' || p === '/health' || p === '/api/me' || p === '/api/me/settings' || p.startsWith('/api/team-logos/')) return null;
  if (p.startsWith('/api/admin/users') || p === '/api/admin/capabilities') return ['admin.users'];
  if (p.startsWith('/api/admin/') || p === '/api/status') return ['admin.diagnostics'];
  if (p === '/api/ui/live' || p === '/api/live' || p.startsWith('/api/live/') || p === '/api/ui/odds-providers' || p === '/api/ui/odds-watch') return p === '/api/live/history' || p === '/api/live/past' ? ['live.view', 'history.view'] : ['live.view'];
  if (p === '/api/ui/prematch' || p === '/api/prematch' || p === '/api/prematch/history') return ['prematch.view'];
  if (p === '/api/prematch/odds') return ['odds.prematch'];
  if (p === '/api/ui/results') return ['results.view'];
  if (p === '/api/ui/history') return ['history.view'];
  if (p === '/api/prematch/compare') return ['compare.schedule'];
  if (p === '/api/ui/event-detail') return params.get('view') === 'prematch' ? ['prematch.view', 'compare.view'] : params.get('view') === 'results' ? ['results.view'] : ['live.view', 'compare.view'];
  if (p === '/api/ui/full-markets') return ['odds.fullMarkets'];
  if (p === '/api/astek/markets' || p === '/api/pinnacle/live-markets' || p === '/api/pinnacle/live-stream') return ['odds.fullMarkets'];
  if (p === '/api/odds/timeline' || p === '/api/odds/history') return ['odds.history'];
  if (/^\/api\/events\/[^/]+\/history$/.test(p)) return ['odds.history','scores.history'];
  if (p === '/api/score-history') return ['scores.history'];
  if (p.startsWith('/api/statistics/') || p === '/api/cs2/match' || p.startsWith('/api/hltv/')) return ['statistics.view', 'tools.generator'];
  if (p === '/api/odds/generate' || p === '/api/odds/job' || p === '/api/odds/manual' || p === '/api/live-generator') return ['tools.generator'];
  if (p === '/api/league-links/challenge' || p === '/api/league-links/publish' || (p === '/api/league-links' && method === 'POST')) return ['leagues.manage'];
  if (p === '/api/league-links' || p === '/api/leagues' || p === '/api/ui/leagues') return VIEW_CAPS;
  if (p === '/api/feed-stream') return VIEW_CAPS;
  return ['admin.diagnostics'];   // anything not listed is closed by default
}
// The provider a provider-specific endpoint serves (its data is refused when that bookmaker is not allowed).
export function routeProvider(pathname) {
  const m = /^\/api\/live\/(astek|fonbet|ggbet|databet)$/.exec(pathname); if (m) return m[1];
  if (pathname === '/api/astek/markets') return 'astek';
  if (pathname.startsWith('/api/pinnacle/')) return 'pinnacle';
  if (pathname === '/api/ui/full-markets') return 'ggbet';
  return '';
}

// ------------------------------------------------------------------------------------------------ data filter ----
const oddsCapFor = (mode) => (mode === 'prematch' ? 'odds.prematch' : 'odds.live');
const SAFE_PROVIDER_ERROR = 'Источник временно недоступен';
function scrubRef(ref, p, mode) {
  if (!ref || typeof ref !== 'object') return ref;
  const out = { ...ref };
  if (!can(p, oddsCapFor(mode))) { delete out.odds; delete out.quote; }
  else if (!can(p, 'odds.fullMarkets') && out.odds?.markets?.length > 1) out.odds = { ...out.odds, markets: out.odds.markets.slice(0, 1) };
  return out;
}
function scrubProviders(providers, p, mode = 'live') {
  if (!providers || typeof providers !== 'object') return providers;
  const out = {};
  for (const [key, value] of Object.entries(providers)) {
    if (PROVIDERS.includes(key) && !can(p, 'provider.' + key)) continue;
    // A list under a bookmaker key (league catalog: providers.astek = [leagues]) is that bookmaker's data, already
    // allowed above. It must stay an array: spreading it into a status object turned it into {"0":…} and broke the
    // «Лиги и связи» screen for every user without admin.diagnostics.
    if (Array.isArray(value)) { out[key] = value; continue; }
    let row = value;
    if (row && typeof row === 'object') for (const list of ['events', 'logicalEvents']) if (Array.isArray(row[list])) row = { ...row, [list]: row[list].map((e) => scrubEvent(e, p, mode)).filter(Boolean) };
    if (row && typeof row === 'object' && !can(p, 'admin.diagnostics')) {
      const { lastError, lastHttpStatus, lastUrl, error, ...rest } = row;
      out[key] = { ...rest, ...((lastError || error || Number(lastHttpStatus) >= 400) ? { lastError: SAFE_PROVIDER_ERROR } : {}) };
    } else out[key] = row;
  }
  return out;
}
const allowedSource = (p, source) => !PROVIDERS.includes(source) || can(p, 'provider.' + source);
// Per-provider lists an event carries besides its refs (league names, aliases, ui.providers...).
function scrubLists(out, p) {
  for (const [key, value] of Object.entries(out)) {
    if (key === 'sourceRefs' || !Array.isArray(value)) continue;
    if (value.some((x) => x && typeof x === 'object' && 'source' in x)) out[key] = value.filter((x) => !(x && typeof x === 'object') || allowedSource(p, x.source));
    else if (value.some((x) => typeof x === 'string' && /^(astek|fonbet|pinnacle|ggbet|databet)[:-]/.test(x))) out[key] = value.filter((x) => typeof x !== 'string' || !/^(astek|fonbet|pinnacle|ggbet|databet)[:-]/.test(x) || allowedSource(p, x.split(/[:-]/)[0]));
  }
  if (out.ui && Array.isArray(out.ui.providers)) out.ui = { ...out.ui, providers: out.ui.providers.filter((x) => allowedSource(p, x)), sourceCount: out.sourceRefs ? out.sourceRefs.length : out.ui.sourceCount };
  return out;
}
function scrubEvent(e, p, mode) {
  if (!e || typeof e !== 'object') return e;
  if (Array.isArray(e.sourceRefs)) {
    const sourceRefs = e.sourceRefs.filter((r) => allowedSource(p, r?.source)).map((r) => scrubRef(r, p, mode));
    if (!sourceRefs.length) return null;
    const out = scrubLists({ ...e, sourceRefs }, p);
    if (!can(p, oddsCapFor(mode))) { delete out.odds; delete out.quote; }
    return out;
  }
  if (PROVIDERS.includes(e.source) && !can(p, 'provider.' + e.source)) return null;
  return scrubRef(e, p, mode);
}
// Applies the principal's provider and odds capabilities to any API payload that carries events/providers.
export function filterForPrincipal(p, data, { mode = 'live' } = {}) {
  if (!p || p.role === 'admin' || data == null || typeof data !== 'object' || Array.isArray(data)) return data;
  if (p.unrestricted && can(p, 'admin.diagnostics')) return data;
  const out = { ...data };
  for (const key of ['events', 'upsert', 'matches', 'onlyAstek', 'missingInput']) if (Array.isArray(out[key])) out[key] = out[key].map((e) => scrubEvent(e, p, mode)).filter(Boolean);
  if (out.event && typeof out.event === 'object') out.event = scrubEvent(out.event, p, mode);
  if (out.providers) out.providers = scrubProviders(out.providers, p, mode);
  if (out.marketDetailErrors && !can(p, 'admin.diagnostics')) out.marketDetailErrors = Object.fromEntries(Object.entries(out.marketDetailErrors).filter(([k]) => !PROVIDERS.includes(k) || can(p, 'provider.' + k)).map(([k]) => [k, SAFE_PROVIDER_ERROR]));
  return out;
}
// SSE payloads (hello, feed patches, invalidations): bookmaker patches and feed metadata through the same rules.
export function filterSsePayload(p, payload, mode = 'live') {
  if (!p || p.role === 'admin' || !payload || typeof payload !== 'object') return payload;
  const out = { ...payload };
  if (Array.isArray(out.patches)) out.patches = filterPatches(p, out.patches, mode);
  if (out.meta?.providers) out.meta = { ...out.meta, providers: scrubProviders(out.meta.providers, p, mode) };
  if (out.feeds) out.feeds = Object.fromEntries(Object.entries(out.feeds).map(([k, v]) => [k, v?.providers ? { ...v, providers: scrubProviders(v.providers, p, k === 'prematch' ? 'prematch' : 'live') } : v]));
  return out;
}
// Thin SSE patches: drop other bookmakers' patches; without the odds capability drop prices from the rest.
export function filterPatches(p, patches = [], mode = 'live') {
  if (!p || p.role === 'admin' || (p.unrestricted && can(p, 'admin.diagnostics'))) return patches;
  const odds = can(p, oddsCapFor(mode));
  return (patches || []).filter((x) => !PROVIDERS.includes(x?.source) || can(p, 'provider.' + x.source)).map((x) => {
    if (odds) return x;
    const { quote, odds: _o, ...rest } = x; return { ...rest, fields: (x.fields || []).filter((f) => f !== 'quote' && f !== 'odds'), detailChanged: false };
  });
}
