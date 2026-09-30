import {parentPort} from 'node:worker_threads';
import {resolveEvents,loadMatcherAliases} from './entity-resolver.js';
import {leagueStore} from './league-store.js';
import {compareSchedule} from './comparison.js';
import {ResultsService} from './results.js';
import {mergeUiLedger,queryUiEvents} from './ui-service.js';
await loadMatcherAliases();
parentPort.on('message',({id,task,payload,rules,catalog})=>{
  parentPort.postMessage({id,started:true});
  try{
    leagueStore.state={...leagueStore.state,...rules};
    if(catalog)leagueStore.catalog=new Map(catalog);
    let value;
    if(task==='resolve')value=resolveEvents(payload.events,{mode:payload.mode});
    else if(task==='ui-history-page'){
      const pre=resolveEvents(payload.prematchHistory||[],{mode:'prematch'});
      const live=resolveEvents(payload.liveHistory||[],{mode:'live'});
      const currentPre=resolveEvents(payload.currentPrematch||[],{mode:'prematch'});
      const currentLive=resolveEvents(payload.currentLive||[],{mode:'live'});
      const events=mergeUiLedger({prematchHistory:pre,liveHistory:live,currentPrematch:currentPre,currentLive,links:rules?.links||[]});
      value=queryUiEvents(events,payload.params||{},rules||{},'history');
    }
    else if(task==='compare')value=compareSchedule(payload.input,payload.events,payload.options);
    else if(task==='archive')value=new ResultsService({history:payload.history}).combine(payload.games,payload.from,payload.to);
    else throw new Error('Unknown matcher task');
    parentPort.postMessage({id,value});
  }catch(error){parentPort.postMessage({id,error:error.message});}
});
