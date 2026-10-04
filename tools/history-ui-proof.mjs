/* global chrome, MatchHistory, modal, request, document */
// Real extension UI against a local API. Credentials remain in the disposable browser profile only.
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
const {chromium}=await import(process.env.PLAYWRIGHT_MODULE||'playwright');
const env={};for(const row of fs.readFileSync('/etc/esports-monitor/server.env','utf8').split('\n')){const m=row.match(/^\s*([A-Za-z0-9_]+)=(.*)$/);if(m)env[m[1]]=m[2].trim().replace(/^(['"])(.*)\1$/,'$2');}
const base=process.env.HISTORY_PROOF_URL||'http://127.0.0.1:'+(env.PORT||80),token=process.env.HISTORY_PROOF_TOKEN||env.API_TOKEN;
const out=process.argv[2]||'/root/sqlite-history-implementation';const samples=JSON.parse(fs.readFileSync(path.join(out,'acceptance-samples.json'),'utf8'));
const profile=fs.mkdtempSync(path.join(os.tmpdir(),'history-ui-'));fs.chmodSync(profile,0o700);let context;const results=[],errors=[];
try{
 context=await chromium.launchPersistentContext(profile,{headless:false,args:['--headless=new','--no-sandbox',`--disable-extensions-except=${path.resolve('extension')}`,`--load-extension=${path.resolve('extension')}`]});
 let [worker]=context.serviceWorkers();worker||=await context.waitForEvent('serviceworker',{timeout:15000});const id=new URL(worker.url()).host;
 await worker.evaluate(async ({base,token})=>{await chrome.storage.local.set({server:{base,token}});},{base,token});
 const page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));await page.goto(`chrome-extension://${id}/app.html`);await page.waitForFunction(()=>typeof MatchHistory!=='undefined'&&typeof modal==='function');await page.waitForTimeout(1000);
 for(const sample of samples){await page.evaluate(e=>MatchHistory.open(e,{modal,request}),sample.event);await page.waitForFunction(()=>document.getElementById('historyEntries')?.children.length>0,{timeout:15000});
   const selector=`[data-history-id="${sample.entry.id}"]`;let row=page.locator(selector);for(let n=0;n<5&&!(await row.count());n++){const more=page.locator('#historyMore');if(!await more.isVisible())break;await more.click();await page.waitForTimeout(500);row=page.locator(selector);}
   const text=await row.innerText();if(!text.includes(String(sample.entry.oldValue))||!text.includes(String(sample.entry.newValue))||!text.includes('→'))throw Error('Old/new values absent from rendered row');
   const requests=[];page.on('request',r=>{if(r.url().includes('/history?'))requests.push(new URL(r.url()).searchParams.get('provider'));});await page.locator(`[data-history-provider="${sample.entry.provider}"]`).click();await page.waitForFunction(()=>document.getElementById('historyStatus')?.textContent.includes('изменений'));await page.screenshot({path:path.join(out,'ui-'+sample.entry.kind+'.png'),fullPage:true});
   results.push({kind:sample.entry.kind,entryId:sample.entry.id,provider:sample.entry.provider,publicationSource:sample.entry.publicationSource,renderedText:text,providerFilterRequested:requests.includes(sample.entry.provider)});await page.locator('#historyClose').click();
 }
 if(errors.length)throw Error('Page errors: '+errors.join('; '));
 fs.writeFileSync(path.join(out,'extension-proof.json'),JSON.stringify({at:new Date().toISOString(),runtime:'Chromium unpacked extension 9.2.0',apiBase:base,results,pageErrors:errors},null,2),{mode:0o600});console.log(JSON.stringify({results,pageErrors:errors}));
}finally{await context?.close();fs.rmSync(profile,{recursive:true,force:true});}
