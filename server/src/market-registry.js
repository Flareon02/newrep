// Canonical market registry (market semantics v2): one bookmaker-independent identity per bet.
//
// Every provider market is mapped from STRUCTURED provider data only — GGBET/DataBet typeId + specifiers + outcome ids,
// Fonbet factor ids, Pinnacle type/period/side/units/bestOf, Astek group (G/GS) + outcome template (T). A provider
// market that is not in the tables below is NOT guessed: it becomes `unknown` (kept with its raw identity and recorded
// in the unknown-market log for later classification). Titles/outcome names are never the source of the family; they
// are used only as outcome-level evidence where the provider's own template/caption says it (Astek T captions, GGBET
// over/under/yes/no outcome texts), and to label a market for a human.
//
// Identity: `id` = family + the parameters that change the bet (map, half, round, target, side, line, overtime, unit,
// variant). Lines are home-perspective for handicaps (+2.5 = the home team receives 2.5). Overtime is
// included / excluded / unspecified; markets with different values are different bets and are never merged.
// `eventKey` is the same identity oriented to the merged event's team order (ref.scoreReversed swaps home/away and
// negates handicap lines), so the same bet from different bookmakers gets the same `eventKey`.
//
// Evidence for every table entry (production SQLite journal, 2026-10-06): see docs/MARKET-COVERAGE.md.
// Changing a rule → bump MARKET_SEMANTICS_VERSION. History rows keep the raw provider data and are re-normalized when
// read, so a corrected rule applies to old observations without rewriting the database.

export const MARKET_SEMANTICS_VERSION = 2;

const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : null; };
const text = (v) => String(v ?? '').trim();
const fmt = (n) => { if (n == null) return ''; const r = Math.round(n * 1000) / 1000; return String(Object.is(r, -0) ? 0 : r); };
const signed = (n) => (n == null ? '' : n > 0 ? '+' + fmt(n) : fmt(n));
const specsOf = (m) => (m?.specifiers && typeof m.specifiers === 'object' && !Array.isArray(m.specifiers) ? m.specifiers
  : Object.fromEntries((Array.isArray(m?.specifiers) ? m.specifiers : []).map((x) => [text(x?.name), text(x?.value)]).filter(([k]) => k)));

// Sport classes decide the unit of a provider's generic handicap/total where the provider itself fixes it per sport.
const ROUND_SPORTS = /counter.?strike|^cs\s*2|valorant|rainbow|standoff|crossfire/i;
const KILL_SPORTS = /dota|league of legends|mobile legends|honor of kings|king of glory|arena of valor|wild rift/i;
const sportClass = (s) => (ROUND_SPORTS.test(String(s || '')) ? 'rounds' : KILL_SPORTS.test(String(s || '')) ? 'kills' : '');
const isCs = (s) => /counter.?strike|^cs\s*2/i.test(String(s || ''));

