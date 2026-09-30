import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {config} from '../src/config.js';
import {archiveRead,closeSqliteStorage,exportLegacy,migrateLegacy,oddsEntries,scoreLoad,snapshotLoad,snapshotSave,storageMetrics} from '../src/sqlite-storage.js';

async function write(file,value){await fs.mkdir(path.dirname(file),{recursive:true});await fs.writeFile(file,typeof value==='string'?value:JSON.stringify(value));}

test('SQLite v2 migrates, compacts and exports the 3.7.6 durable layout',async()=>{
  const prior=config.dataDir,tmp=await fs.mkdtemp(path.join(os.tmpdir(),'astek-sqlite-v2-'));
  closeSqliteStorage();config.dataDir=tmp;
  try{
    const event={id:'astek:1',source:'astek',sourceEventId:'1',team1:'A',team2:'B',startAt:100,firstSeenAt:100,lastSeenAt:200,removedAt:200};
    await write(path.join(tmp,'live.json'),{revision:2,matchRevision:1,events:[],history:[event],seen:{'astek:1':{firstSeenAt:100,lastSeenAt:200}}});
    const identity='astek:1',scoreFile=path.join(tmp,'scores',Buffer.from(identity).toString('base64url')+'.json');
    await write(scoreFile,{key:identity,startedAt:100,entries:[{at:100,source:'astek',sourceEventId:'1',team1:'A',team2:'B',scoreText:'0:0',phase:'live'}]});
    await write(path.join(tmp,'odds-state','astek','1.json'),{last:{m:'x'},lastAt:200,team1:'A',team2:'B',scoreText:'0:0'});
    await write(path.join(tmp,'odds-journal','astek','1.ndjson'),JSON.stringify({at:150,changes:[{key:'m',period:0,title:'Winner',status:'open',prices:[{side:'home',points:null,odds:1.8}]}],team1:'A',team2:'B'})+'\n');
    await write(path.join(tmp,'results','days','2026-09-28.json'),{schemaVersion:4,date:'2026-09-28',events:[event],complete:true,updatedAt:300});

    const report=await migrateLegacy({compact:true});
    assert.equal(report.snapshots,1);assert.equal(report.scores,1);assert.equal(report.odds,1);assert.equal(report.archives,1);
    assert.equal((await fs.stat(path.join(tmp,'monitor-v2.sqlite3'))).isFile(),true);
    await assert.rejects(fs.stat(path.join(tmp,'live.json')),{code:'ENOENT'});
    await assert.rejects(fs.stat(scoreFile),{code:'ENOENT'});
    assert.equal(snapshotLoad('live').history[0].team1,'A');
    assert.equal(scoreLoad(identity).entries[0].scoreText,'0:0');
    assert.equal(oddsEntries('astek','1').length,1);
    assert.equal(archiveRead('results/days/2026-09-28.json').date,'2026-09-28');
    assert.equal(storageMetrics().integrity,'ok');

    const exported=await exportLegacy();
    assert.equal(exported.snapshots,1);assert.equal(exported.scores,1);assert.equal(exported.odds,1);assert.equal(exported.archives,1);
    assert.equal(JSON.parse(await fs.readFile(path.join(tmp,'live.json'),'utf8')).history[0].sourceEventId,'1');
    assert.equal(JSON.parse(await fs.readFile(scoreFile,'utf8')).entries.length,1);
    assert.equal((await fs.readFile(path.join(tmp,'odds-journal','astek','1.ndjson'),'utf8')).trim().split('\n').length,1);
    assert.equal(JSON.parse(await fs.readFile(path.join(tmp,'results','days','2026-09-28.json'),'utf8')).complete,true);
  }finally{closeSqliteStorage();config.dataDir=prior;await fs.rm(tmp,{recursive:true,force:true});}
});


test('SQLite snapshot migration and saves tolerate duplicate current event ids',async()=>{
  const prior=config.dataDir,tmp=await fs.mkdtemp(path.join(os.tmpdir(),'astek-sqlite-dup-snapshot-'));
  closeSqliteStorage();config.dataDir=tmp;
  try{
    const first={id:'ggbet:dup',source:'ggbet',sourceEventId:'dup',team1:'Old A',team2:'Old B',startAt:100};
    const last={...first,team1:'New A',team2:'New B',startAt:200};
    await write(path.join(tmp,'live.json'),{revision:1,events:[first,last],history:[]});

    const report=await migrateLegacy({compact:false});
    assert.equal(report.snapshots,1);
    let saved=snapshotLoad('live');
    assert.equal(saved.events.length,1);
    assert.equal(saved.events[0].team1,'New A','last duplicate occurrence should win during legacy import');

    snapshotSave('live',{revision:2,events:[{...last,team1:'Runtime A'},{...last,team1:'Runtime B'}],history:[]});
    saved=snapshotLoad('live');
    assert.equal(saved.events.length,1);
    assert.equal(saved.events[0].team1,'Runtime B','last duplicate occurrence should win during runtime save');

    const second=await migrateLegacy({compact:false});
    assert.equal(second.snapshots,1);
    assert.equal(snapshotLoad('live').events.length,1,'repeat migration must remain idempotent');
    assert.equal(storageMetrics().integrity,'ok');
  }finally{closeSqliteStorage();config.dataDir=prior;await fs.rm(tmp,{recursive:true,force:true});}
});
