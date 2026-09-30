import test from 'node:test';
import assert from 'node:assert/strict';
import {HawkService} from '../src/hawk.js';

test('Dota statistics does not auto-match when only one team matches',async()=>{
 const now=Date.now(),service=new HawkService();
 const series={id:901,slug:'azure-vs-peace',championship:{slug:'mad-dogs',name:'Mad Dogs League'},team1:{name:'Azure Dragons'},team2:{name:'Peacekeepers Team'},startAt:new Date(now).toISOString(),bestOf:3,matches:[],streams:[]};
 service.catalog=[series];service.indexAt=now;
 service.page=async()=>({seriesPageData:series});
 const value=await service.get({team1:'Azure Dragons',team2:'Dark Templars',startAt:now});
 assert.equal(value.matched,false);assert.equal('event' in value,false);assert.match(value.message,/точное совпадение/i);service.close();
});

test('Dota statistics refuses ambiguous one-team candidates without a manual chooser',async()=>{
 const now=Date.now(),service=new HawkService(),base={championship:{slug:'mad-dogs',name:'Mad Dogs League'},team1:{name:'Azure Dragons'},bestOf:3,matches:[],streams:[]};
 service.catalog=[{...base,id:901,slug:'a',team2:{name:'Peacekeepers Team'},startAt:new Date(now).toISOString()},{...base,id:902,slug:'b',team2:{name:'Hellspawn'},startAt:new Date(now+60000).toISOString()}];service.indexAt=now;
 const value=await service.get({team1:'Azure Dragons',team2:'Dark Templars',startAt:now});
 assert.equal(value.matched,false);assert.equal('candidates' in value,false);assert.match(value.message,/(несколько похожих|точное совпадение)/i);service.close();
});