// ---------------------------------------------------------------------------------------------------- families ----
// title(p, teams) builds the Russian label; `cat` is the UI category; `ot` = overtime matters for this family.
const T1 = (t) => t.team1 || 'команда 1', T2 = (t) => t.team2 || 'команда 2';
const sideName = (p, t) => (p.side === 'home' ? T1(t) : p.side === 'away' ? T2(t) : 'команда');
const where = (p) => [p.map ? `Карта ${p.map}` : '', p.half ? `половина ${p.half}` : '', p.round ? `раунд ${p.round}` : ''].filter(Boolean).join(' · ');
const pre = (p) => { const w = where(p); return w ? w + ' — ' : ''; };
const otText = (p) => (p.ot === 'included' ? ' (с овертаймом)' : p.ot === 'excluded' ? ' (без овертайма)' : p.ot === 'unspecified' ? ' (овертайм: не указан)' : '');
const unitText = { maps: 'карт', rounds: 'раундов', kills: 'фрагов' };
export const FAMILIES = Object.freeze({
  match_winner: { cat: 'winners', title: () => 'Победитель матча' },
  match_1x2: { cat: 'winners', title: () => 'Исход матча 1X2' },
  double_chance: { cat: 'winners', title: (p) => pre(p) + 'двойной шанс' },
  map_winner: { cat: 'winners', title: (p) => `Карта ${p.map} — победитель${p.ot === 'included' ? ' (с овертаймом)' : ''}` },
  map_1x2: { cat: 'winners', ot: true, title: (p) => `Карта ${p.map} — исход 1X2${otText(p)}` },
  map_handicap: { cat: 'handicaps', title: () => 'Фора по картам' },
  map_total: { cat: 'totals', title: () => 'Тотал карт' },
  map_parity: { cat: 'specials', title: () => 'Чёт / нечёт карт' },
  correct_map_score: { cat: 'scores', title: () => 'Точный счёт по картам' },
  map_and_match: { cat: 'combined', title: () => 'Первая карта / матч' },
  team_wins_a_map: { cat: 'specials', title: (p, t) => `${sideName(p, t)} выиграет хотя бы одну карту` },
  way_to_win: { cat: 'combined', title: () => 'Способ победы' },
  handicap: { cat: 'handicaps', title: (p) => pre(p) + 'фора (единица не указана)' },
  total: { cat: 'totals', title: (p) => pre(p) + 'тотал (единица не указана)' },
  team_total: { cat: 'totals', title: (p, t) => pre(p) + `индивидуальный тотал — ${sideName(p, t)} (единица не указана)` },
  round_handicap: { cat: 'handicaps', ot: true, title: (p) => (p.map ? pre(p) : 'Матч — ') + 'фора по раундам' + otText(p) },
  round_handicap_3way: { cat: 'handicaps', ot: true, title: (p) => pre(p) + 'фора по раундам, 3 исхода' + otText(p) },
  asian_round_handicap: { cat: 'handicaps', ot: true, title: (p) => pre(p) + 'азиатская фора по раундам' + otText(p) },
  round_total: { cat: 'totals', ot: true, title: (p) => (p.map ? pre(p) : 'Матч — ') + 'тотал раундов' + otText(p) },
  round_total_3way: { cat: 'totals', ot: true, title: (p) => pre(p) + 'тотал раундов, 3 исхода' + otText(p) },
  asian_round_total: { cat: 'totals', ot: true, title: (p) => pre(p) + 'азиатский тотал раундов' + otText(p) },
  team_round_total: { cat: 'totals', ot: true, title: (p, t) => (p.map ? pre(p) : 'Матч — ') + `тотал раундов — ${sideName(p, t)}${otText(p)}` },
  round_parity: { cat: 'rounds', ot: true, title: (p) => pre(p) + 'чёт / нечёт раундов' + otText(p) },
  race_to_rounds: { cat: 'rounds', title: (p) => pre(p) + `кто первым возьмёт ${p.target} раундов` },
  round_winner: { cat: 'rounds', title: (p) => pre(p) + 'победитель раунда' },
  pistol_round_winner: { cat: 'rounds', title: (p) => pre(p) + 'победитель пистолетного раунда' },
  pistol_correct_score: { cat: 'scores', title: (p) => pre(p) + 'точный счёт пистолетных раундов' },
  bomb_planted: { cat: 'rounds', title: (p) => pre(p) + 'будет установлена бомба' },
  ace_in_round: { cat: 'rounds', title: (p) => pre(p) + 'будет эйс' },
  first_kill_in_round: { cat: 'rounds', title: (p) => pre(p) + 'первое убийство' },
  overtime: { cat: 'specials', title: (p) => pre(p) + 'будет овертайм' },
  overtime_1x2: { cat: 'winners', title: (p) => pre(p) + `овертайм ${p.target} — исход 1X2` },
  overtime_round_handicap: { cat: 'handicaps', title: (p) => pre(p) + `овертайм ${p.target} — фора по раундам` },
  correct_score: { cat: 'scores', ot: true, title: (p) => pre(p) + 'точный счёт' + otText(p) },
  winning_margin: { cat: 'combined', ot: true, title: (p) => pre(p) + `разница победы ${p.variant}` + otText(p) },
  winner_and_total_over: { cat: 'combined', ot: true, title: (p) => pre(p) + 'победитель + тотал больше' + otText(p) },
  winner_and_total_under: { cat: 'combined', ot: true, title: (p) => pre(p) + 'победитель + тотал меньше' + otText(p) },
  half_1x2: { cat: 'winners', title: (p) => pre(p) + 'исход 1X2' },
  half_double_chance: { cat: 'winners', title: (p) => pre(p) + 'двойной шанс' },
  half_round_handicap: { cat: 'handicaps', title: (p) => pre(p) + 'фора по раундам' },
  half_round_total: { cat: 'totals', title: (p) => pre(p) + 'тотал раундов' },
  half_team_round_total: { cat: 'totals', title: (p, t) => pre(p) + `тотал раундов — ${sideName(p, t)}` },
  half_correct_score: { cat: 'scores', title: (p) => pre(p) + 'точный счёт' },
  first_half_and_map_winner: { cat: 'combined', title: (p) => pre(p) + 'выиграет первую половину и карту' },
  kills_handicap: { cat: 'handicaps', ot: true, title: (p) => pre(p) + 'фора по фрагам' + otText(p) },
  kills_total: { cat: 'totals', ot: true, title: (p) => pre(p) + 'тотал фрагов' + otText(p) },
  team_kills_total: { cat: 'totals', title: (p, t) => pre(p) + `тотал фрагов — ${sideName(p, t)}` },
  kills_parity: { cat: 'specials', title: (p) => pre(p) + 'фраги: чёт / нечёт' },
  kills_total_at_minute: { cat: 'totals', title: (p) => pre(p) + `тотал фрагов на ${p.target}-й минуте` },
  race_to_kills: { cat: 'specials', title: (p) => pre(p) + `гонка до ${p.target} фрагов` },
  nth_kill: { cat: 'specials', title: (p) => pre(p) + `кто сделает ${p.target}-й фраг` },
  first_blood: { cat: 'specials', title: (p) => pre(p) + 'первая кровь' },
  map_duration: { cat: 'totals', title: (p) => pre(p) + 'продолжительность карты, минут' },
  winner_and_duration: { cat: 'combined', title: (p, t) => pre(p) + `${sideName(p, t)} выиграет + продолжительность карты` },
  winner_and_kills_total: { cat: 'combined', title: (p, t) => pre(p) + `${sideName(p, t)} выиграет + тотал фрагов` },
  winner_and_kills_parity: { cat: 'combined', title: (p) => pre(p) + 'победитель + чётность фрагов' },
  towers_total: { cat: 'totals', title: (p) => pre(p) + 'тотал башен' },
  dragons_total: { cat: 'totals', title: (p) => pre(p) + 'тотал драконов' },
  barons_total: { cat: 'totals', title: (p) => pre(p) + 'тотал баронов' },
  first_baron: { cat: 'specials', title: (p) => pre(p) + 'первый барон' },
  first_dragon_type: { cat: 'specials', title: (p) => pre(p) + 'тип первого дракона' },
  baron_type: { cat: 'specials', title: (p) => pre(p) + 'тип барона' },
  both_teams_dragon: { cat: 'specials', title: (p) => pre(p) + 'обе команды убьют дракона' },
  first_roshan: { cat: 'specials', title: (p) => pre(p) + 'первый Рошан' },
  both_teams_roshan: { cat: 'specials', title: (p) => pre(p) + 'обе команды убьют Рошана' },
  winner_by_roshan_kills: { cat: 'specials', title: (p) => pre(p) + 'победитель по убийствам Рошана' },
  roshan_kills_1x2: { cat: 'specials', title: (p) => pre(p) + '1X2 по убийствам Рошана' },
  first_courier_kill: { cat: 'specials', title: (p) => pre(p) + 'первое убийство курьера' },
  aegis_snatch: { cat: 'specials', title: (p) => pre(p) + 'Аегис будет украден' },
  rampage: { cat: 'specials', title: (p) => pre(p) + 'будет Rampage' },
  ultra_kill: { cat: 'specials', title: (p) => pre(p) + 'будет Ultra Kill' },
  player_kills_total: { cat: 'players', ot: true, title: (p) => pre(p) + `${p.variant} — тотал убийств` + otText(p) },
  player_deaths_total: { cat: 'players', ot: true, title: (p) => pre(p) + `${p.variant} — тотал смертей` + otText(p) },
  player_duel_winner: { cat: 'players', ot: true, title: (p) => pre(p) + `${p.variant} — дуэль по убийствам` + otText(p) },
  player_duel_1x2: { cat: 'players', ot: true, title: (p) => pre(p) + `${p.variant} — дуэль по убийствам, 1X2` + otText(p) },
  player_duel_handicap: { cat: 'players', ot: true, title: (p) => pre(p) + `${p.variant} — фора по убийствам` + otText(p) },
  most_kills_player: { cat: 'players', ot: true, title: (p) => pre(p) + 'игрок с наибольшим числом убийств' + otText(p) },
  most_deaths_player: { cat: 'players', ot: true, title: (p) => pre(p) + 'игрок с наибольшим числом смертей' + otText(p) },
  provider_special: { cat: 'specials', title: (p) => pre(p) + (p.label || 'специальный рынок') },
});
const PARAM_ORDER = ['map', 'half', 'round', 'target', 'side', 'line', 'unit', 'ot', 'variant', 'provider', 'rawType'];
export function canonicalId(family, params = {}) {
  const parts = [family];
  for (const k of PARAM_ORDER) {
    const v = params[k];
    if (v == null || v === '') continue;
    parts.push(`${k}=${k === 'line' && typeof v === 'number' ? (family.includes('handicap') ? signed(v) : fmt(v)) : String(v).toLowerCase()}`);
  }
  return parts.join('|');
}

