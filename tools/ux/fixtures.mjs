// Deterministic synthetic data for the UX harness: LIVE, line, results and ~1,900 History matches over several days,
// shaped like the server's thin UI payloads (server/src/ui-service.js THIN_* keys). No production data is used.
const GAMES = [
  ['Counter-Strike 2', ['ESL Pro League', 'CCT Europe', 'PGL Masters', 'European Pro League', 'YaLLa Compass']],
  ['Dota 2', ['DreamLeague', 'PGL Wallachia', 'European Pro League Dota', 'CCT Dota']],
  ['League of Legends', ['LCK', 'LEC', 'LPL', 'Prime League']],
  ['Valorant', ['VCT Challengers', 'Game Changers']],
  ['Overwatch', ['OWCS Europe']],
  ['Hearthstone', ['Masters Tour']],
  ['Honor of Kings', ['KPL']],
  ['Heroes of Might and Magic III', ['Jebus Cup']],
  ['Rainbow Six Siege', ['R6 Europe League']],
  ['Mobile Legends', ['MPL ID']],
  ['StarCraft', ['ESL SC2 Masters']],
];
const TEAMS = ['Shinden', 'G2 Esports', 'Natus Vincere', 'Team Spirit', 'FaZe Clan', 'Vitality', 'MOUZ', 'Heroic', 'Astralis', 'Ninjas in Pyjamas', 'Fnatic', 'Team Liquid', 'BIG', 'Eternal Fire', 'Monte', 'Aurora', 'Falcons', 'Virtus.pro', 'paiN Gaming', 'FURIA', 'The MongolZ', 'Complexity', '3DMAX', 'SAW', 'Gentle Mates', 'Passion UA', 'Sangal', 'ENCE', 'Betboom Team', 'Tundra Esports', 'Gaimin Gladiators', 'Xtreme Gaming', 'Team Falcons Academy', 'Rare Atom', 'Imperial Esports', 'Wildcard Gaming', 'Nemiga Gaming', 'Alliance', 'OG', 'Entity', 'Partizan', 'Rebels Gaming', 'ECSTATIC', 'Sashi Esport', 'Metizport', 'Fire Flux', 'Zero Tenacity', 'Johnny Speeds', 'Inner Circle', 'Fluxo'];
const ZONE_OFFSET = 4 * 3600000;

function rng(seed) { let s = seed >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; }; }
const hex = (r) => Array.from({ length: 32 }, () => '0123456789abcdef'[Math.floor(r() * 16)]).join('');

export function buildFixtures({ now = Date.now(), historyCount = 1900, days = 10, liveCount = 32, lineCount = 260, seed = 7 } = {}) {
  const r = rng(seed), pick = (a) => a[Math.floor(r() * a.length)];
  const logos = { good: [], broken: [] };
  const teamLogo = new Map();
  TEAMS.forEach((t, i) => { const h = hex(r); if (i % 7 === 3) { logos.broken.push(h); teamLogo.set(t, `/api/team-logos/${h}`); } else if (i % 5 !== 1) { logos.good.push(h); teamLogo.set(t, `/api/team-logos/${h}`); } });
  const todayStart = Math.floor((now + ZONE_OFFSET) / 86400000) * 86400000 - ZONE_OFFSET;
  const events = [];
  for (let i = 0; i < historyCount; i++) {
    const [category, leagues] = GAMES[Math.min(GAMES.length - 1, Math.floor(Math.pow(r(), 1.8) * GAMES.length))];
    const league = pick(leagues); let team1 = pick(TEAMS), team2 = pick(TEAMS); while (team2 === team1) team2 = pick(TEAMS);
    const kind = i < liveCount ? 'live' : i < liveCount + lineCount ? 'line' : 'removed';
    // History clock (firstPrematchAt): today for current matches, spread over `days` days for the rest (more recent = denser).
    const appearedAt = kind === 'removed' ? Math.round(now - Math.pow(r(), 1.3) * days * 86400000) : Math.round(Math.max(todayStart + 60000, now - r() * (now - todayStart)));
    const startAt = kind === 'line' ? Math.round(now + (1 + r() * 40) * 3600000) : kind === 'live' ? Math.round(now - r() * 5400000) : Math.round(appearedAt + (2 + r() * 20) * 3600000);
    const sources = ['astek', 'fonbet', 'pinnacle'].filter((s, k) => k === 0 ? r() < 0.8 : r() < 0.55);
    if (!sources.length) sources.push('fonbet');
    const id = `h${i}`;
    const sourceRefs = sources.map((source, k) => {
      const sid = `${source[0]}${100000 + i * 3 + k}`;
      const ref = { id: `${source}:${sid}`, sourceEventId: sid, source, category, league, leagueId: `${source}-${league}`, leagueKey: `${source}:${league}`, url: source === 'pinnacle' && i % 4 === 0 ? undefined : `https://${source}.example/esports/match/${sid}`, startAt, firstSeenAt: appearedAt, firstPrematchAt: appearedAt + k * 60000 };
      if (kind === 'live') { ref.inLive = true; ref.enteredLiveAt = startAt; ref.scoreText = `${i % 2}:${i % 3 === 0 ? 1 : 0} (${7 + (i % 6)}:${5 + (i % 7)})`; ref.seriesScore = [i % 2, i % 3 === 0 ? 1 : 0]; ref.mapScores = [[13, 9], [7 + (i % 6), 5 + (i % 7)]].slice(i % 2 ? 0 : 1); ref.activeMap = i % 2 ? 2 : 1; ref.bestOf = 3; }
      else if (kind === 'line') ref.inPrematch = true;
      else { ref.removedAt = startAt + 7200000; ref.endedAt = startAt + 7000000; ref.scoreText = '2:1'; }
      // Logos: the event-level logo is sometimes missing while one bookmaker ref has it (merge-loss case).
      if (k === sources.length - 1 && i % 3 === 0) { if (teamLogo.get(team1)) ref.team1Logo = teamLogo.get(team1); if (teamLogo.get(team2)) ref.team2Logo = teamLogo.get(team2); }
      return ref;
    });
    const e = { id, ui: true, category, league, leagueKey: `${category}|${league}`, team1, team2, startAt, firstSeenAt: appearedAt, firstPrematchAt: appearedAt, sourceRefs };
    if (i % 3 === 1) { if (teamLogo.get(team1)) e.team1Logo = teamLogo.get(team1); if (teamLogo.get(team2)) e.team2Logo = teamLogo.get(team2); }
    if (kind === 'live') { e.inLive = true; e.enteredLiveAt = startAt; e.scoreText = sourceRefs[0].scoreText; }
    if (kind === 'line') e.inPrematch = true;
    if (kind === 'removed') { e.removedAt = startAt + 7200000; e.endedAt = startAt + 7000000; }
    events.push(e);
  }
  const quote = (k) => ({ h: +(1.4 + ((k * 37) % 120) / 100).toFixed(3), a: +(1.5 + ((k * 53) % 110) / 100).toFixed(3), at: now - (k % 50) * 1000 });
  const liveEvents = events.filter((e) => e.inLive).map((e, k) => ({ ...e, sourceRefs: [...e.sourceRefs.map((x, j) => ({ ...x, quote: quote(k + j) })), { id: `ggbet:g${k}`, sourceEventId: `g${k}`, source: 'ggbet', category: e.category, league: e.league, url: `https://gg.example/match/g${k}`, startAt: e.startAt, inLive: true, enteredLiveAt: e.startAt, scoreText: e.scoreText, seriesScore: e.sourceRefs[0].seriesScore, mapScores: e.sourceRefs[0].mapScores, activeMap: e.sourceRefs[0].activeMap, bestOf: 3, quote: quote(k + 9), team1Logo: k % 4 === 0 ? e.team1Logo || e.sourceRefs.find((x) => x.team1Logo)?.team1Logo : undefined }] }));
  const lineEvents = events.filter((e) => e.inPrematch).map((e, k) => ({ ...e, sourceRefs: e.sourceRefs.map((x, j) => ({ ...x, quote: quote(k * 2 + j) })) }));
  return { now, events, liveEvents, lineEvents, logos, todayStart };
}

