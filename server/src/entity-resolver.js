import { log } from "./logger.js";
import GameCategories from './game-categories.cjs';
import {coalesce} from './identity.js';
import { clean, normalizeKey, readJson, writeJson } from './utils.js';
import { randomUUID } from 'node:crypto';
import { leagueStore } from './league-store.js';
import LeagueModel from './league-model.cjs';

const leagueEvidence=new Map();let aliasRevision=0,aliasTimer=null,persistAliases=false;
export const matcherRevision=()=>`${aliasRevision}.${leagueStore.revision()}`;
export async function loadMatcherAliases(){
  const saved=await readJson('entity-aliases.json',{});leagueEvidence.clear();
  for(const [key,values] of Object.entries(saved.leagues||{}))if(Array.isArray(values))leagueEvidence.set(key,new Set(values.slice(0,8).map(String)));
  await leagueStore.load(Array.isArray(saved.manualLeagueLinks)?saved.manualLeagueLinks:[]);
  aliasRevision++;persistAliases=true;
}
export async function flushMatcherAliases(){clearTimeout(aliasTimer);aliasTimer=null;if(persistAliases)await writeJson('entity-aliases.json',{schemaVersion:3,leagues:Object.fromEntries([...leagueEvidence].map(([key,values])=>[key,[...values]]))});}
function learnLeague(key,pair){
  if(!leagueEvidence.has(key))leagueEvidence.set(key,new Set());const evidence=leagueEvidence.get(key),before=evidence.size;
  if(before<8)evidence.add(pair);if(before<2&&evidence.size>=2)aliasRevision++;
  if(leagueEvidence.size>5000)leagueEvidence.delete(leagueEvidence.keys().next().value);
  if(persistAliases&&before!==evidence.size&&!aliasTimer){aliasTimer=setTimeout(()=>flushMatcherAliases().catch(e=>log.error('[matcher]',e.message)),1000);aliasTimer.unref?.();}
}

const CYR_MAP = {
  а:'a',б:'b',в:'v',г:'g',д:'d',е:'e',ё:'e',ж:'zh',з:'z',и:'i',й:'y',к:'k',л:'l',м:'m',н:'n',о:'o',п:'p',р:'r',с:'s',т:'t',у:'u',ф:'f',х:'h',ц:'ts',ч:'ch',ш:'sh',щ:'sch',ъ:'',ы:'y',ь:'',э:'e',ю:'yu',я:'ya'
};
const RU_REPL = [
  // Do not use JS \b around Cyrillic: \b follows ASCII-style word semantics
  // and can silently miss these phrases. New upstream requests use English,
  // these replacements mainly clean historical v1.2 records during migration.
  [/северная америка/giu,'North America'],[/южная америка/giu,'South America'],
  [/групповой этап/giu,'Group Stage'],[/регулярный сезон/giu,'Regular Season'],
  [/закрытая квалификация/giu,'Closed Qualifier'],[/открытая квалификация/giu,'Open Qualifier'],
  [/сравнение по киллам/giu,'Kills Comparison'],[/сравнение по картам/giu,'Maps Comparison'],
  [/плей-?офф/giu,'Playoffs'],[/квалификация/giu,'Qualifier'],[/финал/giu,'Final'],
  [/азия/giu,'Asia'],[/европа/giu,'Europe'],[/китай/giu,'China'],[/япония/giu,'Japan'],[/москва/giu,'Moscow']
];
const GENERIC_TEAM = new Set(['team','gaming','esport','esports','e-sports','club','squad','organization','org']);
const STAGE_WORDS = [
  'group stage','groups','group','regular season','swiss stage','swiss','playoffs','playoff','qualifier','qualifiers',
  'open qualifier','closed qualifier','upper bracket','lower bracket','grand final','finals','final','round robin','stage','series'
];
const CATEGORY_ALIASES = GameCategories.entries;

export function transliterate(value='') {
  return [...clean(value)].map((ch)=>{
    const low=ch.toLowerCase();
    if (!(low in CYR_MAP)) return ch;
    const out=CYR_MAP[low];
    return ch===ch.toUpperCase() && ch!==low ? out.charAt(0).toUpperCase()+out.slice(1) : out;
  }).join('');
}

// Pure string -> string normalizers are memoized (bounded, like norm): the resolver compares every fixture pair and
// re-normalized the same team/league names thousands of times per pass (History: ~1.5 s per resolve before).
function memoString(fn,max=20000){const cache=new Map();return (value='')=>{const key=String(value??'');const hit=cache.get(key);if(hit!==undefined)return hit;const out=fn(key);if(cache.size>=max)cache.clear();cache.set(key,out);return out;};}
export const englishize=memoString(englishizeRaw);
function englishizeRaw(value='') {
  let text=clean(value);
  for (const [re,to] of RU_REPL) text=text.replace(re,to);
  if (/[А-Яа-яЁё]/.test(text)) text=transliterate(text);
  return clean(text);
}

export function canonicalCategory(value='') {
  const text=englishize(value);
  for (const [re,name] of CATEGORY_ALIASES) if (re.test(text)) return name;
  return text || 'Esports';
}

