// One-shot diagnostic only. It never writes application state or enables GGBET results.
import {WebSocket} from 'ws';
import {GgbetLiveCollector} from './ggbet.js';

const QUERY=`query ProbeEnded($offset:Int!,$limit:Int!,$matchStatuses:[SportEventStatus!],$sportIds:[String!],$sportEventTypes:[SportEventType!]){matches:sportEventListByFilters(offset:$offset,limit:$limit,matchStatuses:$matchStatuses,sportIds:$sportIds,sportEventTypes:$sportEventTypes){count sportEvents{id slug fixture{score status startTime sportId tournament{id name} competitors{id name homeAway score{id type points number}}}}}}`;
const SPORT_IDS=['esports_counter_strike','esports_dota_2','esports_league_of_legends','esports_valorant'];
const state={async success(){},async failure(){}};
const collector=new GgbetLiveCollector(state);
const clean=e=>({
 id:e?.id||'',slug:e?.slug||'',status:e?.fixture?.status||'',startTime:e?.fixture?.startTime||'',sportId:e?.fixture?.sportId||'',league:e?.fixture?.tournament?.name||'',score:e?.fixture?.score||'',
 teams:(e?.fixture?.competitors||[]).map(c=>({name:c?.name||'',homeAway:c?.homeAway||'',score:(c?.score||[]).map(s=>({type:s?.type,points:s?.points,number:s?.number}))}))
});
let ws;
try{
 const boot=await collector.fetchBootstrap(true);
 ws=new WebSocket(boot.wsUrl,'graphql-ws',{headers:{Origin:boot.origin,'User-Agent':'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/153 Safari/537.36'},handshakeTimeout:12000,perMessageDeflate:false});
 const result=await new Promise((resolve,reject)=>{
  const timer=setTimeout(()=>reject(Error('ENDED probe timeout')),15000);timer.unref?.();
  ws.on('open',()=>ws.send(JSON.stringify({type:'connection_init',payload:{headers:{'X-Auth-Token':boot.token}}})));
  ws.on('message',raw=>{let m;try{m=JSON.parse(String(raw));}catch{return;}
   if(m.type==='connection_ack')ws.send(JSON.stringify({id:'ended-probe',type:'start',payload:{operationName:'ProbeEnded',query:QUERY,variables:{offset:0,limit:50,matchStatuses:['ENDED'],sportIds:SPORT_IDS,sportEventTypes:['MATCH']}}}));
   else if(m.id==='ended-probe'&&m.type==='data'){clearTimeout(timer);resolve(m.payload?.data?.matches||{});}
   else if(m.type==='connection_error'||m.type==='error'){clearTimeout(timer);reject(Error(JSON.stringify(m.payload||m).slice(0,1200)));}
  });
  ws.on('error',e=>{clearTimeout(timer);reject(e);});
 });
 const events=Array.isArray(result.sportEvents)?result.sportEvents:[];
 console.log(JSON.stringify({ok:true,count:Number(result.count)||events.length,returned:events.length,events:events.slice(0,20).map(clean)},null,2));
}finally{
 try{ws?.close();}catch{}
 await collector.stop().catch(()=>{});
}
