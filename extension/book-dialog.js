const BookDialog=(()=>{
 const norm=s=>MarketCanonical.norm(s);
 const name=s=>({astek:'AstekBet',fonbet:'Fonbet',pinnacle:'Pinnacle',ggbet:'GGBET',databet:'DataBet'})[s]||s;
 const sourceOrder={astek:0,fonbet:1,pinnacle:2,ggbet:3,databet:3};
 // GGBET and DataBet are DATA.BET-platform feeds: full markets and native tabs come from the server detail.
 const platformSource=s=>s==='ggbet'||s==='databet';
 let cleanup=()=>{};
 function open(e,{refs,esc,stamp,modal,load,reload,request,base}){
  cleanup();const $=id=>document.getElementById(id);
  let source=refs.find(r=>r.odds?.markets?.length)?.source||refs[0]?.source||'astek',providerTab='all',scope='all',category='all';
  let detail=null,detailId='',detailAt=0,detailError='',loading=false,history=null,historyOpen=false,historyLoading=false,historyToken=0,revision='',active=true,liveRef=null,liveAt=0,stream=null,streamId='',streamToken=0,pushFrame=0;
  const current=()=>{const loaded=load?.();return Array.isArray(loaded)&&loaded.length?loaded:refs;};
  const selected=()=>{const latest=current().find(r=>r.source===source);return source==='pinnacle'&&liveRef&&Date.now()-liveAt<15000?liveRef:latest;};
  const sourceId=r=>String(r?.sourceEventId||r?.id||'');
  const activeModal=()=>active&&$('modal')?.open&&$('modal').dataset.kind==='book-odds';
  modal(`<div class="data-dialog-header"><div><h2>Коэффициенты</h2><strong>${esc(e.team1)} — ${esc(e.team2)}</strong></div><button id="bookClose" class="icon-button" aria-label="Закрыть">×</button></div>
  <div id="bookSources" class="book-source-tabs" role="tablist" aria-label="Конторы"></div>
  <div class="book-search-row"><input id="bookSearch" type="search" placeholder="Найти рынок или исход…" aria-label="Поиск рынков"><span id="bookMarketCount" class="book-market-count"></span></div>
  <div id="bookProviderTabs" class="book-tabs book-provider-tabs" role="tablist" aria-label="Вкладки букмекера" hidden></div>
  <div id="bookScopes" class="book-tabs book-scope-tabs" role="tablist" aria-label="Период"></div>
  <div id="bookCategories" class="book-tabs book-category-tabs" role="tablist" aria-label="Тип рынка"></div>
  <p id="bookMeta" class="muted book-meta" role="status"></p><div id="bookMarkets"></div>
  <details id="bookHistory" class="book-history"><summary>История коэффициентов</summary><button id="bookTimelineOpen">Открыть временную шкалу</button><div id="bookHistoryBody"></div></details>`,'book-odds');
  $('bookTimelineOpen').onclick=()=>{dispose();OddsTimeline.open(e,{refs:current(),esc,stamp,modal,request});};
  $('bookClose').onclick=()=>$('modal').close();
  const currentOdds=()=>{const r=selected();return source==='astek'&&detailId===sourceId(r)&&detail?.markets?.length?detail:r?.odds;};
  function nativeTeams(){const r=selected(),o=currentOdds();return {team1:o?.team1||(r?.scoreReversed?r?.team2:r?.team1)||e.team1,team2:o?.team2||(r?.scoreReversed?r?.team1:r?.team2)||e.team2};}
  const describe=m=>MarketCanonical.describe(m,e,source,nativeTeams());
  const priceLabel=(p,m)=>MarketCanonical.outcomeLabel(p,m,e,nativeTeams());
  function outcomeRank(p){const d=String(p?.designation||'');return ({home:0,'home-draw':0,over:0,yes:0,draw:1,'home-away':1,away:2,'draw-away':2,under:2,no:2})[d]??5;}
  async function refreshDetail(){
   const r=selected(),id=sourceId(r),needsServerDetail=source==='astek'||platformSource(source);
   if(!needsServerDetail||!id||!reload||loading)return;
   // A hydrated event already contains the full market tree. Keep it until a
   // detailChanged push arrives; a 60s fallback refresh covers missed pushes
   // without downloading ~100KB of identical markets every 15 seconds.
   if(r?.odds?.markets?.length){
    if(detailId!==id){detailId=id;detailAt=Date.now();detailError='';return;}
    if(Date.now()-detailAt<60000)return;
   }else if(detailId===id&&Date.now()-detailAt<5000)return;
   // The event-detail endpoint is the only provider-detail boundary. Do not
   // teach the shell Astek/GGBET protocols: ask the server to hydrate the event.
   loading=true;render(true);
   try{
    const fresh=await reload();if(!activeModal())return;
    if(fresh){e=fresh;refs=fresh?.sourceRefs?.length?fresh.sourceRefs:[fresh].filter(Boolean);detail=null;}
    const hydrated=(fresh?.sourceRefs?.length?fresh.sourceRefs:[fresh]).find(x=>x?.source===source);
    detailError=hydrated?.odds?.markets?.length?'':'Полный список рынков пока не получен';detailId=id;detailAt=Date.now();
   }catch(error){if(!activeModal())return;detailError=error.message;detailId=id;detailAt=Date.now();}
   finally{loading=false;render(true);}
  }
  function tabButton(kind,value,label,count,activeValue){return `<button type="button" role="tab" data-book-${kind}="${esc(value)}" aria-selected="${activeValue===value}" aria-pressed="${activeValue===value}"><span>${esc(label)}</span>${Number.isFinite(count)?`<b>${count}</b>`:''}</button>`;}
  function providerTabLabel(row){const id=String(row?.id||''),raw=String(row?.name||'');if(id==='all'||/^all$/i.test(raw))return'Все';if(/popular/i.test(raw))return'Популярные';if(/round/i.test(raw))return'Раунды ⚡';if(/^match$/i.test(raw))return'Матч';const map=raw.match(/map\s*(\d+)/i)||id.match(/mapnr:mapnr:(\d+)/);if(map)return`Карта ${map[1]}`;const half=raw.match(/half\s*(\d+)/i)||id.match(/halfnr:(\d+)/);if(half)return`Половина ${half[1]}`;return raw||id;}
  const inProviderTab=(m,id)=>id==='all'||(m?.providerTabs||[]).includes(id);
  function render(force=false){if(!activeModal())return;
   const books=[...new Map(current().filter(r=>['astek','fonbet','pinnacle','ggbet','databet'].includes(r.source)).map(r=>[r.source,r])).values()].sort((a,b)=>(sourceOrder[a.source]??9)-(sourceOrder[b.source]??9));
   if(books.length&&!books.some(r=>r.source===source)){source=books[0].source;history=null;historyOpen=false;++historyToken;}
   const r=selected(),o=currentOdds(),markets=o?.markets||[],query=norm($('bookSearch').value),described=markets.map((m,index)=>({m,index,d:describe(m)}));
   const nativeTabs=platformSource(source)&&Array.isArray(o?.providerTabs)?o.providerTabs:[];
   if(providerTab!=='all'&&!nativeTabs.some(t=>String(t.id)===providerTab))providerTab='all';
   const providerVisible=described.filter(x=>inProviderTab(x.m,providerTab));
   const scopes=[...new Set(providerVisible.map(x=>x.d.period))].sort((a,b)=>a-b);if(scope!=='all'&&!scopes.includes(Number(scope)))scope='all';
   const categories=[...new Set(providerVisible.filter(x=>scope==='all'||x.d.period===Number(scope)).map(x=>x.d.category))];if(category!=='all'&&!categories.includes(category))category='all';
   const filtered=providerVisible.filter(x=>(scope==='all'||x.d.period===Number(scope))&&(category==='all'||x.d.category===category)&&(!query||norm([x.d.title,...(x.m.prices||[]).map(p=>priceLabel(p,x.m))].join(' ')).includes(query)));
   // Feed pushes call render(true), so the idle/fallback pass only needs a cheap
   // revision key. Serializing hundreds of full market/price objects every five
   // seconds was one of the largest UI stalls in the odds dialog.
   const next=[source,sourceId(r),Number(o?.updatedAt||0),Number(o?.checkedAt||0),markets.length,nativeTabs.map(t=>`${t.id}:${t.count||0}`).join(','),historyOpen,query,providerTab,scope,category,loading,detailError].join('|');if(!force&&next===revision)return;revision=next;
   StableDOM.patch($('bookSources'),books.map(row=>{const count=row.source===source?(currentOdds()?.markets?.length||0):(row.odds?.markets?.length||0);return `<button type="button" role="tab" data-book-source="${esc(row.source)}" aria-selected="${source===row.source}" aria-pressed="${source===row.source}"><span>${name(row.source)}</span><b>${count}</b></button>`;}).join(''));
   const providerBox=$('bookProviderTabs');providerBox.hidden=!(platformSource(source)&&nativeTabs.length>1);
   if(!providerBox.hidden){const tabs=nativeTabs.some(t=>String(t.id)==='all')?nativeTabs:[{id:'all',name:'All'},...nativeTabs];StableDOM.patch(providerBox,tabs.map(t=>{const id=String(t.id),count=markets.filter(m=>inProviderTab(m,id)).length;return tabButton('provider-tab',id,providerTabLabel(t),count,providerTab);}).join(''));}else StableDOM.patch(providerBox,'');
   const scopeCounts=new Map();for(const x of providerVisible)scopeCounts.set(x.d.period,(scopeCounts.get(x.d.period)||0)+1);
   StableDOM.patch($('bookScopes'),tabButton('scope','all','Все',providerVisible.length,scope)+scopes.map(p=>tabButton('scope',String(p),MarketCanonical.scopeLabel(p),scopeCounts.get(p)||0,scope)).join(''));
   const visibleForScope=providerVisible.filter(x=>scope==='all'||x.d.period===Number(scope)),catCounts=new Map();for(const x of visibleForScope)catCounts.set(x.d.category,(catCounts.get(x.d.category)||0)+1);
   const orderedCategories=Object.keys(MarketCanonical.categoryLabel).filter(k=>k!=='all'&&catCounts.has(k));
   StableDOM.patch($('bookCategories'),tabButton('category','all','Все рынки',visibleForScope.length,category)+orderedCategories.map(k=>tabButton('category',k,MarketCanonical.categoryLabel[k],catCounts.get(k)||0,category)).join(''));
   const closed=markets.filter(m=>m.status&&m.status!=='open').length;$('bookMarketCount').textContent=`${filtered.length} / ${markets.length}`;
   const serverDetailError=e?.marketDetailErrors?.[source]||'';
   $('bookMeta').textContent=(o?'Обновлено '+stamp(o.updatedAt,true,true):'Коэффициенты пока не получены')+(loading?' · загрузка…':'')+(closed?' · закрыто/приостановлено: '+closed:'')+(o?.incompleteMaps?' · данные карт ещё дополняются':'')+((detailError||serverDetailError)?' · обновление деталей не удалось: '+(detailError||serverDetailError):'');
   const groups=new Map();for(const row of filtered){if(!groups.has(row.d.period))groups.set(row.d.period,[]);groups.get(row.d.period).push(row);}
   const html=[...groups].sort((a,b)=>a[0]-b[0]).map(([p,rows])=>{rows.sort((a,b)=>a.d.order-b.d.order||(a.d.line??0)-(b.d.line??0)||a.d.title.localeCompare(b.d.title,'ru')||String(a.m.key||'').localeCompare(String(b.m.key||'')));
    return `<section class="market-period"><h3><span>${esc(MarketCanonical.scopeLabel(p))}</span><b>${rows.length}</b></h3>${rows.map(({m,d,index})=>{const open=!m.status||m.status==='open',prices=[...(m.prices||[])].sort((a,b)=>outcomeRank(a)-outcomeRank(b));return `<div class="market-line ${open?'':'market-closed'}" data-market-key="${esc(d.key)}" data-provider-market-key="${esc(m.key||index)}"><div class="market-name"><strong>${esc(d.title)}</strong>${d.line!=null&&['handicap','map-handicap','round-handicap','round-handicap-3way','asian-round-handicap','half-round-handicap','total','map-total','round-total','team-total','team-round-total','asian-round-total','round-total-3way','winner-total-over','winner-total-under'].includes(d.family)?`<small>Линия: ${esc(d.line)}</small>`:''}${open?'':`<small>${m.status==='closed'?'Закрыт':'Приостановлен'}</small>`}</div><div class="market-outcomes">${prices.map(price=>`<div class="market-outcome"><span>${esc(priceLabel(price,m))}</span><b>${open&&Number(price.decimal)>1?Number(price.decimal).toFixed(3):'—'}</b></div>`).join('')}</div></div>`;}).join('')}</section>`;}).join('');
   StableDOM.patch($('bookMarkets'),html||`<div class="book-empty"><strong>Рынков по этим фильтрам нет</strong><p class="muted">${query?'Попробуйте изменить поиск.':'Выберите другой период или тип рынка.'}</p></div>`);
   $('bookHistory').open=historyOpen;
  }
  function renderHistory(){if(!activeModal())return;const box=$('bookHistoryBody');if(historyLoading&&!history){box.textContent='Загружаем историю…';return;}if(history?.error){box.textContent='Не удалось загрузить историю: '+history.error;return;}
   const teams=nativeTeams(),html=history?.entries?.length?`<div class="book-history-list">${history.entries.map(entry=>`<section data-log-key="${entry.at}"><time>${esc(stamp(entry.at,true,true))}</time><div>${entry.changes.map(m=>{const pseudo={...m,prices:(m.prices||[]).map(p=>({designation:p.side,points:p.points,label:p.side}))},d=MarketCanonical.describe(pseudo,e,source,teams);return `<div><b>${esc(d.title)}</b><span>${(m.prices||[]).map(p=>`${esc(MarketCanonical.outcomeLabel({designation:p.side,points:p.points,label:p.side},pseudo,e,teams))}: ${p.odds||'—'}`).join(' · ')}</span></div>`;}).join('')}</div></section>`).join('')}</div>${history.hasMore?'<button id="bookHistoryMore">Показать ранее</button>':''}`:'<p class="muted">Изменений ещё не сохранено.</p>';
   StableDOM.patch(box,html);const more=$('bookHistoryMore');if(more){more.disabled=historyLoading;more.onclick=()=>fetchHistory(true);}
  }
  async function fetchHistory(more=false){const r=selected(),id=sourceId(r);if(!id||historyLoading)return;const token=++historyToken,requestedSource=source;historyLoading=true;renderHistory();
   try{const next=await request(`/api/odds/history?source=${encodeURIComponent(requestedSource)}&id=${encodeURIComponent(id)}&limit=50${more&&history?.nextBefore?'&before='+history.nextBefore:''}`);if(!activeModal()||token!==historyToken||requestedSource!==source)return;history=more?{...next,entries:[...(history?.entries||[]),...next.entries]}:next;}
   catch(error){if(token===historyToken)history={entries:[],error:error.message};}finally{if(token===historyToken){historyLoading=false;renderHistory();}}
  }
  function syncStream(){const r=selected(),id=sourceId(r),live=!!(e.inLive||r?.inLive||r?.enteredLiveAt||String(r?.odds?.transport||'').includes('live')||r?.odds?.transport==='match-detail');
   if(source!=='pinnacle'||!live||!id||!base||!window.EventSource){stream?.close();stream=null;streamId='';++streamToken;return;}if(stream&&streamId===id)return;
   stream?.close();const token=++streamToken;streamId=id;stream=new EventSource(`${base}/api/pinnacle/live-stream?id=${encodeURIComponent(id)}`);
   stream.onmessage=event=>{if(!activeModal()||token!==streamToken||source!=='pinnacle')return;try{const data=JSON.parse(event.data);if(data.event){liveRef={...(selected()||r),...data.event};liveAt=Date.now();render(true);}else if(data.live===false&&r?.odds){liveRef={...r,odds:{...r.odds,updatedAt:Date.now(),markets:r.odds.markets.map(m=>({...m,status:'closed'}))}};liveAt=Date.now();render(true);}}catch{}};
  }
  $('bookSources').onclick=event=>{const b=event.target.closest('[data-book-source]');if(!b||b.dataset.bookSource===source)return;source=b.dataset.bookSource;++historyToken;historyLoading=false;history=null;historyOpen=false;providerTab='all';scope='all';category='all';syncStream();render(true);refreshDetail();};
  $('bookProviderTabs').onclick=event=>{const b=event.target.closest('[data-book-provider-tab]');if(!b)return;providerTab=b.dataset.bookProviderTab;scope='all';category='all';render(true);};
  $('bookScopes').onclick=event=>{const b=event.target.closest('[data-book-scope]');if(!b)return;scope=b.dataset.bookScope;category='all';render(true);};
  $('bookCategories').onclick=event=>{const b=event.target.closest('[data-book-category]');if(!b)return;category=b.dataset.bookCategory;render(true);};
  let searchTimer=0;$('bookSearch').oninput=()=>{clearTimeout(searchTimer);searchTimer=setTimeout(()=>render(true),60);};
  $('bookHistory').addEventListener('toggle',()=>{if(!activeModal())return;const value=$('bookHistory').open;if(value===historyOpen)return;historyOpen=value;if(value&&!history)fetchHistory();});
  const onFeedPush=event=>{if(!activeModal()||event.detail?.kind!=='live')return;const r=selected(),id=sourceId(r),hit=(event.detail?.patches||[]).find(p=>p.source===source&&String(p.sourceEventId||p.id)===id);if(!hit)return;if(pushFrame)return;pushFrame=requestAnimationFrame(async()=>{pushFrame=0;if(!activeModal())return;try{if(hit.detailChanged&&reload){const fresh=await reload();if(!activeModal())return;e=fresh;refs=fresh?.sourceRefs?.length?fresh.sourceRefs:[fresh].filter(Boolean);detail=null;detailId='';detailAt=0;}}catch{}render(true);refreshDetail();syncStream();});};
  window.addEventListener('monitor-feed-push',onFeedPush);
  render();refreshDetail();syncStream();const timer=setInterval(()=>{if(!activeModal()){dispose();return;}if(document.hidden)return;render();refreshDetail();syncStream();},15000);
  function dispose(){active=false;clearInterval(timer);clearTimeout(searchTimer);if(pushFrame)cancelAnimationFrame(pushFrame);pushFrame=0;window.removeEventListener('monitor-feed-push',onFeedPush);stream?.close();stream=null;++streamToken;++historyToken;}
  cleanup=dispose;$('modal').addEventListener('close',dispose,{once:true});
 }
 return {open};
})();
