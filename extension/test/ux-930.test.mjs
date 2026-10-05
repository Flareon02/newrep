// 9.3 behaviour: collapse model, panel toggle, copy/context menu model, stream links, logos, game icons, theme,
// GGBET/DataBet and the CS2 board (event log collapsed, round outcomes never invented).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const read = (f) => fs.readFileSync(new URL('../' + f, import.meta.url), 'utf8');
const LineCollapse = require('../line-collapse.js');
const LogoResolver = require('../logo-resolver.js');
const GameCategories = require('../game-categories.js');
const UiKit = (() => { const ctx = { module: { exports: {} }, URL, console, document: {}, window: {} }; vm.runInNewContext(read('ui-kit.js'), ctx); return ctx.module.exports; })();

// ------------------------------------------------------------------ collapse / expand
test('global expand gives games open and leagues collapsed; nested state is never restored', () => {
  const games = ['game:cs', 'game:dota'], f = LineCollapse.create();
  assert.equal(f.gameOpen('game:cs'), true, 'fresh: games open');
  assert.equal(f.leagueOpen('cs|esl'), false, 'fresh: leagues collapsed');
  f.setLeague('cs|esl', true); f.setLeague('dota|dreamleague', true);
  assert.equal(f.leagueOpen('cs|esl'), true);
  f.setAll(false, games);
  assert.deepEqual(games.map(f.gameOpen), [false, false]);
  f.setAll(true, games);
  assert.deepEqual(games.map(f.gameOpen), [true, true], 'expand all: every game open');
  assert.equal(f.leagueOpen('cs|esl'), false, 'previously open league is NOT restored');
  assert.equal(f.leagueOpen('dota|dreamleague'), false);
});

test('collapsing one game forgets its open leagues, other games keep theirs', () => {
  const f = LineCollapse.create();
  f.setLeague('cs|esl', true); f.setLeague('dota|dl', true);
  f.setGame('game:cs', false); f.setGame('game:cs', true);
  assert.equal(f.leagueOpen('cs|esl'), false, 'reopened game starts with leagues collapsed');
  assert.equal(f.leagueOpen('dota|dl'), true);
  assert.equal(f.anyOpen(['game:cs', 'game:dota']), true);
  const restored = LineCollapse.create({ closedGames: f.closedGames() });
  assert.equal(restored.leagueOpen('dota|dl'), false, 'open leagues are session-only');
});

// ------------------------------------------------------------------ match panel toggle
test('same match click closes the panel, a different match switches, another bookmaker cell switches the book', () => {
  assert.equal(UiKit.panelClick({ openId: null, id: 'A' }), 'open');
  assert.equal(UiKit.panelClick({ openId: 'A', id: 'A' }), 'close');
  assert.equal(UiKit.panelClick({ openId: 'A', id: 'B' }), 'switch');
  assert.equal(UiKit.panelClick({ openId: 'A', id: 'A', cellBook: 'fonbet', source: 'astek' }), 'book');
  assert.equal(UiKit.panelClick({ openId: 'A', id: 'A', cellBook: 'astek', source: 'astek' }), 'close');
  assert.equal(UiKit.panelClick({ openId: 7, id: '7' }), 'close', 'ids compare as strings');
});

// ------------------------------------------------------------------ copy / context menu model
test('match name copies exactly as "Team A - Team B"; single teams copy alone', () => {
  const e = { team1: 'Shinden', team2: 'G2 Esports' };
  assert.equal(UiKit.matchName(e), 'Shinden - G2 Esports');
  assert.deepEqual([...UiKit.matchCopies(e).map((c) => c.value)], ['Shinden - G2 Esports', 'Shinden', 'G2 Esports']);
  assert.equal(UiKit.matchName({ team1: ' A ', team2: 'B ' }), 'A - B');
});

test('bookmaker URL is copied only when the feed has a usable one — never invented', () => {
  assert.equal(UiKit.bookLink({ source: 'astek', url: 'https://astek.example/esports/match/123' }), 'https://astek.example/esports/match/123');
  assert.equal(UiKit.bookLink({ source: 'pinnacle' }), '', 'no URL in the data: unavailable');
  assert.equal(UiKit.bookLink({ source: 'x', url: 'javascript:alert(1)' }), '');
  assert.equal(UiKit.bookLink({ source: 'x', url: 'not a url' }), '');
});

