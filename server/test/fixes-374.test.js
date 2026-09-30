import test from 'node:test';
import assert from 'node:assert/strict';
import {HawkService} from '../src/hawk.js';
import {StatisticsService} from '../src/statistics-service.js';

test('3.7.4 logical bookmaker event id does not override Hawk auto matching', async()=>{
 const svc=new HawkService();
 svc.catalog=[{id:100991,slug:'real-eclipse-vs-silent-killer',startAt:'2026-09-28T23:00:00Z',championship:{slug:'d2-space-league',name:'Dota 2 Space League 2026 Season 74'},team1:{name:'Real Eclipse'},team2:{name:'Silent killer'}}];
 svc.indexAt=Date.now();
 svc.page=async()=>({seriesPageData:{id:100991,slug:'real-eclipse-vs-silent-killer',championship:{slug:'d2-space-league',name:'Dota 2 Space League 2026 Season 74'},team1:{name:'Real Eclipse'},team2:{name:'Silent killer'},matches:[],streams:[]}});
 const result=await svc.get({id:'logical:live:astek-756966588|ggbet-f513',team1:'Real Eclipse',team2:'Silent killer',league:'Space Dota 2 League',category:'Dota 2',startAt:Date.now()+99_000_000});
 assert.equal(result.matched,true);
 assert.equal(result.event.id,100991);
 svc.close();
});

test('3.7.4 explicit numeric Hawk id can still be used manually', async()=>{
 const svc=new HawkService();
 svc.catalog=[{id:100991,slug:'a',championship:{slug:'league',name:'League'},team1:{name:'A'},team2:{name:'B'}}];svc.indexAt=Date.now();
 svc.page=async()=>({seriesPageData:{id:100991,slug:'a',championship:{slug:'league',name:'League'},team1:{name:'A'},team2:{name:'B'},matches:[],streams:[]}});
 const result=await svc.get({statisticsId:'100991',team1:'Wrong',team2:'Names',league:'Wrong',category:'Dota 2'});
 assert.equal(result.matched,true);
 svc.close();
});

test('3.7.4 StatisticsService strips logical id before provider get', async()=>{
 let received=null;
 const hawk={get:async q=>{received=q;return {matched:false};},status:()=>({indexUpdatedAt:1,catalogSeries:1}),close(){}};
 const event={id:'logical:live:astek-1|ggbet-2',view:'live',category:'Dota 2',league:'Destiny League',team1:'Wiser Warriors',team2:'LSG',startAt:123};
 const service=new StatisticsService(null,hawk,()=>[event]);
 await service.sweep();
 assert.ok(received);
 assert.equal('id' in received,false);
 assert.deepEqual(received,{team1:'Wiser Warriors',team2:'LSG',league:'Destiny League',category:'Dota 2',startAt:123});
 await service.stop();
});