// Outcome schemes: provider outcome → canonical outcome key (home, away, draw, over, under, exact, yes, no, odd, even,
// score:A-B, home+odd …). Opaque outcomes keep `id:<provider outcome id>` and are comparable only within one provider.
const SWAP = { home: 'away', away: 'home', 'home-draw': 'draw-away', 'draw-away': 'home-draw' };
export function orientOutcome(key) {
  if (!key) return key;
  if (SWAP[key]) return SWAP[key];
  let m = /^score:(\d+)-(\d+)$/.exec(key);
  if (m) return `score:${m[2]}-${m[1]}`;
  m = /^(home|away)\+(.+)$/.exec(key);
  if (m) return `${SWAP[m[1]]}+${m[2]}`;
  return key;
}
const scoreKey = (name) => { const m = /^\s*(\d+)\s*[:\-]\s*(\d+)\s*$/.exec(text(name)); return m ? `score:${Number(m[1])}-${Number(m[2])}` : null; };
const ouName = (name) => { const n = text(name).toLowerCase(); return /^(over|больше|powyżej)\b/.test(n) ? 'over' : /^(under|меньше|poniżej)\b/.test(n) ? 'under' : null; };
const parityName = (name) => { const n = text(name).toLowerCase(); return /\bodd\b|нечет|нечёт|nieparzyst/.test(n) ? 'odd' : /\beven\b|\bчет\b|\bчёт\b|parzyst/.test(n) ? 'even' : null; };

// ---------------------------------------------------------------------------------------------- GGBET / DataBet ----
// typeId → rule. `o`: outcome scheme by outcome id (verified on the journal: ids 1/2 = home/away for 2-way competitor
// markets, 1/2/3 = home/draw/away for 3-way, 1/2 = over/under, yes/no, odd/even; see docs/MARKET-COVERAGE.md).
const W2 = { 1: 'home', 2: 'away' }, W3 = { 1: 'home', 2: 'draw', 3: 'away' }, OU = { 1: 'over', 2: 'under' };
const YN = { 1: 'yes', 2: 'no' }, OE = { 1: 'odd', 2: 'even' }, OU3 = { 1: 'over', 2: 'exact', 3: 'under' }, HC3 = { 1: 'home', 2: 'exact', 3: 'away' };
const P1P2 = { 1: 'home', 2: 'away' };
const GG = {
  1: { f: 'match_winner', o: W2 },
  4: { f: 'round_parity', map: 1, ot: 'included', o: OE },
  5: { f: 'bomb_planted', map: 1, round: 1, o: YN },
  7: { f: 'map_winner', map: 1, ot: 'included', o: W2 },
  8: { f: 'race_to_rounds', map: 1, target: 'roundnr', o: W2 },
  10: { f: 'round_handicap', map: 1, line: 'hcp', ot: 'included', o: W2 },
  11: { f: 'overtime', map: 1, o: YN },
  13: { f: 'round_winner', map: 1, round: 1, o: W2 },
  14: { f: 'map_total', line: 'total', o: OU },
  17: { f: 'map_handicap', line: 'hcp', o: W2 },
  21: { f: 'map_1x2', map: 1, ot: 'excluded', o: W3 },
  27: { f: 'nth_kill', map: 1, target: 'xth', o: W2 },
  32: { f: 'towers_total', map: 1, line: 'total', o: OU },
  35: { f: 'kills_handicap', map: 1, line: 'hcp', ot: 'na', o: W2 },
  45: { f: 'rampage', map: 1, o: YN },
  47: { f: 'provider_special', map: 1, label: 'специальные рынки (комбинации)' },
  49: { f: 'race_to_kills', map: 1, target: 'xth', o: W2 },
  50: { f: 'map_winner', map: 1, o: W2 },
  51: { f: 'ultra_kill', map: 1, o: YN },
  67: { f: 'both_teams_dragon', map: 1, o: YN },
  79: { f: 'first_blood', map: 1, o: W2 },
  86: { f: 'barons_total', map: 1, line: 'total', o: OU },
  90: { f: 'dragons_total', map: 1, line: 'total', o: OU },
  96: { f: 'kills_parity', map: 1, o: OE },
  103: { f: 'round_handicap', line: 'hcp', ot: 'included', o: W2 },
  175: { f: 'first_roshan', map: 1, o: W2 },
  194: { f: 'round_total', line: 'total', ot: 'included', o: OU },
  292: { f: 'map_parity', o: OE },
  293: { f: 'pistol_round_winner', map: 1, round: 1, o: W2 },
  294: { f: 'team_kills_total', map: 1, side: 'home', line: 'total', o: OU },
  295: { f: 'team_kills_total', map: 1, side: 'away', line: 'total', o: OU },
  300: { f: 'round_total', map: 1, line: 'total', ot: 'unspecified', o: OU },
  318: { f: 'map_duration', map: 1, line: 'total', o: OU },
  348: { f: 'correct_map_score', o: 'score' },
  349: { f: 'correct_map_score', o: 'score' },
  351: { f: 'kills_total', map: 1, line: 'total', ot: 'na', o: OU },
  378: { f: 'round_total', map: 1, line: 'total', ot: 'included', o: OU },
  441: { f: 'half_correct_score', map: 1, half: 1, o: 'score' },
  443: { f: 'correct_score', map: 1, ot: 'unspecified', o: 'score' },
  454: { f: 'first_courier_kill', map: 1, o: W2 },
  460: { f: 'aegis_snatch', map: 1, o: YN },
  474: { f: 'first_dragon_type', map: 1, o: 'id' },
  475: { f: 'first_baron', map: 1, o: W2 },
  476: { f: 'kills_total', line: 'total', ot: 'na', o: OU },
  477: { f: 'kills_handicap', line: 'hcp', ot: 'na', o: W2 },
  538: { f: 'pistol_correct_score', map: 1, o: 'score' },
  539: { f: 'way_to_win', o: 'id' },
  545: { f: 'round_parity', map: 1, ot: 'unspecified', o: OE },
  560: { f: 'first_kill_in_round', map: 1, round: 1, o: W2 },
  683: { f: 'provider_special', map: 1, target: 'minute', label: 'активная руна на минуте' },
  786: { f: 'half_round_handicap', map: 1, half: 1, line: 'hcp', o: W2 },
  787: { f: 'half_team_round_total', map: 1, half: 1, side: 'home', line: 'total', o: OU },
  788: { f: 'half_team_round_total', map: 1, half: 1, side: 'away', line: 'total', o: OU },
  789: { f: 'half_1x2', map: 1, half: 1, o: W3 },
  790: { f: 'half_correct_score', map: 1, half: 1, o: 'score' },
  791: { f: 'overtime_1x2', map: 1, target: 'overtimenr', o: { 1: 'home', 2: 'draw', 3: 'away' } },
  792: { f: 'overtime_round_handicap', map: 1, target: 'overtimenr', line: 'hcp', o: W2 },
  838: { f: 'winner_and_duration', map: 1, side: 'home', line: 'total', o: OU },
  839: { f: 'winner_and_duration', map: 1, side: 'away', line: 'total', o: OU },
  840: { f: 'winner_and_kills_total', map: 1, side: 'home', line: 'total', o: OU },
  841: { f: 'winner_and_kills_total', map: 1, side: 'away', line: 'total', o: OU },
  842: { f: 'winner_and_kills_parity', map: 1, o: 'winparity' },
  850: { f: 'first_half_and_map_winner', map: 1, o: W2 },
  858: { f: 'provider_special', map: 1, target: 'minute', label: 'место активной руны на минуте' },
  859: { f: 'winner_by_roshan_kills', map: 1, o: W2 },
  860: { f: 'roshan_kills_1x2', map: 1, o: W3 },
  913: { f: 'player_kills_total', map: 1, variant: 'variant', line: 'total', ot: 'included', o: OU },
  925: { f: 'player_deaths_total', map: 1, variant: 'variant', line: 'total', ot: 'included', o: OU },
  927: { f: 'asian_round_total', map: 1, line: 'total', ot: 'unspecified', o: OU },
  929: { f: 'round_total_3way', map: 1, line: 'total', ot: 'unspecified', o: OU3 },
  939: { f: 'both_teams_roshan', map: 1, o: YN },
  973: { f: 'player_kills_total', map: 1, variant: 'variant', line: 'total', ot: 'na', o: OU },
  1115: { f: 'player_deaths_total', map: 1, variant: 'variant', line: 'total', ot: 'na', o: OU },
  1224: { f: 'ace_in_round', map: 1, round: 1, o: YN },
  1278: { f: 'player_duel_winner', map: 1, variant: 'variant', ot: 'included', o: P1P2 },
  1279: { f: 'player_duel_1x2', map: 1, variant: 'variant', ot: 'included', o: W3 },
  1280: { f: 'player_duel_handicap', map: 1, variant: 'variant', line: 'hcp', ot: 'included', o: W2 },
  1303: { f: 'kills_total_at_minute', map: 1, target: 'minute', line: 'total', o: OU },
  1518: { f: 'baron_type', map: 1, o: 'id' },
  1519: { f: 'correct_score', map: 1, ot: 'unspecified', o: 'score' },
  1564: { f: 'team_round_total', map: 1, side: 'home', line: 'total', ot: 'included', o: OU },
  1565: { f: 'team_round_total', map: 1, side: 'away', line: 'total', ot: 'included', o: OU },
  1590: { f: 'asian_round_handicap', map: 1, line: 'hcp', ot: 'included', o: W2 },
  1591: { f: 'round_handicap_3way', map: 1, line: 'hcp', ot: 'included', o: HC3 },
  1592: { f: 'winning_margin', map: 1, variant: 'score', ot: 'included', o: W2 },
  1593: { f: 'winner_and_total_over', map: 1, line: 'total', ot: 'included', o: W2 },
  1594: { f: 'winner_and_total_under', map: 1, line: 'total', ot: 'included', o: W2 },
  2444: { f: 'most_kills_player', map: 1, ot: 'included', o: 'id' },
  2445: { f: 'most_deaths_player', map: 1, ot: 'included', o: 'id' },
  407: { f: 'team_round_total', side: 'home', line: 'total', ot: 'included', o: OU },
  408: { f: 'team_round_total', side: 'away', line: 'total', ot: 'included', o: OU },
};
// 448/449 (attackers/defenders rounds total) and 1646 (game N top) were seen too rarely to classify: unknown.

