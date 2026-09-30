export function sourceId(row){return String(row.sourceEventId||row.id||'').replace(/^fonbet-(?:result-)?/,'');}
export function identity(row){return `${row.source}:${sourceId(row)}`;}
export function coalesce(rows){
 const map=new Map();
 for(const row of rows||[]){const key=identity(row),old=map.get(key);if(!old){map.set(key,{...row,sourceEventId:sourceId(row)});continue;}
  const fresh=Number(row.lastSeenAt||row.updatedAt||row.removedAt||0)>=Number(old.lastSeenAt||old.updatedAt||old.removedAt||0)?row:old;
  const result=row.resultVerified?row:old.resultVerified?old:null;
  const times=[old.firstSeenAt,old.enteredLiveAt,row.firstSeenAt,row.enteredLiveAt].map(Number).filter(n=>n>0);
  const lifecycle=[...new Map([...(old.lifecycle||[]),...(row.lifecycle||[])].map(c=>[`${c.type}:${c.at}`,c])).values()].sort((a,b)=>a.at-b.at);
  map.set(key,{...old,...fresh,...(result?{resultVerified:true,resultSource:result.resultSource,scoreText:result.scoreText,seriesScore:result.seriesScore,mapScores:result.mapScores,endedAt:result.endedAt}:{}),sourceEventId:sourceId(row),firstSeenAt:times.length?Math.min(...times):0,enteredLiveAt:times.length?Math.min(...times):0,lifecycle});
 }
 return [...map.values()];
}