// ------------------------------------------------------------------ stream links
test('stream links: one component, service icons, full name in the tooltip, bad URLs dropped, escaped', () => {
  const html = UiKit.streamLinks([
    { name: 'ESL_CS', url: 'https://www.twitch.tv/eslcs' },
    { name: 'a_very_long_channel_name_that_will_be_truncated_<b>', url: 'https://youtube.com/@x' },
    { name: 'kick', url: 'https://kick.com/cs' },
    { name: 'evil', url: 'javascript:alert(1)' },
    { url: 'https://example.org/live' },
  ]);
  assert.equal((html.match(/class="stream /g) || []).length, 4, 'javascript: link is left out');
  assert.match(html, /class="stream twitch"/); assert.match(html, /class="stream youtube"/); assert.match(html, /class="stream kick"/); assert.match(html, /class="stream other"/);
  assert.match(html, /title="YouTube · a_very_long_channel_name_that_will_be_truncated_&lt;b&gt;"/);
  assert.ok(!html.includes('<b>'));
  assert.match(html, /<span>Трансляция<\/span>/, 'a link without a name gets the service label');
  assert.match(UiKit.streamLinks([]), /Трансляций нет/);
});

// ------------------------------------------------------------------ team logos
test('logo order: merged event, then bookmaker refs, then a logo learned elsewhere; broken URLs never retried', () => {
  const L = LogoResolver.create({ base: () => 'https://api.test' });
  const a = '/api/team-logos/' + 'a'.repeat(32), b = '/api/team-logos/' + 'b'.repeat(32);
  const e = { category: 'Dota 2', team1: 'Team Spirit', team2: 'OG', team1Logo: a, sourceRefs: [{ source: 'fonbet', team1Logo: b, team2Logo: b }] };
  assert.equal(L.pick(e, 1), 'https://api.test' + a, 'merged logo first');
  assert.equal(L.pick(e, 2), 'https://api.test' + b, 'another bookmaker has the logo the merged event lacks');
  assert.equal(L.fail('https://api.test' + a), true);
  assert.equal(L.fail('https://api.test' + a), false, 'a failure is recorded once');
  assert.equal(L.pick(e, 1), 'https://api.test' + b, 'next candidate after a broken one');
  L.fail('https://api.test' + b);
  assert.equal(L.pick(e, 1), '', 'nothing valid left: placeholder');
  // learned from another view (detail / statistics) and reused by a thin list row without logos
  const M = LogoResolver.create({ base: () => 'https://api.test' });
  M.learn({ category: 'Counter-Strike 2', team1: 'Vitality', team2: 'MOUZ', team1Logo: a, sourceRefs: [{ source: 'ggbet', team2Logo: 'https://cdn.gin.bet/teams/mouz.png' }] });
  assert.equal(M.pick({ category: 'Counter-Strike 2', team1: 'MOUZ', team2: 'Vitality' }, 2), 'https://api.test' + a);
  assert.equal(M.pick({ category: 'Counter-Strike 2', team1: 'MOUZ', team2: 'x' }, 1), 'https://cdn.gin.bet/teams/mouz.png');
  assert.equal(M.pick({ category: 'CS2', team1: 'Vitality' }, 1), 'https://api.test' + a, 'same team name in another category spelling');
});

test('logos: only the server cache and known bookmaker CDNs; nothing fabricated; persistence keeps relative paths', () => {
  const L = LogoResolver.create({ base: () => 'https://api.test' });
  for (const bad of ['http://v2l.traincdn.com/sfiles/logo_teams/' + 'c'.repeat(32) + '.png', 'https://evil.example/logo.png', '/api/team-logos/short', 'data:image/png;base64,xx', '']) assert.equal(L.url(bad), '', bad);
  assert.equal(L.url('https://v2l.traincdn.com/sfiles/logo_teams/' + 'c'.repeat(32) + '.png').startsWith('https://v2l.traincdn.com/'), true);
  assert.equal(L.pick({ team1: 'Nobody' }, 1), '');
  L.learn({ category: 'Dota 2', team1: 'OG', team1Logo: '/api/team-logos/' + 'd'.repeat(32) });
  const dump = L.dump();
  assert.deepEqual([...dump[0]], ['dota2|og', '/api/team-logos/' + 'd'.repeat(32)]);
  const other = LogoResolver.create({ base: () => 'https://other.server' }); other.load(dump);
  assert.equal(other.pick({ category: 'Dota 2', team1: 'OG' }, 1), 'https://other.server/api/team-logos/' + 'd'.repeat(32));
});

// ------------------------------------------------------------------ game icons
test('game filter icons: every known game has a local glyph, unknown games fall back to the abbreviation', () => {
  const css = read('game-icons.css'), app = read('app.js');
  const glyphs = new Set(app.match(/const GLYPHS=new Set\(\[([^\]]+)\]\)/)[1].split(',').map((s) => s.replace(/'/g, '').trim()));
  for (const [, name, key] of GameCategories.entries) {
    assert.ok(glyphs.has(key), `${name}: GLYPHS has ${key}`);
    assert.ok(css.includes(`.gi-${key}{`), `${name}: game-icons.css has .gi-${key}`);
  }
  for (const name of ['Counter-Strike 2', 'Dota 2', 'League of Legends', 'Valorant', 'Overwatch 2', 'Hearthstone', 'Honor of Kings', 'Heroes of Might and Magic III']) assert.notEqual(GameCategories.info(name).key, 'other', name);
  assert.equal(GameCategories.info('Some New Game').key, 'other');
  assert.ok(!/url\(["']?https?:/.test(css), 'no remote icon is fetched');
});

// ------------------------------------------------------------------ theme
function bootTheme(saved, systemDark) {
  const store = new Map(saved == null ? [] : [['monitor-theme', saved]]), html = { dataset: {} };
  vm.runInNewContext(read('theme-boot.js'), { localStorage: { getItem: (k) => store.get(k) ?? null }, matchMedia: () => ({ matches: systemDark }), document: { documentElement: html } });
  return html.dataset.theme;
}
test('theme: dark by default, light and system honoured before the first paint (persisted mirror)', () => {
  assert.equal(bootTheme(null, false), 'dark');
  assert.equal(bootTheme('light', true), 'light');
  assert.equal(bootTheme('dark', false), 'dark');
  assert.equal(bootTheme('system', false), 'light');
  assert.equal(bootTheme('system', true), 'dark');
  assert.equal(bootTheme('neon', false), 'dark');
  const html = read('app.html'), app = read('app.js'), css = read('ui.css');
  assert.ok(html.indexOf('theme-boot.js') < html.indexOf('ui.css'), 'boot script runs before the stylesheets');
  assert.match(app, /localStorage\.setItem\('monitor-theme',mode\)/, 'the choice is mirrored for the next start');
  assert.match(app, /prefs\.theme=mode;savePrefs\(\)/, 'and saved in prefs');
  assert.match(css, /:root\[data-theme="light"\]\{/);
  for (const token of ['--bg', '--surface', '--text', '--muted', '--accent', '--line', '--selected', '--bad-text', '--ct', '--t', '--up', '--down']) assert.ok(new RegExp(`:root\\[data-theme="light"\\]\\{[^}]*${token}:`).test(css), `light theme defines ${token}`);
});

// ------------------------------------------------------------------ GGBET / DataBet
test('DataBet is absent from the UI; GGBET is listed and toggleable like other bookmakers', () => {
  const html = read('app.html'), app = read('app.js'), settings = read('app-settings.js'), panel = read('detail-panel.js');
  assert.ok(!/databet/i.test(html), 'no DataBet option in the page');
  assert.ok(!/databet/i.test(settings), 'no DataBet setting');
  assert.ok(!/databet/i.test(panel), 'no DataBet in the match panel');
  assert.ok(!/data-odds-mode/.test(settings), 'no GGBET/DataBet source switch');
  assert.match(app, /const BOOKS=\['astek','fonbet','pinnacle','ggbet'\];/);
  assert.ok(!/databet/i.test(app.replace(/\/\/[^\n]*|delete prefs\.databet|prefs\.detailBook==='databet'|availability==='databet'/g, '')), 'app.js only migrates old DataBet prefs');
  assert.match(settings, /books=BOOKS\.filter\(s=>Ent\.canProvider\(s\)\)/, 'settings list every bookmaker incl. GGBET');
  assert.ok(!/r\.isOdds\?/.test(app), 'the sources popover gives GGBET its own switch');
});

// ------------------------------------------------------------------ CS2 board
function cs2Harness() {
  const listeners = {};
  const ctx = {
    console, URL, Date, Math, JSON, Number, String, Array, Object, Map, Set, Promise, performance: { now: () => 0 }, CSS: { escape: (s) => s },
    setTimeout: () => 0, clearTimeout: () => {}, setInterval: () => 0, requestAnimationFrame: () => 0,
    document: { hidden: false, addEventListener: (t, f) => { listeners[t] = f; }, querySelector: () => null },
    window: { addEventListener: () => {} },
  };
  vm.createContext(ctx);
  vm.runInContext(read('ui-kit.js'), ctx); vm.runInContext('globalThis.UiKit=UiKit;', ctx);
  vm.runInContext(read('cs2-clock.js'), ctx);
  vm.runInContext('globalThis.StableDOM={patch(){}};globalThis.StatisticsClient={get:async()=>globalThis.__data,subscribe:()=>()=>{}};', ctx);
  vm.runInContext(read('cs2-panel.js') + ';globalThis.Cs2Panel=Cs2Panel;', ctx);
  ctx.Cs2Panel.configure({ esc: (s) => String(s ?? '').replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`), request: async () => ({}), render: () => {}, logosEnabled: () => true });
  return ctx;
}
test('CS2 board: event log collapsed by default, outcomes only from data, sides and current round marked', async () => {
  const ctx = cs2Harness();
  ctx.__data = { matched: true, connected: true, updatedAt: Date.now(), team1: 'Shinden', team2: 'G2 Esports', map: 'Mirage', mapNum: 1, mapScore: [0, 0], roundScore: [2, 1], currentRound: 4, timerRunning: true,
    timeline: [{ number: 1, team: '1', side: 'CT', type: 'defused' }, { number: 2, team: '2', side: 'T', type: 'exploded' }, { number: 3, team: '1', side: 'CT', type: '' }],
    players: [{ name: 'Shinden', side: 'CT', members: [{ name: 'a', alive: true }, { name: 'b', alive: false }] }, { name: 'G2 Esports', side: 'T', members: [{ name: 'c', alive: true }] }],
    eventLog: [{ at: 1, round: 3, type: 'death', killer: 'a', player: 'c' }], streamLinks: [{ name: 'ESL', url: 'https://twitch.tv/esl' }] };
  const e = { id: 'm1', category: 'Counter-Strike 2', team1: 'Shinden', team2: 'G2 Esports', inLive: true };
  ctx.Cs2Panel.toggle(e); await new Promise((r) => setImmediate(r)); await new Promise((r) => setImmediate(r));
  const html = ctx.Cs2Panel.markup(e);
  assert.match(html, /class="fold cs2-fold cs2-event-log" data-cs2-log="m1" >/, 'event log rendered closed');
  assert.ok(!/cs2-event-log"[^>]*\bopen\b/.test(html));
  assert.match(html, /Бомба обезврежена/); assert.match(html, /Взрыв бомбы/);
  assert.match(html, /Раунд 3: Shinden, Победа в раунде \(способ не передан\)/, 'a missing outcome is not invented');
  assert.ok(!/Раунд 3[^"]*Уничтожение/.test(html));
  assert.match(html, /slot won ct/); assert.match(html, /slot won t/);
  assert.match(html, /class="rc current"/, 'the round in progress is marked');
  assert.match(html, /Живы: 1 из 2/);
  assert.match(html, /class="stream twitch"/, 'streams use the shared component');
  assert.ok(!/cs2-close|Статистика CS2/.test(html), 'no duplicated title and no dead close button');
});
