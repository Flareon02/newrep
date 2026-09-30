import {fonbetOdds,fonbetOddsIndex} from './book-odds.js';
import GameCategories from "./game-categories.cjs";
import { clean, epochMs, slug } from "./utils.js";
import { canonicalCategory, englishize, eventKind } from "./entity-resolver.js";

const FONBET_LIVE_ESPORTS_URL = "https://fon.bet/live/esports";
const FONBET_PREMATCH_ESPORTS_URL = "https://fon.bet/sports/esports";

function normalized(value) { return clean(value).toLowerCase().replace(/ё/g, "е"); }

const CATEGORY_RULES = GameCategories.entries;

const CATEGORY_SLUGS = new Map([
  ["Counter Strike 2", "cs"], ["Dota 2", "dota2"], ["League of Legends", "lol"],
  ["Valorant", "valorant"], ["Rainbow Six Siege", "rss"], ["CrossFire", "crossfire"],
  ["Mobile Legends", "mobilelegends"], ["Rocket League", "rocketleague"],
  ["Arena of Valor", "arenaofvalor"], ["Honor of Kings", "honorofkings"],
  ["Standoff 2", "standoff2"], ["StarCraft", "starcraft2"], ["Quake", "quake"],
  ["Warcraft", "warcraft"], ["Overwatch", "overwatch"], ["PUBG", "pubg"],
  ["Call of Duty", "callofduty"], ["World of Tanks", "worldoftanks"], ["Age of Empires", "ageofempires"]
]);

function categoryFromNames(names) {
  const joined = names.filter(Boolean).join(" | ");
  for (const [rule, category] of CATEGORY_RULES) if (rule.test(joined)) return category;
  return "Esports";
}

function buildChain(sportId, sportsById) {
  const chain = [], visited = new Set();
  let current = sportsById.get(Number(sportId));
  for (let i = 0; current && i < 20; i += 1) {
    const id = Number(current.id);
    if (!Number.isFinite(id) || visited.has(id)) break;
    visited.add(id); chain.push(current);
    const parentId = Number(current.parentId);
    current = Number.isFinite(parentId) ? sportsById.get(parentId) : null;
  }
  return chain;
}

function findEsportsRoot(sports) {
  return sports.find((sport) => normalized(sport?.kind) === "sport" && (
    normalized(sport?.alias) === "esports" || normalized(sport?.name) === "киберспорт" || normalized(sport?.tabCaption) === "киберспорт"
  )) || sports.find((sport) => Number(sport?.id) === 29086) || null;
}

function categorySlug(category, alias = "") {
  const known = CATEGORY_SLUGS.get(clean(category));
  if (known) return known;
  const cleanAlias = clean(alias).toLowerCase().replace(/[^a-z0-9]+/g, "");
  if (cleanAlias && cleanAlias !== "esports" && cleanAlias !== "sport") return cleanAlias;
  return slug(category).replace(/-/g, "");
}

function buildFonbetEventUrl(raw, category, mode, categoryAlias = "") {
  const categoryPath = categorySlug(category, categoryAlias), eventId = clean(raw?.id), sportId = clean(raw?.sportId);
  if (!categoryPath || !sportId || !eventId) return mode === "prematch" ? FONBET_PREMATCH_ESPORTS_URL : FONBET_LIVE_ESPORTS_URL;
  if (mode === "prematch") return `https://fon.bet/sports/esports/category/${categoryPath}/${encodeURIComponent(sportId)}/${encodeURIComponent(eventId)}?mode=1`;
  return `https://fon.bet/live/esports/category/${categoryPath}/${encodeURIComponent(sportId)}/${encodeURIComponent(eventId)}`;
}

