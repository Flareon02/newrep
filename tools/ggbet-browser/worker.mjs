#!/usr/bin/env node
// GGBET Firefox headless browser worker (sidecar of esports-monitor).
// Runs INSIDE the fail-closed namespace ggbet-browser (ops/staging/ggbet-browser-netns.sh) as an unprivileged user:
// one real Firefox (--headless) controlled over WebDriver BiDi (loopback of the namespace only), one discovery tab and
// at most GGBET_BROWSER_MAX_PAGES (3) LIVE match tabs (CS / Dota 2 / LoL, selected by core.selectEvents from GG.BET's own
// ranking) with the "All" market tab. Every GG.BET request is made by Firefox itself; this process never contacts GG.BET
// (its only own request is the Mullvad exit check). Market data comes from the page's own betting WebSocket
// (preload.mjs) and leaves only as parsed data over the local Unix socket. No cookie/token/JWE leaves the browser.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { Bidi } from './bidi.mjs';
import { PRELOAD } from './preload.mjs';
import { serveIpc } from './ipc.mjs';
import { MarketStore, Discovery, config, pageState, publish, listRows, selectEvents, walk, SPORT_LABEL, TARGET_SPORTS } from './core.mjs';
import { ForensicLog } from '../../server/src/ggbet-forensics.js';

process.umask(0o077);
const cfg = config(), env = process.env;
const RUN = env.GGBET_BROWSER_RUN_DIR || '/run/ggbet-browser', STATE = env.GGBET_BROWSER_STATE_DIR || '/var/lib/esports-monitor-ggbet-browser';
const SOCK = path.join(RUN, 'data.sock'), PORT = Number(env.GGBET_BROWSER_BIDI_PORT || 9333), ORIGIN = 'https://gg.bet';
const EXPECT = env.GGBET_BROWSER_EXPECTED_EXIT || ''; // Mullvad exit hostname that must be seen (fail closed otherwise)
const BLOCK_HOSTS = (env.GGBET_BROWSER_BLOCK_HOSTS || 'www.googletagmanager.com,www.google-analytics.com,region1.google-analytics.com,analytics.google.com,stats.g.doubleclick.net,ad.doubleclick.net,googleads.g.doubleclick.net,adservice.google.com,www.google.com,static.hotjar.com,script.hotjar.com,vc.hotjar.io,a.mgid.com,mc.yandex.ru,connect.facebook.net').split(',').filter(Boolean);
fs.mkdirSync(STATE, { recursive: true, mode: 0o700 });
// First GG.BET use of this exit survives worker restarts (longevity is measured from it); a different exit starts fresh.
const FIRST_USE = path.join(STATE, 'vpn-first-ggbet-use.json');
const firstUseOf = (hostname) => { try { const j = JSON.parse(fs.readFileSync(FIRST_USE, 'utf8')); return j.hostname && j.hostname === hostname ? j.at : null; } catch { return null; } };
const log = new ForensicLog({ dir: path.join(STATE, 'log'), bufferMs: 1000, maxBytes: 1024 ** 3, minFreeMiB: 4096 });
const note = (kind, data = {}) => log.write(kind, data);

