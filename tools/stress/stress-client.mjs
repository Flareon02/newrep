// Load client for stress-server.mjs (run it on another CPU: taskset -c 1). Simulates extension users at once:
// feed SSE streams, LIVE polling (meta + full on change), event detail, history pages and Timeline scrubbing over
// real journal events of the database copy. Prints per-endpoint latency percentiles every 60 s and a final summary.
//
//   BASE=http://127.0.0.1:18900 API_TOKEN=… MINUTES=30 TIMELINE_KEYS='ggbet:…|astek:…,fonbet:…' node tools/stress/stress-client.mjs
const BASE = process.env.BASE || 'http://127.0.0.1:18900', TOKEN = process.env.API_TOKEN || 'stress-token-0123456789abcdef';
const MINUTES = Number(process.env.MINUTES || 30), SSE = Number(process.env.SSE || 15), SCRUBBERS = Number(process.env.SCRUBBERS || 3);
const TIMELINE = String(process.env.TIMELINE_KEYS || '').split('|').filter(Boolean).map((x) => x.split(','));
const H = { authorization: 'Bearer ' + TOKEN, 'accept-encoding': 'gzip' };
const stats = new Map(), errors = new Map();
const WARMUP_MS = Number(process.env.WARMUP_MS ?? 30000), started = Date.now();
const rec = (name, ms, ok = true) => { if (Date.now() - started < WARMUP_MS) return; const s = stats.get(name) || []; s.push(ms); stats.set(name, s); if (!ok) errors.set(name, (errors.get(name) || 0) + 1); };
const pct = (a, p) => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); return Math.round(s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]); };
async function get(name, path, timeout = 20000) {
  const t = performance.now();
  try { const r = await fetch(BASE + path, { headers: H, signal: AbortSignal.timeout(timeout) }); const body = await r.arrayBuffer(); rec(name, performance.now() - t, r.ok || r.status === 304); return r.ok ? JSON.parse(Buffer.from(body).toString() || 'null') : null; }
  catch { rec(name, performance.now() - t, false); return null; }
}
const end = Date.now() + MINUTES * 60000;
const running = () => Date.now() < end;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let sseEvents = 0, sseBytes = 0;
async function sse(i) {
  while (running()) {
    try {
      const ctl = new AbortController(); setTimeout(() => ctl.abort(), Math.max(1000, end - Date.now()));
      const r = await fetch(`${BASE}/api/feed-stream?modes=live,prematch,results,history,leagues&thin=1&provider=ggbet`, { headers: { ...H, accept: 'text/event-stream' }, signal: ctl.signal });
      const reader = r.body.getReader();
      for (;;) { const { value, done } = await reader.read(); if (done) break; sseBytes += value.length; sseEvents += (Buffer.from(value).toString().match(/^event: /gm) || []).length; }
    } catch {}
    await sleep(500 + i * 10);
  }
}
async function livePoller() {
  let rev = '';
  while (running()) {
    const meta = await get('live meta', '/api/ui/live?meta=1&thin=1&provider=ggbet', 8000);
    if (meta && meta.revision !== rev) { rev = meta.revision; await get('live full', '/api/ui/live?compact=1&thin=1&provider=ggbet', 10000); }
    await sleep(2000);
  }
}
let liveIds = [];
async function detailUser() {
  while (running()) {
    if (!liveIds.length) { const live = await get('live full', '/api/ui/live?compact=1&thin=1&provider=ggbet', 10000); liveIds = (live?.events || []).map((e) => e.id); if (!liveIds.length) { await sleep(2000); continue; } }
    const i = Math.floor(Math.random() * 40);
    await get('event-detail', `/api/ui/event-detail?view=live&id=${encodeURIComponent(liveIds[Math.floor(Math.random() * liveIds.length)])}&provider=ggbet`, 15000);
    await get('history page', `/api/events/astek:${900000 + i}/history?limit=100`, 15000);
    await sleep(5000);
  }
}
async function scrubber(k) {
  if (!TIMELINE.length) return;
  const keys = TIMELINE[k % TIMELINE.length], ids = encodeURIComponent(keys.join(','));
  const meta = await get('timeline meta', `/api/events/${encodeURIComponent(keys[0])}/timeline/meta?ids=${ids}`, 30000);
  if (!meta?.from) return;
  let n = 0;
  while (running()) {
    const at = Math.round(meta.from + Math.random() * (meta.to - meta.from));
    await get('timeline state-at', `/api/events/${encodeURIComponent(keys[0])}/state-at?ids=${ids}&at=${at}`, 30000);
    if (++n % 5 === 0) await get('timeline range', `/api/events/${encodeURIComponent(keys[0])}/timeline?ids=${ids}&from=${at - 180000}&to=${at + 420000}&limit=300`, 30000);
    await sleep(700);
  }
}
function report(final = false) {
  const rows = {};
  for (const [name, a] of stats) rows[name] = { n: a.length, p50: pct(a, 50), p95: pct(a, 95), p99: pct(a, 99), max: Math.round(Math.max(...a)), errors: errors.get(name) || 0 };
  console.log(JSON.stringify({ [final ? 'final' : 'progress']: true, minutes: +((MINUTES * 60000 - (end - Date.now())) / 60000).toFixed(1), sseEvents, sseKB: Math.round(sseBytes / 1024), endpoints: rows }));
}
const timer = setInterval(report, 60000);
await Promise.all([...Array.from({ length: SSE }, (_, i) => sse(i)), livePoller(), livePoller(), detailUser(), detailUser(), ...Array.from({ length: SCRUBBERS }, (_, k) => scrubber(k))]);
clearInterval(timer);
report(true);
