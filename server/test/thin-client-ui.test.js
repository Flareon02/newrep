import test from 'node:test';
import assert from 'node:assert/strict';
import {queryUiEvents,enrichResultsWithPrematch,queryLeagueCatalog,mergeUiLedger,buildUiPrematchEvents} from '../src/ui-service.js';

const rules={links:[],visibility:{excludedLeagueKeys:[],excludedCategoryKeys:[]}};

test('ui results filter and page on server',()=>{
  const rows=[
    {id:'a',category:'Dota 2',league:'Alpha',team1:'One',team2:'Two',removedAt:30,sourceRefs:[{source:'astek',id:'1',sourceEventId:'1'}]},
    {id:'b',category:'Counter Strike 2',league:'Beta',team1:'Three',team2:'Four',removedAt:40,sourceRefs:[{source:'fonbet',id:'2',sourceEventId:'2'}]}
  ];
  const out=queryUiEvents(rows,{q:'three',limit:'10'},rules,'results');
  assert.equal(out.total,1);assert.equal(out.events[0].id,'b');
});

test('results are enriched with prematch appearance by provider identity',()=>{
  const result=[{id:'x',sourceRefs:[{source:'astek',sourceEventId:'77',id:'77',firstSeenAt:200,enteredLiveAt:200,lifecycle:[]}]}];
  const pre=[{source:'astek',sourceEventId:'77',id:'77',firstSeenAt:100,lifecycle:[{type:'entered',at:100}]}];
  const out=enrichResultsWithPrematch(result,pre);
  assert.equal(out[0].sourceRefs[0].firstPrematchAt,100);
  assert.ok(out[0].sourceRefs[0].lifecycle.some(x=>x.phase==='prematch'&&x.at===100));
});

test('history ledger is built server-side',()=>{
  const pre=[{source:'astek',id:'1',sourceEventId:'1',category:'Dota 2',league:'L',team1:'A',team2:'B',startAt:1000,firstSeenAt:500,removedAt:900}];
  const live=[{source:'astek',id:'1',sourceEventId:'1',category:'Dota 2',league:'L',team1:'A',team2:'B',startAt:1000,firstSeenAt:950,enteredLiveAt:950,removedAt:1500}];
  const rows=mergeUiLedger({prematchHistory:pre,liveHistory:live,links:[]});
  assert.equal(rows.length,1);assert.equal(rows[0].sourceRefs[0].firstPrematchAt,500);assert.equal(rows[0].sourceRefs[0].enteredLiveAt,950);
});

test('league view calculates score/metrics on server',()=>{
  const catalog={revision:1,visibilityRevision:0,links:[],visibility:{},providers:{astek:[{id:'astek:id:1',source:'astek',category:'Dota 2',league:'Blast',leagueId:'1',current:1}],fonbet:[{id:'fonbet:id:2',source:'fonbet',category:'Dota 2',league:'BLAST',leagueId:'2',current:1}],pinnacle:[],ggbet:[]}};
  const current=[{category:'Dota 2',league:'Blast',team1:'A',team2:'B',startAt:1000,sourceRefs:[{source:'astek',category:'Dota 2',league:'Blast',leagueId:'1',startAt:1000},{source:'fonbet',category:'Dota 2',league:'BLAST',leagueId:'2',startAt:1000}]}];
  const out=queryLeagueCatalog(catalog,current,{limit:'120'});
  assert.equal(out.providers.astek[0].matchedPercent,100);assert.ok(out.providers.astek[0].suggestion>=70);
});


test('server-prepared line removes fixtures that have already entered live',()=>{
  const currentPrematch=[
    {source:'astek',id:'1',sourceEventId:'1',category:'Dota 2',league:'L',team1:'A',team2:'B',startAt:1000,firstSeenAt:100},
    {source:'fonbet',id:'2',sourceEventId:'2',category:'Dota 2',league:'Other',team1:'C',team2:'D',startAt:2000,firstSeenAt:100}
  ];
  const currentLive=[{source:'astek',id:'1',sourceEventId:'1',category:'Dota 2',league:'L',team1:'A',team2:'B',startAt:1000,firstSeenAt:900,enteredLiveAt:900}];
  const rows=buildUiPrematchEvents(currentPrematch,currentLive,[]);
  assert.equal(rows.length,1);
  assert.equal(rows[0].sourceRefs[0].sourceEventId,'2');
});