// CS2 scoreboard for one LIVE match (statistics panel).
export function cs2Stats(e, now = Date.now()) {
  const types = ['eliminated', 'exploded', 'defused', 'eliminated', 'timeout', 'eliminated', 'exploded'];
  const timeline = Array.from({ length: 19 }, (_, i) => { const team = (i * 7) % 3 === 0 ? '2' : '1'; const side = i < 12 ? (team === '1' ? 'CT' : 'T') : (team === '1' ? 'T' : 'CT'); return { number: i + 1, team, side, type: i === 9 ? '' : types[i % types.length] }; });
  const won = (t) => timeline.filter((x) => x.team === t).length;
  const member = (n, i, alive) => ({ name: `${n.split(' ')[0].slice(0, 6)}${i}`, alive, k: 10 + i * 2, a: 3 + i, d: 8 + i });
  return {
    matched: true, connected: true, updatedAt: now, team1: e.team1, team2: e.team2, map: 'Mirage', mapNum: 2, mapScore: [1, 0], roundScore: [won('1'), won('2')], currentRound: 20, roundTime: '1:12', timerRunning: true, bomb: 'planted',
    timeline, players: [{ name: e.team1, side: 'T', weaponsCost: 18400, members: [0, 1, 2, 3, 4].map((i) => member(e.team1, i, i < 3)) }, { name: e.team2, side: 'CT', weaponsCost: 22750, members: [0, 1, 2, 3, 4].map((i) => member(e.team2, i, i !== 2)) }],
    eventLog: Array.from({ length: 30 }, (_, i) => ({ at: now - (30 - i) * 4000, round: 19 + Math.floor(i / 15), type: i % 6 === 0 ? 'round_end' : i % 9 === 0 ? 'bomb_planted' : 'death', team: i % 2 ? '1' : '2', method: 'eliminated', killer: `${e.team1.slice(0, 4)}${i % 5}`, player: `${e.team2.slice(0, 4)}${(i + 2) % 5}` })),
    maps: [{ mapNum: 1, map: 'Inferno', roundScore: [13, 9], finished: true }, { mapNum: 2, map: 'Mirage' }],
    streamLinks: [{ name: 'ESL_CS', url: 'https://www.twitch.tv/eslcs' }, { name: 'eslcs_ru_very_long_channel_name_for_truncation', url: 'https://www.twitch.tv/eslcs_ru' }, { name: 'ESL Counter-Strike', url: 'https://www.youtube.com/@ESLCS' }, { name: 'kick_cs', url: 'https://kick.com/cs' }],
  };
}

export const dayKeyOf = (ms) => new Date(ms + ZONE_OFFSET).toISOString().slice(0, 10);