function num(value) { const n=Number(value); return Number.isFinite(n)?n:0; }
function inferBestOf(raw, names=[]) {
  const text=[raw?.name,raw?.comment,...names].map(clean).join(' ');
  const m=text.match(/\b(?:bo|best\s+of)\s*([1357])\b/i);
  return m?Number(m[1]):0;
}
function parseFonbetScore(raw, names=[], liveInfo=null, eventMisc=null, category="") {
  const candidates=[raw?.score,raw?.liveScore,raw?.result,raw?.scoreInfo].filter((x)=>x&&typeof x==='object');
  let s1=raw?.score1, s2=raw?.score2;
  for(const obj of candidates){if(s1===undefined)s1=obj?.score1??obj?.s1??obj?.S1;if(s2===undefined)s2=obj?.score2??obj?.s2??obj?.S2;}

  // Fonbet stores the live esports score in liveEventInfos[].scores:
  // scores[0][0] = series/maps score, scores[1] = individual map scores.
  const scoreGroups=Array.isArray(liveInfo?.scores)?liveInfo.scores:[];
  const seriesCell=Array.isArray(scoreGroups[0])?scoreGroups[0][0]:null;
  if(s1===undefined && seriesCell?.c1!==undefined)s1=seriesCell.c1;
  if(s2===undefined && seriesCell?.c2!==undefined)s2=seriesCell.c2;
  if(s1===undefined && eventMisc?.score1!==undefined)s1=eventMisc.score1;
  if(s2===undefined && eventMisc?.score2!==undefined)s2=eventMisc.score2;

  const has=s1!==undefined||s2!==undefined;
  let seriesScore=has?[num(s1),num(s2)]:null;
  const mapScores=[];
  const mapGroup=Array.isArray(scoreGroups[1])?scoreGroups[1]:[];
  for(const item of mapGroup){
    if(item?.c1===undefined && item?.c2===undefined)continue;
    mapScores.push([num(item?.c1),num(item?.c2)]);
  }
  if(!mapScores.length){
    for(const item of Array.isArray(eventMisc?.subScores)?eventMisc.subScores:[]){
      if(item?.score1===undefined && item?.score2===undefined)continue;
      mapScores.push([num(item?.score1),num(item?.score2)]);
    }
  }

  let bestOf=inferBestOf(raw,names);
  // In some CS2 live events scores[0][0] is a round/stat counter rather than
  // the series score (for example 45:6 while the current map is 4:6). Never
  // feed that value into the LIVE model as maps won. Rebuild only from maps
  // that are actually complete.
  if(bestOf>0&&/counter\s*strike|cs\s*2/i.test(String(category))&&seriesScore){
    const wins=Math.ceil(bestOf/2),valid=seriesScore.every(v=>Number.isInteger(v)&&v>=0&&v<=wins)&&seriesScore[0]+seriesScore[1]<=bestOf;
    if(!valid){const derived=[0,0];for(const [a,b] of mapScores){if(Math.max(a,b)>=13&&Math.abs(a-b)>=2)derived[a>b?0:1]++;}seriesScore=derived;}
  }
  if(bestOf>1){while(mapScores.length<bestOf)mapScores.push([0,0]);if(!seriesScore)seriesScore=[0,0];}
  let scoreText='';
  if(seriesScore)scoreText=`${seriesScore[0]}:${seriesScore[1]}${mapScores.length?` (${mapScores.map(x=>`${x[0]}:${x[1]}`).join(', ')})`:''}`;
  else if(typeof raw?.score==='string')scoreText=clean(raw.score);
  else if(clean(liveInfo?.scoreComment) && !/not started|не начался/i.test(clean(liveInfo?.scoreComment)))scoreText=clean(liveInfo.scoreComment);
  return {bestOf,bestOfSource:bestOf?"text":"unknown",seriesScore,mapScores,scoreText};
}

