import test from 'node:test';
import assert from 'node:assert/strict';
import {primaryLeagueName} from '../src/entity-resolver.js';
import {crossbetCatalogRows,isCrossbetCs2} from '../src/crossbet.js';

test('primary league display removes bookmaker stage suffixes without losing tournament name',()=>{
  assert.equal(primaryLeagueName('United21: Division 1','Counter Strike 2'),'United21');
  assert.equal(primaryLeagueName('CS 2. United 21','Counter Strike 2'),'United21');
  assert.equal(primaryLeagueName('Counter-Strike. UNITED21','Counter Strike 2'),'UNITED21');
  assert.equal(primaryLeagueName('ESL Pro League: Season 22','Counter Strike 2'),'ESL Pro League');
});

test('Crossbet catalog accepts legacy and current CS naming/payload shapes',()=>{
  const rows=crossbetCatalogRows({data:{matches:[
    {id:'00001014422',game:'CS2',team1:'XI',team2:'OldMix'},
    {matchId:'00001014423',sport:'Counter-Strike 2',teams:[{name:'A'},{name:'B'}]},
    {matchId:'00001014424',game:'dota2',teams:[{name:'C'},{name:'D'}]}
  ]}});
  assert.equal(rows.length,2);
  assert.equal(rows[0].teams[0].name,'XI');
  assert.equal(rows[0].teams[1].name,'OldMix');
  assert.equal(isCrossbetCs2({game:'csgo'}),true);
  assert.equal(isCrossbetCs2({game:'cs2'}),true);
  assert.equal(isCrossbetCs2({sport:'Counter Strike 2'}),true);
  assert.equal(isCrossbetCs2({game:'dota2'}),false);
});

