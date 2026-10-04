import {historyEventMeta} from './history-model.js';
import {astekOdds} from './book-odds.js';
import GameCategories from "./game-categories.cjs";
import { clean, epochMs, normalizeKey, slug } from "./utils.js";
import { canonicalCategory, englishize, eventKind } from "./entity-resolver.js";

export function inferCategoryFromLeague(league) {return GameCategories.infer(englishize(league));}

export function inferLiveCategory(raw) {return GameCategories.infer([raw?.SSN,raw?.L,raw?.LE,raw?.CHIMG,raw?.SE,raw?.SN].map(englishize).join(" "));}

function numberOrZero(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}
// Astek returns image filenames, not complete URLs. Keep only the expected
// image filename so an upstream value cannot become an arbitrary remote URL.
export function astekTeamLogo(value){
  const file=Array.isArray(value)?value[0]:value;
  return /^[a-f\d]{32}\.(?:png|webp|jpe?g)$/i.test(String(file||''))
    ?`https://v2l.traincdn.com/sfiles/logo_teams/${file}`:'';
}

export function bestOfDetails(raw={},league=''){
  const fields=[['MIO.MaF',raw?.MIO?.MaF],['bestOf',raw.bestOf],['BO',raw.BO],['BestOf',raw.BestOf],
    ...(Array.isArray(raw.MIS)?raw.MIS.filter(x=>Number(x.K)===3).map(x=>['MIS.K3',x.V]):[['MIS.K3',raw.MIS?.['3']]]),
    ['matchInfos.3',raw.matchInfos?.['3']],['league',league],['LE',raw.LE],['L',raw.L],['SSN',raw.SSN]];
  for(const [field,value] of fields){const text=clean(value),match=text.match(/\b(?:bo|best[\s-]*of)[\s:-]*([1357])\b/i),numeric=!['league','LE','L','SSN'].includes(field)&&/^[1357]$/.test(text);
    if(match||numeric)return {bestOf:Number(match?.[1]||text),bestOfSource:`astek:${field}`,bestOfEvidence:text};}
  return {bestOf:0,bestOfSource:'unknown',bestOfEvidence:''};
}
export function inferBestOf(raw,league=''){return bestOfDetails(raw,league).bestOf;}
export function parsePrematchFormats(payload){
  if(payload?.Success===false||!Array.isArray(payload?.Value))throw new Error('Некорректный ответ форматов AstekBet');
  return payload.Value.filter(row=>row?.I).map(row=>({id:String(row.I),...bestOfDetails(row,row.LE||row.L)})).filter(row=>row.bestOf);
}

function parseLiveScore(raw, league = "") {
  const fs = raw?.SC?.FS || {};
  const hasSeries = fs?.S1 !== undefined || fs?.S2 !== undefined;
  let seriesScore = hasSeries ? [numberOrZero(fs.S1), numberOrZero(fs.S2)] : null;
  const bestOf = inferBestOf(raw, league);
  const periods = Array.isArray(raw?.SC?.PS) ? raw.SC.PS : [];
  const byKey = new Map();
  for (const item of periods) {
    const key = Number(item?.Key || 0);
    const value = item?.Value || {};
    if (!key) continue;
    byKey.set(key, [numberOrZero(value?.S1), numberOrZero(value?.S2)]);
  }
  const mapCount = bestOf || Math.max(0, ...byKey.keys());
  const mapScores = [];
  for (let i = 1; i <= mapCount; i += 1) mapScores.push(byKey.get(i) || [0, 0]);
  // Some AstekBet LIVE rows do not expose SC.FS until a map has completed.
  // The map/round score is already live, so show an explicit 0:0 series instead
  // of hiding the whole score block.
  if (!seriesScore && (mapScores.length || bestOf)) seriesScore = [0, 0];
  const scoreText = seriesScore
    ? `${seriesScore[0]}:${seriesScore[1]}${mapScores.length ? ` (${mapScores.map((x) => `${x[0]}:${x[1]}`).join(", ")})` : ""}`
    : "";
  return { activeMap:Number(raw?.SC?.CP)||0,scoreObserved:!!(hasSeries||periods.length), bestOf, bestOfSource: bestOf ? 'format' : 'unknown', seriesScore, mapScores, scoreText };
}