const S = { vpnState: 'UNKNOWN', vpnExit: null, vpnFails: 0, browser: null, bidi: null, browserStartedAt: 0, browserSessionId: null, restarts: 0, pageRecoveries: 0, discovery: null, disc: new Discovery(), discReq: new Map(), discStep: 0, excluded: new Map(), recreates: new Map(), pages: new Map(), wsFrames: 0, lastWsFrameAt: 0, startedAt: Date.now(), firstGgbetAt: null, stopping: false };
const store = new MarketStore();
const WORKER_ID = `W${process.pid}-${S.startedAt}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- VPN (fail closed) ---------------------------------
async function probeVpn() {
  try {
    const j = await (await fetch('https://am.i.mullvad.net/json', { signal: AbortSignal.timeout(10000) })).json();
    const ok = j.mullvad_exit_ip === true && (!EXPECT || j.mullvad_exit_ip_hostname === EXPECT);
    return { ok, exit: { ip: j.ip, country: j.country, city: j.city, hostname: j.mullvad_exit_ip_hostname, mullvad: j.mullvad_exit_ip } };
  } catch (e) { return { ok: false, error: String(e.message).slice(0, 120) }; }
}
async function vpnTick() {
  const r = await probeVpn();
  if (r.ok) { S.vpnFails = 0; S.vpnExit = r.exit; if (!S.firstGgbetAt) S.firstGgbetAt = firstUseOf(r.exit?.hostname); if (S.vpnState !== 'UP') { note('vpn', { state: 'UP', exit: r.exit }); S.vpnState = 'UP'; } return; }
  if (++S.vpnFails >= 2 && S.vpnState !== 'VPN_DOWN') {
    S.vpnState = 'VPN_DOWN'; note('vpn', { state: 'VPN_DOWN', reason: r.error || `unexpected exit ${JSON.stringify(r.exit)}` });
    await stopBrowser('vpn down'); // publication turns UNAVAILABLE; old prices are never served as fresh
  }
}

// ---------------------------------------------------------------- Firefox ---------------------------------------------
const PREFS = {
  'browser.startup.page': 0, 'browser.startup.homepage': 'about:blank', 'browser.aboutwelcome.enabled': false, 'browser.shell.checkDefaultBrowser': false,
  'datareporting.policy.dataSubmissionPolicyBypassNotification': true, 'datareporting.healthreport.uploadEnabled': false, 'toolkit.telemetry.enabled': false,
  'app.update.auto': false, 'app.update.enabled': false, 'extensions.update.enabled': false, 'browser.safebrowsing.malware.enabled': false, 'browser.safebrowsing.phishing.enabled': false,
  'browser.sessionstore.resume_from_crash': false, 'network.trr.mode': 5,
  // lighter pages: no images, no web fonts, no media autoplay; few content processes
  'permissions.default.image': 2, 'browser.display.use_document_fonts': 0, 'gfx.downloadable_fonts.enabled': false, 'media.autoplay.default': 5,
  'fission.autostart': false, 'dom.ipc.processCount': Number(env.GGBET_BROWSER_CONTENT_PROCESSES || 3), 'browser.cache.disk.enable': false,
};
async function startBrowser() {
  if (S.vpnState !== 'UP') return false;
  const profile = path.join(STATE, `profile-${Date.now()}`);
  for (const d of fs.readdirSync(STATE)) if (d.startsWith('profile-')) fs.rmSync(path.join(STATE, d), { recursive: true, force: true }); // never reuse a session
  fs.mkdirSync(profile, { mode: 0o700 });
  fs.writeFileSync(path.join(profile, 'user.js'), Object.entries(PREFS).map(([k, v]) => `user_pref(${JSON.stringify(k)}, ${JSON.stringify(v)});`).join('\n') + '\n', { mode: 0o600 });
  const ff = spawn('firefox', ['--headless', '--no-remote', '--profile', profile, '--remote-debugging-port', String(PORT), 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'], env: { ...env, MOZ_CRASHREPORTER_DISABLE: '1' } });
  S.browser = ff; S.browserStartedAt = Date.now(); S.browserSessionId = `B${Date.now().toString(36)}`;
  ff.stderr.on('data', () => {}); ff.on('exit', (code, sig) => { note('browser', { event: 'exit', code, sig, sessionId: S.browserSessionId }); if (S.browser === ff) { S.browser = null; S.bidi = null; } });
  for (let i = 0; i < 40 && !S.bidi; i++) { await sleep(500); try { S.bidi = await new Bidi(`ws://127.0.0.1:${PORT}/session`).connect(3000); } catch {} }
  if (!S.bidi) { note('browser', { event: 'bidi-unavailable' }); await stopBrowser('no bidi'); return false; }
  const b = S.bidi; await b.send('session.new', { capabilities: {} });
  b.on('__close', () => { if (S.bidi === b) { S.bidi = null; note('browser', { event: 'bidi-closed' }); } });
  b.on('script.message', onMessage);
  b.on('network.beforeRequestSent', (p) => { if (p.isBlocked) b.send('network.failRequest', { request: p.request.request }).catch(() => {}); });
  await b.send('session.subscribe', { events: ['script.message', 'network.beforeRequestSent', 'browsingContext.contextDestroyed'] });
  if (BLOCK_HOSTS.length) await b.send('network.addIntercept', { phases: ['beforeRequestSent'], urlPatterns: BLOCK_HOSTS.map((h) => ({ type: 'pattern', protocol: 'https', hostname: h })) });
  await b.send('script.addPreloadScript', { functionDeclaration: PRELOAD, arguments: [{ type: 'channel', value: { channel: 'gg' } }] });
  note('browser', { event: 'started', pid: ff.pid, sessionId: S.browserSessionId, headless: true, blockedHosts: BLOCK_HOSTS.length });
  S.discovery = null; S.pages.clear();
  // Reuse the startup about:blank for discovery, so there is no fifth tab.
  const tree = await b.send('browsingContext.getTree');
  S.startupContext = tree.contexts?.[0]?.context || null;
  for (const context of (tree.contexts || []).slice(1)) await b.send('browsingContext.close', { context: context.context });
  return true;
}
async function stopBrowser(reason) {
  const ff = S.browser, b = S.bidi; S.browser = null; S.bidi = null; S.discovery = null; S.sessionFirstGgbetAt = null;
  for (const p of S.pages.values()) p.closedReason = reason;
  S.pages.clear(); store.reset(); S.disc = new Discovery(); S.discReq.clear(); S.selectionReady = false; // new session = clean slate
  try { b?.close(); } catch {}
  if (ff) { try { ff.kill('SIGTERM'); } catch {} await sleep(3000); try { ff.kill('SIGKILL'); } catch {} }
  note('browser', { event: 'stopped', reason });
}

