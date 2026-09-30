/* Parse an inert document; never insert source HTML into the extension. */
const ScheduleImport=(()=>{
 const games=GameCategories.entries.map(([re,name])=>[re,name]);
 const clean=s=>String(s||'').replace(/\s+/g,' ').trim();
 function leagueInfo(text){let category='',league=clean(text).replace(/^(?:Esports|Киберспорт)\s*[.:]\s*/i,'');for(const [re,name] of games){re.lastIndex=0;if(re.test(league)){category=name;re.lastIndex=0;league=league.replace(re,'');break;}}return {category,league:league.replace(/^[\s.,:–—-]+|[\s.,:–—-]+$/g,'').replace(/\s*\.\s*\./g,'.')};}
 function parse(text,{year=new Date().getFullYear(),offsetMinutes=240}={}){
  if(!/<tr[\s>]/i.test(text))text=printedTable(text);
  const doc=new DOMParser().parseFromString(text,'text/html');
  const printed=doc.body.textContent.match(/(?:printed at|напечатано)[\s\S]{0,80}?(20\d{2})/i);if(printed)year=Number(printed[1]);
  const printedDate=doc.body.textContent.match(/(?:printed at|напечатано)\s+(\d{1,2})\s+([^\s]+)\s+(20\d{2})/i);
  const months=['январ','феврал','март','апрел','ма','июн','июл','август','сентябр','октябр','ноябр','декабр'];
  const printedMonth=printedDate?months.findIndex(m=>printedDate[2].toLowerCase().startsWith(m))+1:0;
  let info={category:'',league:''};const events=[],errors=[],seen=new Set();let candidates=0;
  for(const row of doc.querySelectorAll('tr')){
   const cells=[...row.children].filter(n=>n.tagName==='TD'||n.tagName==='TH');
   if(cells.length&&/^(?:Esports|Киберспорт)\s*[.:]/i.test(clean(cells[0].textContent))){info=leagueInfo(cells[0].textContent);continue;}
   if(cells.length<3||!/^\d+$/.test(clean(cells[0].textContent)))continue;
   candidates++;const date=clean(cells[1].textContent).match(/^(\d{1,2})\.(\d{1,2})(?:\.(\d{4}))?\s+(\d{1,2})\s*:\s*(\d{2})$/);
   const teams=clean(cells[2].textContent).split(/\s+[–—-]\s+/);
   if(!date||teams.length!==2||!teams.every(Boolean)||!info.league){errors.push(`Строка ${candidates}: не удалось прочитать дату, турнир или команды`);continue;}
   const day=Number(date[1]),month=Number(date[2]),hour=Number(date[4]),minute=Number(date[5]);
   const eventYear=date[3]?Number(date[3]):year+(printedMonth>=11&&month<=2?1:printedMonth<=2&&printedMonth>0&&month>=11?-1:0);
   const utc=Date.UTC(eventYear,month-1,day,hour,minute),check=new Date(utc);
   if(check.getUTCMonth()!==month-1||check.getUTCDate()!==day||hour>23||minute>59){errors.push(`Строка ${candidates}: некорректная дата`);continue;}
   const event={...info,id:clean(cells[0].textContent),team1:teams[0],team2:teams[1],startAt:utc-offsetMinutes*60000,marketKind:'main'};
   const key=JSON.stringify([info.category,info.league,event.startAt,...teams.map(t=>t.toLowerCase()).sort()]);
   if(!seen.has(key)){seen.add(key);events.push(event);}
  }
  if(!events.length)throw new Error('В файле не найдено матчей. Ожидается таблица с колонками #, Date, Event.');
  if(events.length>500)throw new Error('В файле более 500 матчей. Разделите расписание на несколько файлов.');
  return {events:events.sort((a,b)=>a.startAt-b.startAt),errors,year,candidates,duplicates:candidates-errors.length-events.length};
 }
 function printedTable(text){
  const escape=s=>String(s).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
  let rows=[];
  for(const line of text.split(/\r?\n/)){
   let cells=line.includes('|')?line.split('|').map(s=>s.trim()).filter((s,i,a)=>s||i>0&&i<a.length-1):line.split(/\t+/).map(s=>s.trim());
   cells=cells.map(s=>s.replace(/\*\*|__/g,'').trim());
   if(cells[0]?.match(/^(Esports|Киберспорт)\s*[.:]/i))rows.push('<tr><td class="noBorder">'+escape(cells[0])+'</td></tr>');
   else if(/^\d+$/.test(cells[0])&&cells.length>=3)rows.push('<tr>'+cells.slice(0,3).map(s=>'<td>'+escape(s)+'</td>').join('')+'</tr>');
   else if(cells.length===1){const m=cells[0].match(/^(\d+)\s+(\d{1,2}\.\d{1,2}(?:\.\d{4})?\s+\d{1,2}\s*:\s*\d{2})\s+(.+?)(?:\s{2,}|$)/);if(m)rows.push('<tr>'+m.slice(1).map(s=>'<td>'+escape(s)+'</td>').join('')+'</tr>');}
  }
  return '<p>'+escape(text.match(/(?:printed at|напечатано)[^\n|]+/i)?.[0]||'')+'</p><table>'+rows.join('')+'</table>';
 }
 return {parse,leagueInfo};
})();
