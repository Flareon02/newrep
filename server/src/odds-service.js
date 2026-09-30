import {Worker} from 'node:worker_threads';
import {randomUUID} from 'node:crypto';
export class OddsService{
 constructor(hltv){this.hltv=hltv;this.jobs=new Map();this.queue=[];this.active=null;this.closed=false;}
 create(body){return this.enqueue('hltv',body);}
 createManual(body){return this.enqueue('manual',body);}
 enqueue(kind,body){if(this.closed)throw Error('Сервер завершает работу');if(this.queue.length+(this.active?1:0)>=3){const e=Error('Расчёт уже выполняется. Попробуйте через несколько секунд.');e.status=429;throw e;}const job={id:randomUUID(),kind,status:'queued',progress:0,createdAt:Date.now(),body};this.jobs.set(job.id,job);this.queue.push(job);this.next();for(const [id,j] of this.jobs)if(Date.now()-j.createdAt>30*60000&&j.status!=='running')this.jobs.delete(id);return this.get(job.id);}
 get(id){const job=this.jobs.get(id);if(!job)return null;const {body,worker,...publicJob}=job;return publicJob;}
 async next(){if(this.active||!this.queue.length||this.closed)return;const job=this.queue.shift();this.active=job;job.status='running';job.progress=2;
  try{const manual=job.kind==='manual',payload=manual?job.body:await this.hltv.prepare(job.body);if(this.closed)return;job.progress=manual?5:8;const workerUrl=new URL(manual?'./manual-odds-worker.js':'./odds-worker.js',import.meta.url);job.result=await new Promise((resolve,reject)=>{const worker=new Worker(workerUrl,{workerData:payload,resourceLimits:{maxOldGenerationSizeMb:256}});job.worker=worker;let settled=false;const done=(error,result)=>{if(settled)return;settled=true;clearTimeout(timer);worker.terminate();error?reject(error):resolve(result);};const timer=setTimeout(()=>done(Error('Расчёт превысил допустимое время')),60000);worker.on('message',m=>{if(m.result)done(null,m.result);else if(m.error)done(Error(m.error));else if(m.progress)job.progress=m.progress;});worker.once('error',e=>done(e));worker.once('exit',code=>{if(!settled)done(Error('Расчёт прерван: '+code));});});job.status='done';job.progress=100;
  }catch(error){job.status='error';job.error=error.message;}finally{delete job.body;delete job.worker;this.active=null;for(const [id,j] of this.jobs){if(this.jobs.size<=24)break;if(j.status==='done'||j.status==='error')this.jobs.delete(id);}this.next();}
 }
 async stop(){this.closed=true;this.queue=[];if(this.active?.worker)await this.active.worker.terminate();}
}
