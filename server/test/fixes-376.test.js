import test from 'node:test';
import assert from 'node:assert/strict';
import {eventKind} from '../src/entity-resolver.js';
import {crossbetOrderedPlayers} from '../src/crossbet.js';

test('3.7.6 classifies Fonbet comparison by frags as an additional kills event',()=>{
  assert.equal(eventKind({league:'BLAST Slam. Comparison by frags',team1:'Larl (Team Spirit)',team2:'Ken (Team Nemesis)'}),'kills-comparison');
  assert.equal(eventKind({league:'BLAST Slam. Comparisons by kills',team1:'A',team2:'B'}),'kills-comparison');
  assert.equal(eventKind({league:'BLAST Slam',team1:'Team Spirit',team2:'Team Nemesis'}),'main');
});

test('3.7.6 Crossbet zero-based teamStats keys preserve team ownership and names',()=>{
  const fixture={teams:[{name:'REFRESHER'},{name:'HOTU'}]};
  const players=crossbetOrderedPlayers(fixture,{teamStats:{
    0:{side:'ct',members:[{name:'Draft-',k:7,a:4,d:11,alive:true},{name:'dobry',k:10,a:1,d:14,alive:false}]},
    1:{side:'t',members:[{name:'mizu',k:9,a:5,d:5,alive:true},{name:'dwushka',k:9,a:1,d:4,alive:false}]}
  }});
  assert.equal(players.length,2);
  assert.equal(players[0].name,'REFRESHER');
  assert.deepEqual(players[0].members.map(p=>p.name),['Draft-','dobry']);
  assert.equal(players[1].name,'HOTU');
  assert.deepEqual(players[1].members.map(p=>p.name),['mizu','dwushka']);
});

test('3.7.6 Crossbet one-based object slots also map to two distinct teams',()=>{
  const fixture={teams:[{name:'Alpha'},{name:'Beta'}]};
  const players=crossbetOrderedPlayers(fixture,{teamStats:{
    1:{members:[{name:'a1'}]},2:{members:[{name:'b1'}]}
  }});
  assert.deepEqual(players.map(t=>t.name),['Alpha','Beta']);
  assert.deepEqual(players.map(t=>t.members[0].name),['a1','b1']);
});