// ---------------------------------------------------------------- tabs ------------------------------------------------
async function navigate(context, url) { return S.bidi.send('browsingContext.navigate', { context, url, wait: 'complete' }, 60000); }
async function call(context, fn) { const r = await S.bidi.send('script.callFunction', { functionDeclaration: fn, target: { context }, awaitPromise: false }, 15000); return r?.result?.value; }
// A normal DOM click on the market-tab button labelled All/Все (the one next to Popular/Популярное).
const CLICK_TAB = (labels) => `() => { const want = ${JSON.stringify(labels)}; const els = [...document.querySelectorAll('button, a, [role="tab"], li, span, div')].filter((e) => want.includes((e.textContent || '').trim()) && e.children.length <= 2 && e.offsetParent !== null);
  const pick = els.find((e) => /Popular|Популярное|Match|Матч/.test(e.parentElement?.textContent || '')) || els[0]; if (!pick) return false; pick.click(); return true; }`;
// One lightweight discovery tab cycles through GG.BET's own listings: each sport's /live page lists that sport's LIVE matches in the
// provider's RANK_RECOMMENDED order; the global /live page lists every LIVE match in the provider's cross-sport order.
const DISCOVERY = [{ path: '/counter-strike/live' }, { path: '/dota2/live' }, { path: '/league-of-legends/live' }, { path: '/live' }];
const DISCOVERY_STEP_MS = Math.max(10000, Number(env.GGBET_BROWSER_DISCOVERY_STEP_MS) || 30000);
async function openDiscovery() {
  const context = S.startupContext || (await S.bidi.send('browsingContext.create', { type: 'tab' })).context;
  S.startupContext = null;
  S.discovery = { context, openedAt: Date.now(), refreshedAt: 0 };
  await refreshDiscovery();
}
async function refreshDiscovery() {
  const d = S.discovery; if (!d) return;
  d.refreshedAt = Date.now(); // a failed refresh (GG.BET unreachable) waits for the next period instead of retrying every tick
  const step = DISCOVERY[S.discStep++ % DISCOVERY.length]; d.path = step.path;
  await navigate(d.context, `${ORIGIN}${step.path}`); await sleep(3000);
  if (step.live) await call(d.context, CLICK_TAB(['Live', 'Лайв'])).catch(() => false);
  d.refreshedAt = Date.now();
  if (!S.sessionFirstGgbetAt) S.sessionFirstGgbetAt = new Date().toISOString();
  if (!S.firstGgbetAt) { S.firstGgbetAt = S.sessionFirstGgbetAt; try { fs.writeFileSync(FIRST_USE, JSON.stringify({ hostname: S.vpnExit?.hostname || null, at: S.firstGgbetAt }), { mode: 0o600 }); } catch {} note('ggbet', { event: 'first-use-of-vpn-for-ggbet', at: S.firstGgbetAt, exit: S.vpnExit }); }
}
async function openPage(c) {
  if (S.pages.size >= cfg.maxPages) return;
  store.events.delete(c.eventId); // a recreated page must receive its own fresh snapshot
  const { context } = await S.bidi.send('browsingContext.create', { type: 'tab' });
  const page = { pageId: `P${randomBytes(3).toString('hex')}`, context, eventId: c.eventId, slug: c.slug, sportId: c.sportId, title: c.title || null, league: c.league || null, sportRank: c.sportRank ?? null, globalRank: c.globalRank ?? null, reason: c.reason || null, selectedAt: c.selectedAt || Date.now(), openedAt: Date.now(), lastWsFrameAt: 0, lastKeepAliveAt: 0, allRequestedAt: 0, allLoadedAt: 0, allSubIds: new Set(), recoveries: [], recovering: false, recoveringSince: 0, ended: false, state: 'RECOVERING' };
  S.pages.set(context, page); note('page', { event: 'opened', pageId: page.pageId, eventId: c.eventId, slug: c.slug, sport: c.sportId, sportRank: page.sportRank, globalRank: page.globalRank, reason: page.reason });
  try { await navigate(context, `${ORIGIN}/esports/match/${c.slug}`); await activateAll(page); } catch (e) { note('page', { event: 'open-failed', pageId: page.pageId, error: String(e.message).slice(0, 160) }); }
}
async function activateAll(page) {
  for (let i = 0; i < 4 && !page.allRequestedAt; i++) { await sleep(2500); const ok = await call(page.context, CLICK_TAB(['All', 'Все'])).catch(() => false); if (ok) note('page', { event: 'all-clicked', pageId: page.pageId, attempt: i + 1 }); await sleep(1500); }
}
async function closePage(page, reason) { S.pages.delete(page.context); note('page', { event: 'closed', pageId: page.pageId, eventId: page.eventId, reason }); await S.bidi?.send('browsingContext.close', { context: page.context }).catch(() => {}); }
function retirePage(page, reason) {
  if (page.retiring) return;
  page.retiring = { reason, at: Date.now() };
  note('page', { event: 'handoff-pending', pageId: page.pageId, eventId: page.eventId, reason });
}
async function recover(page) {
  if (S.pages.get(page.context) !== page || page.retiring) return;
  const now = Date.now(); page.recoveries = page.recoveries.filter((t) => t > now - 1800000); S.pageRecoveries++;
  if (page.recoveries.length >= 3) {
    // Unrecoverable (a third recreate within 30 min would be needed): the event is excluded for excludeMs and its slot
    // goes to the next selection.
    const rec = (S.recreates.get(page.eventId) || []).filter((t) => t > now - 1800000);
    if (rec.length >= 2) { S.excluded.set(page.eventId, now + cfg.excludeMs); note('page', { event: 'excluded', pageId: page.pageId, eventId: page.eventId, untilMs: cfg.excludeMs }); retirePage(page, 'unrecoverably stale'); return; }
    rec.push(now); S.recreates.set(page.eventId, rec);
    note('page', { event: 'recreate', pageId: page.pageId, eventId: page.eventId }); await closePage(page, 'repeatedly stale'); await openPage({ ...page }); return;
  }
  page.recoveries.push(now); page.recovering = true; page.recoveringSince = now; page.allRequestedAt = 0; page.allLoadedAt = 0; page.allSubIds.clear();
  store.events.delete(page.eventId);
  note('page', { event: 'reload', pageId: page.pageId, eventId: page.eventId, attempt: page.recoveries.length });
  try { await S.bidi.send('browsingContext.reload', { context: page.context, wait: 'complete' }, 60000); await activateAll(page); } catch (e) { note('page', { event: 'reload-failed', pageId: page.pageId, error: String(e.message).slice(0, 160) }); }
}

