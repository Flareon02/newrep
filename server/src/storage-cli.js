import {config} from './config.js';
import {exportLegacy,integrityCheck,migrateLegacy,storageMetrics} from './sqlite-storage.js';

const command=process.argv[2]||'status';
const progress=event=>{
  if(!event||typeof event!=='object')return;
  if(event.kind==='odds-key')console.error(`[sqlite-migrate] odds ${event.index}/${event.total} ${event.source}:${event.id}`);
  else if(event.kind==='odds-progress'){
    const pct=event.size?Math.min(100,Math.round((event.offset/event.size)*1000)/10):100;
    console.error(`[sqlite-migrate] ${event.source}:${event.id} ${pct}% (${event.rows} rows)`);
  }else if(event.kind==='odds-file-complete')console.error(`[sqlite-migrate] verified ${event.origin}: ${event.rows} rows`);
};

if(command==='status'){const ok=integrityCheck();console.log(JSON.stringify({ok,...storageMetrics({checkIntegrity:false,integrityOverride:ok?'ok':'failed'})}));}
else if(command==='migrate-legacy'){
  const report=await migrateLegacy({compact:process.argv.includes('--compact'),progress});
  console.log(JSON.stringify({ok:true,dataDir:config.dataDir,report,...storageMetrics({checkIntegrity:false,integrityOverride:'ok'})}));
}else if(command==='export-legacy'){
  const report=await exportLegacy();
  console.log(JSON.stringify({ok:true,dataDir:config.dataDir,report,...storageMetrics({checkIntegrity:false,integrityOverride:'ok'})}));
}else{
  console.error('Usage: node src/storage-cli.js [status|migrate-legacy [--compact]|export-legacy]');
  process.exitCode=2;
}
