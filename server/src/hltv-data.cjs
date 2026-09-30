(function(root){
'use strict';
const PlayerData=typeof module!=='undefined'&&module.exports?require('./hltv-player-data.cjs'):root.HltvPlayerData;
// A deliberately small, non-executing HTML reader. Imported scripts, cookies,
// headers, advertisements and account information never enter the dataset.
const clean=s=>String(s||'').replace(/\s+/g,' ').trim();
const decode=s=>String(s||'').replace(/&(#x[\da-f]+|#\d+|amp|quot|apos|lt|gt|nbsp);/gi,(_,v)=>v[0]==='#'?String.fromCodePoint(Math.min(0x10ffff,parseInt(v.slice(v[1]?.toLowerCase()==='x'?2:1),v[1]?.toLowerCase()==='x'?16:10)||32)):({amp:'&',quot:'"',apos:"'",lt:'<',gt:'>',nbsp:' '})[v.toLowerCase()]);
function html(input){
 const tree={tag:'root',a:{},c:[]},stack=[tree],voids=new Set(['img','br','hr','meta','link','input','source','area','wbr','embed','param','col','base']);
 const source=String(input).replace(/<!--[^]*?-->/g,'').replace(/<(script|style|noscript)\b[^>]*>[^]*?<\/\1\s*>/gi,'');
 for(const token of source.matchAll(/<\/?[a-z][^>"']*(?:(?:"[^"]*"|'[^']*')[^>"']*)*>|[^<]+/gi)){
  const s=token[0];if(s[0]!=='<'){stack.at(-1).c.push(decode(s));continue;}
  const tag=s.match(/^<\/?([\w-]+)/)?.[1]?.toLowerCase();if(!tag)continue;
  if(s[1]==='/'){for(let i=stack.length-1;i>0;i--)if(stack[i].tag===tag){stack.length=i;break;}continue;}
  const a={};for(const m of s.slice(tag.length+1,-1).matchAll(/([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g))a[m[1].toLowerCase()]=decode(m[2]??m[3]??m[4]??'');
  const n={tag,a,c:[]};stack.at(-1).c.push(n);if(!voids.has(tag)&&!s.endsWith('/>'))stack.push(n);
 }
 return tree;
}
function all(n,p){const out=[];function visit(x){if(typeof x!=='object')return;if(p(x))out.push(x);for(const c of x.c)visit(c);}if(n)visit(n);return out;}
const cls=(n,k)=>all(n,x=>(x.a.class||'').split(/\s+/).includes(k));
const first=(n,k)=>cls(n,k)[0];
const text=n=>n?clean(n.c.map(c=>typeof c==='string'?c:text(c)).join(' ')):'';
const number=s=>{const m=String(s??'').replace(/,/g,'').match(/-?\d+(?:\.\d+)?/);return m?Number(m[0]):null;};
const val=(n,k)=>number(text(first(n,k)));
const idOf=(href,kind)=>Number(String(href||'').match(new RegExp('/'+kind+'/(\\d+)'))?.[1])||0;
const slug=s=>String(s||'team').normalize('NFKD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'')||'team';
const norm=s=>clean(s).normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]/gu,'');
function person(link,nickname){const id=idOf(link?.a.href,'player');return id?{id,name:nickname||text(link),slug:link.a.href.split('/').at(-1)}:null;}
function parseSearch(payload){
 const groups=Array.isArray(payload)?payload:[payload],teams=[],players=[];
 for(const group of groups){for(const t of group.teams||[])if(t.id){teams.push({id:Number(t.id),name:String(t.name),slug:String(t.location||'').split('/').at(-1)||slug(t.name),players:(t.players||[]).map(p=>({id:idOf(p.location,'player'),name:String(p.nickName||p.nickname||p.name||''),slug:String(p.location||'').split('/').at(-1)})).filter(p=>p.id&&p.name)});}
  for(const p of group.players||[]){const id=Number(p.id)||idOf(p.location,'player');if(id&&(p.nickName||p.nickname||p.name))players.push({id,name:String(p.nickName||p.nickname||p.name),slug:String(p.location||'').split('/').at(-1)||slug(p.nickName||p.name)});}
 }
 return {teams,players,matches:[]};
}
function snapshot(p,url,at,extra={}){
 const filters={};for(const k of ['csVersion','matchType','rankingFilter','maps','event','teamId'])if(url.searchParams.has(k))filters[k]=url.searchParams.get(k);
 return {source:url.href,at,startDate:url.searchParams.get('startDate'),endDate:url.searchParams.get('endDate'),period:url.searchParams.has('startDate')?'date range':'all time',filters,rating:p.rating,ratingVersion:p.ratingVersion,maps:p.ratingMaps??p.maps,rounds:p.rounds,kpr:p.kpr,dpr:p.dpr,adr:p.adr,headshots:p.headshots,...extra};
}
function parseTeam(doc,url,at){
 const id=idOf(url.pathname,'team'),profile=first(doc,'teamProfile');if(!id||!profile)throw Error('Не найдена карточка команды HLTV');
 const name=text(first(profile,'profile-team-name'))||text(all(doc,n=>n.tag==='title')[0]).replace(/ team overview[^]*/,''),team={id,name,slug:url.pathname.split('/').at(-1),at,url:url.href,players:[],maps:[],matches:[]};
 for(const n of cls(profile,'profile-team-stat')){const t=text(n);if(t.includes('World ranking'))team.rank=number(t);}
 const table=first(profile,'players-table');
 for(const row of all(table,n=>n.tag==='tr')){
  if(!first(row,'player-active'))continue;const link=all(row,n=>n.tag==='a'&&idOf(n.a.href,'player'))[0],p=person(link,text(first(row,'playersBox-playernick')));
  if(p){const cells=all(row,n=>n.tag==='td');p.rating=val(row,'rating-cell');p.maps=number(text(cells[3]));p.ratingMaps=p.maps;p.ratingVersion=text(cells[4]).includes('*')?'older':'3.0';p.ratingPeriod='team tenure';p.at=at;p.statSnapshots=[snapshot(p,url,at,{period:'team tenure'})];team.players.push(p);}
 }
 if(!team.players.length)for(const link of all(profile,n=>n.tag==='a'&&(n.a.class||'').includes('col-custom'))) {const p=person(link,text(first(link,'playerFlagName')));if(p)team.players.push({...p,at});}
 team.players=[...new Map(team.players.map(p=>[p.id,p])).values()].slice(0,5);
 for(const node of cls(profile,'map-statistics-container')){
  const map={name:text(first(node,'map-statistics-row-map-mapname')),wins:0,losses:0,draws:0,pistol:null,pick:null,ban:null,at};
  for(const n of cls(first(node,'map-statistics-extended-wdl'),'highlighted-stat')){const label=text(first(n,'description')).toLowerCase(),v=val(n,'stat');if(label==='win')map.wins=v;if(label==='losses')map.losses=v;if(label==='draws')map.draws=v;}
  for(const n of cls(node,'map-statistics-extended-general-stat')){const t=text(n);if(t.includes('Pistolround'))map.pistol=number(t)/100;}
  for(const n of cls(node,'map-statistics-extended-highlight-veto')){const t=text(n);if(t.startsWith('Picks'))map.pick=number(t)/100;if(t.startsWith('Bans'))map.ban=number(t)/100;}
  const link=all(node,n=>n.tag==='a'&&String(n.a.href).includes('/stats/teams/map/'))[0];
  if(link){const u=new URL(link.a.href,url);map.startDate=u.searchParams.get('startDate');map.endDate=u.searchParams.get('endDate');}
  map.played=map.wins+map.losses+map.draws;if(map.name)team.maps.push(map);
 }
 for(const row of cls(profile,'team-row')){
  const names=cls(row,'team-name'),scores=cls(row,'score'),ts=all(row,n=>n.a['data-unix'])[0],link=all(row,n=>n.tag==='a'&&idOf(n.a.href,'matches'))[0];
  if(names.length!==2||scores.length!==2||!link)continue;const a=number(text(scores[0])),b=number(text(scores[1])),date=Number(ts?.a['data-unix']);
  if(a===null||b===null||!date||a===b||Math.max(a,b)>3)continue;
  team.matches.push({id:idOf(link.a.href,'matches'),at:date,teamA:idOf(names[0].a.href,'team'),teamB:idOf(names[1].a.href,'team'),nameA:text(names[0]),nameB:text(names[1]),scoreA:a,scoreB:b,url:new URL(link.a.href,url).href});
 }
 team.matches=team.matches.filter(m=>m.teamA&&m.teamB&&m.at<=at&&m.at>at-365*86400100).slice(0,400);
 if(!team.name||(!team.players.length&&!team.maps.length&&!team.matches.length))throw Error('Структура профиля HLTV изменилась');
 return {teams:[team],players:team.players,matches:team.matches};
}
function parsePlayer(doc,url,at){
 const id=idOf(url.pathname,'players')||idOf(url.pathname,'player');if(!id)throw Error('Нет ID игрока');
 const title=text(all(doc,n=>n.tag==='title')[0]),name=text(first(doc,'summaryNickname'))||text(first(doc,'playerNickname'))||title.match(/['‘](.+?)['’]/)?.[1]||url.pathname.split('/').at(-1);
 const p={id,name,slug:url.pathname.split('/').at(-1),at,url:url.href};
 const stats={};for(const n of cls(doc,'stats-row')){const spans=all(n,x=>x.tag==='span');if(spans.length===2)stats[text(spans[0]).toLowerCase()]=number(text(spans[1]));}
 p.kpr=stats['kills / round'];p.dpr=stats['deaths / round'];p.headshots=stats['headshot %']==null?null:stats['headshot %']/100;p.rounds=stats['rounds played'];p.maps=stats['maps played'];p.adr=stats['damage / round'];
 for(const n of cls(doc,'summaryStatBreakdown')){const t=text(n);if(t.includes('Rating')){p.rating=val(n,'summaryStatBreakdownDataValue');p.ratingVersion=t.includes('3.0')?'3.0':'older';}}
 const rows=cls(doc,'player-stat');for(const n of rows){const t=text(n);if(/Rating 3\.0/.test(t)){p.rating=val(n,'statsVal');p.ratingVersion='3.0';p.ratingMaps=number(text(first(doc,'stats-window')).match(/(\d+)\s+maps/)?.[1]);p.ratingPeriod='past 3 months';}}
 p.startDate=url.searchParams.get('startDate');p.endDate=url.searchParams.get('endDate');p.statsPeriod=p.startDate?'date range':'all time';
 if(!p.kpr&&!p.rating)throw Error('В странице игрока нет подходящей статистики');
 p.statSnapshots=[snapshot(p,url,at,{period:p.ratingPeriod==='past 3 months'?'past 3 months':p.statsPeriod})];
 return {teams:[],players:[p],matches:[]};
}
function parseMatch(doc,url,at){
 const a=first(doc,'team1-gradient'),b=first(doc,'team2-gradient'),links=[a,b].map(n=>all(n,x=>x.tag==='a'&&idOf(x.a.href,'team'))[0]);if(links.some(x=>!x))throw Error('Не найден матч HLTV');
 const players=[];for(const node of all(doc,n=>n.a['data-team1-players-data']||n.a['data-team2-players-data']))for(const key of ['data-team1-players-data','data-team2-players-data']){
  if(!node.a[key])continue;let items;try{items=JSON.parse(node.a[key]);}catch{continue;}
  for(const d of Object.values(items)){const id=Number(d.playerId);if(!id||!d.nickname||!d.statsLinkUrl)continue;const source=new URL(d.statsLinkUrl,url);if(source.hostname!=='www.hltv.org')continue;
   const p={id,name:clean(d.nickname),slug:slug(d.nickname),at,url:source.href,rating:d.numericRating,ratingVersion:'3.0',kpr:d.numericKpr,dpr:d.numericDpr,adr:d.numericAdr,statsPeriod:'date range',startDate:source.searchParams.get('startDate'),endDate:source.searchParams.get('endDate')};
   p.statSnapshots=[snapshot(p,source,at,{kast:d.numericKast,multiKillRating:d.numericMultiKillRating,roundSwing:d.numericRoundSwing})];players.push(p);
  }
 }
 const dateNode=all(first(doc,'timeAndEvent'),n=>n.a['data-unix'])[0],date=Number(dateNode?.a['data-unix']),maps=[];
 for(const m of cls(doc,'mapholder')){const s=[val(m,'results-left'),val(m,'results-right')];const left=first(m,'results-left'),right=first(m,'results-right');s[0]=val(left,'results-team-score');s[1]=val(right,'results-team-score');if(s.some(x=>x===null)||s[0]===s[1])continue;maps.push({name:text(first(m,'mapname')),scoreA:s[0],scoreB:s[1]});}
 const match={id:idOf(url.pathname,'matches'),at:date,teamA:idOf(links[0].a.href,'team'),teamB:idOf(links[1].a.href,'team'),nameA:text(first(a,'teamName')),nameB:text(first(b,'teamName')),scoreA:maps.filter(m=>m.scoreA>m.scoreB).length,scoreB:maps.filter(m=>m.scoreB>m.scoreA).length,maps,url:url.href};
 if(!date||date>at||!maps.length)return {teams:[],players,matches:[]};
 return {teams:[],players,matches:[match]};
}
function parsePlayerDetail(doc,url,at){
 const path=url.pathname.match(/^\/stats\/players\/(matches|individual)\/(\d+)\/(.+)/);if(!path)throw Error('Неизвестный раздел игрока');
 const p={id:Number(path[2]),name:text(first(doc,'summaryNickname'))||decode(path[3]),slug:path[3],at,url:url.href};
 if(path[1]==='individual'){
  const stats={};for(const n of cls(doc,'stats-row')){const spans=all(n,x=>x.tag==='span');if(spans.length===2)stats[text(spans[0]).toLowerCase()]=number(text(spans[1]));}
  const multikills=Array.from({length:6},(_,i)=>stats[i+' kill rounds']);
  const rounds=multikills.every(Number.isFinite)?multikills.reduce((a,b)=>a+b,0):null;
  p.statSnapshots=[snapshot({kpr:stats['kill / round'],rounds},url,at,{openingKills:stats['total opening kills'],openingDeaths:stats['total opening deaths'],openingWinRate:stats['team win percent after first kill']/100,multikills:multikills.every(Number.isFinite)?multikills:undefined})];
  if(!rounds)throw Error('Не найдена индивидуальная статистика');
 }else{
  const mapNames={d2:'Dust2',inf:'Inferno',mir:'Mirage',nuke:'Nuke',nuk:'Nuke',anc:'Ancient',anb:'Anubis',trn:'Train',cch:'Cache',vtg:'Vertigo',ovp:'Overpass'};
  p.mapHistory=[];
  for(const row of all(first(doc,'stats-matches-table'),n=>n.tag==='tr')){
   const cells=all(row,n=>n.tag==='td');if(cells.length<7)continue;
   const link=all(cells[0],n=>n.tag==='a'&&String(n.a.href).includes('/mapstatsid/'))[0],id=idOf(link?.a.href,'mapstatsid');
   const date=text(cells[0]).match(/(\d{2})\/(\d{2})\/(\d{2,4})/),kd=text(cells[4]).match(/(\d+)\s*[-–]\s*(\d+)/);
   const team=all(cells[1],n=>n.tag==='a'&&idOf(n.a.href,'teams'))[0],opponent=all(cells[2],n=>n.tag==='a'&&idOf(n.a.href,'teams'))[0];
   const scoreA=number(text(cells[1]).match(/\((\d+)\)\s*$/)?.[1]),scoreB=number(text(cells[2]).match(/\((\d+)\)\s*$/)?.[1]);
   if(!id||!date||!kd||!team||!opponent||scoreA==null||scoreB==null)continue;
   const when=Date.UTC(Number(date[3])+(date[3].length===2?2000:0),Number(date[2])-1,Number(date[1]));if(when>at)continue;
   p.mapHistory.push({id,at:when,observedAt:at,teamId:idOf(team.a.href,'teams'),opponentId:idOf(opponent.a.href,'teams'),map:mapNames[text(cells[3]).toLowerCase()]||text(cells[3]),scoreA,scoreB,rounds:scoreA+scoreB,kills:Number(kd[1]),deaths:Number(kd[2]),rating:number(text(cells[6])),source:url.href});
  }
  if(!p.mapHistory.length)throw Error('Не найдена история карт игрока');
 }
 return {teams:[],players:[p],matches:[]};
}
function parsePage(urlString,body,at=Date.now()){
 const url=new URL(urlString);if(url.protocol!=='https:'||url.hostname!=='www.hltv.org')throw Error('Требуется страница www.hltv.org');
 if(url.pathname==='/search')return parseSearch(typeof body==='string'?JSON.parse(body):body);
 const doc=html(body);
 if(/^\/team\/\d+\//.test(url.pathname))return parseTeam(doc,url,at);
 if(/^\/stats\/players\/(matches|individual)\/\d+\//.test(url.pathname))return parsePlayerDetail(doc,url,at);
 if(/^\/(stats\/players|player)\/\d+\//.test(url.pathname))return parsePlayer(doc,url,at);
 if(/^\/matches\/\d+\//.test(url.pathname))return parseMatch(doc,url,at);
 throw Error('Эта страница HLTV не содержит поддерживаемых данных');
}
function merge(...sets){const teams=new Map(),players=new Map(),matches=new Map();for(const set of sets.filter(Boolean)){
 for(const [kind,map] of [['teams',teams],['players',players],['matches',matches]])for(const row of set[kind]||[]){if(!row?.id)continue;const old=map.get(row.id);if(kind==='players'){map.set(row.id,PlayerData.mergePlayer(old,row));continue;}if(old&&old.at>row.at)continue;map.set(row.id,{...old,...Object.fromEntries(Object.entries(row).filter(([,v])=>v!=null)),...(kind==='teams'&&!row.maps?.length&&old?.maps?.length?{maps:old.maps,matches:old.matches}: {})});}
 }return {teams:[...teams.values()],players:[...players.values()],matches:[...matches.values()]};}
function harEntry(e){
 const url=e.request?.url||'';if(!/^https:\/\/www\.hltv\.org\/(?:search\?|team\/\d+\/|(?:stats\/players|player)\/\d+\/|stats\/players\/(?:matches|individual)\/\d+\/|matches\/\d+\/)/.test(url)||e.response?.status!==200||!e.response.content?.text)return null;
 const c=e.response.content;let body=c.text;if(c.encoding==='base64')body=typeof Buffer!=='undefined'?Buffer.from(body,'base64').toString('utf8'):new TextDecoder().decode(Uint8Array.from(atob(body),x=>x.charCodeAt(0)));
 return parsePage(url,body,Date.parse(e.startedDateTime)||Date.now());
}
function importHar(har){let data={teams:[],players:[],matches:[]},pages=0,skipped=0;for(const e of har?.log?.entries||[]){
 try{const parsed=harEntry(e);if(parsed){data=merge(data,parsed);pages++;}}catch{skipped++;}
 }return {...data,pages,skipped};}
const api={parsePage,parseSearch,harEntry,importHar,merge,norm,slug,derivePlayer:PlayerData.derivePlayer};if(typeof module!=='undefined'&&module.exports)module.exports=api;else root.HltvData=api;
})(typeof globalThis!=='undefined'?globalThis:this);