function ggOutcome(rule, price, index) {
  if (!rule.o) rule = { ...rule, o: 'id' };
  const id = text(price?.outcomeId ?? price?.id ?? price?.providerOutcomeId);
  const name = price?.rawLabel ?? price?.outcomeName ?? price?.label ?? '';
  if (rule.o === 'score') return scoreKey(name) || (id ? `id:${id}` : null);
  if (rule.o === 'id') return id ? `id:${id}` : `pos:${index}`;
  if (rule.o === 'winparity') {
    const d = String(price?.designation || ''), side = /^(home|away)$/.test(d) ? d : W2[{ 1: 1, 2: 1, 3: 2, 4: 2 }[id]] || null;
    const par = parityName(name);
    return side && par ? `${side}+${par}` : id ? `id:${id}` : null;
  }
  if (id && rule.o[id]) return rule.o[id];
  // Outcome without a provider id (legacy rows / tests): the provider's own outcome semantics, never the position.
  const d = String(price?.designation || '').toLowerCase();
  if (price?.designationSource !== 'position' && /^(home|away|draw|over|under|yes|no|odd|even)$/.test(d)) {
    const values = new Set(Object.values(rule.o));
    if (values.has(d)) return d;
    if (d === 'draw' && values.has('exact')) return 'exact';
  }
  const ou = ouName(name);
  if (ou && Object.values(rule.o).includes(ou)) return ou;
  return null;
}
function platformCanonical(m, provider, ctx) {
  const rawType = Number(m?.rawType ?? m?.typeId ?? 0) || 0, rule = GG[rawType];
  if (!rule) return null;
  const sp = specsOf(m), p = {};
  const mapnr = num(sp.mapnr) ?? (Number(m?.period) > 0 ? Number(m.period) : null);
  if (rule.map) { if (!mapnr) return null; p.map = mapnr; }
  if (rule.half) { const h = num(sp.halfnr); if (!h) return null; p.half = h; }
  if (rule.round) { const r = num(sp.roundnr); if (!r) return null; p.round = r; }
  if (rule.target) { const t = text(sp[rule.target]); if (!t) return null; p.target = t; }
  if (rule.side) p.side = rule.side;
  if (rule.line) { const l = num(sp[rule.line]); if (l == null) return null; p.line = l; }
  if (rule.variant) { const v = text(sp[rule.variant]); if (!v) return null; p.variant = v; }
  if (rule.ot) p.ot = rule.ot;
  if (rule.f === 'provider_special') { p.provider = provider; p.rawType = rawType; p.label = rule.label; }
  return { family: rule.f, params: p, rule: `${provider}:typeId=${rawType}`, confidence: 'verified', outcome: (price, i) => ggOutcome(rule, price, i) };
}