function parseEsportsFeed(payload, place, mode) {
  if (!payload || typeof payload !== "object") throw new Error("Fonbet: некорректный JSON");
  const rawEvents = Array.isArray(payload.events) ? payload.events : [];
  const sports = Array.isArray(payload.sports) ? payload.sports : [];
  const liveInfoByEventId = new Map();
  for (const info of Array.isArray(payload.liveEventInfos) ? payload.liveEventInfos : []) {
    const id = clean(info?.eventId || info?.id);
    if (id) liveInfoByEventId.set(id, info);
  }
  const eventMiscByEventId = new Map();
  for (const info of Array.isArray(payload.eventMiscs) ? payload.eventMiscs : []) {
    const id = clean(info?.eventId || info?.id);
    if (id) eventMiscByEventId.set(id, info);
  }
  const sportsById = new Map();
  for (const sport of sports) { const id = Number(sport?.id); if (Number.isFinite(id)) sportsById.set(id, sport); }
  const esportsRoot = findEsportsRoot(sports);
  if (!esportsRoot) throw new Error("Fonbet: не найден раздел Киберспорт в sports[]");
  const esportsRootId = Number(esportsRoot.id), events = [], seenIds = new Set();
  const rawPlaced = rawEvents.filter((event) => normalized(event?.place) === place);
  const esportsPlaced=rawPlaced.filter(raw=>buildChain(raw?.sportId,sportsById).some(item=>Number(item?.id)===esportsRootId));
  // The feed contains thousands of events across all sports. Build factor/child
  // indexes only for esports roots we are actually going to parse instead of
  // retaining references to the complete packet in temporary Maps.
  const oddsIndex=fonbetOddsIndex(payload,esportsPlaced.map(event=>clean(event?.id)).filter(Boolean));
  for (const raw of esportsPlaced) {
    const sourceId = clean(raw?.id), team1 = englishize(raw?.team1), team2 = englishize(raw?.team2);
    if (!sourceId || !team1 || !team2 || seenIds.has(sourceId)) continue;
    const chain = buildChain(raw?.sportId, sportsById);
    const leaf = chain[0] || null;
    const names = chain.map((item) => englishize(item?.name)).filter(Boolean);
    const league = englishize(leaf?.name) || englishize(raw?.name) || "Unknown league";
    const rootIndex = chain.findIndex((item) => Number(item?.id) === esportsRootId);
    const categoryNode = rootIndex > 0 ? chain[rootIndex - 1] : null;
    const detectedCategory = categoryFromNames(names);
    const category = canonicalCategory(detectedCategory !== "Esports" ? detectedCategory : englishize(categoryNode?.name || "Esports"));
    const categoryAlias = clean(categoryNode?.alias || "");
    const sportId = clean(raw?.sportId);
    events.push({
      id: `fonbet-${sourceId}`,
      sourceEventId: sourceId,
      source: "fonbet",
      odds:fonbetOdds(raw,payload,mode,oddsIndex),
      scoreObserved:mode==="live"&&!!(liveInfoByEventId.get(sourceId)?.scores?.length||eventMiscByEventId.get(sourceId)?.subScores?.length||raw.score||raw.score1!==undefined),
      provider: "Fonbet",
      category,
      categoryKey: `cat:${normalized(category).replace(/[^a-zа-я0-9]+/g, "-")}`,
      categorySlug: categorySlug(category, categoryAlias),
      subSportId: sportId,
      league,
      leagueId: sportId,
      leagueKey: `fonbet:id:${sportId || normalized(league)}`,
      tournamentInfoId: clean(leaf?.tournamentInfoId),
      team1, team2, sportName: category,
      marketKind:eventKind({league,team1,team2,name:raw?.name}),
      startAt: epochMs(raw?.startTime),
      updatedAt: Date.now(),
      broadcast:Array.isArray(raw?.tv)&&raw.tv.length?{available:true,provider:"Fonbet",channelIds:raw.tv.map(String),transport:"bookmaker-page"}:null,
      ...parseFonbetScore(raw, names, mode === "live" ? liveInfoByEventId.get(sourceId) : null, mode === "live" ? eventMiscByEventId.get(sourceId) : null, category),
      url: buildFonbetEventUrl(raw, category, mode, categoryAlias)
    });
    seenIds.add(sourceId);
  }
  return { events, rawEventCount: rawEvents.length, rawPlacedCount: rawPlaced.length, esportsEventCount: events.length, sportsCount: sports.length, esportsRootId };
}

export function parseFonbetLive(payload) { return parseEsportsFeed(payload, "live", "live"); }
export function parseFonbetPrematch(payload) { return parseEsportsFeed(payload, "line", "prematch"); }