export function parseLiveFeed(payload, origin) {
  if (!payload || typeof payload !== "object" || payload.Success === false || !Array.isArray(payload.Value)) {
    throw new Error("Некорректный LiveFeed payload");
  }
  const map = new Map();
  for (const raw of payload.Value) {
    if (!raw || typeof raw !== "object") continue;
    const id = clean(raw.I);
    if (!id) continue;
    const league = englishize(raw.LE || raw.L);
    const team1 = englishize(raw.O1E || raw.O1);
    const team2 = englishize(raw.O2E || raw.O2);
    const leagueId = clean(raw.LI);
    const category = canonicalCategory(inferLiveCategory(raw));
    const event = {
      id,
      sourceEventId: id,
      source: "astek",
      odds:astekOdds(raw,payload.Value,"live"),
      provider: "AstekBet",
      category,
      categoryKey: clean(raw.SSI) ? `ssi:${clean(raw.SSI)}` : `name:${normalizeKey(category)}`,
      subSportId: clean(raw.SSI),
      league,
      leagueId,
      leagueKey: leagueId ? `id:${leagueId}` : `name:${normalizeKey(league)}`,
      team1,
      team2,
      team1Logo:astekTeamLogo(raw.O1IMG),
      team2Logo:astekTeamLogo(raw.O2IMG),
      marketKind: eventKind({ league, team1, team2 }),
      sportName: clean(raw.SN || raw.SE),
      startAt: epochMs(raw.S),
      updatedAt: epochMs(raw.U),
      broadcast: Number(raw.VA)===1&&clean(raw.VI)?{available:true,provider:"AstekBet",videoId:clean(raw.VI),transport:"bookmaker-page"}:null,
      ...parseLiveScore(raw, league),
      url: id && leagueId && league && team1 && team2
        ? `${origin}/live/esports/${leagueId}-${slug(league)}/${id}-${slug(team1)}-${slug(team2)}`
        : `${origin}/live/esports`
    };
    historyEventMeta(event,{eventVersion:raw.version??null,clock:raw.SC?.TS??raw.SC?.clock??null,map:raw.SC?.CP??null,providerState:raw.SC??null,betStop:raw.B??null,providerTimestamp:epochMs(raw.U)});
    map.set(id, event);
  }
  return [...map.values()];
}

export function findEsportsFromPayload(payload) {
  const list = Array.isArray(payload?.Value) ? payload.Value : [];
  return list.find((item) => {
    if (!item || typeof item !== "object") return false;
    const id = Number(item.I);
    const name = `${clean(item.N)} ${clean(item.E)}`.toLowerCase();
    return id === 40 || name.includes("кибер") || name.includes("esport") || name.includes("cyber");
  }) || null;
}

export function extractCatalogFromPayload(esports) {
  const map = new Map();

  function addChamp(node, parentCategory, parentCategoryKey) {
    const leagueId = clean(node.LI);
    const league = englishize(node.LE || node.L);
    if (!leagueId || !league) return;
    const ownSSI = clean(node.SSI);
    const ownSSN = englishize(node.SSNE || node.SSN);
    const category = canonicalCategory(ownSSN || parentCategory || inferCategoryFromLeague(league));
    const categoryKey = ownSSI ? `ssi:${ownSSI}` : (parentCategoryKey || `name:${normalizeKey(category)}`);
    const gameCount = Number.isFinite(Number(node.GC)) ? Number(node.GC) : (Array.isArray(node.G) ? node.G.length : 0);
    map.set(leagueId, {
      champId: leagueId,
      leagueId,
      league,
      leagueKey: `id:${leagueId}`,
      category,
      categoryKey,
      subSportId: ownSSI,
      gameCount: Math.max(0, gameCount)
    });
  }

  function walk(node, parentCategory = "", parentCategoryKey = "") {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) {
      for (const child of node) walk(child, parentCategory, parentCategoryKey);
      return;
    }
    const hasSubChamps = Array.isArray(node.SC);
    const hasSSIField = Object.prototype.hasOwnProperty.call(node, "SSI");
    const hasSSN = !!clean(node.SSN);
    const hasGames = Array.isArray(node.G);
    let category = parentCategory;
    let categoryKey = parentCategoryKey;
    if (hasSubChamps) {
      const groupName = englishize(node.SSNE || node.SSN) || englishize(node.LE || node.L) || parentCategory;
      const groupSSI = clean(node.SSI);
      category = canonicalCategory(groupName || "Esports");
      categoryKey = groupSSI ? `ssi:${groupSSI}` : `group:${clean(node.LI) || normalizeKey(category)}`;
    }
    if (!hasSubChamps && clean(node.LI) && clean(node.L) && (hasSSIField || hasSSN || hasGames || !!parentCategory)) {
      addChamp(node, parentCategory, parentCategoryKey);
    }
    if (hasSubChamps) {
      for (const child of node.SC) walk(child, category, categoryKey);
    }
  }

  walk(esports?.L || [], "", "");
  return [...map.values()];
}

