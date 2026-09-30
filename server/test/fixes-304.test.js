import test from 'node:test';
import assert from 'node:assert/strict';
import {ResultsService} from '../src/results.js';
import {urls} from '../src/config.js';
import {inferCategoryFromLeague,inferLiveCategory} from '../src/parsers.js';
import {resolveEvents} from '../src/entity-resolver.js';
import GameCategories from '../src/game-categories.cjs';
test('current results use full six-hour boundaries for catalog and games, skip future windows',async()=>{
 const original=Date.now;Date.now=()=>Date.parse('2026-09-22T11:11:00Z');
 try{
  const service=new ResultsService(),calls=[];service.astekPage=async(_day,_key,load)=>load();
  service.astekRequest=async(build,kind)=>{const url=new URL(build('https://astekbet.com','plural'));calls.push(url);return {origin:url.origin,payload:{items:kind==='games'?[]:[{sportId:40,id:1}]}};};
  const result=await service.fetchAstekDay('2026-09-22');
  assert.equal(result.complete,true);assert.equal(calls.length,6);
  assert.ok(calls.every(u=>Number(u.searchParams.get('dateTo'))-Number(u.searchParams.get('dateFrom'))===21600));
  assert.equal(Math.max(...calls.map(u=>+u.searchParams.get('dateTo'))),Date.parse('2026-09-22T14:00:00Z')/1000);
  const url=new URL(urls.resultsChamps('https://astekbet.com',0,Date.now()+10000));assert.equal(+url.searchParams.get('dateTo'),(Date.now()+10000)/1000);
 }finally{Date.now=original;}
});
test('same discipline rules cover live, line, and stored generic archive categories',()=>{
 for(const [,name] of GameCategories.entries){assert.equal(inferCategoryFromLeague(name+'. Test'),name);assert.equal(inferLiveCategory({SSN:'Esports',L:name+'. Test'}),name);}
 const e={id:'ow',source:'astek',category:'Esports',league:'Overwatch. Champions Series. Japan',team1:'ENTER FORCE.36',team2:'Uwinks',startAt:Date.now()};
 const result=resolveEvents([e],{mode:'past'})[0];assert.equal(result.category,'Overwatch');assert.equal(result.sourceRefs[0].category,'Overwatch');
});