// ---------------------------------------------------------------------------------------------------- Fonbet --------
// Factor ids (outcome-level). Pairs verified by price monotonicity across lines on the journal (>99%): lower id = home
// for handicaps, lower id = over for totals. Unit of 927-type handicaps / 930-type totals: rounds in round sports,
// kills in MOBA maps; match-level MOBA lines have no proven unit (left `total`/`handicap` with unit unspecified).
// Fonbet does not state overtime treatment in the feed → `unspecified` (never merged with included/excluded).
const FON = {
  921: ['winner', 'home'], 922: ['winner', 'draw'], 923: ['winner', 'away'],
  924: ['double', 'home-draw'], 925: ['double', 'draw-away'], 1571: ['double', 'home-away'],
  3262: ['map-handicap', 'home'], 3263: ['map-handicap', 'away'], 3274: ['map-total', 'over'], 3275: ['map-total', 'under'],
};
for (const [h, a] of [[910, 912], [927, 928], [989, 991], [1569, 1572], [1672, 1675], [1677, 1678], [1680, 1681], [1683, 1684], [1686, 1687], [1689, 1690], [1692, 1718]]) { FON[h] = ['handicap', 'home']; FON[a] = ['handicap', 'away']; }
for (const [o, u] of [[930, 931], [1696, 1697], [1727, 1728], [1730, 1731], [1733, 1734], [1736, 1737], [1793, 1794]]) { FON[o] = ['total', 'over']; FON[u] = ['total', 'under']; }
export const FONBET_FACTORS = Object.freeze(Object.fromEntries(Object.entries(FON).map(([k, v]) => [k, Object.freeze({ family: v[0], side: v[1] })])));
const factorOf = (price) => Number(price?.rawType ?? price?.outcomeId ?? price?.factorId);
function fonbetCanonical(m, ctx) {
  const factors = (m?.prices || m?.outcomes || []).map(factorOf);
  if (!factors.length || factors.some((f) => !FON[f])) return null;
  const kinds = new Set(factors.map((f) => FON[f][0]));
  if (kinds.size !== 1) return null;
  const kind = [...kinds][0], period = Number(m?.period) || 0, cls = sportClass(ctx.sport), p = {};
  if (period) p.map = period;
  const side = (price) => FON[factorOf(price)]?.[1] || null;
  // One handicap = one home-perspective line: every home price at h, every away price at -h (else not one market).
  const homeLine = () => {
    const lines = new Set((m.prices || m.outcomes || []).map((x) => { const v = num(x.points ?? x.line); return v == null ? null : side(x) === 'away' ? -v : v; }));
    return lines.size === 1 ? [...lines][0] : null;
  };
  const totalLine = () => { const lines = new Set((m.prices || m.outcomes || []).map((x) => num(x.points ?? x.line))); return lines.size === 1 ? [...lines][0] : null; };
  let family;
  if (kind === 'winner') family = period ? (factors.includes(922) ? 'map_1x2' : 'map_winner') : factors.includes(922) ? 'match_1x2' : 'match_winner';
  else if (kind === 'double') family = 'double_chance';
  else if (kind === 'map-handicap') { if (period) return null; family = 'map_handicap'; p.line = homeLine(); }
  else if (kind === 'map-total') { if (period) return null; family = 'map_total'; p.line = totalLine(); }
  else if (kind === 'handicap') {
    p.line = homeLine();
    family = cls === 'rounds' ? 'round_handicap' : cls === 'kills' && period ? 'kills_handicap' : 'handicap';
    p.ot = 'unspecified';
    if (family === 'handicap') { delete p.ot; p.unit = 'unspecified'; }
  } else if (kind === 'total') {
    p.line = totalLine();
    family = cls === 'rounds' ? 'round_total' : cls === 'kills' && period ? 'kills_total' : 'total';
    p.ot = 'unspecified';
    if (family === 'total') { delete p.ot; p.unit = 'unspecified'; }
  } else return null;
  if (family === 'map_1x2') p.ot = 'unspecified';
  if (['round_handicap', 'kills_handicap', 'handicap', 'map_handicap', 'round_total', 'kills_total', 'total', 'map_total'].includes(family) && p.line == null) return null;
  return { family, params: p, rule: `fonbet:factors=${[...new Set(factors)].sort((a, b) => a - b).join('/')}`, confidence: 'verified', outcome: (price) => side(price) };
}

// Journal rows written before 4.16 grouped Fonbet handicaps by |line| (home -2.5 and home +2.5 in one row) and paired
// unknown factors by guesswork. Split such a row into one market per factor pair + home-perspective line so each part
// is described on its own (unknown factors become single-outcome unknown markets).
export function splitLegacyMarket(provider, m = {}) {
  if (provider !== 'fonbet') return [m];
  const prices = m.prices || m.outcomes || [];
  if (prices.length <= 2 && !prices.some((x) => !FON[factorOf(x)])) return [m];
  const groups = new Map();
  for (const x of prices) {
    const f = FON[factorOf(x)], v = num(x.points ?? x.line);
    const key = !f ? `unknown:${factorOf(x)}` : f[0] === 'handicap' || f[0] === 'map-handicap' ? `${f[0]}:${v == null ? '' : f[1] === 'away' ? -v : v}` : f[0] === 'total' || f[0] === 'map-total' ? `${f[0]}:${v ?? ''}` : f[0];
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(x);
  }
  if (groups.size === 1) return [m];
  const field = m.prices ? 'prices' : 'outcomes', id = m.marketId ?? m.key ?? '';
  return [...groups].map(([key, list]) => ({ ...m, [field]: list, marketId: `${id}#${key}`, key: `${id}#${key}`, __split: true }));
}

