// GGBET forensic log: sanitized NDJSON with hourly files, 24 h rolling retention and a disk guard; incidents as separate
// JSON files. Everything is redacted BEFORE it is written (sanitize): no token/JWE value, cookie value, Authorization,
// password, private key or registered secret ever reaches the disk.
//
//   <dir>/events/YYYYMMDDTHH.ndjson   current hour (completed hours are gzipped: YYYYMMDDTHH.ndjson.gz)
//   <dir>/incidents/incident-<UTC>-<id>.json
//   <dir>/state.json                   current egress/session/guard state (ggbet-supervisor.js, read by the CLI)
// Directories 0700, files 0600 (owner = the service user).
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { randomBytes } from 'node:crypto';

const HOUR = 3600000;
// Keys whose VALUES are never persisted (case-insensitive substring match on the key name).
const SECRET_KEY = /(token|cookie|authorization|password|passwd|secret|private.?key|presharedkey|credential|api.?key)/i;
// JWT/JWE-looking strings (base64url header starting with {" = eyJ) anywhere inside a value.
const JWT = /eyJ[A-Za-z0-9_-]{8,}(?:\.[A-Za-z0-9_-]*){1,4}/g;
// WireGuard keys are 44-char base64 ending in '='; never expected in GGBET data.
const WG_KEY = /\b[A-Za-z0-9+/]{42}[AEIMQUYcgkosw048]=(?![A-Za-z0-9+/=])/g;
const MAX_STRING = 4096;

let registered = [];
// Exact strings (e.g. API_TOKEN, proxy credentials) that must be replaced wherever they appear.
export function registerSecret(value) { const v = String(value || ''); if (v.length >= 8 && !registered.includes(v)) registered = [...registered, v].sort((a, b) => b.length - a.length); }
export function clearRegisteredSecretsForTests() { registered = []; }

function cleanString(value) {
  let out = String(value);
  for (const secret of registered) if (out.includes(secret)) out = out.split(secret).join('<redacted>');
  out = out.replace(JWT, '<redacted:jwt>').replace(WG_KEY, '<redacted:key>');
  return out.length > MAX_STRING ? out.slice(0, MAX_STRING) + `…(+${out.length - MAX_STRING})` : out;
}
// Deep copy with secrets removed. `allow` lists keys that are safe although they match SECRET_KEY (e.g. cookieNames).
export function sanitize(value, { allow = ['cookieNames', 'setCookie', 'cookieOnRedirect', 'tokenExtraction', 'cookieSent'] } = {}, depth = 0) {
  if (value == null || typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'string') return cleanString(value);
  if (depth > 12) return '<depth>';
  if (Array.isArray(value)) return value.slice(0, 500).map((v) => sanitize(v, { allow }, depth + 1));
  if (typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = SECRET_KEY.test(k) && !allow.includes(k) ? (v == null || v === '' ? v : '<redacted>') : sanitize(v, { allow }, depth + 1);
    return out;
  }
  return cleanString(value);
}

const hourKey = (ms) => new Date(Math.floor(ms / HOUR) * HOUR).toISOString().slice(0, 13).replace(/[-:]/g, '');
const hourOf = (name) => { const m = /^(\d{8})T(\d{2})\.ndjson/.exec(name); return m ? Date.parse(`${m[1].slice(0, 4)}-${m[1].slice(4, 6)}-${m[1].slice(6, 8)}T${m[2]}:00:00Z`) : NaN; };

