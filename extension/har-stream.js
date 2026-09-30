(function(root){
'use strict';
// Read HAR entries without ever constructing the complete JSON string/object.
// Large unrelated response bodies are scanned and discarded in bounded chunks.
async function forEntries(file,onEntry,onProgress=()=>{},{maxBytes=1073741824,maxEntryChars=16777216}={}){
 if(!file||!Number.isFinite(file.size)||file.size<0||file.size>maxBytes)throw Error('Допустимый размер HAR — до 1 ГБ (1024 МБ)');
 const stack=[],decoder=new TextDecoder('utf-8',{fatal:true}),stats={bytes:0,entries:0,oversized:0},reader=file.stream().getReader();
 let rootSeen=false,found=false,entry=false,entryDepth=0,entryParts=[],entryLength=0,entryLarge=false,inString=false,escaped=false,keyString=false,stringParts=[],stringLength=0,literal='',started=false;
 const top=()=>stack.at(-1);
 function takeValue(){const p=top();if(!p){if(rootSeen)throw Error('Лишние данные после HAR');rootSeen=true;return [];}
  if(p.state!=='value')throw Error('Некорректный JSON: ожидалось значение');const path=[...p.path,p.type==='object'?p.key:'*'];p.state='comma';p.afterComma=false;return path;}
 function token(kind,value){const p=top();
  if(kind==='string'&&p?.type==='object'&&p.state==='key'){p.key=value;p.state='colon';return;}
  if(kind==='}'||kind===']'){if(!p||p.afterComma||(kind==='}')!==(p.type==='object')||p.state==='colon'||p.state==='value'&&p.type==='object')throw Error('Незавершённый JSON HAR');stack.pop();return;}
  if(kind===':'){if(p?.type!=='object'||p.state!=='colon')throw Error('Некорректный JSON HAR');p.state='value';return;}
  if(kind===','){if(p?.state!=='comma')throw Error('Некорректный JSON HAR');p.state=p.type==='object'?'key':'value';p.afterComma=true;return;}
  if(kind==='literal'&&!/^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)$/.test(value))throw Error('Некорректное значение JSON HAR');
  takeValue();
 }
 // Metadata can contain arbitrary nested objects. Keep only the first two
 // path components for recognizing log.entries; other paths are never entries.
 function open(kind){const p=top(),path=takeValue();const isEntries=path.length===2&&path[0]==='log'&&path[1]==='entries'&&kind==='[';
  if(isEntries)found=true;stack.push({type:kind==='{'?'object':'array',state:kind==='{'?'key':'value',path:path.length<=2?path:['$other'],entries:isEntries});if(stack.length>256)throw Error('Слишком глубокая структура JSON HAR');}
 function capture(s){if(entryLarge)return;entryLength+=s.length;if(entryLength>maxEntryChars){entryLarge=true;entryParts=[];return;}entryParts.push(s);}
 function keyPart(s){if(!keyString)return;stringLength+=s.length;if(stringLength>4096)throw Error('Слишком длинное имя поля JSON');stringParts.push(s);}
 function consume(chunk){let i=0,captureStart=entry?0:-1;const quoteOrSlash=/["\\]/g;
  while(i<chunk.length){
   if(inString){const begin=i;if(escaped){i++;escaped=false;}
    quoteOrSlash.lastIndex=i;let m;let closed=false;
    while((m=quoteOrSlash.exec(chunk))){if(m[0]==='\\'){if(m.index+1===chunk.length){escaped=true;i=chunk.length;break;}quoteOrSlash.lastIndex=m.index+2;continue;}i=m.index+1;closed=true;break;}
    if(!closed){i=chunk.length;keyPart(chunk.slice(begin,i));continue;}
    keyPart(chunk.slice(begin,i));inString=false;if(!entry){token('string',keyString?JSON.parse(stringParts.join('')):null);}keyString=false;stringParts=[];stringLength=0;continue;
   }
   const c=chunk[i];if(literal){if(!/[\s,\]}]/.test(c)){literal+=c;if(literal.length>1000)throw Error('Некорректное значение JSON HAR');i++;continue;}token('literal',literal);literal='';continue;}
   if(!started){started=true;if(c==='\uFEFF'){i++;continue;}}
   if(c==='"'){inString=true;keyString=!entry&&top()?.type==='object'&&top().state==='key';stringParts=keyString?['"']:[];stringLength=1;i++;continue;}
   if(entry){if(c==='{'||c==='[')entryDepth++;else if(c==='}'||c===']')entryDepth--;i++;
    if(entryDepth===0){capture(chunk.slice(captureStart,i));entry=false;captureStart=-1;stats.entries++;if(entryLarge)stats.oversized++;else{const raw=entryParts.join('');onEntry(JSON.parse(raw));}entryParts=[];entryLength=0;entryLarge=false;}continue;
   }
   if(/\s/.test(c)){i++;continue;}
   if(top()?.entries&&top().state==='value'&&c=== '{'){takeValue();entry=true;entryDepth=1;captureStart=i;entryParts=[];entryLength=0;entryLarge=false;i++;continue;}
   if(top()?.entries&&top().state==='value'&&c!==']')throw Error('В log.entries HAR ожидается объект записи');
   if(c==='{'||c==='['){open(c);i++;continue;}if(c==='}'||c===']'||c===','||c===':'){token(c);i++;continue;}
   literal=c;i++;
  }
  if(entry&&captureStart>=0)capture(chunk.slice(captureStart));
 }
 try{for(;;){const {done,value}=await reader.read();if(done)break;stats.bytes+=value.byteLength;if(stats.bytes>maxBytes)throw Error('Допустимый размер HAR — до 1 ГБ (1024 МБ)');consume(decoder.decode(value,{stream:true}));onProgress({...stats,total:file.size});}
  consume(decoder.decode());if(literal)token('literal',literal);if(inString||entry||stack.length||!rootSeen)throw Error('HAR обрезан или содержит незавершённый JSON');if(!found)throw Error('В файле нет массива log.entries HAR');return stats;
 }finally{await reader.cancel().catch(()=>{});reader.releaseLock();}
}
const api={forEntries};if(typeof module!=='undefined'&&module.exports)module.exports=api;else root.HarStream=api;
})(globalThis);