// --------------------------------------------------------------------------------------------------- Pinnacle -------
// type moneyline/spread/total/team_total + period: 0 = match, 1..10 = map N, 11..17 = first half of map N-10,
// ≥18 = round markets. `units` (matchup) = Regular | Kills. Match-level spread/total are in maps for best-of ≥ 2.
// Pinnacle esports rules: Counter-Strike results after overtime are used for settlement → overtime included (CS only).
function pinnacleCanonical(m, ctx) {
  const type = text(m?.type ?? m?.rawType ?? m?.typeId).toLowerCase(), period = Number(m?.period) || 0;
  // Journal rows (≤4.15) carry no `units`: Pinnacle names the participants of its kills child matchup "<team> (Kills)".
  const kills = /\(kills\)\s*$/i.test(text(ctx.team1)) && /\(kills\)\s*$/i.test(text(ctx.team2));
  const units = text(ctx.units || (kills ? 'Kills' : 'Regular')).toLowerCase(), bestOf = Number(ctx.bestOf) || 0, cls = sportClass(ctx.sport);
  // team_total side: market field, or the last segment of Pinnacle's own market key ("s;1;tt;12.5;home").
  const sideOf = () => text(m?.side || /;(home|away)$/.exec(text(m?.key ?? m?.marketId))?.[1]).toLowerCase();
  const prices = m?.prices || m?.outcomes || [];
  const desig = (x) => { const d = String(x?.designation ?? x?.outcomeId ?? x?.outcomeName ?? '').toLowerCase(); return /^(home|away|draw|over|under)$/.test(d) ? d : null; };
  const line = (side) => { const x = prices.find((y) => desig(y) === side); return num(x?.points ?? x?.line); };
  const hLine = () => { const h = line('home'), a = line('away'); if (h != null && a != null && h !== -a) return null; return h ?? (a != null ? -a : null); };
  const tLine = () => { const o = line('over'), u = line('under'); if (o != null && u != null && o !== u) return null; return o ?? u; };
  const ot = cls === 'rounds' ? (isCs(ctx.sport) ? 'included' : 'unspecified') : 'na';
  const p = {};
  let family = null;
  if (units === 'kills') {
    if (period >= 1 && period <= 10) p.map = period; else if (period) return null;
    if (type === 'moneyline') return null; // a "Kills" moneyline is "most kills", not the map winner: not classified yet
    if (type === 'spread') { family = 'kills_handicap'; p.line = hLine(); p.ot = 'na'; }
    else if (type === 'total') { family = 'kills_total'; p.line = tLine(); p.ot = 'na'; }
    else if (type === 'team_total') { family = 'team_kills_total'; p.side = sideOf(); p.line = tLine(); }
  } else if (units === 'regular') {
    if (period === 0) {
      if (type === 'moneyline') family = prices.some((x) => desig(x) === 'draw') ? 'match_1x2' : 'match_winner';
      else if (type === 'spread' && bestOf >= 2) { family = 'map_handicap'; p.line = hLine(); }
      else if (type === 'total' && bestOf >= 2) { family = 'map_total'; p.line = tLine(); }
    } else if (period >= 1 && period <= 10) {
      p.map = period;
      if (type === 'moneyline') { family = prices.some((x) => desig(x) === 'draw') ? 'map_1x2' : 'map_winner'; if (family === 'map_1x2') p.ot = 'unspecified'; }
      else if (type === 'spread' && cls === 'rounds') { family = 'round_handicap'; p.line = hLine(); p.ot = ot; }
      else if (type === 'total' && cls === 'rounds') { family = 'round_total'; p.line = tLine(); p.ot = ot; }
      else if (type === 'team_total' && cls === 'rounds') { family = 'team_round_total'; p.side = sideOf(); p.line = tLine(); p.ot = ot; }
    } else if (period >= 11 && period <= 17 && cls === 'rounds') {
      p.map = period - 10; p.half = 1;
      if (type === 'moneyline') family = prices.some((x) => desig(x) === 'draw') ? 'half_1x2' : null;
      else if (type === 'spread') { family = 'half_round_handicap'; p.line = hLine(); }
      else if (type === 'total') { family = 'half_round_total'; p.line = tLine(); }
      else if (type === 'team_total') { family = 'half_team_round_total'; p.side = sideOf(); p.line = tLine(); }
    } else if (period >= 18 && cls === 'rounds' && type === 'moneyline') {
      const offset = period - 18; p.map = Math.floor(offset / 36) + 1; p.round = (offset % 36) + 1; family = 'round_winner';
    }
  }
  if (!family) return null;
  if ('line' in p && p.line == null) return null;
  if ('side' in p && !/^(home|away)$/.test(p.side)) return null;
  return { family, params: p, rule: `pinnacle:${units}:${type}:period=${period >= 18 ? '18+' : period}${period === 0 && bestOf ? ':bo' + (bestOf >= 2 ? '2+' : '1') : ''}`, confidence: 'verified', outcome: (x) => desig(x) };
}

// ------------------------------------------------------------------------------------------------------ Astek --------
// Group id G (and the semantic group GS where the feed gives it) + outcome templates T with captions from the official
// dictionary (server/src/astek-market-*.json). Only combinations whose T captions describe the bet are mapped.
const AT = { 1: 'home', 2: 'draw', 3: 'away', 7: 'home', 8: 'away', 9: 'over', 10: 'under', 11: 'over', 12: 'under', 13: 'over', 14: 'under', 759: 'yes', 761: 'no', 1365: 'home', 1366: 'away', 2822: 'home', 2823: 'away', 2824: 'over', 2825: 'under', 2826: 'home', 2827: 'away', 3508: 'even', 3509: 'odd', 3653: 'home', 3654: 'draw', 3655: 'away', 3656: 'home-draw', 3657: 'home-away', 3658: 'draw-away', 3862: 'home', 3863: 'away', 3864: 'over', 3865: 'under', 5167: 'even', 5168: 'odd', 14131: 'home', 14132: 'away', 14139: 'over', 14140: 'under', 14141: 'over', 14142: 'under', 3455: 'home', 3456: 'away', 3457: 'over', 3458: 'under', 3459: 'even', 3460: 'odd', 3461: 'home', 3462: 'away', 13716: 'home', 13717: 'away', 13292: 'home', 13293: 'away', 5606: 'yes', 5607: 'no', 5608: 'yes', 5609: 'no' };
// group → [allowed T ids, family, options]
const AG = {
  1: [[1, 2, 3], 'winner'],
  2: [[7, 8], 'handicap'],
  17: [[9, 10], 'total'],
  15: [[11, 12], 'team_total', { side: 'home' }],
  62: [[13, 14], 'team_total', { side: 'away' }],
  2438: [[2826, 2827], 'map_handicap', { match: true }], 753: [[2826, 2827], 'map_handicap', { match: true }],
  2436: [[2824, 2825], 'map_total', { match: true }], 752: [[2824, 2825], 'map_total', { match: true }],
  1136: [[3864, 3865], 'round_total', { match: true, ot: 'unspecified' }],
  2874: [[3862, 3863], 'round_handicap', { match: true, ot: 'unspecified' }],
  90: [[759, 761], 'overtime', { map: true }],
  403: [[1365, 1366], 'round_winner', { map: true, round: true }],
  2434: [[2822, 2823], 'race_to_rounds', { map: true, target: true }],
  2717: [[3508, 3509], 'round_parity', { map: true, ot: 'unspecified' }],
  6643: [[5167, 5168], 'map_parity', { match: true }],
  2766: [[3653, 3654, 3655], 'half_1x2', { map: true, half: 1 }],
  2768: [[3656, 3657, 3658], 'half_double_chance', { map: true, half: 1 }],
  10558: [[14131, 14132], 'round_handicap', { map: true, ot: 'excluded' }],
  10562: [[14139, 14140], 'team_round_total', { map: true, side: 'home', ot: 'excluded' }],
  10563: [[14141, 14142], 'team_round_total', { map: true, side: 'away', ot: 'excluded' }],
  2683: [[3455, 3456], 'kills_handicap', { map: true, ot: 'unspecified' }],
  2685: [[3457, 3458], 'kills_total', { map: true, ot: 'unspecified' }],
  2687: [[3459, 3460], 'kills_parity', { map: true }],
  2689: [[3461, 3462], 'race_to_kills', { map: true, target: true }],
  10423: [[13716, 13717], 'pistol_round_winner', { map: true, fixedRound: 13 }],
  10279: [[13292, 13293], 'pistol_round_winner', { map: true, fixedRound: 1 }],
  6993: [[5606, 5607], 'team_wins_a_map', { match: true, side: 'home' }],
  6995: [[5608, 5609], 'team_wins_a_map', { match: true, side: 'away' }],
};
function astekCanonical(m, ctx) {
  const prices = m?.prices || m?.outcomes || [];
  const ts = prices.map((x) => Number(x?.rawType ?? x?.outcomeId));
  const groups = [Number(m?.semanticGroup), Number(m?.rawGroup ?? m?.typeId)].filter((g) => Number.isFinite(g) && AG[g]);
  const g = groups.find((x) => ts.length && ts.every((t) => AG[x][0].includes(t)));
  if (g == null) return null;
  const [, kind, opt = {}] = AG[g], period = Number(m?.period) || 0, cls = sportClass(ctx.sport), p = {};
  if (opt.match && period) return null;
  if (opt.map && !period) return null;
  if (period) p.map = period;
  if (opt.half) p.half = opt.half;
  const param = num(prices.map((x) => x.points ?? x.line).find((x) => num(x) != null));
  const out = (x) => AT[Number(x?.rawType ?? x?.outcomeId)] || null;
  // Astek handicap points belong to the selected team; express the line from the home side.
  const hLine = () => { const lines = new Set(prices.map((x) => { const v = num(x.points ?? x.line); return v == null ? null : out(x) === 'away' ? -v : v; })); return lines.size === 1 ? [...lines][0] : null; };
  let family = kind;
  if (kind === 'winner') family = period ? (ts.includes(2) ? 'map_1x2' : 'map_winner') : ts.includes(2) ? 'match_1x2' : 'match_winner';
  if (family === 'map_1x2') p.ot = 'unspecified';
  if (['handicap', 'total', 'team_total'].includes(kind)) {
    // G2/G17/G15/G62: rounds on a map in round sports; at match level Astek also has separate map/round groups, so the
    // unit of the plain group is not proven there.
    const unit = period && cls === 'rounds' ? 'rounds' : period && cls === 'kills' ? 'kills' : '';
    family = unit === 'rounds' ? { handicap: 'round_handicap', total: 'round_total', team_total: 'team_round_total' }[kind]
      : unit === 'kills' ? { handicap: 'kills_handicap', total: 'kills_total', team_total: 'team_kills_total' }[kind] : kind;
    if (unit) p.ot = 'unspecified'; else p.unit = 'unspecified';
  }
  if (opt.side) p.side = opt.side;
  if (opt.ot) p.ot = opt.ot;
  if (opt.round) { if (param == null) return null; p.round = param; }
  if (opt.fixedRound) p.round = opt.fixedRound;
  if (opt.target) { if (param == null) return null; p.target = fmt(param); }
  if (/handicap/.test(family)) { p.line = hLine(); if (p.line == null) return null; }
  else if (/total/.test(family)) { p.line = param; if (p.line == null) return null; }
  return { family, params: p, rule: `astek:G=${g}:T=${[...new Set(ts)].sort((a, b) => a - b).join('/')}`, confidence: 'verified', outcome: out };
}

