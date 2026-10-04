import {parentPort,workerData} from 'node:worker_threads';
import {DatabaseSync} from 'node:sqlite';
import fs from 'node:fs/promises';
import path from 'node:path';
import {SqliteHistoryStore} from './sqlite-history-store.js';
const db=new DatabaseSync(path.join(workerData.dataDir,'monitor-v2.sqlite3'));
db.exec('PRAGMA journal_mode=WAL;PRAGMA synchronous=NORMAL;PRAGMA cache_size=-4096;');
const store=new SqliteHistoryStore(db,workerData);store.minFreeBytes=(workerData.minFreeMiB??4096)*1048576;
async function guard(){try{const s=await fs.statfs(workerData.dataDir);store.guard(Number(s.bavail)*Number(s.bsize));}catch{store.guard(0);}}
await guard();parentPort.postMessage({type:'ready'});
const flush=setInterval(()=>store.flush(),250),disk=setInterval(guard,15000),cleanup=setInterval(()=>{store.cleanup();parentPort.postMessage({type:'status',stats:store.stats});},30000);
parentPort.on('message',async m=>{if(m.type==='stop'){clearInterval(flush);clearInterval(disk);clearInterval(cleanup);for(let n=0;n<20&&store.queue.size;n++){store.flush();if(store.queue.size)await new Promise(r=>setTimeout(r,250));}if(store.queue.size)store.guard(0);db.close();parentPort.postMessage({type:'stopped'});parentPort.close();return;}try{store.observe(m.event);}catch{store.stats.dropped++;}parentPort.postMessage({type:'ack',id:m.id});});
