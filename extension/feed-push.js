/* Pure helpers for the server -> extension feed stream. Kept independent from
   Chrome APIs so the patching/orientation logic can be regression-tested. */
(function(root){
 const refKey=(value)=>`${String(value?.source||'')}:${String(value?.sourceEventId||value?.id||'')}`;
 const flipPair=value=>Array.isArray(value)&&value.length>=2?[value[1],value[0]]:value;
 const flipScoreText=value=>String(value||'').replace(/(\d+)\s*:\s*(\d+)/g,(_,a,b)=>`${b}:${a}`);
 function orientPatch(patch,ref){
  const fields=Array.isArray(patch?.fields)?patch.fields:[];
  const data={};for(const field of fields)if(Object.hasOwn(patch||{},field))data[field]=patch[field];
  if(ref?.scoreReversed!==true)return data;
  const out={...data};
  if(Object.hasOwn(data,'seriesScore'))out.seriesScore=flipPair(data.seriesScore);
  if(Object.hasOwn(data,'mapScores'))out.mapScores=Array.isArray(data.mapScores)?data.mapScores.map(flipPair):data.mapScores;
  if(Object.hasOwn(data,'scoreText'))out.scoreText=flipScoreText(data.scoreText);
  if(Object.hasOwn(data,'team1Logo')||Object.hasOwn(data,'team2Logo')){out.team1Logo=data.team2Logo||'';out.team2Logo=data.team1Logo||'';}
  return out;
 }
 function mergeRef(ref,patch){
  const next=orientPatch(patch,ref);
  return {...ref,...next,id:ref.id,sourceEventId:ref.sourceEventId||ref.id,source:ref.source,scoreReversed:ref.scoreReversed===true};
 }
 function applyProviderPatches(snapshot,patches,meta={},now=Date.now()){
  if(!snapshot||!Array.isArray(snapshot.events))return {ok:false,matched:0,changed:false,snapshot};
  const list=Array.isArray(patches)?patches:[],index=new Map(list.map(p=>[refKey(p),p]));
  const matchedKeys=new Set();let changed=false;
  const events=snapshot.events.map(event=>{
   if(Array.isArray(event.sourceRefs)){
    let hit=false;const sourceRefs=event.sourceRefs.map(ref=>{const key=refKey(ref),patch=index.get(key);if(!patch)return ref;hit=true;matchedKeys.add(key);return mergeRef(ref,patch);});
    return hit?(changed=true,{...event,sourceRefs}):event;
   }
   const key=refKey(event),patch=index.get(key);if(!patch)return event;matchedKeys.add(key);changed=true;return mergeRef(event,patch);
  });
  const next={...snapshot,...meta,events,receivedAt:now,transportError:'',pushAt:now};
  return {ok:matchedKeys.size===index.size,matched:matchedKeys.size,changed,snapshot:next};
 }
 function parseSseBlock(block){
  let type='message';const data=[];
  for(const raw of String(block||'').split(/\r?\n/)){
   if(!raw||raw.startsWith(':'))continue;
   const i=raw.indexOf(':'),field=i<0?raw:raw.slice(0,i),value=i<0?'':raw.slice(i+1).replace(/^ /,'');
   if(field==='event')type=value;else if(field==='data')data.push(value);
  }
  if(!data.length)return null;
  try{return {type,data:JSON.parse(data.join('\n'))};}catch{return null;}
 }
 const api={applyProviderPatches,parseSseBlock,orientPatch,refKey};
 if(typeof module==='object'&&module.exports)module.exports=api;else root.FeedPush=api;
})(globalThis);