function stripDiacritics(value='') { return String(value).normalize('NFKD').replace(/[\u0300-\u036f]/g,''); }
const normCache=new Map(),similarityCache=new Map(),leagueFamilyCache=new Map(),eventKindCache=new Map();
function norm(value='') {
  const cached=normCache.get(value);if(cached!==undefined)return cached;
  const result= stripDiacritics(englishize(value)).toLowerCase().replace(/&/g,' and ').replace(/[^a-z0-9]+/g,' ').replace(/\s+/g,' ').trim();
  if(normCache.size>20000)normCache.clear();normCache.set(value,result);return result;
}
function tokens(value='') { return norm(value).split(' ').filter(Boolean); }
function acronym(value='') {
  const t=tokens(value).filter((x)=>!['of','the','and','for','in','on','to'].includes(x));
  return t.map((x)=>x[0]||'').join('');
}
function teamCore(value='') {
  const t=tokens(value).filter((x)=>!GENERIC_TEAM.has(x));
  return t.join(' ');
}
function charBigrams(s){const out=[];for(let i=0;i+1<s.length;i++)out.push(s.slice(i,i+2));return out;}
function dice(a,b){
  a=norm(a).replace(/ /g,'');b=norm(b).replace(/ /g,'');
  if(!a||!b)return 0;if(a===b)return 1;
  const aa=charBigrams(a), bb=charBigrams(b); if(!aa.length||!bb.length)return a===b?1:0;
  const counts=new Map(); for(const x of aa)counts.set(x,(counts.get(x)||0)+1); let hit=0;
  for(const x of bb){const c=counts.get(x)||0;if(c>0){hit++;counts.set(x,c-1);}}
  return (2*hit)/(aa.length+bb.length);
}
function tokenJaccard(a,b){const A=new Set(tokens(a)),B=new Set(tokens(b));if(!A.size||!B.size)return 0;let inter=0;for(const x of A)if(B.has(x))inter++;return inter/(A.size+B.size-inter);}
function prefixScore(a,b){a=norm(a).replace(/ /g,'');b=norm(b).replace(/ /g,'');if(!a||!b)return 0;const min=Math.min(a.length,b.length);let i=0;while(i<min&&a[i]===b[i])i++;return i/Math.max(a.length,b.length);}
const aliasNorm=memoString(aliasNormRaw);
function aliasNormRaw(value='') {
  // Provider suffixes such as "(zh)" describe a feed/localization variant, not
  // a different roster. Canonicalize common roster-class synonyms before fuzzy
  // comparison so MIBR (Women) and MIBR Female (zh) share one identity.
  let s=teamCore(englishize(value).replace(/\((?:zh|cn|ru|en|pl|pt|br|es|fr|de)\)\s*$/i,''));
  const map=[
    [/\bnatus vincere\b/g,'navi'],[/\b1 win\b/g,'1win'],[/\b1w\b/g,'1win'],[/\b1w team\b/g,'1win'],
    [/\bd plus kia\b/g,'dplus kia'],[/\bdplus kia\b/g,'dplus'],[/\bkingzero esports\b/g,'kingzero'],[/\besports\b/g,''],
    [/\b(?:women|woman|womens|ladies|fe)\b/g,'female'],[/\bacad\b/g,'academy']
  ];
  for(const [re,to] of map)s=s.replace(re,to);
  return s.replace(/\s+/g,' ').trim();
}
function teamAbbreviationScore(a,b){
  const A=tokens(aliasNorm(a)),B=tokens(aliasNorm(b));let shared=0;
  while(A.length&&B.length&&A.at(-1)===B.at(-1)){A.pop();B.pop();shared++;}
  if(!shared||!A.length||!B.length)return 0;
  const leftA=A.join(''),leftB=B.join(''),short=leftA.length<=leftB.length?leftA:leftB,long=leftA.length<=leftB.length?leftB:leftA;
  if(short.length<2||short.length>5||long.length<short.length+2)return 0;
  let index=0;for(const ch of long)if(ch===short[index])index++;
  return index===short.length ? 0.98 : 0;
}
// Pinnacle sometimes shortens one participant to a bare initialism while the
// other books keep the full single-token name (e.g. largadosypelados -> LP).
// Keep this deliberately below exact/acronym matching; the event matcher still
// requires the other team, league and start time to agree.
function compactTeamAbbreviationScore(a,b){
  const A=aliasNorm(a).replace(/\s+/g,''),B=aliasNorm(b).replace(/\s+/g,'');
  if(!A||!B||A===B)return 0;
  const short=A.length<=B.length?A:B,long=A.length<=B.length?B:A;
  if(short.length<2||short.length>5||long.length<short.length+4)return 0;
  let i=0;for(const ch of long)if(ch===short[i])i++;
  if(i!==short.length)return 0;
  return short.length===2?0.88:0.94;
}

// Normalized edit similarity supplements token/bigram agreement for provider
// spellings (e.g. Yakutou/Yakult). It is never used by the UI search.
function editSimilarity(a,b){
  let row=Array.from({length:b.length+1},(_,i)=>i);
  for(let i=1;i<=a.length;i++){const next=[i];for(let j=1;j<=b.length;j++)next[j]=Math.min(next[j-1]+1,row[j]+1,row[j-1]+(a[i-1]===b[j-1]?0:1));row=next;}
  return 1-row[b.length]/Math.max(a.length,b.length,1);
}
function divisions(value){
  const map={women:'female',woman:'female',womens:'female',female:'female',ladies:'female',fe:'female',academy:'academy',acad:'academy',youth:'youth',junior:'junior',u18:'u18',u21:'u21'};
  // Female/Women are provider spelling variants of the same roster class.
  // Language suffixes such as "(zh)" are intentionally ignored.
  return tokens(value).map(x=>map[x]||x).filter(x=>['female','academy','youth','junior','u18','u21'].includes(x)).sort().join(' ');
}
export function stringSimilarity(a,b,{team=false}={}) {
  if(team&&divisions(a)!==divisions(b))return 0;
  const A=team?aliasNorm(a):norm(a),B=team?aliasNorm(b):norm(b);
  if(!A||!B)return 0;if(A===B)return 1;
  const key=(team?'t|':'s|')+(A<B?A+'\0'+B:B+'\0'+A),cached=similarityCache.get(key);if(cached!==undefined)return cached;
  const acA=acronym(A),acB=acronym(B);
  let score=Math.max(dice(A,B),editSimilarity(A,B),tokenJaccard(A,B)*0.96,prefixScore(A,B)*0.9,team?teamAbbreviationScore(a,b):0,team?compactTeamAbbreviationScore(a,b):0);
  if(!team&&acA&&acB&&acA.length>=3&&acA===acB)score=Math.max(score,0.96);
  if(A.length>=4&&B.length>=4&&(A.includes(B)||B.includes(A)))score=Math.max(score,Math.min(A.length,B.length)/Math.max(A.length,B.length)>=0.55?0.94:0.82);
  score=Math.min(1,score);if(similarityCache.size>60000)similarityCache.clear();similarityCache.set(key,score);return score;
}

