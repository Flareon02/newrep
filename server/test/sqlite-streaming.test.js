import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {config} from '../src/config.js';
import {closeSqliteStorage,migrateLegacy,oddsEntries,storageMetrics} from '../src/sqlite-storage.js';

async function writeLargeJournal(file,rows=12000){
  await fs.mkdir(path.dirname(file),{recursive:true});
  const fh=await fs.open(file,'w');
  try{
    for(let i=0;i<rows;i++){
      const entry={
        at:1700000000000+i,
        team1:'Alpha Team',team2:'Beta Team',scoreText:`${i%16}:${(i*3)%16}`,
        changes:Array.from({length:8},(_,m)=>({key:`market-${m}|map-${m%3}|line-${i%5}`,period:m%4,title:'Winner / Total / Handicap',status:'open',prices:[{side:'home',points:m%2?1.5:null,odds:1.5+(i%70)/100},{side:'away',points:m%2?-1.5:null,odds:2.1+(i%50)/100}]}))
      };
      await fh.write(JSON.stringify(entry)+'\n');
    }
  }finally{await fh.close();}
}

test('large NDJSON migration resumes from checkpoints and compacts only after verification',async()=>{
  const prior=config.dataDir,tmp=await fs.mkdtemp(path.join(os.tmpdir(),'astek-streaming-'));
  closeSqliteStorage();config.dataDir=tmp;
  try{
    const journal=path.join(tmp,'odds-journal','ggbet','huge.ndjson');
    await writeLargeJournal(journal,12000);
    const sourceSize=(await fs.stat(journal)).size;
    await fs.mkdir(path.join(tmp,'odds-state','ggbet'),{recursive:true});
    await fs.writeFile(path.join(tmp,'odds-state','ggbet','huge.json'),JSON.stringify({last:{},lastAt:1700000011999,team1:'Alpha Team',team2:'Beta Team'}));

    let interrupted=false;
    await assert.rejects(
      migrateLegacy({compact:true,progress:e=>{if(!interrupted&&e.kind==='odds-checkpoint'&&e.rows>=1500){interrupted=true;throw new Error('simulated interruption');}}}),
      /simulated interruption/
    );
    assert.equal(interrupted,true);
    assert.equal((await fs.stat(journal)).isFile(),true,'source must remain after interrupted migration');

    closeSqliteStorage();
    const report=await migrateLegacy({compact:true});
    assert.equal(report.odds,1);
    assert.equal(report.oddsJournalRows,12000);
    await assert.rejects(fs.stat(journal),{code:'ENOENT'});
    assert.equal(oddsEntries('ggbet','huge',{limit:300,ascending:false}).length,300);
    const metrics=storageMetrics();
    assert.equal(metrics.integrity,'ok');
    assert.equal(metrics.oddsRows,12000);
    const dbSize=(await fs.stat(path.join(tmp,'monitor-v2.sqlite3'))).size;
    assert.ok(dbSize < sourceSize*0.55,`compressed SQLite should be materially smaller (${dbSize} vs ${sourceSize})`);
  }finally{closeSqliteStorage();config.dataDir=prior;await fs.rm(tmp,{recursive:true,force:true});}
});
