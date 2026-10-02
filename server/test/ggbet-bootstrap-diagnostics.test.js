import test from 'node:test';
import assert from 'node:assert/strict';
import {GgbetLiveCollector,GGBET_TRUSTED_ORIGINS} from '../src/ggbet.js';
import {config} from '../src/config.js';
import {SnapshotState} from '../src/state.js';
import {createApi} from '../src/api.js';
import {stopMatcher} from '../src/matcher-client.js';

// Direct-mode bootstrap against a mock of the public pages (no network). Responses are real `Response` objects, so
// headers behave as with Node fetch (`redirect: 'manual'` hands every 3xx back to the collector).
const TOKEN='T'.repeat(389),COOKIE='SECRET-COOKIE-VALUE-42';
const page=(token=TOKEN)=>`<!doctype html><html><script>"bettingClientOptions":{"token":"${token}","endpoint":"//gg-b-gql.gg.bet"}</script></html>`;
const html=(body,status=200,headers={})=>new Response(body,{status,headers:{'content-type':'text/html; charset=utf-8',...headers}});
const redirect=(location,headers={})=>new Response(null,{status:302,headers:{location,...headers}});
function collector(routes,{origins=['https://gg.bet'],trusted}={}){
  const calls=[];
  const fetchImpl=async(url,opts)=>{calls.push({url,redirect:opts?.redirect});const r=routes[url];if(!r)throw new Error('mock: no route '+url);return typeof r==='function'?r():r;};
  const c=new GgbetLiveCollector({async success(){},async failure(){}},{fetchImpl,...(trusted?{trustedOrigins:trusted}:{})});
  const old={o:config.ggbetOrigins,m:config.ggbetNetworkModeSetting,r:config.ggbetBootstrapRelayUrl};
  config.ggbetOrigins=origins;config.ggbetNetworkModeSetting='direct';config.ggbetBootstrapRelayUrl='';
  return {c,calls,restore:()=>{config.ggbetOrigins=old.o;config.ggbetNetworkModeSetting=old.m;config.ggbetBootstrapRelayUrl=old.r;}};
}
const last=c=>c.bootstrapDiagnostics().attempts.at(-1);
const noSecrets=c=>{const all=JSON.stringify(c.bootstrapDiagnostics())+JSON.stringify(c.status());assert.ok(!all.includes(COOKIE),'cookie value leaked');assert.ok(!all.includes(TOKEN),'token leaked');};

test('trusted origins are an exact static list; the default and compose lists only hold it', ()=>{
  assert.deepEqual([...GGBET_TRUSTED_ORIGINS],['https://gg.bet']);
  assert.deepEqual(config.ggbetOrigins,['https://gg.bet']);
});

test('A: 302 to a trusted host, then 200 with the token: the diagnostics show the redirect chain', async()=>{
  const {c,calls,restore}=collector({'https://gg.bet/ru/live':redirect('https://gg.bet/ru/live/'),'https://gg.bet/ru/live/':html(page())});
  try{
    const boot=await c.fetchBootstrap(true);assert.equal(boot.origin,'https://gg.bet');
    assert.ok(calls.every(x=>x.redirect==='manual'),'redirects are walked by the collector, never followed blindly');
    const d=last(c);
    assert.deepEqual({requestedHost:d.requestedHost,finalHost:d.finalHost,status:d.status,redirects:d.redirects,redirectChain:d.redirectChain,bodyKind:d.bodyKind,contentType:d.contentType,tokenExtraction:d.tokenExtraction,reason:d.reason},
      {requestedHost:'gg.bet',finalHost:'gg.bet',status:200,redirects:1,redirectChain:['gg.bet'],bodyKind:'html',contentType:'text/html',tokenExtraction:'ok',reason:'ok'});
    noSecrets(c);
  }finally{restore();}
});