// ---------------------------------------------------------------- frames ----------------------------------------------
// Diagnostics: the last frames per tab (incoming data and the page's own start/stop operations; never connection_init),
// truncated. Served on the local socket only (/debug/frames).
const RING = new Map();
function ringPush(key, k, msg) { let r = RING.get(key); if (!r) RING.set(key, r = []); const d = JSON.stringify(msg); r.push({ at: new Date().toISOString(), k, op: msg?.payload?.operationName || null, type: msg?.type, id: msg?.id ?? null, bytes: d.length, d: d.length > 60000 ? d.slice(0, 60000) : d }); if (r.length > (key === 'discovery' ? 300 : 40)) r.shift(); }
function onMessage(p) {
  if (p.channel !== 'gg') return; let f; try { f = JSON.parse(p.data?.value); } catch { return; }
  const ctx = p.source?.context, page = S.pages.get(ctx), now = Date.now();
  // Transport liveness = frames received from GG.BET only (a reconnect loop of open/close is not a live transport).
  if (f.k === 'in') { S.wsFrames++; S.lastWsFrameAt = now; if (page) page.lastWsFrameAt = now; }
  if (f.k === 'open' || f.k === 'close') { note('ws', { event: f.k, pageId: page?.pageId || (ctx === S.discovery?.context ? 'discovery' : null), code: f.code }); return; }
  let msg; try { msg = JSON.parse(f.d); } catch { return; }
  ringPush(page ? page.pageId : ctx === S.discovery?.context ? 'discovery' : 'other', f.k, msg);
  const isDiscovery = ctx === S.discovery?.context;
  if (f.k === 'out') {
    const op = msg.payload?.operationName, v = msg.payload?.variables || {};
    // The page's own "All" tab: its catalog query and its catalog subscription.
    if (page && msg.type === 'start' && ((op === 'GetMarketsTab' && v.marketTabID === 'all') || (op === 'OnUpdateTab' && v.marketTabId === 'all'))) { if (op === 'GetMarketsTab') { page.allRequestedAt = now; note('page', { event: 'all-requested', pageId: page.pageId }); } page.allSubIds.add(String(msg.id)); }
    // Discovery lists: only LIVE listings from their first row (offset 0) are rankings.
    if (isDiscovery && msg.type === 'start' && op === 'GetSportEventListByFilters' && Number(v.offset || 0) === 0 && v.order === 'RANK_RECOMMENDED' && (v.matchStatuses || []).includes('LIVE')) S.discReq.set(String(msg.id), v.sportIds || []);
    return;
  }
  if (msg.type === 'ka') { if (page) page.lastKeepAliveAt = now; return; }
  if (isDiscovery) {
    if (msg.type !== 'data') return;
    const sportIds = S.discReq.get(String(msg.id)), list = sportIds ? listRows(msg) : null;
    if (list) { S.disc.applyList(sportIds, list, now); S.discReq.delete(String(msg.id)); return; }
    for (const it of walk(msg.payload)) if (it.kind === 'event') S.disc.applyUpdate(it.event, now);
    return;
  }
  if (!page) return;
  const allTab = page.allSubIds.has(String(msg.id));
  if (allTab && msg.type === 'data' && !page.allLoadedAt && Array.isArray((msg.payload?.data?.compiledMarketsTab || msg.payload?.data?.onUpdateTab)?.marketIds)) { page.allLoadedAt = now; note('page', { event: 'all-loaded', pageId: page.pageId, eventId: page.eventId }); }
  const r = store.ingest(msg, { capturedAt: f.t, pageId: page.pageId, allTab });
  // typeId 96 (total kills odd/even) price history for forensics/comparison: every new or changed row, raw prices only.
  for (const m of r.changed) if (Number(m.typeId) === 96) { const e = store.events.get(m.eventId); note('price96', { eventId: m.eventId, eventVersion: e?.version || null, status: e?.meta?.status || null, score: e?.meta?.score ?? null, marketId: m.marketId, mapnr: m.mapnr, marketStatus: m.marketStatus, outcomes: m.outcomes.map((o) => [o.outcomeId, o.outcomeName, o.rawPrice, o.active]), capturedAt: m.capturedAt, exit: S.vpnExit?.hostname || null, session: S.browserSessionId }); }
  if (page.recovering && r.events.includes(page.eventId)) { page.recovering = false; note('page', { event: 'recovered', pageId: page.pageId, eventId: page.eventId }); }
}

