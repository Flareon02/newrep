import {inflateRawSync} from 'node:zlib';
import {createHash} from 'node:crypto';
import {sqlite} from './sqlite-storage.js';
const providers=['astek','fonbet','pinnacle','ggbet','ggbet-node','ggbet-browser'];
const bad=message=>Object.assign(Error(message),{status:400});
const timestamp=v=>{if(v==null||v==='')return null;const n=/^\d+$/.test(v)?Number(v):Date.parse(v);if(!Number.isFinite(n)||n<0)throw bad('Неверный timestamp');return n;};
export function historyOptions(params){const provider=params.get('provider')||'';if(provider&&!providers.includes(provider))throw bad('Неизвестный bookmaker');let cursorTo;try{cursorTo=JSON.parse(Buffer.from(params.get('cursor')||'','base64url')).to;}catch{}const from=timestamp(params.get('from'))??0,to=timestamp(params.get('to'))??cursorTo??Date.now();if(from>to)throw bad('from позже to');const limit=params.get('limit')==null?100:Number(params.get('limit'));if(!Number.isInteger(limit)||limit<1||limit>500)throw bad('limit должен быть 1–500');const marketId=params.get('marketId')||'';if(marketId.length>200)throw bad('Неверный marketId');return {from,to,provider,marketId,limit,cursor:params.get('cursor')||''};}
const compare=(a,b)=>b.at-a.at||b.order-a.order||b.seq-a.seq||a.index-b.index;
export function eventHistoryQuery(identities,options={},db=sqlite().db){
  const o={from:0,to:Date.now(),provider:'',marketId:'',limit:100,cursor:'',includeOdds:true,includeScores:true,...options};
  const keys=[...new Set(identities)].filter(k=>/^(astek|fonbet|pinnacle|ggbet):[\w-]{1,80}$/.test(k)).slice(0,32);
  const sig=createHash('sha256').update(JSON.stringify([keys.sort(),o.from,o.to,o.provider,o.marketId,o.includeOdds,o.includeScores])).digest('hex').slice(0,24);
  let cursor=null;if(o.cursor){try{cursor=JSON.parse(Buffer.from(o.cursor,'base64url'));if(cursor.sig!==sig||!Number.isFinite(cursor.at)||![0,1].includes(cursor.order)||!Number.isInteger(cursor.seq)||!Number.isInteger(cursor.index))throw Error();}catch{throw bad('Неверный cursor или изменились фильтры');}}
  const all=[];for(const key of keys){const sep=key.indexOf(':'),provider=key.slice(0,sep),id=key.slice(sep+1).replace(/[^\w-]/g,'');if(o.provider&&o.provider.split('-')[0]!==provider)continue;
    for(const kind of ['score','odds']){if(kind==='score'&&(!o.includeScores||o.marketId)||kind==='odds'&&!o.includeOdds)continue;
      const order=kind==='score'?1:0,params=kind==='score'?[key]:[provider,id];let where=kind==='score'?'identity=?':'source=? AND event_id=?';where+=' AND at>=? AND at<=?';params.push(o.from,o.to);
      if(o.provider.includes('-')){where+=' AND publication_source=?';params.push(o.provider);}
      if(cursor){if(order>cursor.order){where+=' AND at<?';params.push(cursor.at);}else if(order===cursor.order){where+=' AND (at<? OR (at=? AND seq<=?))';params.push(cursor.at,cursor.at,cursor.seq);}else{where+=' AND at<=?';params.push(cursor.at);}}
      if(kind==='odds'&&o.marketId){where+=' AND seq IN (SELECT entry_seq FROM odds_history_market_refs WHERE source=? AND event_id=? AND market_id=? AND at>=? AND at<=?)';params.push(provider,id,o.marketId,o.from,o.to);}
      params.push(Math.max(128,o.limit+1));const table=kind==='score'?'score_entries':'odds_entries_v3';const rows=db.prepare(`SELECT seq,at,payload,publication_source FROM ${table} WHERE ${where} ORDER BY at DESC,seq DESC LIMIT ?`).all(...params);
      for(const row of rows){let e;try{e=JSON.parse(kind==='odds'?inflateRawSync(row.payload).toString():row.payload);}catch{continue;}
        const base={at:row.at,timestamp:new Date(row.at).toISOString(),provider,publicationSource:row.publication_source||e.publicationSource||'legacy-unspecified',sourceEventId:id,eventVersion:e.eventVersion??null,sport:e.sport??null,team1:e.team1??null,team2:e.team2??null,sourceReceivedAt:e.sourceReceivedAt??null,updatedAt:e.updatedAt??null,receivedTimeSemantics:e.receivedTimeSemantics??null,order,seq:row.seq};
        if(kind==='score'){const stateOnly=!e.baseline&&e.oldState&&e.newState&&JSON.stringify(e.oldScore)===JSON.stringify(e.newScore);all.push({...base,kind:stateOnly?'state':'score',index:0,oldValue:stateOnly?e.oldState:e.oldScore??null,newValue:stateOnly?e.newState:e.newScore??e.scoreText??null,oldState:e.oldState??null,newState:e.newState??{score:e.scoreText,seriesScore:e.seriesScore,mapScores:e.mapScores},map:e.map??null,period:e.period??null,clock:e.clock??null,eventStatus:e.eventStatus??null,baseline:e.baseline??e.oldScore===undefined});continue;}
        let index=0;for(const m of e.changes||[]){if(o.marketId&&String(m.marketId||m.key)!==o.marketId)continue;
          const mb={...base,marketId:m.marketId||m.key,typeId:m.typeId??m.rawType??null,marketName:m.marketName||m.title||m.type,map:m.map??null,period:m.period??null,status:m.newStatus??m.status};
          if(m.oldStatus!=null&&m.oldStatus!==m.newStatus)all.push({...mb,kind:'market',index:index++,oldValue:m.oldStatus,newValue:m.newStatus});
          for(const p of m.prices||[])all.push({...mb,kind:'odds',index:index++,outcomeId:p.outcomeId??p.side,outcomeName:p.outcomeName||p.side,oldValue:p.oldOdds??null,newValue:p.newOdds??p.odds??null,rawOldValue:p.oldRawOdds??null,rawNewValue:p.newRawOdds??p.odds??null,oddsFormat:p.oddsFormat||'decimal',baseline:p.baseline??p.oldOdds===undefined});
        }
      }
    }
  }
  all.sort(compare);const after=cursor?all.filter(e=>compare(e,cursor)>0):all;const take=after.slice(0,o.limit),hasMore=after.length>o.limit,last=take.at(-1);
  const nextCursor=hasMore&&last?Buffer.from(JSON.stringify({sig,to:o.to,at:last.at,order:last.order,seq:last.seq,index:last.index})).toString('base64url'):null;
  const clean=take.map(({order,seq,index,...e})=>({...e,id:`${order}:${seq}:${index}`}));return {entries:clean,scoreTimeline:clean.filter(e=>['score','state'].includes(e.kind)),oddsTimeline:clean.filter(e=>!['score','state'].includes(e.kind)),hasMore,nextCursor,from:o.from,to:o.to,limit:o.limit,retentionDays:7};
}
