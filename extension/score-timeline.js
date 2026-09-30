(function(root){
 const DM=root.ScoreOrientation||(typeof require==='function'?require('./score-orientation.js'):null);
 function build(entries,base,{sources=['astek','fonbet','pinnacle','ggbet']}={}){const states={},rows=[];
  const seen=new Set();
  for(const raw of [...entries].sort((a,b)=>a.at-b.at||String(a.key||'').localeCompare(String(b.key||'')))){
   if(!sources.includes(raw.source))continue;
   const r=DM.orient(raw,base),previous=states[r.source],signature=String(r.scoreText||'').replace(/\s+/g,''),hasScore=/\d/.test(signature),changed=hasScore&&previous?.signature!==signature;
   const event=['entered','removed'].includes(r.event)?r.event:null,key=[r.source,r.at,event,signature].join(':');
   if(seen.has(key)||!changed&&!event)continue;seen.add(key);
   if(hasScore)states[r.source]={...r,signature};
   let row=rows.at(-1);if(!row||row.at!==r.at){row={at:r.at,changed:[],scores:{},events:[]};rows.push(row);}
   if(changed&&!row.changed.includes(r.source))row.changed.push(r.source);
   if(event&&!row.events.some(e=>e.source===r.source&&e.type===event))row.events.push({source:r.source,type:event});
   row.scores={...states};
  }
  return rows.reverse();
 }
 function withLifecycle(entries,refs,before=Infinity){const out=[...entries],seen=new Set(entries.filter(r=>r.event).map(r=>[r.source,r.at,r.event].join(':')));
  for(const r of refs)for(const c of r.timeline||r.lifecycle||[]){if(c.phase&&c.phase!=='live'||!['entered','removed'].includes(c.type)||!(c.at>0)||c.at>=before)continue;
   const key=[r.source,c.at,c.type].join(':');if(seen.has(key))continue;seen.add(key);
   // Legacy lifecycle has no score snapshot. Carry forward only an actually
   // observed older score, never infer an earlier score from the current feed.
   out.push({at:c.at,source:r.source,sourceEventId:r.sourceEventId,team1:r.team1,team2:r.team2,event:c.type,phase:'live',scoreText:''});
  }return out;
 }
 const api={build,withLifecycle};if(typeof module==='object'&&module.exports)module.exports=api;else root.ScoreTimeline=api;
})(globalThis);