// ---------------------------------------------------------------- loops -----------------------------------------------
async function reconcile() {
  if (S.vpnState !== 'UP') return;
  if (!S.bidi) { await stopBrowser('bidi lost'); if (S.browserStartedAt) S.restarts++; // the first start is not a restart
    if (!(await startBrowser())) return; }
  if (!S.discovery) await openDiscovery();
  else if (Date.now() - S.discovery.refreshedAt > DISCOVERY_STEP_MS) await refreshDiscovery();
  const now = Date.now();
  for (const [id, until] of S.excluded) if (until <= now) S.excluded.delete(id);
  // Pages that end: finished (page or list status), gone from their sport's fresh list, or excluded as unrecoverable.
  for (const p of [...S.pages.values()]) {
    const st = String(store.events.get(p.eventId)?.meta?.status || '').toUpperCase();
    const reason = p.ended || ['ENDED', 'CLOSED', 'FINISHED', 'CANCELLED', 'ABANDONED'].includes(st) || S.disc.ended(p.eventId) ? 'ended' : S.disc.gone(p, now, cfg) ? 'gone from the provider list' : null;
    if (reason && !p.retiring) { S.excluded.set(p.eventId, now + cfg.excludeMs);
      if (reason === 'ended') await closePage(p, reason); else retirePage(p, reason);
    }
  }
  // Warm-up: no selection before every target sport's list was seen in this session (or two full discovery cycles
  // passed - a sport page may fail), so the first choice is already the diverse one instead of three tabs of one sport.
  if (!TARGET_SPORTS.every((x) => S.disc.sports.has(x)) && now - S.discovery.openedAt < 2 * DISCOVERY.length * DISCOVERY_STEP_MS) { S.selectionReady = false; return; }
  S.selectionReady = true; // from here, an event absent from the selection is really deselected (the server may hand it back)
  const candidates = S.disc.candidates(now, cfg);
  // Diagnostics: current provider ranks of the held events.
  for (const p of S.pages.values()) { const c = (candidates.get(p.sportId) || []).find((x) => x.eventId === p.eventId); if (c) { p.sportRank = c.sportRank; p.globalRank = c.globalRank; } }
  // A retiring LIVE page occupies its slot until the server confirms a published fresh Node copy.
  if ([...S.pages.values()].some((p) => p.retiring)) return;
  const plan = selectEvents({ current: [...S.pages.values()].map((p) => ({ eventId: p.eventId, sportId: p.sportId, selectedAt: p.selectedAt })), candidates, maxPages: cfg.maxPages, now, cfg, excluded: new Set(S.excluded.keys()) });
  for (const d of plan.drop) { const p = [...S.pages.values()].find((x) => x.eventId === d.eventId); if (p) retirePage(p, d.reason); }
  if (plan.drop.length) return; // wait for handoff acknowledgement before opening a replacement
  for (const c of plan.add) { note('select', { eventId: c.eventId, sport: c.sportId, sportRank: c.sportRank, globalRank: c.globalRank, reason: c.reason, title: c.title }); await openPage({ ...c, selectedAt: Date.now() }); }
}
async function watchdog() {
  const now = Date.now();
  for (const p of [...S.pages.values()]) {
    const st = pageState(p, store.events.get(p.eventId), cfg, now, S.disc.refs.get(p.eventId));
    if (st !== p.state) { note('page', { event: 'state', pageId: p.pageId, eventId: p.eventId, from: p.state, to: st }); p.state = st; }
    // A reload that never brought event data back (STALE while recovering) is retried too; 3 in 30 min -> recreate.
    if (!p.retiring && st === 'STALE' && (!p.recovering || now - p.recoveringSince > cfg.eventStaleMs)) await recover(p);
  }
}
function pssOfBrowser() {
  let kb = 0, n = 0; const uid = process.getuid();
  for (const pid of fs.readdirSync('/proc').filter((d) => /^\d+$/.test(d))) {
    if (Number(pid) === process.pid) continue;
    // PSS (proportional set size): shared pages counted once across Firefox's processes (a plain RSS sum overstates).
    try { const s = fs.readFileSync(`/proc/${pid}/status`, 'utf8'); if (Number(/^Uid:\s+(\d+)/m.exec(s)?.[1]) !== uid) continue; kb += Number(/^Pss:\s+(\d+)/m.exec(fs.readFileSync(`/proc/${pid}/smaps_rollup`, 'utf8'))?.[1] || 0); n++; } catch {}
  }
  return { pssMiB: Math.round(kb / 1024), processes: n };
}
function health() {
  const now = Date.now(), pub = publish(store, [...S.pages.values()], { vpnState: S.vpnState, browserUp: !!S.bidi, cfg, now, refs: S.disc.refs }), count = (st) => pub.filter((p) => p.state === st).length;
  const ff = pssOfBrowser(), mem = fs.readFileSync('/proc/meminfo', 'utf8'), avail = Number(/^MemAvailable:\s+(\d+)/m.exec(mem)?.[1] || 0);
  return { at: new Date(now).toISOString(), browserRunning: !!S.bidi, browserPid: S.browser?.pid || null, browserSessionId: S.browserSessionId, browserSessionAgeMs: S.browserStartedAt ? now - S.browserStartedAt : null,
    vpnState: S.vpnState, vpnExit: S.vpnExit, firstGgbetAt: S.firstGgbetAt, vpnAgeSinceFirstGgbetMs: S.firstGgbetAt ? now - Date.parse(S.firstGgbetAt) : null, sessionFirstGgbetAt: S.sessionFirstGgbetAt || null, pagesActive: pub.length, maxPages: cfg.maxPages, pagesHealthy: count('HEALTHY'), pagesQuiet: count('QUIET'), pagesSuspect: count('SUSPECT_STALE'), pagesStale: count('STALE'), pagesRecovering: count('RECOVERING'),
    wsFramesTotal: S.wsFrames, lastWsFrameAgeMs: S.lastWsFrameAt ? now - S.lastWsFrameAt : null, eventsTracked: store.events.size, candidatesLive: Object.fromEntries([...S.disc.candidates(now, cfg)].map(([k, v]) => [SPORT_LABEL[k], v.length])), discoveryLists: Object.fromEntries([...S.disc.sports].map(([k, v]) => [SPORT_LABEL[k] || k, { ageMs: now - v.at, rows: v.rows.length, count: v.count }])), globalListAgeMs: S.disc.global ? now - S.disc.global.at : null, excluded: S.excluded.size,
    marketCount: pub.reduce((n, p) => n + p.markets.length, 0), outcomeCount: pub.reduce((n, p) => n + p.markets.reduce((m, x) => m + x.outcomes.length, 0), 0), updatesPerMinute: store.updatesPerMinute(),
    lastAnyUpdateAgeMs: Math.min(...[...store.events.values()].map((e) => now - e.lastEventUpdateAt), Infinity), firefoxPssMiB: ff.pssMiB, firefoxProcesses: ff.processes, workerRssMiB: Math.round(process.memoryUsage().rss / 1048576),
    systemMemAvailableMiB: Math.round(avail / 1024), restartCount: S.restarts, pageRecoveries: S.pageRecoveries, stats: store.stats, thresholds: cfg };
}
function matches() {
  const now = Date.now();
  return publish(store, [...S.pages.values()], { vpnState: S.vpnState, browserUp: !!S.bidi, cfg, now, refs: S.disc.refs }).map((p) => { const pg = S.pages.get([...S.pages.keys()].find((k) => S.pages.get(k).pageId === p.pageId)), e = store.events.get(p.eventId);
    return { pageId: p.pageId, eventId: p.eventId, eventName: p.eventName, league: p.league, status: p.status, score: p.score, eventVersion: p.eventVersion, listVersion: p.listVersion, listVersionAgeMs: p.listVersionAgeMs, state: p.state, fresh: p.fresh, tabAgeMs: pg ? now - pg.openedAt : null, allLoaded: !!pg?.allLoadedAt, markets: p.markets.length, outcomes: p.markets.reduce((n, m) => n + m.outcomes.length, 0),
      wsAgeMs: pg?.lastWsFrameAt ? now - pg.lastWsFrameAt : null, eventUpdateAgeMs: e?.lastEventUpdateAt ? now - e.lastEventUpdateAt : null, priceChangeAgeMs: e?.lastPriceChangeAt ? now - e.lastPriceChangeAt : null, versionChangeAgeMs: e?.lastEventVersionChangeAt ? now - e.lastEventVersionChangeAt : null, recoveries: pg?.recoveries.length || 0 }; });
}

