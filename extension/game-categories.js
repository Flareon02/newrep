/* Shared discipline names and icons for feeds, archives and UI. */
(function(root){
 const entries=[
 [/counter[\s_-]*strike(?:[\s_-]*2)?|\bcs[\s_:]*2\b|\bcs:?go\b/i,'Counter Strike 2','cs','CS'],
 [/\bdota[\s_]*2?\b/i,'Dota 2','dota','D'],
 [/wild[\s_]?rift/i,'LoL: Wild Rift','wildrift','WR'],
 [/teamfight[\s_]tactics|\btft\b/i,'Teamfight Tactics','tft','TF'],
 [/league[\s_]of[\s_]legends|\blol\b/i,'League of Legends','lol','L'],
 [/valorant/i,'Valorant','valorant','V'],
 [/rainbow[\s_]six|\br6\b/i,'Rainbow Six Siege','rainbow','R6'],
 [/overwatch(?:\s*2)?/i,'Overwatch','overwatch','OW'],
 [/cross[\s_]?fire/i,'CrossFire','cf','CF'],
 [/mobile[\s_]legends/i,'Mobile Legends','mobile','ML'],
 [/rocket[\s_]league/i,'Rocket League','rocket','RL'],
 [/arena[\s_]of[\s_]valor/i,'Arena of Valor','arena','AV'],
 [/honou?r[\s_]of[\s_]kings|king[\s_]of[\s_]glory/i,'Honor of Kings','honor','HK'],
 [/hearth[\s_]?stone/i,'Hearthstone','hearthstone','HS'],
 [/apex[\s_]legends/i,'Apex Legends','apex','AP'],
 [/standoff[\s_]*2?/i,'Standoff 2','standoff','S2'],
 [/star[\s_]?craft(?:\s*(?:ii|2))?/i,'StarCraft','starcraft','SC'],
 [/age[\s_]*of[\s_]*empires/i,'Age of Empires','aoe','AE'],
 [/heroes[\s_]of[\s_]might(?:[\s_]and[\s_]magic)?(?:\s*(?:iii|3))?|heroes.*magic(?:\s*(?:iii|3))?|\bhomm\b/i,'Heroes of Might and Magic III','heroes','H3'],
 [/war[\s_]?craft(?:\s*(?:iii|3))?/i,'Warcraft','warcraft','W'],
 [/world[\s_]of[\s_]tanks|\bwot\b/i,'World of Tanks','tanks','WT'],
 [/call[\s_]of[\s_]duty/i,'Call of Duty','cod','CD'],
 [/pubg|playerunknown/i,'PUBG','pubg','PG'],
 [/quake/i,'Quake','quake','Q'],
 [/\bfifa\b|ea[\s_]?(?:sports[\s_]?)?fc\b|e-?football|\bpes\b/i,'EA Sports FC','fc','FC'],
 [/nba[\s_]?2k|basketball/i,'NBA 2K','basketball','2K']
 ];
 const generic=s=>!s||/^(?:e[\s-]?sports?|киберспорт|cybersport|other|другое)$/i.test(String(s).trim());
 const infer=(text,fallback='Esports')=>entries.find(([re])=>re.test(String(text||'')))?.[1]||fallback;
 const resolve=(category,league)=>generic(category)?infer(league):infer(category,category);
 const info=category=>{const e=entries.find(([re])=>re.test(String(category||'')));return e?{name:e[1],key:e[2],abbr:e[3]}:{name:category||'Esports',key:'other',abbr:'E'};};
 const api={entries,generic,infer,resolve,info};
 if(typeof module==='object'&&module.exports)module.exports=api;else root.GameCategories=api;
})(globalThis);