test('B: a 302 that sets a cookie: diagnostics say setCookie / cookieOnRedirect, the value appears nowhere', async()=>{
  const {c,restore}=collector({'https://gg.bet/ru/live':redirect('/ru/live?c=1',{'set-cookie':`sid=${COOKIE}; Path=/; Secure; HttpOnly`}),'https://gg.bet/ru/live?c=1':html(page())});
  try{
    await c.fetchBootstrap(true);
    const d=last(c);assert.equal(d.setCookie,true);assert.equal(d.cookieOnRedirect,true,'a host-only cookie of gg.bet goes back to gg.bet');
    noSecrets(c);assert.ok(!JSON.stringify(c.bootstrapDiagnostics()).includes('sid'),'not even the cookie name');
  }finally{restore();}
  // A cookie scoped to another domain would not be sent on the redirect.
  const other=collector({'https://gg.bet/ru/live':redirect('https://gg.bet/x',{'set-cookie':`a=${COOKIE}; Domain=example.com`}),'https://gg.bet/x':html(page())});
  try{await other.c.fetchBootstrap(true);const d=last(other.c);assert.equal(d.setCookie,true);assert.equal(d.cookieOnRedirect,false);}finally{other.restore();}
});

test('C: a redirect to an untrusted host is refused without requesting it', async()=>{
  for(const target of ['https://evil.example/ru/live','https://gg.bet.evil.example/ru/live','http://gg.bet/ru/live']){
    const {c,calls,restore}=collector({'https://gg.bet/ru/live':redirect(target)});
    try{
      await assert.rejects(c.fetchBootstrap(true),/untrusted host/);
      assert.equal(calls.length,1,`${target} was never requested`);
      const d=last(c);assert.equal(d.reason,'redirect-untrusted');assert.equal(d.status,302);assert.equal(d.redirects,1);assert.equal(d.redirectChain[0],new URL(target).hostname);
    }finally{restore();}
  }
});

test('D: a configured trusted mirror passes the exact allowlist (redirects between trusted hosts too)', async()=>{
  const trusted=['https://gg.bet','https://mirror.gg.bet'];
  const {c,restore}=collector({'https://mirror.gg.bet/ru/live':redirect('https://gg.bet/ru/live'),'https://gg.bet/ru/live':html(page())},{origins:['https://mirror.gg.bet'],trusted});
  try{const boot=await c.fetchBootstrap(true);assert.equal(boot.origin,'https://mirror.gg.bet');assert.deepEqual(last(c).redirectChain,['gg.bet']);assert.equal(last(c).finalHost,'gg.bet');}finally{restore();}
});

test('E: unconfigured lookalike / old mirror domains are never fetched', async()=>{
  const {c,calls,restore}=collector({'https://gg.bet/ru/live':html(page())},{origins:['https://gg397.bet','https://ggbets.co','https://gg.bet.example','https://xgg.bet','https://gg.bet']});
  try{
    await c.fetchBootstrap(true);
    assert.deepEqual(calls.map(x=>new URL(x.url).hostname),['gg.bet']);
    assert.deepEqual(c.bootstrapDiagnostics().ignoredOrigins,['https://gg397.bet','https://ggbets.co','https://gg.bet.example','https://xgg.bet']);
  }finally{restore();}
  const none=collector({},{origins:['https://gg397.bet']});
  try{await assert.rejects(none.c.fetchBootstrap(true),/нет доверенного origin/);assert.equal(none.calls.length,0);}finally{none.restore();}
});

test('F: an HTTP failure keeps its exact status, body kind and content type', async()=>{
  for(const [status,body,type,kind] of [[500,'','text/html','empty'],[404,'<html>Not found</html>','text/html','html'],[451,'{"error":"x"}','application/json','json'],[503,'busy','text/plain','other']]){
    const {c,restore}=collector({'https://gg.bet/ru/live':new Response(body||null,{status,headers:{'content-type':type}})});
    try{
      await assert.rejects(c.fetchBootstrap(true),new RegExp(`HTTP ${status}`));
      const d=last(c);assert.equal(d.status,status);assert.equal(d.reason,'http-status');assert.equal(d.bodyKind,kind);assert.equal(d.contentType,type);assert.equal(d.tokenExtraction,'');
    }finally{restore();}
  }
});