// The selected events as the server consumes them. ready = the page is healthy/quiet, its identity is confirmed (the raw
// event is the selected id and slug), its "All" tree arrived and it has markets: only then may the server hand off.
function selected(now = Date.now(), retiring = false) {
  const pub = new Map(publish(store, [...S.pages.values()], { vpnState: S.vpnState, browserUp: !!S.bidi, cfg, now, refs: S.disc.refs }).map((p) => [p.pageId, p]));
  return [...S.pages.values()].filter((p) => !!p.retiring === retiring).map((p) => {
    const e = store.events.get(p.eventId), raw = store.rawEvent(p.eventId), v = pub.get(p.pageId), identity = !!raw && raw.id === p.eventId && (!raw.slug || raw.slug === p.slug);
    const complete = !!e?.catalog?.size && [...e.catalog].every((id) => e.rawMarkets.has(id));
    const ref = S.disc.refs.get(p.eventId);
    const validatedAt = Math.max(e?.lastEventUpdateAt || 0, ref?.version === e?.version && now - ref.versionAt <= cfg.eventStaleMs ? ref.versionAt : 0);
    return { eventId: p.eventId, sportId: p.sportId, sport: SPORT_LABEL[p.sportId] || p.sportId, slug: p.slug, title: e?.meta?.eventName || p.title, league: e?.meta?.league || p.league, status: e?.meta?.status || null, score: e?.meta?.score ?? null,
      sportRank: p.sportRank, globalRank: p.globalRank, reason: p.reason, selectedAt: new Date(p.selectedAt).toISOString(), pageId: p.pageId, state: v?.state || 'UNAVAILABLE', fresh: !!v?.fresh, allLoaded: !!p.allLoadedAt, identity,
      marketCount: raw?.markets?.length || 0, ready: !!v?.fresh && !!p.allLoadedAt && complete && identity && (raw?.markets?.length || 0) > 0,
      catalogComplete: complete, validatedAt: validatedAt ? new Date(validatedAt).toISOString() : null, dataFreshMs: cfg.eventStaleMs, retiring: p.retiring?.reason || null, version: e?.version || null, seq: e?.seq || 0,
      lastUpdateAt: e?.lastEventUpdateAt ? new Date(e.lastEventUpdateAt).toISOString() : null, lastPriceChangeAt: e?.lastPriceChangeAt ? new Date(e.lastPriceChangeAt).toISOString() : null };
  });
}
// Server feed: health, the selected set and the raw GraphQL event (merged event + "All" markets) of every selected event
// changed since `since` (store sequence).
function feed(since, now = Date.now()) {
  const sel = selected(now), retiring = selected(now, true), events = {};
  for (const x of [...sel, ...retiring]) if (x.seq > since) { const raw = store.rawEvent(x.eventId); if (raw) events[x.eventId] = raw; }
  return { at: new Date(now).toISOString(), worker: WORKER_ID, seq: store.seq, sessionId: S.browserSessionId, vpnState: S.vpnState, browserRunning: !!S.bidi, selectionReady: !!S.selectionReady && S.vpnState === 'UP' && !!S.bidi, vpnExit: S.vpnExit ? { ip: S.vpnExit.ip, city: S.vpnExit.city, hostname: S.vpnExit.hostname } : null, maxPages: cfg.maxPages, selected: sel, retiring, events };
}

