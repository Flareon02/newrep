import test from 'node:test';
import assert from 'node:assert/strict';
import {resolveEvents,fixtureLogo} from '../src/entity-resolver.js';
import {TeamLogos} from '../src/team-logos.js';

const start=Date.parse('2026-09-28T18:00:00Z'),base={category:'Dota 2',league:'Mad Dogs League',team1:'Moonlight Wispers',team2:'Project Achilles',startAt:start,marketKind:'main'};
const L=(n)=>`/api/team-logos/${String(n).repeat(32).slice(0,32)}`;

test('team logos: AstekBet first, then the same fixture at another bookmaker (oriented), else no logo', ()=>{
  const astekWithLogo=resolveEvents([{...base,id:'a',source:'astek',sourceEventId:'a',team1Logo:L('a'),team2Logo:''},{...base,id:'g',source:'ggbet',sourceEventId:'g',team1Logo:L('b'),team2Logo:L('c'),startAt:start+1000}],{mode:'live'});
  assert.equal(astekWithLogo.length,1);assert.equal(astekWithLogo[0].team1Logo,L('a'),'AstekBet logo wins');assert.equal(astekWithLogo[0].team2Logo,L('c'),'missing AstekBet logo: GGBET of the same fixture');
  // GGBET lists the teams the other way round: its logos follow its teams, not its columns.
  const reversed=resolveEvents([{...base,id:'a',source:'astek',sourceEventId:'a'},{...base,id:'g',source:'ggbet',sourceEventId:'g',team1:'Project Achilles',team2:'Moonlight Wispers',team1Logo:L('p'),team2Logo:L('m'),startAt:start+1000}],{mode:'live'});
  assert.equal(reversed.length,1);assert.equal(reversed[0].team1,'Moonlight Wispers');assert.equal(reversed[0].team1Logo,L('m'));assert.equal(reversed[0].team2Logo,L('p'));
  // A different fixture (other opponent) never lends its logo, even with the same team name.
  const separate=resolveEvents([{...base,id:'a',source:'astek',sourceEventId:'a'},{...base,id:'g',source:'ggbet',sourceEventId:'g',team2:'Totally Other Team',team1Logo:L('x'),team2Logo:L('y'),startAt:start+6*3600000}],{mode:'live'});
  assert.equal(separate.length,2);const astek=separate.find(e=>e.sourceRefs.some(r=>r.source==='astek'));assert.equal(astek.team1Logo,'');assert.equal(astek.team2Logo,'');
  assert.equal(fixtureLogo([{source:'pinnacle'},{source:'databet',team1Logo:L('d')}],1),L('d'));
  assert.equal(fixtureLogo([],2,{}),'');
});

test('team logo store accepts the GGBET/DataBet image CDN (raster only) next to the AstekBet one', ()=>{
  const t=new TeamLogos();
  assert.ok(t.allowed('https://cdn.gin.bet/team/home.png'));assert.ok(t.allowed('https://cdn.gin.bet/a/b.webp'));
  assert.equal(t.allowed('https://cdn.gin.bet/a/b.svg'),'','no SVG');assert.equal(t.allowed('http://cdn.gin.bet/a.png'),'');assert.equal(t.allowed('https://cdn.gin.bet.evil.example/a.png'),'');
  assert.ok(t.allowed('https://v2l.traincdn.com/sfiles/logo_teams/'+'a'.repeat(32)+'.png'));
});
