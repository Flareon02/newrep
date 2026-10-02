import {config} from './config.js';

export const ORIGIN_COOLDOWN_MS=5*60_000;
// A fault of the mirror itself: unreachable/timed out, 5xx, or refused (403/429). A 200 with Success=false, a non-JSON
// body or HTTP 406/400 is about the request (its shape), so it says nothing about the mirror.
export const mirrorFault=e=>!e?.status||e.status>=500||e.status===403||e.status===429;

// Mirror order for AstekBet requests: the mirror that answered last goes first; a mirror with a fault waits
// `cooldownMs` behind the healthy ones and stays in the list as the last fallback. The -0021 mirror keeps its old
// place as the first choice only while nothing is known.
export class OriginHealth{
  constructor({origins=()=>config.origins,cooldownMs=ORIGIN_COOLDOWN_MS,now=()=>Date.now()}={}){Object.assign(this,{origins,cooldownMs,now,lastGood:'',failedUntil:new Map()});}
  order(now=this.now()){
    const preferred=[...this.origins()].sort((a,b)=>Number(b.includes('0021'))-Number(a.includes('0021')));
    const rank=o=>((this.failedUntil.get(o)||0)>now?2:0)+(o===this.lastGood?0:1);
    return preferred.map((o,i)=>[o,rank(o),i]).sort((a,b)=>a[1]-b[1]||a[2]-b[2]).map(x=>x[0]);
  }
  ok(origin){this.lastGood=origin;this.failedUntil.delete(origin);}
  // Returns true when the error counted against the mirror.
  fail(origin,error){
    if(!mirrorFault(error))return false;
    this.failedUntil.set(origin,this.now()+this.cooldownMs);if(this.lastGood===origin)this.lastGood='';
    return true;
  }
  status(now=this.now()){return {lastGood:this.lastGood||null,coolingDown:[...this.failedUntil].filter(([,t])=>t>now).map(([origin,until])=>({origin,until}))};}
  reset(){this.lastGood='';this.failedUntil.clear();}
}
// Shared by the line collector and the LIVE detail reads: what one learns about a mirror the other uses.
export const astekOrigins=new OriginHealth();