// ---------------------------------------------------------------- local IPC (Unix socket only) --------------------------
function serve() {
  const srv = serveIpc({ socketPath: SOCK, handle: async ({ method, url: u, body: input }) => {
    const now = Date.now(); let body;
    if (method === 'POST' && u.pathname === '/handoff') {
      const p = [...S.pages.values()].find((p) => p.retiring && p.eventId === input?.eventId && p.pageId === input?.pageId);
      if (input?.worker !== WORKER_ID || input?.sessionId !== S.browserSessionId || !p) return { status: 409, body: { ok: false } };
      await closePage(p, `safe handoff: ${p.retiring.reason}`);
      return { body: { ok: true } };
    }
    if (method !== 'GET') return { status: 404 };
    if (u.pathname === '/health') body = health();
    else if (u.pathname === '/matches' || u.pathname === '/events') body = matches();
    else if (u.pathname === '/snapshot') body = { at: new Date(now).toISOString(), vpnState: S.vpnState, browserUp: !!S.bidi, events: publish(store, [...S.pages.values()], { vpnState: S.vpnState, browserUp: !!S.bidi, cfg, now, refs: S.disc.refs }) };
    else if (u.pathname === '/markets') { const id = u.searchParams.get('eventId'); body = publish(store, [...S.pages.values()].filter((p) => p.eventId === id), { vpnState: S.vpnState, browserUp: !!S.bidi, cfg, now, refs: S.disc.refs })[0] || { error: 'unknown event' }; }
    else if (u.pathname === '/selected') body = selected(now);
    else if (u.pathname === '/feed') body = feed(Number(u.searchParams.get('since') || 0), now);
    else if (u.pathname === '/debug/discovery') body = S.discovery && S.bidi ? JSON.parse(await call(S.discovery.context, `() => JSON.stringify({ path: location.pathname, text: document.body.innerText.slice(0,6000), links: [...document.querySelectorAll('a')].map(e => ({text: e.textContent.trim(), path: new URL(e.href).pathname})).filter(e => /live|counter|dota|league|more|show/i.test(e.path+' '+e.text)).slice(0,100) })`)) : {};
    else if (u.pathname === '/debug/frames') body = (RING.get(u.searchParams.get('tab') || 'discovery') || []).slice(-Number(u.searchParams.get('n') || 300));
    else if (u.pathname === '/stale') body = matches().filter((m) => !['HEALTHY', 'QUIET'].includes(m.state));
    else return { status: 404 };
    return { body };
  } });
  srv.on('listening', () => note('ipc', { event: 'listening', socket: SOCK }));
}

// ---------------------------------------------------------------- main ------------------------------------------------
serve();
note('worker', { event: 'start', pid: process.pid, cfg, expectedExit: EXPECT || null });
for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, async () => { S.stopping = true; await stopBrowser('worker stop'); log.flushSync(); process.exit(0); });
let ticks = 0;
// Control loop (VPN, browser, discovery, page set) and watchdog loop run independently: a slow or failing navigation in
// the control loop never stops staleness detection and recovery.
const guarded = async (name, fn) => { try { await fn(); } catch (e) { note('error', { loop: name, error: String(e.message).slice(0, 200) }); } };
(async () => { await guarded('vpn', vpnTick); for (;;) { if (S.stopping) return; if (ticks % 2 === 0) await guarded('vpn', vpnTick); await guarded('reconcile', reconcile); if (ticks % 6 === 0) note('stats', health()); ticks++; await sleep(15000); } })();
(async () => { for (;;) { await sleep(15000); if (S.stopping) return; if (S.vpnState === 'UP' && S.bidi) await guarded('watchdog', watchdog); } })();
