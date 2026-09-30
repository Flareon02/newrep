/* All instants remain Unix milliseconds. Formatting and day boundaries use IANA zones. */
const MonitorTime=(()=>{
  let choice='Asia/Yerevan';const formats=new Map(),pad=n=>String(n).padStart(2,'0');
  const valid=zone=>{try{new Intl.DateTimeFormat('en',{timeZone:zone});return true;}catch{return false;}};
  function setZone(zone){choice=zone==='auto'||valid(zone)?zone:'Asia/Yerevan';}
  const zone=()=>choice==='auto'?Intl.DateTimeFormat().resolvedOptions().timeZone:choice;
  function parts(ts=Date.now(),timeZone=zone()){
    if(!formats.has(timeZone))formats.set(timeZone,new Intl.DateTimeFormat('en-GB',{timeZone,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23',numberingSystem:'latn'}));
    return Object.fromEntries(formats.get(timeZone).formatToParts(Number(ts)).filter(x=>x.type!=='literal').map(x=>[x.type,Number(x.value)]));
  }
  function dateKey(ts=Date.now(),timeZone=zone()){const p=parts(ts,timeZone);return `${p.year}-${pad(p.month)}-${pad(p.day)}`;}
  function clock(ts,seconds=false){if(!ts)return'—';const p=parts(ts);return `${pad(p.hour)}:${pad(p.minute)}${seconds?':'+pad(p.second):''}`;}
  function dateTime(ts,seconds=false){if(!ts)return'—';const p=parts(ts);return `${pad(p.day)}.${pad(p.month)}.${p.year} ${clock(ts,seconds)}`;}
  function fromLocal(year,month,day,hour=0,minute=0,second=0,timeZone=zone()){
    const target=Date.UTC(year,month-1,day,hour,minute,second);let instant=target;
    for(let i=0;i<4;i++){const p=parts(instant,timeZone),delta=target-Date.UTC(p.year,p.month-1,p.day,p.hour,p.minute,p.second);instant+=delta;if(!delta)break;}
    return instant;
  }
  function dayRange(day,timeZone=zone()){
    if(!/^\d{4}-\d{2}-\d{2}$/.test(day)||!Number.isFinite(Date.parse(day))||new Date(day+'T00:00:00Z').toISOString().slice(0,10)!==day)throw new Error('Некорректная дата');
    const [y,m,d]=day.split('-').map(Number),next=new Date(Date.UTC(y,m-1,d+1));
    return {from:fromLocal(y,m,d,0,0,0,timeZone),to:fromLocal(next.getUTCFullYear(),next.getUTCMonth()+1,next.getUTCDate(),0,0,0,timeZone)};
  }
  function offset(ts=Date.now(),timeZone=zone()){const p=parts(ts,timeZone);return Math.round((Date.UTC(p.year,p.month-1,p.day,p.hour,p.minute,p.second)-Math.floor(ts/1000)*1000)/60000);}
  function label(){const minutes=offset(),abs=Math.abs(minutes),value=`UTC${minutes>=0?'+':'−'}${Math.floor(abs/60)}${abs%60?':'+pad(abs%60):''}`;return `${zone()==='Asia/Yerevan'?'Армения':zone().replaceAll('_',' ')} (${value})`;}
  return {setZone,zone,valid,parts,dateKey,clock,dateTime,fromLocal,dayRange,offset,label};
})();
if(typeof globalThis!=='undefined')globalThis.MonitorTime=MonitorTime;
