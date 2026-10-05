/* View projections never use a hidden bookmaker's clocks or presence. */
(function(root){
 const refs=e=>e.sourceRefs?.length?e.sourceRefs:[e];
 // GGBET is the LIVE-only odds provider; it takes no part in Results/History. DataBet is retired: never shown.
 const oddsProviders=['ggbet','databet'];
 const liveOddsProvider=()=>'ggbet';
 function selected(e,prefs,view){return refs(e).filter(r=>(!r.source||prefs[r.source]!==false)&&(!oddsProviders.includes(r.source)||r.source===liveOddsProvider(prefs))&&(view!=='live'||r.inLive)&&(view!=='results'||!['pinnacle',...oddsProviders].includes(r.source))&&(view!=='history'||!oddsProviders.includes(r.source)&&r.firstPrematchAt>0));}
 function start(e){const times=refs(e).map(r=>Number(r.startAt)).filter(t=>t>0);return times.length?Math.min(...times):0;}
 function appearance(e){return Math.max(0,...refs(e).map(r=>Number(r.firstPrematchAt)||0));}
 function clock(e,view){return Math.max(0,...refs(e).map(r=>Number(view==='history'?r.firstPrematchAt:view==='live'?r.enteredLiveAt||r.firstSeenAt:r.endedAt||r.removedAt||r.enteredLiveAt||r.startAt)||0));}
 function project(e,prefs,view){const list=selected(e,prefs,view);if(!list.length)return null;const times=list.map(r=>Number(r.startAt)).filter(t=>t>0);return {...e,sourceRefs:list,startAt:start({sourceRefs:list}),displayMerged:list.length>1,startDifferenceMinutes:times.length>1?Math.round((Math.max(...times)-Math.min(...times))/60000):0};}
 function inWindow(e,mode,view,now=Date.now()){
  if(!mode)return true;const hours=Number(mode);if(!(hours>0))return true;
  if(['history','live','results'].includes(view)){const at=clock(e,view);return at>0&&at<=now&&at>=now-hours*3600000;}
  return refs(e).some(r=>Number(r.startAt)>=now&&Number(r.startAt)<=now+hours*3600000);
 }
 function historyPhase(e,mode){if(!mode)return true;return refs(e).some(r=>mode==='live'?r.inLive:mode==='line'?r.inPrematch&&!r.inLive:mode==='removed'?!r.inPrematch&&!r.inLive:true);}
 const api={selected,project,start,appearance,clock,inWindow,historyPhase};if(typeof module==='object'&&module.exports)module.exports=api;else root.MatchView=api;
})(globalThis);
