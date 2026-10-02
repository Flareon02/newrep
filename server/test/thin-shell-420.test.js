import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {compactUiEvent,compactUiPayload} from '../src/ui-service.js';
import {thinFeedPushPayload} from '../src/api.js';

const ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const read=name=>fs.readFileSync(path.join(ROOT,name),'utf8');

test('thin UI projection strips bookmaker market trees but preserves list semantics',()=>{
 const event={id:'logical-1',category:'Counter Strike 2',categoryKey:'cs2',league:'Cup',leagueKey:'cup',team1:'A',team2:'B',team1Logo:'/logo/a',team2Logo:'/logo/b',startAt:1000,marketKind:'main',entityAliases:['astek:11'],sourceRefs:[{source:'astek',id:'11',sourceEventId:'11',catalogId:'astek:id:9',category:'Counter Strike 2',categoryKey:'cs2',league:'Cup',leagueId:'9',leagueKey:'cup',team1:'A',team2:'B',team1Logo:'/dup/a',team2Logo:'/dup/b',url:'https://example.test/11',startAt:1000,firstPrematchAt:500,enteredLiveAt:900,inLive:true,inPrematch:false,scoreText:'1:0',seriesScore:[1,0],odds:{updatedAt:12,markets:[{type:'moneyline',prices:[{decimal:1.5}]}]},lifecycle:[{phase:'prematch',type:'entered',at:500,extra:'drop-me'},{phase:'live',type:'entered',at:900}]}]};
 const out=compactUiEvent(event),ref=out.sourceRefs[0];
 assert.equal(out.marketKind,undefined); // 'main' is the default and is omitted on the wire
 assert.equal(ref.source,'astek');assert.equal(ref.league,'Cup');assert.equal(ref.scoreText,'1:0');
 assert.equal('odds' in ref,false);assert.equal('oddsMeta' in ref,false);
 assert.equal('team1Logo' in ref,false);assert.equal('team2Logo' in ref,false);
 assert.deepEqual(ref.timeline,[{phase:'prematch',type:'entered',at:500},{phase:'live',type:'entered',at:900}]);
 assert.equal(out.team1Logo,'/logo/a');assert.equal(out.team2Logo,'/logo/b');
});

test('thin payload keeps only one lightweight event list',()=>{
 const out=compactUiPayload({events:[{id:'1',category:'Dota 2',league:'L',team1:'A',team2:'B',sourceRefs:[{source:'ggbet',id:'x',sourceEventId:'x',odds:{markets:new Array(100).fill({type:'x'})}}]}]});
 assert.equal(out.thin,true);assert.equal(out.uiSchemaVersion,2);assert.equal(out.events.length,1);assert.equal(out.events[0].sourceRefs[0].odds,undefined);
});

test('thin push never sends odds trees and tells open detail views to reload',()=>{
 const out=thinFeedPushPayload('live','ggbet',{patches:[{source:'ggbet',id:'x',fields:['odds','scoreText','seriesScore'],odds:{markets:[{huge:true}]},scoreText:'1:0',seriesScore:[1,0]}],at:1},{revision:'r',structureRevision:'s',leagueRules:{huge:true},providers:{ggbet:{huge:true}}});
 assert.equal(out.event,'patch');assert.equal(out.payload.thin,true);assert.equal(out.payload.patches.length,1);
 assert.deepEqual(out.payload.meta,{revision:'r',structureRevision:'s'});
 const patch=out.payload.patches[0];assert.equal(patch.detailChanged,true);assert.equal('odds' in patch,false);assert.deepEqual(patch.fields,['scoreText','seriesScore','quote']);assert.equal(patch.quote,null,'no main market in this tree: the quote is cleared');
});

test('thin shell API exposes compact lists, on-demand detail and server manual generator',()=>{
 const api=read('src/api.js'),service=read('src/odds-service.js');
 assert.match(api,/\/api\/ui\/live/);assert.match(api,/\/api\/ui\/event-detail/);assert.match(api,/\/api\/odds\/manual/);
 assert.match(api,/thinFeedPushPayload/);assert.match(service,/createManual/);assert.match(service,/manual-odds-worker\.js/);
});

test('thin refs and pushes carry the main-market quote (bookmaker order, open/suspended, no market tree)',async()=>{
 const {uiQuote,compactUiPayload}=await import('../src/ui-service.js');
 const odds=(status='open')=>({updatedAt:5,team1:'A',team2:'B',markets:[{type:'total',period:0,status:'open',prices:[{designation:'over',decimal:1.9}]},{type:'moneyline',period:1,status:'open',prices:[{designation:'home',decimal:1.5},{designation:'away',decimal:2.5}]},{type:'moneyline',period:0,status,prices:[{designation:'home',decimal:1.8333},{designation:'away',decimal:2.05},{designation:'draw',decimal:0}]}]});
 assert.deepEqual(uiQuote(odds()),{h:1.833,a:2.05,at:5},'match winner (period 0), rounded, no invalid draw');
 assert.deepEqual(uiQuote(odds('suspended')),{h:null,a:null,s:'s',at:5});
 assert.equal(uiQuote({markets:[{type:'total',prices:[]}]}),null);assert.equal(uiQuote(null),null);
 const thin=compactUiPayload({events:[{id:'e',team1:'A',team2:'B',sourceRefs:[{source:'astek',id:'1',scoreReversed:true,odds:odds()},{source:'fonbet',id:'2'}]}]});
 assert.deepEqual(thin.events[0].sourceRefs[0].quote,{h:1.833,a:2.05,at:5});assert.equal(thin.events[0].sourceRefs[0].odds,undefined);assert.equal(thin.events[0].sourceRefs[0].scoreReversed,true);
 assert.equal('quote' in thin.events[0].sourceRefs[1],false);
 const push=thinFeedPushPayload('live','ggbet',{patches:[{source:'astek',id:'1',fields:['odds'],odds:odds()}],at:1},{revision:'r'});
 assert.deepEqual(push.payload.patches[0].fields,['quote']);assert.deepEqual(push.payload.patches[0].quote,{h:1.833,a:2.05,at:5});
});