// ---------------------------------------------------------------------------------------------- unknown log --------
// Bounded in-memory log of markets nobody has classified yet (provider + raw identity + up to 3 real examples).
const UNKNOWN_LIMIT = 1500;
const unknown = new Map();
let unknownDirty = false;
export function recordUnknown(provider, m, ctx = {}) {
  const raw = rawIdentity(provider, m);
  const key = [provider, raw.rawType, raw.specKeys.join(','), raw.outcomeTypes.join(',')].join('|');
  let row = unknown.get(key);
  const now = Date.now();
  if (!row) {
    if (unknown.size >= UNKNOWN_LIMIT) { const oldest = [...unknown.entries()].sort((a, b) => a[1].lastSeen - b[1].lastSeen)[0]; if (oldest) unknown.delete(oldest[0]); }
    row = { provider, rawType: raw.rawType, specKeys: raw.specKeys, outcomeTypes: raw.outcomeTypes, count: 0, firstSeen: now, lastSeen: now, sports: [], examples: [] };
    unknown.set(key, row);
  }
  row.count++; row.lastSeen = now; unknownDirty = true;
  if (ctx.sport && !row.sports.includes(ctx.sport) && row.sports.length < 8) row.sports.push(ctx.sport);
  if (row.examples.length < 3 && !row.examples.some((x) => x.title === raw.title && x.period === raw.period))
    row.examples.push({ title: raw.title, period: raw.period, specifiers: raw.specifiers, outcomes: raw.outcomes.slice(0, 8), teams: [ctx.team1 || '', ctx.team2 || ''], at: now });
}
export function unknownMarkets({ provider = '' } = {}) {
  return [...unknown.values()].filter((r) => !provider || r.provider === provider).sort((a, b) => b.count - a.count);
}
export function restoreUnknown(rows = []) {
  for (const r of Array.isArray(rows) ? rows.slice(0, UNKNOWN_LIMIT) : []) if (r?.provider) unknown.set([r.provider, r.rawType, (r.specKeys || []).join(','), (r.outcomeTypes || []).join(',')].join('|'), r);
}
export const unknownChanged = () => { const d = unknownDirty; unknownDirty = false; return d; };
export function resetUnknown() { unknown.clear(); unknownDirty = false; }

export function rawIdentity(provider, m = {}) {
  const sp = specsOf(m);
  const prices = m?.prices || m?.outcomes || [];
  return {
    provider,
    rawType: text(m?.rawType ?? m?.typeId ?? m?.rawGroup ?? m?.type),
    semanticGroup: m?.semanticGroup ?? null,
    title: text(m?.rawTitle || m?.marketName || m?.title || m?.name),
    period: Number(m?.period) || 0,
    specifiers: sp,
    specKeys: Object.keys(sp).sort(),
    outcomeTypes: [...new Set(prices.map((x) => text(x?.rawType ?? x?.outcomeId ?? x?.designation)))].sort(),
    outcomes: prices.map((x) => ({ id: text(x?.outcomeId ?? x?.id ?? x?.rawType), label: text(x?.rawLabel ?? x?.outcomeName ?? x?.label ?? x?.designation), points: x?.points ?? x?.line ?? null })),
  };
}

// ---------------------------------------------------------------------------------------------------- public -------
const LEGACY_CATEGORY = { players: 'specials', rounds: 'rounds' };
/**
 * Canonical description of one provider market. `ctx` = { sport, team1, team2, reversed, bestOf, units }.
 * Returns { v, id, eventKey, family, params, title, category, confidence, rule, unknown, raw, outcomes[] } where
 * outcomes[i] = { key, eventKey } for prices[i] (null when the provider outcome has no canonical meaning).
 */