export class ForensicLog {
  constructor({ dir, now = () => Date.now(), retentionMs = 24 * HOUR, maxBytes = 2 * 1024 ** 3, minFreeMiB = 4096, raw = false, statfs = (p) => fs.statfsSync(p) } = {}) {
    Object.assign(this, { dir, now, retentionMs, maxBytes, minFreeMiB, rawRequested: raw, raw, statfs });
    this.eventsDir = path.join(dir, 'events'); this.incidentsDir = path.join(dir, 'incidents');
    for (const d of [dir, this.eventsDir, this.incidentsDir]) { fs.mkdirSync(d, { recursive: true, mode: 0o700 }); try { fs.chmodSync(d, 0o700); } catch {} }
    this.currentHour = ''; this.writes = 0; this.dropped = 0; this.guard = { level: 'ok', freeMiB: null, bytes: 0, checkedAt: 0 };
    this.maintain(true);
  }
  file(hour) { return path.join(this.eventsDir, `${hour}.ndjson`); }
  // kind: transition | session | bootstrap | ws | pricing | guard | incident | egress | raw | error ...
  write(kind, record = {}) {
    if (kind === 'raw' && !this.raw) { this.dropped++; return false; }
    const at = this.now(), hour = hourKey(at);
    if (hour !== this.currentHour) { const previous = this.currentHour; this.currentHour = hour; if (previous) this.compress(previous); this.maintain(true); }
    else if (++this.writes % 200 === 0 || at - this.guard.checkedAt > 60000) this.maintain(false);
    const line = JSON.stringify(sanitize({ at: new Date(at).toISOString(), kind, ...record })) + '\n';
    try { fs.appendFileSync(this.file(hour), line, { mode: 0o600 }); return true; } catch { this.dropped++; return false; }
  }
  incident(record = {}) {
    const at = this.now(), id = record.incidentId || `${new Date(at).toISOString().replace(/[-:.]/g, '').slice(0, 15)}Z-${randomBytes(3).toString('hex')}`;
    const body = sanitize({ incidentId: id, at: new Date(at).toISOString(), ...record });
    const file = path.join(this.incidentsDir, `incident-${id}.json`);
    try { fs.writeFileSync(file, JSON.stringify(body, null, 1), { mode: 0o600 }); } catch {}
    this.write('incident', { incidentId: id, classification: record.classification, decision: record.decision });
    return id;
  }
  compress(hour) {
    const src = this.file(hour); if (!fs.existsSync(src)) return;
    try { fs.writeFileSync(src + '.gz', zlib.gzipSync(fs.readFileSync(src)), { mode: 0o600 }); fs.unlinkSync(src); } catch {}
  }
  list() {
    let names = []; try { names = fs.readdirSync(this.eventsDir); } catch {}
    return names.filter((n) => /^\d{8}T\d{2}\.ndjson(\.gz)?$/.test(n)).map((n) => { const p = path.join(this.eventsDir, n); let size = 0; try { size = fs.statSync(p).size; } catch {} return { name: n, path: p, hour: hourOf(n), size }; }).sort((a, b) => a.hour - b.hour);
  }
  // Retention, size cap (oldest hour first, never the current one), free-disk guard (raw logging off first).
  maintain(force = false) {
    const now = this.now(); this.guard.checkedAt = now;
    let files = this.list();
    for (const f of files) if (f.hour < now - this.retentionMs) { try { fs.unlinkSync(f.path); } catch {} }
    files = this.list();
    let total = files.reduce((n, f) => n + f.size, 0);
    for (const f of files) { if (total <= this.maxBytes) break; if (hourKey(f.hour) === this.currentHour) continue; try { fs.unlinkSync(f.path); total -= f.size; } catch {} }
    let incidents = []; try { incidents = fs.readdirSync(this.incidentsDir).map((n) => path.join(this.incidentsDir, n)); } catch {}
    for (const p of incidents) { try { if (fs.statSync(p).mtimeMs < now - 7 * 24 * HOUR) fs.unlinkSync(p); } catch {} }
    let freeMiB = null; try { const s = this.statfs(this.dir); freeMiB = Math.floor((Number(s.bavail) * Number(s.bsize)) / 1048576); } catch {}
    const level = freeMiB == null ? 'unknown' : freeMiB < this.minFreeMiB / 4 ? 'critical' : freeMiB < this.minFreeMiB ? 'low' : 'ok';
    // Low disk: raw messages stop first; critical: only incidents/state (events are still small transitions).
    this.raw = this.rawRequested && level === 'ok';
    this.guard = { level, freeMiB, bytes: total, checkedAt: now, raw: this.raw };
    return this.guard;
  }
  status() { return { dir: this.dir, retentionHours: this.retentionMs / HOUR, maxBytes: this.maxBytes, minFreeMiB: this.minFreeMiB, rawRequested: this.rawRequested, ...this.guard, files: this.list().length, dropped: this.dropped }; }
}
