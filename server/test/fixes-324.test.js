import test from 'node:test';
import assert from 'node:assert/strict';
import {eventKind,resolveEvents,stringSimilarity} from '../src/entity-resolver.js';

test('plural comparison leagues are additional events',()=>{
  assert.equal(eventKind({league:'PGL Wallachia. Comparisons by kills',team1:'Ws (Aurora)',team2:'pma (Natus Vincere)'}),'kills-comparison');
  assert.equal(eventKind({league:'League. Comparisons by maps',team1:'A',team2:'B'}),'maps-comparison');
});

test('Pinnacle short team initialism can match a strongly anchored fixture',()=>{
  assert.ok(stringSimilarity('largadosypelados','LP',{team:true})>=0.88);
  const start=Date.parse('2026-09-26T14:00:00+04:00');
  const rows=resolveEvents([
    {id:'astek-1',sourceEventId:'1',source:'astek',provider:'AstekBet',category:'Counter Strike 2',league:'LB Masters',leagueId:'11',team1:'Fluxo W7M',team2:'largadosypelados',startAt:start},
    {id:'pin-1',sourceEventId:'2',source:'pinnacle',provider:'Pinnacle',category:'Counter Strike 2',league:'LB Masters',leagueId:'22',team1:'Fluxo W7M',team2:'LP',startAt:start}
  ],{mode:'prematch'});
  assert.equal(rows.length,1);
  assert.equal(rows[0].sourceRefs.length,2);
  assert.deepEqual(new Set(rows[0].sourceRefs.map(r=>r.source)),new Set(['astek','pinnacle']));
});
