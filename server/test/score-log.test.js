import test from 'node:test';
import assert from 'node:assert/strict';
import {ScoreLog} from '../src/score-log.js';
import {ResultsService} from '../src/results.js';
import {config} from '../src/config.js';

test('score journal persists changes, final confirmation/correction, and survives restart',async()=>{
 const disk=new Map(),io={read:async(k,f)=>structuredClone(disk.get(k)||f),write:async(k,v)=>disk.set(k,structuredClone(v))},log=new ScoreLog(io);
 const row={source:'astek',id:'11',team1:'A',team2:'B',scoreText:'0:0'};
 await log.record([row],{at:100});await log.record([row],{at:200});
 await Promise.all([log.record([{...row,scoreText:'1:0'}],{at:300}),log.record([{...row,scoreText:'1:1'}],{at:400})]);
 await log.record([{...row,scoreText:'2:1',resultVerified:true}],{phase:'results',at:500});
 await log.record([{...row,scoreText:'0:0'}],{at:600});
 await log.record([{...row,scoreText:'2:0',resultVerified:true}],{phase:'results',at:700});
 const result=await new ScoreLog(io).get(['astek:11']);assert.deepEqual(result.entries.map(r=>r.scoreText),['2:0','2:1','1:1','1:0','0:0']);assert.equal(result.entries[0].verified,true);assert.equal(result.startedAt,100);
});
test('journal keeps source identities separate and canonicalizes Fonbet result IDs',async()=>{
 const disk=new Map(),log=new ScoreLog({read:async(k,f)=>disk.get(k)||f,write:async(k,v)=>disk.set(k,v)});
 await log.record([{source:'astek',id:'12',scoreText:'1:0'},{source:'fonbet',id:'fonbet-12',scoreText:'0:1'}],{at:100});
 await log.record([{source:'fonbet',id:'fonbet-result-12',scoreText:'0:2',resultVerified:true}],{at:200});
 assert.equal((await log.get(['astek:12'])).entries.length,1);assert.equal((await log.get(['fonbet:12'])).entries.length,2);
 assert.equal((await log.get(['astek:missing'])).entries.length,0);
});
test('viewed archive days refresh every five minutes without refreshing entire warm archive',()=>{
 const service=new ResultsService(),past='2026-01-01';assert.equal(service.ttl(past),86400100);
 service.viewedDays=new Map([[past,Date.now()+360000]]);assert.equal(service.ttl(past),300000);assert.equal(config.prematchCatalogIntervalMs,60000);assert.equal(config.resultsCurrentCacheMs,300000);
});
