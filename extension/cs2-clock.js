'use strict';
/* Round clock of the CS2 statistics panel (Crossbet). The display is derived from one anchor - the upstream reading
   of the round clock brought to the moment the server sent it, plus the local monotonic time it arrived - and never
   from a counter incremented by a timer, so late timers, renders or feed bursts cannot make it drift or stutter.
   A feed update re-anchors; within the same round a reading that is at most `maxBackStepSec` behind the running
   display is not applied (no visual jump back), anything larger, a new round/map/bomb phase or a pause/resume is a
   real correction and is applied. Pure: no DOM; unit-tested in Node with a fake clock. */
(function(root){
 const secondsOf=value=>{if(value==null||value==='')return null;if(typeof value==='number'&&Number.isFinite(value))return Math.max(0,value);const raw=String(value).trim();if(/^\d+(?:[.,]\d+)?$/.test(raw))return Math.max(0,Number(raw.replace(',','.')));const m=raw.match(/^(\d+):(\d{1,2})(?:[.,](\d+))?$/);return m?Number(m[1])*60+Number(m[2])+(m[3]?Number('0.'+m[3]):0):null;};
 const format=seconds=>{if(seconds==null)return '—:—';const whole=Math.max(0,Math.floor(seconds+1e-6));return Math.floor(whole/60)+':'+String(whole%60).padStart(2,'0');};
 function createRoundClock({now=()=>performance.now(),maxBackStepSec=1.5,staleAfterMs=45000}={}){
  let anchor=null,lastUpdate=0;
  const running=d=>!d?.archived&&!d?.finished&&d?.connected!==false&&(d?.timerRunning===true||d?.clockAdvancing===true);
  function value(t=now()){if(!anchor)return null;if(!anchor.running||stale(t))return frozen(t);return Math.max(0,anchor.seconds-(t-anchor.local)/1000);}
  // A stale clock stops where it was when the feed went quiet instead of counting into nothing.
  function frozen(t){if(!anchor.running)return anchor.seconds;const until=Math.min(t,lastUpdate+staleAfterMs);return Math.max(0,anchor.seconds-(until-anchor.local)/1000);}
  function stale(t=now()){return !!anchor&&anchor.live&&t-lastUpdate>=staleAfterMs;}
  function update(d,{receivedLocal=now()}={}){
   const sec=secondsOf(d?.roundTime);lastUpdate=receivedLocal;
   if(sec==null){anchor=null;return 'none';}
   const run=running(d),age=run?Math.max(0,Number(d?.serverNow||0)-Number(d?.clockAt||d?.serverNow||0))/1000:0;
   const key=[d?.mapNum,d?.currentRound,['planted','defusing'].includes(d?.bomb)?'bomb':'round'].join('|');
   const next={seconds:run?Math.max(0,sec-age):sec,local:receivedLocal,running:run,key,live:!d?.archived&&!d?.finished};
   if(anchor&&anchor.running&&run&&anchor.key===key){
    const shown=Math.max(0,anchor.seconds-(receivedLocal-anchor.local)/1000),behind=next.seconds-shown;
    if(behind>0&&behind<=maxBackStepSec)return 'kept';
   }
   anchor=next;return 'anchored';
  }
  // ms until the displayed second changes (for a count-down: the fractional part of the remaining time)
  function nextChangeIn(t=now()){const v=value(t);if(v==null||!anchor.running||stale(t))return 1000;const frac=v-Math.floor(v+1e-6);return Math.min(1000,Math.max(16,Math.round(frac*1000)+8));}
  return {update,value,stale,nextChangeIn,text:(t)=>format(value(t)),state:()=>anchor&&{...anchor},reset(){anchor=null;}};
 }
 const api={createRoundClock,secondsOf,format};
 if(typeof module==='object'&&module.exports)module.exports=api;else root.Cs2Clock=api;
})(globalThis);
