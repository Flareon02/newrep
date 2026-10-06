/* In-page history: cached first paint, then only score changes and LIVE transitions. */
const ScoreDialog=(()=>{
 let generation=0;
 function open(event,{ids,refs,getCurrent,modal,esc,stamp,providerName}){
  const token=++generation,providers=[...new Set(refs.map(r=>r.source))],shown=new Set(providers),base={team1:event.team1,team2:event.team2};
  let entries=[],hasMore=false,nextBefore=null,error='',loading=false,updatedAt=0;
  const $=id=>document.getElementById(id),active=()=>generation===token&&$('modal').open&&$('modal').dataset.kind==='scores';
  modal(`<div class="data-dialog-header"><div><h2>История счёта</h2><strong>${esc(event.team1)} - ${esc(event.team2)}</strong></div><button id="scoreClose" class="icon-button" aria-label="Закрыть">×</button></div><div class="score-controls"><div id="scoreSources">${providers.map(source=>`<button data-score-source="${source}" class="${source}" aria-pressed="true">${providerName(source)}</button>`).join('')}</div><button id="scoreRefresh">Обновить</button></div><p class="dialog-caption muted">Время наблюдения сервером · UTC+4. Выделены изменения счёта.</p><div id="scoreJournal"></div><p id="scoreStatus" class="muted" role="status"></p><button id="scoreMore" hidden>Показать более ранние</button>`, 'scores');
  $('scoreClose').onclick=()=>$('modal').close();
  $('scoreSources').onclick=e=>{const b=e.target.closest('[data-score-source]');if(!b)return;const source=b.dataset.scoreSource;if(shown.has(source))shown.delete(source);else shown.add(source);b.setAttribute('aria-pressed',shown.has(source));render();};
  function render(){if(!active())return;const fresh=getCurrent?.();if(fresh)refs=fresh;const selected=providers.filter(s=>shown.has(s)),minAt=hasMore&&entries.length?Math.min(...entries.map(r=>r.at)):0,lifecycleRefs=refs.map(r=>({...r,timeline:(r.timeline||r.lifecycle||[]).filter(c=>c.at>=minAt)})),rows=ScoreTimeline.build(ScoreTimeline.withLifecycle(entries,lifecycleRefs),base,{sources:selected});
   const current=refs.filter(r=>shown.has(r.source)).map(r=>{const observed=rows[0]?.scores[r.source];return observed&&observed.at>=Number(r.scoreAt||r.lastSeenAt||r.endedAt||0)?{...r,...observed}:r;});
   const journal=!selected.length?'<p class="empty">Выберите контору</p>':`<div class="score-current">${current.map(r=>`<span><small>${providerName(r.source)}</small><b>${esc(ScoreOrientation.orient(r,base).scoreText||'Счёт не передан')}</b></span>`).join('')}</div>`+(rows.length?`<table class="score-journal"><thead><tr><th>Время</th>${selected.map(s=>`<th class="${s}">${providerName(s)}</th>`).join('')}</tr></thead><tbody>${rows.map(row=>`<tr data-log-key="${row.at}"><td><time>${stamp(row.at,true,true)}</time>${row.events.map(e=>`<small class="score-transition">${providerName(e.source)} · ${e.type==='entered'?'появился в LIVE':'убран из LIVE'}</small>`).join('')}</td>${selected.map(s=>`<td class="${row.changed.includes(s)?'score-updated':'score-carried'}">${esc(row.scores[s]?.scoreText||'—').replace(/(\d+:\d+)/g,'<span class="map-pair">$1</span>')}</td>`).join('')}</tr>`).join('')}</tbody></table>`:'<p class="muted">Изменения счёта пока не записаны.</p>');
   StableDOM.patch($('scoreJournal'),journal);
   $('scoreStatus').textContent=error|| (loading?'Обновляем журнал…':updatedAt?'Обновлено '+stamp(updatedAt,false,true):'Загружаем журнал…');$('scoreStatus').className=error?'bad':'muted';$('scoreRefresh').disabled=loading;$('scoreMore').hidden=!hasMore;$('scoreMore').disabled=loading;
  }
  function combine(rows){entries=[...new Map([...entries,...rows].map(r=>[[r.key||r.source+':'+r.sourceEventId,r.at,r.event||'',r.scoreText||''].join('|'),r])).values()];}
  async function load(before){if(loading)return;loading=true;error='';render();try{const data=await ScoreCache.load(ids,{before});if(!active())return;combine(data.entries||[]);if(before||!nextBefore){hasMore=data.hasMore;nextBefore=data.nextBefore;}updatedAt=Date.now();}catch(e){error=e.message;if(e.status===401||e.status===403)clearInterval(timer);}finally{loading=false;render();}}
  $('scoreRefresh').onclick=()=>load();$('scoreMore').onclick=()=>load(nextBefore);
  const timer=setInterval(()=>{if(!active()){clearInterval(timer);return;}load();},10000);
  render();ScoreCache.read(ids).then(data=>{if(!active())return;if(data){combine(data.entries||[]);hasMore=data.hasMore;nextBefore=data.nextBefore;updatedAt=data.cachedAt;render();}load();}).catch(()=>load());
 }
 return {open};
})();