export function describeMarket(provider, m = {}, ctx = {}, { record = true } = {}) {
  const src = provider === 'databet' ? 'databet' : provider === 'ggbet' || /^ggbet-/.test(provider) ? 'ggbet' : provider;
  let hit = null;
  try {
    hit = src === 'ggbet' || src === 'databet' ? platformCanonical(m, src, ctx) : src === 'fonbet' ? fonbetCanonical(m, ctx) : src === 'pinnacle' ? pinnacleCanonical(m, ctx) : src === 'astek' ? astekCanonical(m, ctx) : null;
  } catch { hit = null; }
  const prices = m?.prices || m?.outcomes || [];
  const teams = { team1: ctx.eventTeam1 || (ctx.reversed ? ctx.team2 : ctx.team1), team2: ctx.eventTeam2 || (ctx.reversed ? ctx.team1 : ctx.team2) };
  if (!hit) {
    if (record) recordUnknown(src, m, ctx);
    const raw = rawIdentity(src, m);
    const id = canonicalId('unknown', { provider: src, rawType: raw.rawType || 'none' }) + (raw.specKeys.length ? '|' + raw.specKeys.map((k) => `${k}=${raw.specifiers[k]}`).join('|') : '') + `|period=${raw.period}`;
    return { v: MARKET_SEMANTICS_VERSION, id, eventKey: id, family: 'unknown', params: {}, title: raw.title || `Рынок ${raw.rawType || 'без типа'}`, category: 'specials', confidence: 'unknown', rule: '', unknown: true, raw: { rawType: raw.rawType, semanticGroup: raw.semanticGroup, title: raw.title, period: raw.period, specifiers: raw.specifiers }, outcomes: prices.map(() => null) };
  }
  const def = FAMILIES[hit.family];
  const params = { ...hit.params };
  // A two-way map winner in a round sport is settled on the final result, overtime included (there is no draw).
  if (hit.family === 'map_winner' && (sportClass(ctx.sport) === 'rounds' || params.ot === 'included')) params.ot = 'included';
  const id = canonicalId(hit.family, params);
  const outcomes = prices.map((x, i) => { let key = null; try { key = hit.outcome(x, i) || null; } catch { key = null; } return { key, eventKey: key && ctx.reversed ? orientOutcome(key) : key }; });
  const oriented = { ...params };
  if (ctx.reversed) {
    if (oriented.side === 'home' || oriented.side === 'away') oriented.side = SWAP[oriented.side];
    if (typeof oriented.line === 'number' && hit.family.includes('handicap')) oriented.line = -oriented.line;
  }
  const raw = rawIdentity(src, m);
  return {
    v: MARKET_SEMANTICS_VERSION, id, eventKey: canonicalId(hit.family, oriented), family: hit.family, params, eventParams: oriented,
    title: def.title(oriented, teams), category: def.cat, confidence: hit.confidence, rule: hit.rule, unknown: false,
    raw: { rawType: raw.rawType, semanticGroup: raw.semanticGroup, title: raw.title, period: raw.period, specifiers: raw.specifiers },
    outcomes,
  };
}

// Legacy fields kept for clients that read `canonical.family/title/category` (extension ≤ 9.3, market semantics v1).
const LEGACY_FAMILY = { match_winner: 'winner', map_winner: 'winner', match_1x2: 'winner', map_1x2: 'winner', map_handicap: 'map-handicap', map_total: 'map-total', round_handicap: 'round-handicap', round_total: 'round-total', team_round_total: 'team-round-total', race_to_rounds: 'race-to-rounds', round_winner: 'round-winner', pistol_round_winner: 'pistol-round-winner', correct_map_score: 'exact-score', correct_score: 'exact-score', overtime: 'overtime', round_parity: 'round-parity', map_parity: 'map-parity', asian_round_handicap: 'asian-round-handicap', asian_round_total: 'asian-round-total', round_total_3way: 'round-total-3way', round_handicap_3way: 'round-handicap-3way', winning_margin: 'winning-margin', winner_and_total_over: 'winner-total-over', winner_and_total_under: 'winner-total-under', half_1x2: 'half-winner', half_round_handicap: 'half-round-handicap', half_correct_score: 'half-exact-score', way_to_win: 'way-to-win', bomb_planted: 'bomb-planted', pistol_correct_score: 'pistol-exact-score', double_chance: 'double-chance', handicap: 'handicap', total: 'total', team_total: 'team-total' };
export function canonicalMarket(provider, m = {}, ctx = {}, opts) {
  const d = describeMarket(provider, m, ctx, opts);
  const p = d.params;
  return {
    // semantics v1 fields (unchanged meaning)
    provider: provider === 'databet' ? 'databet' : provider,
    rawType: Number(d.raw.rawType) || d.raw.rawType || 0,
    family: d.unknown ? 'special' : LEGACY_FAMILY[d.family] || d.family,
    category: LEGACY_CATEGORY[d.category] || d.category,
    scope: p.round ? 'round' : p.half ? 'half' : p.map ? 'map' : 'match',
    map: p.map || null, half: p.half || null, round: p.round || (d.family === 'race_to_rounds' ? Number(p.target) || null : null),
    line: typeof p.line === 'number' ? p.line : null,
    score: null, side: p.side || '', overtime: p.ot === 'included' ? 'include' : p.ot === 'excluded' ? 'exclude' : '',
    title: d.title, unknown: d.unknown,
    // semantics v2
    v: d.v, id: d.id, eventKey: d.eventKey, market: d.family, params: d.params, eventParams: d.eventParams || d.params,
    confidence: d.confidence, rule: d.rule, outcomes: d.outcomes, raw: d.raw,
  };
}
// Attaches `canonical` to every market of one provider odds tree (pure; returns new objects).
export function canonicalOdds(odds, provider, ctx = {}) {
  if (!odds || typeof odds !== 'object' || !Array.isArray(odds.markets)) return odds;
  return { ...odds, markets: odds.markets.map((m) => ({ ...m, canonical: canonicalMarket(provider, m, ctx) })) };
}
export function marketContext(ref = {}, event = {}) {
  return {
    sport: ref.category || event.category || '',
    team1: ref.odds?.team1 || ref.originalTeam1 || (ref.scoreReversed ? ref.team2 : ref.team1) || '',
    team2: ref.odds?.team2 || ref.originalTeam2 || (ref.scoreReversed ? ref.team1 : ref.team2) || '',
    reversed: ref.scoreReversed === true,
    bestOf: Number(ref.bestOf) || Number(event.bestOf) || 0,
    units: ref.units || ref.odds?.units || 'Regular',
    eventTeam1: event.team1 || '',
    eventTeam2: event.team2 || '',
  };
}
