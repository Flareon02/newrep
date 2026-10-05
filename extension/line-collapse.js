'use strict';
/* Collapse model of the Line (game > league > matches), 9.2 UX.

   - Closed games are remembered (prefs); open leagues exist only in this session.
   - Collapsing a game forgets which of its leagues were open; collapsing everything forgets all of them.
   - So every (re)open is deterministic: games expanded, leagues collapsed. No nested state is ever restored.
   League keys are "<game>|<league>", game keys "game:<game>". Pure: unit-tested in Node. */
(function(root){
 function create({closedGames=[]}={}){
  const closed=new Set(closedGames),open=new Set();
  const gameOf=leagueKey=>'game:'+String(leagueKey).split('|')[0];
  return {
   gameOpen:key=>!closed.has(key),
   leagueOpen:key=>open.has(key)&&!closed.has(gameOf(key)),
   setGame(key,isOpen){if(isOpen)closed.delete(key);else{closed.add(key);for(const k of [...open])if(gameOf(k)===key)open.delete(k);}},
   setLeague(key,isOpen){if(isOpen){open.add(key);closed.delete(gameOf(key));}else open.delete(key);},
   // The one global toggle: "collapse all" closes every game; "expand all" opens every game - leagues stay collapsed.
   setAll(isOpen,gameKeys=[]){open.clear();if(isOpen)closed.clear();else for(const k of gameKeys)closed.add(k);},
   anyOpen:gameKeys=>gameKeys.some(k=>!closed.has(k)),
   closedGames:()=>[...closed],
   signature:()=>[...closed].join('|')+'#'+[...open].join('|')
  };
 }
 const api={create};
 if(typeof module==='object'&&module.exports)module.exports=api;else root.LineCollapse=api;
})(globalThis);