export function extractGamesFromPayload(payload, wantedChamp, origin) {
  const esports = findEsportsFromPayload(payload);
  if (!esports) return [];
  const map = new Map();

  function walk(node, ctx = {}) {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) {
      for (const child of node) walk(child, ctx);
      return;
    }
    const nodeLeagueId = clean(node.LI) || ctx.leagueId || "";
    const nodeLeague = englishize(node.LE || node.L) || ctx.league || "";
    const nodeSSN = englishize(node.SSNE || node.SSN) || ctx.category || "";
    const nodeSSI = clean(node.SSI) || ctx.subSportId || "";
    const format=bestOfDetails(node,nodeLeague),inheritedFormat=format.bestOf?format:ctx.format;
    const nextCtx = { leagueId: nodeLeagueId, league: nodeLeague, category: nodeSSN, subSportId: nodeSSI,format:inheritedFormat };
    const hasEventShape = clean(node.I) && (clean(node.O1) || clean(node.O1E)) && (clean(node.O2) || clean(node.O2E));
    if (hasEventShape) {
      const id = clean(node.I);
      const leagueId = nodeLeagueId || clean(wantedChamp?.leagueId);
      const league = nodeLeague || clean(wantedChamp?.league);
      const category = canonicalCategory(nodeSSN || clean(wantedChamp?.category) || inferCategoryFromLeague(league));
      const categoryKey = nodeSSI ? `ssi:${nodeSSI}` : (clean(wantedChamp?.categoryKey) || `name:${normalizeKey(category)}`);
      const team1 = englishize(node.O1E || node.O1);
      const team2 = englishize(node.O2E || node.O2);
      map.set(id, {
        id,
        sourceEventId: id,
        source: "astek",
        odds:astekOdds(node,[],"prematch"),
        provider: "AstekBet",
        category,
        categoryKey,
        subSportId: nodeSSI || clean(wantedChamp?.subSportId),
        league,
        leagueId,
        leagueKey: leagueId ? `id:${leagueId}` : `name:${normalizeKey(league)}`,
        team1,
        team2,
        team1Logo:astekTeamLogo(node.O1IMG),
        team2Logo:astekTeamLogo(node.O2IMG),
        marketKind: eventKind({ league, team1, team2 }),
        startAt: epochMs(node.S),
        ...(inheritedFormat?.bestOf?inheritedFormat:bestOfDetails(wantedChamp||{},league)),
        url: id && leagueId && league && team1 && team2
          ? `${origin}/line/esports/${leagueId}-${slug(league)}/${id}-${slug(team1)}-${slug(team2)}`
          : `${origin}/line/esports`
      });
    }
    for (const [key, value] of Object.entries(node)) {
      if (!value || typeof value !== "object") continue;
      if (["E", "AE", "SG", "MIS", "MS"].includes(key)) continue;
      walk(value, nextCtx);
    }
  }

  walk(esports, {});
  const events = [...map.values()];
  if (!wantedChamp?.champId) return events;
  return events.filter((event) => !event.leagueId || event.leagueId === String(wantedChamp.champId));
}