export function primaryLeagueName(value='',category='') {
  let s=englishize(value).trim();
  const cat=canonicalCategory(category);
  // Remove bookmaker/game prefixes from the display name without changing the
  // source identity stored in leagueId/sourceRefs.
  const prefixes=[cat,'Counter Strike 2','Counter-Strike','CS 2','CS2','Dota 2','League of Legends','LoL'].filter(Boolean).sort((a,b)=>b.length-a.length);
  for(const prefix of prefixes){const re=new RegExp('^'+prefix.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')+'\\s*[.:/-]?\\s*','i');if(re.test(s)){s=s.replace(re,'').trim();break;}}
  s=s.replace(/\bUnited\s+21\b/gi,'United21').replace(/\bbo\s*[1357]\b/gi,'').trim();
  // Suffixes describe a stage/division of the same competition. Keep those in
  // sourceRefs for matching/audit, but use the stable tournament name in UI.
  s=s.replace(/(?:\s*[:.–—-]\s*)(?:division|div\.?|season|stage|group|groups|playoffs?|qualifiers?|qualification|regular season|swiss stage|upper bracket|lower bracket)\b.*$/i,'').trim();
  s=s.replace(/\s+series$/i,'').trim();
  return s.replace(/^[\s.,:;–—-]+|[\s.,:;–—-]+$/g,'').trim()||englishize(value)||'Unknown league';
}

export function leagueFamily(value='',category='') {
  const cacheKey=String(category)+'\0'+String(value),cached=leagueFamilyCache.get(cacheKey);if(cached!==undefined)return cached;
  let s=norm(value);
  const cat=norm(canonicalCategory(category));
  const catForms=[cat,'counter strike 2','counter strike','cs2','cs 2','dota 2','league of legends','lol','rainbow six siege','rainbow six'];
  for(const c of catForms.filter(Boolean).sort((a,b)=>b.length-a.length)) if(s.startsWith(c+' ')) s=s.slice(c.length).trim();
  s=s.replace(/\bbo\s*[1357]\b/g,' ')
    .replace(/\bbest of\s*[1357]\b/g,' ')
    .replace(/\bcomparison (by|on) (kills|maps|rounds)\b/g,' ')
    .replace(/\bmatch winner\b/g,' ');
  for(const word of STAGE_WORDS.sort((a,b)=>b.length-a.length)) {
    const re=new RegExp(`\\b${word.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')}\\b`,'g');
    s=s.replace(re,' ');
  }
  const result=s.replace(/\s+/g,' ').trim();if(leagueFamilyCache.size>20000)leagueFamilyCache.clear();leagueFamilyCache.set(cacheKey,result);return result;
}

function manualRef(input={},source='',category=''){
  const league=englishize(input.league||''),leagueId=clean(input.leagueId||''),cat=canonicalCategory(input.category||category);
  return {source,category:cat,league,leagueId,leagueKey:clean(input.leagueKey||''),family:leagueFamily(league,cat)};
}
export function manualLeagueLinked(a,b){
  return !!a&&!!b&&a.source!==b.source&&leagueStore.relation(a,b).linked;
}
export function getManualLeagueLinks(){return leagueStore.snapshot().links;}
// Internal migration/test convenience. The HTTP API never exposes unauthenticated writes.
export async function setManualLeagueLink(input={}){
  const category=canonicalCategory(input.category||input.astek?.category||input.fonbet?.category),astek=manualRef(input.astek,'astek',category),fonbet=manualRef(input.fonbet,'fonbet',category);
  await leagueStore.remember([astek,fonbet]);
  const base=getManualLeagueLinks(),next=LeagueModel.connect(base,[astek,fonbet],randomUUID());
  await leagueStore.commit(leagueStore.revision(),LeagueModel.diff(base,next));return leagueStore.group(astek);
}
export async function removeManualLeagueLink(id=''){
  if(!getManualLeagueLinks().some(row=>row.id===id))return false;
  await leagueStore.commit(leagueStore.revision(),{upsert:[],remove:[id]});return true;
}

export function leagueSimilarity(a,b,catA='',catB='') {
  const A=leagueFamily(a,catA),B=leagueFamily(b,catB);
  if(!A||!B)return 0.25;if(A===B)return 1;
  const acA=acronym(A),acB=acronym(B);
  let score=stringSimilarity(A,B);
  if(acA&&acB&&acA.length>=3&&acA===acB)score=Math.max(score,0.97);
  if((acA&&acA.length>=3&&acA===norm(B).replace(/ /g,''))||(acB&&acB.length>=3&&acB===norm(A).replace(/ /g,'')))score=Math.max(score,0.98);
  return score;
}

// LIVE statistics sources often keep scheduled times long after a series has
// actually started.  Statistics identity therefore deliberately ignores time:
// two participant names and the competition are the only automatic anchors.
// The 0.50 floor is intentionally symmetric: *both* teams and the league must
// independently clear it.  Archive/result lookup keeps its stricter time rules.
function statisticsLeagueNorm(value='') {
  return norm(value)
    .replace(/\b(?:dota\s*2|counter\s*strike\s*2|counter\s*strike|cs\s*2|cs2|csgo|esports?)\b/g,' ')
    .replace(/\b(?:season)\s*\d+\b/g,' ')
    .replace(/\b20\d{2}(?:\s*[-/]\s*20\d{2})?\b/g,' ')
    .replace(/\b(?:group\s*stage|groups?|playoffs?|qualifiers?|qualification|regular\s*season|upper\s*bracket|lower\s*bracket)\b/g,' ')
    .replace(/\b(?:bo|best\s*of)\s*[1357]\b/g,' ')
    .replace(/\s+/g,' ').trim();
}
function statisticsLeagueAcronym(value='') {
  let s=norm(value)
    .replace(/\b(?:season)\s*\d+\b/g,' ')
    .replace(/\b20\d{2}(?:\s*[-/]\s*20\d{2})?\b/g,' ')
    .replace(/\b(?:group\s*stage|groups?|playoffs?|qualifiers?|qualification|regular\s*season|upper\s*bracket|lower\s*bracket)\b/g,' ')
    .replace(/\b(?:bo|best\s*of)\s*[1357]\b/g,' ')
    .replace(/\s+/g,' ').trim();
  return acronym(s);
}
export function liveStatisticsLeagueSimilarity(a,b,category='') {
  const base=leagueSimilarity(a,b,category,category),A=statisticsLeagueNorm(a),B=statisticsLeagueNorm(b);
  let score=Math.max(base,A&&B?stringSimilarity(A,B):0);
  const rawA=norm(a).replace(/ /g,''),rawB=norm(b).replace(/ /g,''),compactA=A.replace(/ /g,''),compactB=B.replace(/ /g,''),acA=statisticsLeagueAcronym(a),acB=statisticsLeagueAcronym(b);
  if(acA&&acA.length>=3&&(acA===rawB||acA===compactB||acA===acB))score=Math.max(score,0.98);
  if(acB&&acB.length>=3&&(acB===rawA||acB===compactA||acA===acB))score=Math.max(score,0.98);
  return Math.min(1,score);
}
export function liveStatisticsMatchScore(team1,team2,other1,other2,leagueA='',leagueB='',category='') {
  const d1=stringSimilarity(team1,other1,{team:true}),d2=stringSimilarity(team2,other2,{team:true});
  const s1=stringSimilarity(team1,other2,{team:true}),s2=stringSimilarity(team2,other1,{team:true});
  const direct=(d1+d2)/2,swappedScore=(s1+s2)/2,swapped=swappedScore>direct;
  const pair=swapped?[s1,s2]:[d1,d2],teamMin=Math.min(...pair),teamMax=Math.max(...pair),teamScore=swapped?swappedScore:direct;
  const leagueScore=liveStatisticsLeagueSimilarity(leagueA,leagueB,category);
  if(teamMin<0.50||leagueScore<0.50)return null;
  const exactPair=teamMin>=0.995;
  return {score:0.80*teamScore+0.20*leagueScore,teamScore,teamMin,teamMax,leagueScore,swapped,exactPair};
}

export function pairTeamSimilarity(a,b){
  const direct1=stringSimilarity(a.team1,b.team1,{team:true}), direct2=stringSimilarity(a.team2,b.team2,{team:true});
  const swap1=stringSimilarity(a.team1,b.team2,{team:true}), swap2=stringSimilarity(a.team2,b.team1,{team:true});
  const direct=(direct1+direct2)/2, swapped=(swap1+swap2)/2;
  if(swapped>direct)return{score:swapped,min:Math.min(swap1,swap2),max:Math.max(swap1,swap2),swapped:true};
  return{score:direct,min:Math.min(direct1,direct2),max:Math.max(direct1,direct2),swapped:false};
}

// Main matches and derivative markets (AWP kills, player kills, maps, rounds)
// can have deceptively similar team names and start times. They must never be
// merged into one logical event.
export function eventKind(event={}) {
  const raw=[event.marketKind,event.league,event.team1,event.team2,event.name].filter(Boolean).join(' '),cached=eventKindCache.get(raw);if(cached!==undefined)return cached;
  const text=norm(raw);let kind='main';
  if(/\bawp (?:kills?|frags?)\b|\bsniper (?:kills?|frags?|rifle)\b/.test(text))kind='awp-kills';
  else if(/\b(?:kills?|frags?) comparisons?\b|\bcomparisons? (?:by|on) (?:kills?|frags?)\b|\bplayer (?:kills?|frags?)\b/.test(text))kind='kills-comparison';
  else if(/\bmaps? comparisons?\b|\bcomparisons? (by|on) maps?\b/.test(text))kind='maps-comparison';
  else if(/\brounds? comparisons?\b|\bcomparisons? (by|on) rounds?\b/.test(text))kind='rounds-comparison';
  if(eventKindCache.size>20000)eventKindCache.clear();eventKindCache.set(raw,kind);return kind;
}

function timeSimilarity(a,b,mode='prematch'){
  const A=Number(a||0),B=Number(b||0);if(!A||!B)return{score:.35,minutes:Infinity};
  const minutes=Math.abs(A-B)/60000;
  if(minutes<=5)return{score:1,minutes};if(minutes<=15)return{score:.98,minutes};if(minutes<=30)return{score:.92,minutes};
  if(minutes<=60)return{score:.82,minutes};if(mode==='prematch'&&minutes<=120)return{score:.62,minutes};return{score:0,minutes};
}


// Source-qualified aliases avoid accidental reuse across unrelated competitions.
function automaticLeagueKey(a,b){return 'v4|'+[a,b].map(e=>[e.source,canonicalCategory(e.category),e.leagueId||leagueFamily(e.league,e.category)].join(':')).sort().join('|');}
function inferredLeagueScore(a,b){return (leagueEvidence.get(automaticLeagueKey(a,b))?.size||0)>=2?.98:0;}
function prepareAutomaticLinks(events,mode){
 const rows=coalesce(events).map(e=>({...e,catalogId:e.catalogId||LeagueModel.id(e),category:leagueStore.group(e)?.category||GameCategories.resolve(englishize(e.category||e.sportName),englishize(e.league))}));
 const pairBuckets=new Map(),pairKey=e=>[aliasNorm(e.team1),aliasNorm(e.team2)].sort().join('|');
 rows.forEach((e,i)=>{const key=pairKey(e);if(!e.team1||!e.team2)return;if(!pairBuckets.has(key))pairBuckets.set(key,[]);pairBuckets.get(key).push(i);});
 // A generic Esports label is resolved only by one unambiguous participant pair.
 for(const a of rows.filter(e=>canonicalCategory(e.category)==='Esports')){
  // A generic provider category may still be resolved when exactly one other
  // bookmaker has the same fixture. Provider abbreviations such as
  // Wraith PCIFIC -> PCIFIC must not prevent category recovery. The relaxed
  // path is guarded by an exact opposite participant, very close time and a
  // strong tournament identity, so it cannot teach a category from a name
  // resemblance alone.
  const matches=rows.filter(b=>{
    if(b===a||b.source===a.source||canonicalCategory(b.category)==='Esports'||eventKind(a)!==eventKind(b)||leagueStore.relation(a,b).blocked)return false;
    const minutes=Math.abs(Number(a.startAt)-Number(b.startAt))/60000;if(!Number.isFinite(minutes)||minutes>10)return false;
    const teams=pairTeamSimilarity(a,b);if(teams.min===1)return true;
    const league=leagueSimilarity(a.league,b.league,b.category,b.category);
    return teams.max>=.995&&teams.min>=.60&&league>=.78&&minutes<=5;
  });
  const bySource=new Map();for(const b of matches){if(!bySource.has(b.source))bySource.set(b.source,[]);bySource.get(b.source).push(b);}
  const categories=new Set(matches.map(b=>canonicalCategory(b.category)));
  if(categories.size===1&&[...bySource.values()].every(list=>list.length===1))a.category=[...categories][0];
 }
 const pairs=[];
 for(const bucket of pairBuckets.values()){bucket.sort((i,j)=>Number(rows[i].startAt)-Number(rows[j].startAt));for(let x=0;x<bucket.length;x++)for(let y=x+1;y<bucket.length;y++){
  const i=bucket[x],j=bucket[y],a=rows[i],b=rows[j];if(Number(b.startAt)-Number(a.startAt)>15*60000)break;if(a.source===b.source||Math.abs(Number(a.startAt)-Number(b.startAt))>15*60000||pairTeamSimilarity(a,b).min!==1)continue;
  const info=eventMatchScore(a,b,{mode,inferredLeague:1});if(info)pairs.push({i,j,minutes:info.time.minutes});
 }}
 const alternatives=new Map();for(const p of pairs)for(const i of [p.i,p.j]){if(!alternatives.has(i))alternatives.set(i,[]);alternatives.get(i).push(p);}
 for(const pair of pairs){const {i,j}=pair,a=rows[i],b=rows[j];
  const ambiguous=[...(alternatives.get(i)||[]),...(alternatives.get(j)||[])].some(other=>other!==pair&&((other.i===i&&rows[other.j].source===b.source)||(other.j===i&&rows[other.i].source===b.source)||(other.i===j&&rows[other.j].source===a.source)||(other.j===j&&rows[other.i].source===a.source))&&other.minutes<=pair.minutes+5);
  if(!ambiguous)learnLeague(automaticLeagueKey(a,b),[aliasNorm(a.team1),aliasNorm(a.team2)].sort().join('|'));
 }
 return rows;
}

export function eventMatchScore(a,b,{mode='prematch',inferredLeague=0,allowSwapped=true,manualLeague=false}={}){
  const ca=canonicalCategory(a.category||a.sportName), cb=canonicalCategory(b.category||b.sportName);
  if(norm(ca)!==norm(cb)||eventKind(a)!==eventKind(b))return null;
  const relation=['astek','fonbet','pinnacle','ggbet','databet'].includes(a.source)&&['astek','fonbet','pinnacle','ggbet','databet'].includes(b.source)&&a.source!==b.source?leagueStore.relation(a,b):{blocked:false,linked:false};if(relation.blocked)return null;
  manualLeague=manualLeague||relation.linked;inferredLeague=Math.max(inferredLeague,inferredLeagueScore(a,b),...(a.sourceRefs||[]).map(r=>leagueSimilarity(r.league,b.league,r.category,b.category)));if(manualLeague)inferredLeague=1;
  const teams=pairTeamSimilarity(a,b),time=timeSimilarity(a.startAt,b.startAt,mode==='past'?'prematch':mode);
  if(!Number.isFinite(time.minutes)||time.score===0)return null;
  const rapid=/\bh2h\b|\b2x2\b|\b1x1\b/i.test(`${a.league} ${b.league}`);
  if(rapid&&time.minutes>2)return null;
  if(teams.swapped&&!allowSwapped)return null;
  if(a.source===b.source&&(time.minutes!==0||teams.min!==1||teams.swapped))return null;
  const league=Math.max(leagueSimilarity(a.league,b.league,ca,cb),Number(inferredLeague||0));
  // Some books aggressively shorten a single team name (PARIVISION -> PVISION,
  // Wraith PCIFIC -> PCIFIC). Accept that only when the other participant is
  // effectively exact, the tournament identity is strong and the start time is
  // very close. This is deliberately an event-level exception, not a global
  // team-name alias, so a fuzzy name cannot merge unrelated fixtures.
  const oneSideAlias=teams.max>=.995&&teams.min>=.60&&league>=.78&&time.minutes<=10;
  if(teams.min<.76&&!oneSideAlias)return null;
  // A reversed pair needs close scheduling AND strong two-sided identity and
  // league context. A pair of names on its own never licenses a merge.
  if(teams.swapped&&(teams.min<.94||league<.8||time.minutes>(rapid?1:teams.min===1&&league>=.8?60:15)))return null;
  // A season/series number or a different geographical division is evidence
  // against a match, even if the participants happen to be the same.
  const numberSet=e=>(leagueFamily(e.league,e.category).match(/\b\d+\b/g)||[]).join(',');
  if(!manualLeague&&numberSet(a)&&numberSet(b)&&numberSet(a)!==numberSet(b))return null;
  const region=e=>norm(e.league).match(/north america|south america|europe|european|china|japan|oceania/)?.[0]?.replace('european','europe');
  if(!manualLeague&&region(a)&&region(b)&&region(a)!==region(b))return null;
  const exact=teams.min===1;
  const anchored=teams.max>=.98&&teams.min>=.76&&league>=.86&&time.minutes<=15;
  if(!exact&&!anchored&&!oneSideAlias&&(teams.min<.88||league<.55))return null;
  if(time.minutes>30&&(!exact||league<.8))return null;
  if(league<.5&&(!exact||time.minutes>15))return null;
  const score=Math.max(.66*teams.score+.22*league+.12*time.score,exact&&time.minutes<=15?.93:0);
  if(score<.81)return null;
  return{score,teams,league,time,strongIdentity:exact||anchored||oneSideAlias,oneSideAlias,manualLeague};
}

function sourceRef(event){
  return {
    source:event.source||'astek',provider:event.provider||((event.source||'')==='fonbet'?'Fonbet':'AstekBet'),
    originalTeam1:event.originalTeam1||event.team1,originalTeam2:event.originalTeam2||event.team2,scoreReversed:event.scoreReversed===true,
    odds:event.odds,activeMap:event.activeMap,scoreObserved:event.scoreObserved,id:event.id,catalogId:event.catalogId||LeagueModel.id(event),sourceEventId:event.sourceEventId||event.id,url:event.url||'',category:event.category||'',categoryKey:event.categoryKey||'',league:event.league||'',leagueId:event.leagueId||'',leagueKey:event.leagueKey||'',
    team1:event.team1||'',team2:event.team2||'',team1Logo:event.team1Logo||'',team2Logo:event.team2Logo||'',startAt:Number(event.startAt||0),firstSeenAt:Number(event.firstSeenAt||0),lastSeenAt:Number(event.lastSeenAt||0),removedAt:Number(event.removedAt||0),enteredLiveAt:Number(event.enteredLiveAt||event.firstSeenAt||0),
    aliases:Array.isArray(event.aliases)?event.aliases:[],lifecycle:event.lifecycle||[],endedAt:Number(event.endedAt||0),resultVerified:event.resultVerified===true,resultSource:event.resultSource||'',bestOfSource:event.bestOfSource||'',bestOfEvidence:event.bestOfEvidence||'',marketKind:event.marketKind||eventKind(event),bestOf:Number(event.bestOf||0),seriesScore:event.seriesScore||null,mapScores:Array.isArray(event.mapScores)?event.mapScores:[],scoreText:event.scoreText||''
  };
}
function asciiQuality(value='') { const s=clean(value); if(!s)return-1; const ascii=(s.match(/[A-Za-z0-9]/g)||[]).length; const cyr=(s.match(/[А-Яа-яЁё]/g)||[]).length; return ascii*2-cyr*3+s.length*.02; }
function bestEnglish(values,{shorter=false}={}){
  const list=[...new Set(values.map(englishize).filter(Boolean))]; if(!list.length)return'';
  list.sort((a,b)=>{const qa=asciiQuality(a),qb=asciiQuality(b);if(qb!==qa)return qb-qa;return shorter?a.length-b.length:b.length-a.length;});return list[0];
}
function chooseLeague(refs,category){
  const vals=refs.map(r=>r.league).filter(Boolean);if(!vals.length)return'Unknown league';
  const families=vals.map(v=>leagueFamily(v,category)).filter(Boolean);
  const familyCounts=new Map();for(const f of families)familyCounts.set(f,(familyCounts.get(f)||0)+1);
  const bestFamily=[...familyCounts.entries()].sort((a,b)=>b[1]-a[1]||b[0].length-a[0].length)[0]?.[0]||'';
  const candidates=vals.filter(v=>leagueFamily(v,category)===bestFamily);
  return primaryLeagueName(bestEnglish(candidates.length?candidates:vals,{shorter:true})||bestEnglish(vals,{shorter:true}),category);
}
function chooseTeam(refs,key){return bestEnglish(refs.map(r=>r[key]).filter(Boolean),{shorter:false});}
function scoreQuality(ref){return (ref.scoreText?5:0)+(ref.seriesScore?3:0)+(ref.mapScores?.length||0)+(ref.source==='astek'?1:0);}

// Orient a provider record exactly once; keep its identity, URL and original
// ordering for reconciliation and score-change comparisons.
// Team logo of a logical fixture: AstekBet's first, then the other bookmakers of the SAME fixture (refs the resolver
// matched and oriented to the event's team order), never a different fixture's team that only has a similar name.
const LOGO_ORDER=['astek','ggbet','databet','fonbet','pinnacle'];
export function fixtureLogo(refs,n,anchor={}){for(const source of LOGO_ORDER){const r=(refs||[]).find(x=>x?.source===source&&x['team'+n+'Logo']);if(r)return r['team'+n+'Logo'];}return anchor['team'+n+'Logo']||'';}
export function orientEvent(event,anchor){
  if(!pairTeamSimilarity(anchor,event).swapped)return {...event};
  const flip=pair=>Array.isArray(pair)?[pair[1],pair[0]]:null;
  const seriesScore=flip(event.seriesScore),mapScores=(event.mapScores||[]).map(flip);
  const scoreText=seriesScore?`${seriesScore[0]}:${seriesScore[1]}${mapScores.length?` (${mapScores.map(x=>x.join(':')).join(', ')})`:''}`:String(event.scoreText||'').replace(/(\d+)\s*:\s*(\d+)/g,'$2:$1');
  return {...event,originalTeam1:event.originalTeam1||event.team1,originalTeam2:event.originalTeam2||event.team2,
    team1:event.team2,team2:event.team1,team1Logo:event.team2Logo||'',team2Logo:event.team1Logo||'',seriesScore,mapScores,scoreText,scoreReversed:!event.scoreReversed};
}
class DSU{constructor(n){this.p=Array.from({length:n},(_,i)=>i);}find(x){while(this.p[x]!==x){this.p[x]=this.p[this.p[x]];x=this.p[x];}return x;}union(a,b){a=this.find(a);b=this.find(b);if(a!==b)this.p[b]=a;}}
// Maximum-weight bipartite assignment. Each row gets one counterpart or its
// own zero-weight dummy column. No transitive chains across repeated fixtures.
export function maximumAssignment(weights){
  const n=weights.length;if(!n)return[];const real=weights[0]?.length||0,m=real+n;
  const u=Array(n+1).fill(0),v=Array(m+1).fill(0),p=Array(m+1).fill(0),way=Array(m+1).fill(0);
  for(let i=1;i<=n;i++){
    p[0]=i;let j0=0;const min=Array(m+1).fill(Infinity),used=Array(m+1).fill(false);
    do{used[j0]=true;const i0=p[j0];let delta=Infinity,j1=0;
      for(let j=1;j<=m;j++)if(!used[j]){const cost=-(j<=real?(weights[i0-1][j-1]||0):0)-u[i0]-v[j];if(cost<min[j]){min[j]=cost;way[j]=j0;}if(min[j]<delta){delta=min[j];j1=j;}}
      for(let j=0;j<=m;j++)if(used[j]){u[p[j]]+=delta;v[j]-=delta;}else min[j]-=delta;
      j0=j1;
    }while(p[j0]!==0);
    do{const j1=way[j0];p[j0]=p[j1];j0=j1;}while(j0);
  }
  const out=[];for(let j=1;j<=real;j++)if(p[j]&&weights[p[j]-1][j-1]>0)out.push([p[j]-1,j-1]);return out;
}

function credibleFinalResult(e={}){
  if(!e.resultVerified)return false;
  const series=Array.isArray(e.seriesScore)?e.seriesScore.map(Number):[];
  if(series.length!==2||series.some(v=>!Number.isFinite(v)||v<0))return false;
  const bo=Number(e.bestOf||0),target=[1,3,5,7].includes(bo)?Math.ceil(bo/2):1;
  return Math.max(...series)>=target;
}
function resultSignature(e={}){
  if(!credibleFinalResult(e))return '';
  const series=e.seriesScore.map(Number);
  const maps=Array.isArray(e.mapScores)?e.mapScores.map(row=>Array.isArray(row)?row.map(Number):[]):[];
  return JSON.stringify([series,maps]);
}
function observationWindow(e={}){
  const start=Math.min(...[e.firstSeenAt,e.enteredLiveAt,e.startAt].map(Number).filter(n=>n>0));
  const end=Math.max(0,...[e.lastSeenAt,e.removedAt,e.endedAt,e.updatedAt].map(Number).filter(n=>n>0));
  return {start:Number.isFinite(start)?start:0,end:end||0};
}
function duplicateQuality(e={}){
  return (credibleFinalResult(e)?80:0)+(e.endedAt?24:0)+(e.scoreObserved?12:0)+(e.scoreText?8:0)+(e.mapScores?.length||0)*2+(e.lifecycle?.length||0)+Math.min(10,Number(e.lastSeenAt||e.updatedAt||0)/1e13);
}
function sameSourceDuplicate(a,b,mode='prematch'){
  if(!a||!b||a.source!==b.source||eventKind(a)!==eventKind(b))return false;
  if(norm(canonicalCategory(a.category||a.sportName))!==norm(canonicalCategory(b.category||b.sportName)))return false;
  const teams=pairTeamSimilarity(a,b);if(teams.swapped||teams.min!==1)return false;
  const dt=Math.abs(Number(a.startAt||0)-Number(b.startAt||0))/60000;if(!Number.isFinite(dt)||dt>35)return false;
  const leagueIdA=clean(a.leagueId||''),leagueIdB=clean(b.leagueId||''),sameLeagueId=!!leagueIdA&&leagueIdA===leagueIdB;
  const league=leagueSimilarity(a.league,b.league,a.category,b.category);if(!sameLeagueId&&league<.94)return false;
  const boA=Number(a.bestOf||0),boB=Number(b.bestOf||0);if(boA&&boB&&boA!==boB)return false;
  const sigA=resultSignature(a),sigB=resultSignature(b);if(sigA&&sigB)return sigA===sigB;
  if(sameLeagueId&&dt<=3)return true;
  const A=observationWindow(a),B=observationWindow(b);
  if(A.start&&A.end&&B.start&&B.end){
    const overlap=Math.min(A.end,B.end)-Math.max(A.start,B.start);
    const gap=Math.max(A.start,B.start)-Math.min(A.end,B.end);
    if(overlap>=-2*60000||gap<=2*60000)return true;
  }
  // Historical providers sometimes replace an event ID while correcting its
  // scheduled time. Require one strong lifecycle/result signal before hiding it.
  if(mode==='past'&&(a.resultVerified||b.resultVerified)&&dt<=20&&league>=.98)return true;
  return false;
}
function mergeSourceDuplicate(a,b){
  const primary=duplicateQuality(b)>duplicateQuality(a)?b:a,secondary=primary===a?b:a;
  const ids=[a,b].flatMap(e=>[`${e.source}:${e.sourceEventId||e.id}`,...(e.aliases||[])]).filter(Boolean);
  const firsts=[a.firstSeenAt,a.enteredLiveAt,b.firstSeenAt,b.enteredLiveAt].map(Number).filter(n=>n>0);
  const lifecycle=[...new Map([...(a.lifecycle||[]),...(b.lifecycle||[])].map(c=>[`${c.type}:${c.at}`,c])).values()].sort((x,y)=>x.at-y.at);
  const bestResult=[a,b].filter(credibleFinalResult).sort((x,y)=>duplicateQuality(y)-duplicateQuality(x))[0];
  return {...secondary,...primary,
    aliases:[...new Set(ids)],
    firstSeenAt:firsts.length?Math.min(...firsts):Number(primary.firstSeenAt||0),
    enteredLiveAt:firsts.length?Math.min(...firsts):Number(primary.enteredLiveAt||0),
    lastSeenAt:Math.max(Number(a.lastSeenAt||0),Number(b.lastSeenAt||0)),removedAt:Math.max(Number(a.removedAt||0),Number(b.removedAt||0)),endedAt:Math.max(Number(a.endedAt||0),Number(b.endedAt||0)),lifecycle,
    ...(bestResult?{resultVerified:true,resultSource:bestResult.resultSource,scoreText:bestResult.scoreText,seriesScore:bestResult.seriesScore,mapScores:bestResult.mapScores}:{}),
    sourceEventId:String(primary.sourceEventId||primary.id)
  };
}
export function collapseSourceDuplicates(events,mode='prematch'){
  const rows=coalesce(Array.isArray(events)?events:[]).sort((a,b)=>String(a.source).localeCompare(String(b.source))||Number(a.startAt||0)-Number(b.startAt||0)),out=[],buckets=new Map();
  // A replacement ID can only belong to the same provider/category/event-kind
  // and the exact same oriented participant pair. Index by those stable fields
  // first, then inspect only the recent 35-minute window. This avoids an O(n²)
  // scan through years of same-provider history while keeping replacement-ID
  // detection strict.
  const bucketKey=row=>`${row.source}|${norm(canonicalCategory(row.category||row.sportName))}|${eventKind(row)}|${aliasNorm(row.team1)}|${aliasNorm(row.team2)}`;
  for(const row of rows){
    const key=bucketKey(row),bucket=buckets.get(key)||[],rowStart=Number(row.startAt||0);let merged=false;
    for(let n=bucket.length-1;n>=0;n--){
      const i=bucket[n],old=out[i],oldStart=Number(old?.startAt||0);
      if(rowStart>0&&oldStart>0&&rowStart-oldStart>35*60000)break;
      if(sameSourceDuplicate(old,row,mode)){out[i]=mergeSourceDuplicate(old,row);merged=true;break;}
    }
    if(!merged){const i=out.length;out.push(row);bucket.push(i);buckets.set(key,bucket);}
  }
  return out;
}

function resolveCore(events,{mode='prematch'}={}){
  const identities=new Map();
  for(const e of collapseSourceDuplicates(Array.isArray(events)?events:[],mode)){if(!e)continue;const key=`${e.source}:${e.sourceEventId||e.id}`;identities.set(key,{...e,catalogId:e.catalogId||LeagueModel.id(e),category:leagueStore.group(e)?.category||GameCategories.resolve(englishize(e.category||e.sportName),englishize(e.league)),team1:englishize(e.team1),team2:englishize(e.team2),league:englishize(e.league),marketKind:eventKind(e)});}
  const rows=[...identities.values()].sort((a,b)=>String(a.source).localeCompare(String(b.source))||String(a.id).localeCompare(String(b.id))),buckets=new Map(),candidates=[],dsu=new DSU(rows.length);
  rows.forEach((r,i)=>{const key=`${r.category}|${r.marketKind}`;if(!buckets.has(key))buckets.set(key,[]);buckets.get(key).push(i);});
  const horizon=(mode==='prematch'||mode==='past'?120:60)*60000;
  for(const indices of buckets.values()){
    indices.sort((i,j)=>Number(rows[i].startAt)-Number(rows[j].startAt));
    for(let x=0;x<indices.length;x++)for(let y=x+1;y<indices.length;y++){
      let i=indices[x],j=indices[y];if(Number(rows[j].startAt)-Number(rows[i].startAt)>horizon)break;
      if(rows[i].source===rows[j].source)continue;
      if(rows[i].source!=='astek')[i,j]=[j,i];
      if(leagueStore.relation(rows[i],rows[j]).blocked)continue;
      const manualLeague=manualLeagueLinked(rows[i],rows[j]);
      const info=eventMatchScore(rows[i],rows[j],{mode,inferredLeague:manualLeague?1:0,manualLeague});if(info)candidates.push({i,j,info});
    }
  }
  // Two independent exact participant pairs can establish a cross-source
  // tournament alias (e.g. APAC North / Asia). One fuzzy pair cannot teach one.
  const leaguePair=(i,j)=>`${rows[i].category}|${leagueFamily(rows[i].league,rows[i].category)}|${leagueFamily(rows[j].league,rows[j].category)}`;
  const anchors=new Map();for(const c of candidates)if(c.info.teams.min===1&&c.info.time.minutes<=15){const key=leaguePair(c.i,c.j);if(!anchors.has(key))anchors.set(key,new Set());const pair=[aliasNorm(rows[c.i].team1),aliasNorm(rows[c.i].team2)].sort().join('|');anchors.get(key).add(pair);learnLeague(key,pair);}
  const existing=new Set(candidates.map(c=>`${c.i}:${c.j}`));
  for(const indices of buckets.values())for(let x=0;x<indices.length;x++)for(let y=x+1;y<indices.length;y++){
    let i=indices[x],j=indices[y];if(Number(rows[j].startAt)-Number(rows[i].startAt)>horizon)break;if(rows[i].source===rows[j].source)continue;if(rows[i].source!=='astek')[i,j]=[j,i];
    if(leagueStore.relation(rows[i],rows[j]).blocked||existing.has(`${i}:${j}`)||(leagueEvidence.get(leaguePair(i,j))?.size||0)<2)continue;
    const info=eventMatchScore(rows[i],rows[j],{mode,inferredLeague:.97});if(info)candidates.push({i,j,info});
  }
  // Near ties cannot be resolved safely from the feed. Leave those records
  // separate instead of arbitrarily pairing the first one seen.
  const alternatives=new Map();for(const c of candidates)for(const i of [c.i,c.j]){if(!alternatives.has(i))alternatives.set(i,[]);alternatives.get(i).push(c);}
  const accepted=candidates.filter(c=>![c.i,c.j].some(i=>(alternatives.get(i)||[]).some(other=>other!==c&&Math.abs(other.info.score-c.info.score)<.012&&Math.abs(other.info.time.minutes-c.info.time.minutes)<3)));
  for(const c of accepted)dsu.union(c.i,c.j);
  const components=new Map();for(const c of accepted){const root=dsu.find(c.i);if(!components.has(root))components.set(root,[]);components.get(root).push(c);}
  const groups=[],paired=new Set();
  for(const edges of components.values()){
    const left=[...new Set(edges.map(c=>c.i))],right=[...new Set(edges.map(c=>c.j))],lookup=new Map(edges.map(c=>[`${c.i}:${c.j}`,c]));
    for(const [a,b] of maximumAssignment(left.map(i=>right.map(j=>lookup.get(`${i}:${j}`)?.info.score||0)))){
      const edge=lookup.get(`${left[a]}:${right[b]}`);groups.push({members:[rows[left[a]],rows[right[b]]],confidence:edge.info.score});paired.add(left[a]);paired.add(right[b]);
    }
  }
  rows.forEach((r,i)=>{if(!paired.has(i))groups.push({members:[r],confidence:1});});
  const out=[];
  for(const {members:group,confidence} of groups){
    const anchor=group.find(r=>r.source==='astek')||group[0];
    const refs=group.flatMap(e=>e.sourceRefs?.length?e.sourceRefs:[sourceRef(e)]).map(r=>orientEvent(r,anchor));
    const uniq=[...new Map(refs.map(r=>[`${r.source}:${r.sourceEventId||r.id}`,r])).values()];
    const category=anchor.category,astekRef=uniq.find(r=>r.source==='astek'),scoreRef=[...uniq].sort((a,b)=>scoreQuality(b)-scoreQuality(a))[0];
    const league=chooseLeague(uniq,category),family=leagueFamily(league,category);
    const starts=uniq.map(r=>Number(r.startAt||0)).filter(Boolean),firsts=uniq.map(r=>Number(r.firstSeenAt||0)).filter(Boolean),removeds=uniq.map(r=>Number(r.removedAt||0)).filter(Boolean);
    const both=new Set(uniq.map(r=>r.source)).size>1;
    out.push({...anchor,
      id:both?`logical:${mode}:${uniq.map(r=>`${r.source}-${r.sourceEventId||r.id}`).sort().join('|')}`:anchor.id,
      source:both?'merged':anchor.source,provider:both?uniq.map(r=>r.provider||r.source).join(' + '):anchor.provider,category,
      league,leagueKey:`logical:${normalizeKey(category)}:${normalizeKey(family)}`,
      leagueAliases:uniq.map(r=>({source:r.source,league:r.league,leagueId:r.leagueId,leagueKey:r.leagueKey,category,categoryKey:r.categoryKey})),
      team1:chooseTeam(uniq,'team1'),team2:chooseTeam(uniq,'team2'),team1Logo:fixtureLogo(uniq,1,anchor),team2Logo:fixtureLogo(uniq,2,anchor),startAt:starts.length?Math.min(...starts):0,
      firstSeenAt:firsts.length?Math.min(...firsts):0,enteredLiveAt:firsts.length?Math.min(...firsts):0,lastSeenAt:Math.max(0,...uniq.map(r=>Number(r.lastSeenAt||0))),
      removedAt:removeds.length===uniq.length?Math.max(...removeds):0,endedAt:Math.max(0,...uniq.map(r=>Number(r.endedAt||0))),resultVerified:uniq.some(r=>r.resultVerified),
      bestOf:Math.max(0,...uniq.map(r=>Number(r.bestOf||0)).filter(n=>[1,3,5,7].includes(n))),seriesScore:scoreRef?.seriesScore||null,mapScores:scoreRef?.mapScores||[],scoreText:scoreRef?.scoreText||'',
      url:astekRef?.url||anchor.url,sourceRefs:uniq,matchConfidence:confidence
    });
  }
  // Accepted cross-bookmaker fixtures provide league aliases to unmatched
  // fixtures from either source too (used by grouping and hidden tournaments).
  const aliases=new Map();for(const e of out)if(e.source==='merged')for(const r of e.leagueAliases){const key=`${r.category}|${r.source}:${r.leagueId||leagueFamily(r.league,r.category)}`;const prev=aliases.get(key);if(!prev||prev.leagueKey===e.leagueKey)aliases.set(key,e);else aliases.set(key,false);}
  for(const e of out){const r=e.sourceRefs[0],match=aliases.get(`${e.category}|${r.source}:${r.leagueId||leagueFamily(r.league,e.category)}`);if(match){e.leagueKey=match.leagueKey;e.leagueAliases=[...new Map([...e.leagueAliases,...match.leagueAliases].map(a=>[`${a.source}:${a.leagueId||a.league}`,a])).values()];}}
  for(const e of out){
    const refs=e.sourceRefs?.length?e.sourceRefs:[e],link=refs.map(ref=>leagueStore.group(ref)).find(Boolean);
    if(!link)continue;if(link.name)e.league=link.name;e.leagueKey=LeagueModel.groupKey(link);e.canonicalLeagueId=e.leagueKey;
    const manualAliases=LeagueModel.members(link);
    e.leagueAliases=[...new Map([...(e.leagueAliases||[]),...manualAliases].map(a=>[`${a.source}:${a.leagueId||a.league}`,a])).values()];
  }
  return out;
}

function attachProvider(base,providerRows,options={}){
 const mode=options.mode||'prematch';if(!providerRows.length)return base;
 const extra=resolveCore(providerRows,options),candidates=[],horizon=(mode==='prematch'||mode==='past'?120:60)*60000;
 // Extra providers are attached to the already-resolved core through a sparse
 // time/category index. This keeps each provider independent and avoids the
 // ambiguous multipartite assignment that would arise if 3+ bookmakers were
 // pushed through resolveCore at once.
 const buckets=new Map();
 for(let j=0;j<extra.length;j++){
  const b=extra[j],key=`${b.category}|${eventKind(b)}`;if(!buckets.has(key))buckets.set(key,[]);buckets.get(key).push({j,start:Number(b.startAt||0)});
 }
 for(const bucket of buckets.values())bucket.sort((a,b)=>a.start-b.start);
 const lowerBound=(bucket,value)=>{let lo=0,hi=bucket.length;while(lo<hi){const mid=(lo+hi)>>1;if(bucket[mid].start<value)lo=mid+1;else hi=mid;}return lo;};
 for(let i=0;i<base.length;i++){
  const a=base[i],at=Number(a.startAt||0);if(!at)continue;const bucket=buckets.get(`${a.category}|${eventKind(a)}`)||[];
  for(let k=lowerBound(bucket,at-horizon);k<bucket.length&&bucket[k].start<=at+horizon;k++){
   const j=bucket[k].j,b=extra[j],refs=a.sourceRefs?.length?a.sourceRefs:[a];
   const direct=refs.map(r=>eventMatchScore({...r,category:a.category},b,{mode}));
   const supported=direct.some(c=>c?.strongIdentity&&c.league>=.8&&c.time.minutes<=15);
   const checks=refs.map((r,index)=>direct[index]||(supported?eventMatchScore({...r,category:a.category},b,{mode,inferredLeague:.98}):null));if(checks.some(c=>!c))continue;
   candidates.push({i,j,score:Math.min(...checks.map(c=>c.score)),minutes:Math.min(...checks.map(c=>c.time.minutes))});
  }
 }
 const accepted=candidates.filter(c=>!candidates.some(d=>d!==c&&(d.i===c.i||d.j===c.j)&&Math.abs(d.score-c.score)<.012&&Math.abs(d.minutes-c.minutes)<3));
 const lookup=new Map(accepted.map(c=>[c.i+':'+c.j,c])),adjA=new Map(),adjB=new Map();
 for(const c of accepted){if(!adjA.has(c.i))adjA.set(c.i,new Set());if(!adjB.has(c.j))adjB.set(c.j,new Set());adjA.get(c.i).add(c.j);adjB.get(c.j).add(c.i);}
 const seenA=new Set(),seenB=new Set(),components=[];
 for(const seed of adjA.keys()){
  if(seenA.has(seed))continue;const left=[],right=[],queue=[['a',seed]];seenA.add(seed);
  while(queue.length){const [side,index]=queue.shift();if(side==='a'){left.push(index);for(const j of adjA.get(index)||[])if(!seenB.has(j)){seenB.add(j);queue.push(['b',j]);}}else{right.push(index);for(const i of adjB.get(index)||[])if(!seenA.has(i)){seenA.add(i);queue.push(['a',i]);}}}
  components.push({left,right});
 }
 const usedA=new Set(),usedB=new Set(),out=[];
 for(const {left,right} of components){
  const weights=left.map(i=>right.map(j=>lookup.get(i+':'+j)?.score||0));
  for(const [aIndex,bIndex] of maximumAssignment(weights)){
   const i=left[aIndex],j=right[bIndex];if(!lookup.has(i+':'+j))continue;usedA.add(i);usedB.add(j);
   const a=base[i],refs=a.sourceRefs?.length?a.sourceRefs:[a],anchorSource=refs.find(r=>r.source==='astek')?.source||refs[0]?.source||a.source;
   out.push(...resolveCore([{...a,source:anchorSource},extra[j]],options));
  }
 }
 return [...out,...base.filter((_,i)=>!usedA.has(i)),...extra.filter((_,j)=>!usedB.has(j))];
}

export function resolveEvents(events,options={}){
 const mode=options.mode||'prematch',rows=prepareAutomaticLinks(Array.isArray(events)?events:[],mode);
 // Keep the original Astek/Fonbet bipartite core intact, then attach additional
 // bookmakers one at a time. GGBET is LIVE-only today; keeping it out of the
 // core prevents a fourth source from changing established A/F matching.
 // DataBet (an alternative LIVE odds provider to GGBET) attaches the same way and never enters the core.
 const extras=['pinnacle','ggbet','databet'];
 let base=resolveCore(rows.filter(e=>!extras.includes(e.source)),options);
 for(const source of extras)base=attachProvider(base,rows.filter(e=>e.source===source),options);
 return base;
}