test('G: a 200 page without the token is a token-extraction failure, not an HTTP failure', async()=>{
  for(const [body,reason] of [['<!doctype html><html><body>app shell</body></html>','marker-missing'],[page(''),'token-missing'],[page('short'),'token-short']]){
    const {c,restore}=collector({'https://gg.bet/ru/live':html(body)});
    try{
      await assert.rejects(c.fetchBootstrap(true));
      const d=last(c);assert.equal(d.status,200);assert.equal(d.reason,'token-extraction');assert.equal(d.tokenExtraction,reason);assert.equal(d.bodyKind,'html');assert.ok(d.bodyBytes>0);
    }finally{restore();}
  }
  // An endpoint outside gg.bet is named as such.
  const {c,restore}=collector({'https://gg.bet/ru/live':html(`<html>"bettingClientOptions":{"token":"${TOKEN}","endpoint":"//gql.evil.example"}</html>`)});
  try{await assert.rejects(c.fetchBootstrap(true));assert.equal(last(c).tokenExtraction,'endpoint-invalid');noSecrets(c);}finally{restore();}
});

test('a page failure costs one request per attempt; the ff1beab back-off stays; the log keeps the last 10 attempts', async()=>{
  const {c,calls,restore}=collector({'https://gg.bet/ru/live':()=>html('<html>shell</html>'),'https://mirror.gg.bet/ru/live':()=>html('<html>shell</html>')},{origins:['https://gg.bet','https://mirror.gg.bet'],trusted:['https://gg.bet','https://mirror.gg.bet']});
  try{
    for(let i=0;i<12;i++)await assert.rejects(c.fetchBootstrap(true));
    assert.equal(calls.length,12,'one request per attempt, the next attempt starts with the next trusted mirror');
    assert.deepEqual(calls.slice(0,4).map(x=>new URL(x.url).hostname),['gg.bet','mirror.gg.bet','gg.bet','mirror.gg.bet']);
    assert.equal(c.bootstrapDiagnostics().attempts.length,10);
  }finally{restore();}
});

test('diagnostics are served only to the token holder; /health carries none of them', async()=>{
  const states=Array.from({length:7},(_,i)=>new SnapshotState('test-gg-diag-'+i,60000));for(const s of states)s.persist=async()=>{};
  const {c,restore}=collector({'https://gg.bet/ru/live':html('<html>shell</html>',200,{'set-cookie':`sid=${COOKIE}`})});
  await assert.rejects(c.fetchBootstrap(true));
  const server=createApi({authToken:'diag-token-0123456789abcdef',liveState:states[0],prematchState:states[1],fonbetLiveState:states[2],fonbetPrematchState:states[3],pinnaclePrematchState:states[4],pinnacleLiveState:states[5],ggbetLiveState:states[6],prematchCollector:{status:()=>({}),catalog:[]},fonbetCollector:{status:()=>({})},pinnacleCollector:{status:()=>({}),catalog:[]},ggbetCollector:c,resultsService:{status:()=>({}),days:new Map()},startedAt:Date.now()});
  await new Promise(r=>server.listen(0,'127.0.0.1',r));const base='http://127.0.0.1:'+server.address().port;
  try{
    assert.equal((await fetch(base+'/api/admin/ggbet-bootstrap')).status,401);
    const res=await fetch(base+'/api/admin/ggbet-bootstrap',{headers:{authorization:'Bearer diag-token-0123456789abcdef'}});assert.equal(res.status,200);
    const body=await res.json();assert.equal(body.attempts.at(-1).tokenExtraction,'marker-missing');assert.equal(body.attempts.at(-1).setCookie,true);
    const health=await (await fetch(base+'/health')).text();
    assert.ok(!health.includes('redirectChain')&&!health.includes('tokenExtraction')&&!health.includes(COOKIE));
  }finally{await new Promise(r=>server.close(r));await stopMatcher();restore();}
});
