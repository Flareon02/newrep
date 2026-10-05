'use strict';
/* Team logos from the data the extension already has (9.2 UX). Never searches the web and never builds URLs.

   Order for one side of a match:
     1. the merged event's logo (the server picks one bookmaker's logo for the fixture),
     2. the bookmakers' own refs, in their order (the primary/first ref first) — present in full payloads such as the
        match detail; thin lists carry only 1,
     3. a logo learned earlier for the same team in the same game (another view, the match detail, the statistics
        board), then the same team name in any game.
   Only the server's cached copies (/api/team-logos/<hash>) and the bookmakers' logo CDNs the server itself accepts are
   used. A URL that failed to load is never requested again in this session (no retry storm on broken images); the next
   candidate is used instead, and the generic placeholder when none is left.
   Pure JavaScript, no DOM: unit-tested in Node (extension/test/logo-resolver.test.mjs). */
(function(root){
 const norm=s=>String(s||'').normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu,'');
 const LOCAL=/^\/api\/team-logos\/[a-f0-9]{32}$/;
 function allowedRemote(u){
  return (u.hostname==='v2l.traincdn.com'&&/^\/sfiles\/logo_teams\/[a-f\d]{32}\.(png|webp|jpe?g)$/i.test(u.pathname))
   ||(u.hostname==='cdn.cross.bet'&&u.pathname.startsWith('/csgo/logo/team/'))
   ||u.hostname==='hawk.live'
   ||(u.hostname==='cdn.gin.bet'&&/\.(png|webp|jpe?g|svg)$/i.test(u.pathname));
 }
 function create({base=()=>'',max=3000}={}){
  const valid=new Map(),failed=new Set(),learned=new Map();let version=0;
  const refs=e=>Array.isArray(e?.sourceRefs)&&e.sourceRefs.length?e.sourceRefs:[];
  function url(value){
   if(typeof value!=='string'||!value)return '';
   const key=base()+'\n'+value;if(valid.has(key))return valid.get(key);
   let out='';const b=base();if(LOCAL.test(value))out=b+value;else if(b&&value.startsWith(b+'/')&&LOCAL.test(value.slice(b.length)))out=value;else{try{const u=new URL(value);if(u.protocol==='https:'&&!u.username&&!u.password&&allowedRemote(u))out=u.href;}catch{}}
   valid.set(key,out);if(valid.size>max*2)valid.delete(valid.keys().next().value);return out;
  }
  const teamKey=(category,name)=>norm(category)+'|'+norm(name);
  function candidates(e,side){
   const name=e?.['team'+side],out=[e?.['team'+side+'Logo']];
   for(const r of refs(e))out.push(r?.['team'+side+'Logo']);
   out.push(learned.get(teamKey(e?.category,name)),learned.get('*|'+norm(name)));
   return out;
  }
  function remember(category,name,value){
   const u=url(value);if(!u||failed.has(u)||!norm(name))return;
   for(const key of [teamKey(category,name),'*|'+norm(name)]){if(learned.get(key)===u)continue;learned.delete(key);learned.set(key,u);}
   while(learned.size>max)learned.delete(learned.keys().next().value);
  }
  // Best available logo URL for side 1 or 2, or '' (placeholder).
  function pick(e,side){
   for(const value of candidates(e,side)){const u=url(value);if(u&&!failed.has(u)){if(value!==learned.get(teamKey(e?.category,e?.['team'+side])))remember(e?.category,e?.['team'+side],u);return u;}}
   return '';
  }
  // Learn every logo a payload carries (match detail, statistics board): lists can show them afterwards.
  // Refs are already in the event's team order (the server flips names and logos together).
  function learn(e){if(!e)return;for(const side of [1,2]){remember(e.category,e['team'+side],e['team'+side+'Logo']);for(const r of refs(e))remember(r.category||e.category,r['team'+side]||e['team'+side],r['team'+side+'Logo']);}}
  function fail(value){const u=url(value)||String(value||'');if(!u||failed.has(u))return false;failed.add(u);for(const [k,v] of learned)if(v===u)learned.delete(k);version++;return true;}
  function dump(limit=1500){return [...learned].filter(([k])=>!k.startsWith('*|')).slice(-limit);}
  function load(list){if(!Array.isArray(list))return;for(const row of list){if(!Array.isArray(row))continue;const [key,value]=row;if(typeof key!=='string'||!key.includes('|'))continue;const u=url(value);if(!u)continue;learned.set(key,u);learned.set('*|'+key.split('|')[1],u);}while(learned.size>max)learned.delete(learned.keys().next().value);}
  // Stored URLs keep the server-relative form so a change of server address does not keep the old host.
  function dumpRelative(limit=1500){const b=base();return dump(limit).map(([k,v])=>[k,b&&v.startsWith(b+'/api/team-logos/')?v.slice(b.length):v]);}
  return {url,pick,learn,remember,fail,failed:u=>failed.has(u),dump:dumpRelative,load,version:()=>version,size:()=>learned.size};
 }
 const api={create};
 if(typeof module==='object'&&module.exports)module.exports=api;else root.LogoResolver=api;
})(globalThis);
