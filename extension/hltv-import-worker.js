importScripts('hltv-player-data.js','hltv-data.js','har-stream.js');
self.onmessage=async({data})=>{
 try{
  let parsed={teams:[],players:[],matches:[]},pages=0,skipped=0,last=0;
  const stats=await HarStream.forEntries(data.file,e=>{
   try{const row=HltvData.harEntry(e);if(row){parsed=HltvData.merge(parsed,row);pages++;}}catch{skipped++;}
  },s=>{if(Date.now()-last>100){self.postMessage({progress:Math.min(99,Math.floor(s.bytes/s.total*100)),pages});last=Date.now();}});
  if(!pages)throw Error('В HAR нет поддерживаемых страниц HLTV с содержимым ответов. Нужны профили команд, матчи или статистика игроков.');
  self.postMessage({data:{...parsed,pages,skipped,oversized:stats.oversized,entries:stats.entries,bytes:stats.bytes}});
 }catch(error){self.postMessage({error:error.message});}
};
