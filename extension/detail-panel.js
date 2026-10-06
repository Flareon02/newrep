'use strict';
/* Right-side event detail (9.0): replaces the 8.x modal odds dialog.

   Opening a match renders at once from what the list already has (teams, score, sources, main-market quotes); the
   full market tree comes from the detail cache (stale-while-revalidate) and is patched in when it lands. Background
   refreshes never reset the chosen bookmaker, market tab, search or scroll position. */
const DetailPanel=(()=>{
 const BOOK_ORDER={astek:0,fonbet:1,pinnacle:2,ggbet:3};
 const PLATFORM=new Set(['ggbet']);
 const LINE_FAMILIES=new Set(['handicap','map-handicap','round-handicap','round-handicap-3way','asian-round-handicap','half-round-handicap','total','map-total','round-total','team-total','team-round-total','asian-round-total','round-total-3way','winner-total-over','winner-total-under']);
 const $=id=>document.getElementById(id);
 let ctx=null,root=null;
 let st=null; // {event, view, id, tab, source, providerTab, scope, category, query, detail, detailAt, loading, error, liveRef, liveAt}
 let stream=null,streamKey='',streamToken=0,refreshTimer=0,searchTimer=0;
 const tracker=MatchFormat.createPriceTracker({windowMs:20000});

 function configure(context){ctx=context;root=$('detailPane');root.addEventListener('click',onClick);root.addEventListener('input',onInput);
  root.addEventListener('toggle',event=>{const key=event.target?.dataset?.fold;if(!st||!key)return;if(event.target.open)st.folds.add(key);else st.folds.delete(key);},true);
  // Back from a hidden tab: the GGBET full-market lease may have expired meanwhile; take it again at once.
  document.addEventListener('visibilitychange',()=>{if(st&&!document.hidden){ctx.leaseFull?.(st.event,st.view);loadDetail(false);}});}
 const esc=s=>ctx.esc(s),refs=e=>ctx.refsOf(e);
 const sourceId=r=>String(r?.sourceEventId||r?.id||'');
 const isOpen=()=>!!st;
 const currentId=()=>st?.id||null;

 function books(){
  const all=[...(st.detail?refs(st.detail):[]),...refs(st.event)];
  const map=new Map();for(const r of all)if(['astek','fonbet','pinnacle','ggbet'].includes(r.source)&&ctx.bookVisible(r.source)&&!map.has(r.source))map.set(r.source,r);
  // Prefer the hydrated ref (with markets) over the thin one.
  if(st.detail)for(const r of refs(st.detail))if(map.has(r.source)&&r.odds?.markets)map.set(r.source,{...map.get(r.source),...r});
  return [...map.values()].sort((a,b)=>(BOOK_ORDER[a.source]??9)-(BOOK_ORDER[b.source]??9));
 }
 function selectedRef(){const list=books();let r=list.find(x=>x.source===st.source)||list[0]||null;if(r&&r.source==='pinnacle'&&st.liveRef&&Date.now()-st.liveAt<15000)r={...r,...st.liveRef};return r;}
 function tabsFor(event,view){
  const tabs=[];
  if(['live','prematch','compare'].includes(view)&&!ctx.oddsHidden(view==='compare'?(event.inLive?'live':'prematch'):view))tabs.push(['odds','Коэффициенты']);
  if(ctx.statsAvailable(event,view))tabs.push(['stats','Статистика']);
  tabs.push(['info','Матч']);
  // One history of the match: score, maps, rounds and every bookmaker's markets, with a replay scrubber.
  if((ctx.can('odds.history')||ctx.can('scores.history'))&&ctx.timelineAvailable?.())tabs.push(['timeline','Таймлайн']);
  return tabs;
 }

 function show(event,view,{source=null}={}){
  if(!event)return hide();
  const same=st&&st.id===String(event.id)&&st.view===view;
  if(!same){
   closeStats();
   const tabs=tabsFor(event,view),wanted=ctx.prefs().detailTab;
   const preferred=source||ctx.prefs().detailBook||'';
   st={folds:new Set(),oddsMode:['book','compare'].includes(ctx.prefs().detailOddsMode)?ctx.prefs().detailOddsMode:(globalThis.Platform?.hosted?'book':'compare'),timelineMarket:'',event,view,id:String(event.id),tab:tabs.some(t=>t[0]===wanted)?wanted:tabs[0][0],source:preferred,providerTab:'all',scope:'all',category:'all',query:'',detail:null,detailAt:0,loading:false,error:'',liveRef:null,liveAt:0};
   root.hidden=false;root.scrollTop=0;
   renderShell();
  }else{st.event=event;if(source&&source!==st.source){st.source=source;resetMarketFilters();}}
  render();
  // Full GGBET markets for this match only while the panel shows it (the lease moves on a switch, renews every 10 s).
  ctx.leaseFull?.(st.event,st.view);
  loadDetail(false);
  syncStream();
  clearInterval(refreshTimer);refreshTimer=setInterval(()=>{if(!st||document.hidden)return;ctx.leaseFull?.(st.event,st.view);loadDetail(false);syncStream();},10000);
  if(st.tab==='stats')openStats();
 }
 function hide(){if(!st)return;closeStats();TimelinePanel.close();st=null;clearInterval(refreshTimer);closeStream();ctx.releaseFull?.();root.hidden=true;root.replaceChildren();ctx.onClosed?.();}
 // The list got a newer snapshot (score, sources, quotes): re-render the header and the quotes in place.
 function update(event){if(!st||!event||String(event.id)!==st.id)return;st.event=event;render();}
 function onFeedPatches(patches){
  if(!st)return;const keys=new Set([...(st.detail?refs(st.detail):[]),...refs(st.event)].map(r=>`${r.source}:${sourceId(r)}`));
  const hit=(patches||[]).some(p=>p?.detailChanged&&keys.has(`${p.source}:${String(p.sourceEventId||p.id)}`));
  if(hit){ctx.invalidateDetail(st.event,st.view);loadDetail(false);}
 }

 function loadDetail(force){
  if(!st||!['live','prematch','compare'].includes(st.view)||ctx.oddsHidden(st.view==='compare'?(st.event.inLive?'live':'prematch'):st.view))return;
  const view=st.view==='compare'?(st.event.inLive||refs(st.event).some(r=>r.inLive)?'live':'prematch'):st.view,id=st.id;
  const res=ctx.detail(st.event,view,{force,onValue:value=>{if(!st||st.id!==id)return;st.detail=value;ctx.learnLogos?.(value);st.detailAt=Date.now();st.loading=false;st.error=Object.values(value?.marketDetailErrors||{})[0]||'';render();},onError:error=>{if(!st||st.id!==id)return;st.loading=false;st.error=ctx.errorText(error);render();}});
  if(res.cached&&st.detail!==res.cached){st.detail=res.cached;st.detailAt=res.at;}
  st.loading=res.refreshing;if(!res.refreshing)st.error='';
  render();
 }

 // ------------------------------------------------------------------ rendering
 function renderShell(){
  root.innerHTML=`<div class="detail-head" id="dpHead"></div><div class="detail-tabs" role="tablist" id="dpTabs" aria-label="Разделы матча"></div><div class="detail-body" id="dpBody" tabindex="-1"></div>`;
 }
 function teamLine(name,logo){return `<div class="team">${logo?`<img class="team-logo" src="${esc(logo)}" alt="" aria-hidden="true" width="22" height="22" decoding="async">`:'<span class="logo-ph lg" aria-hidden="true"></span>'}<span class="name" title="${esc(name)}">${esc(name)}</span></div>`;}
 // Logos may come from the hydrated detail (full refs) when the list had none.
 const withDetailRefs=e=>st?.detail?{...e,sourceRefs:[...refs(e),...refs(st.detail)]}:e;
 const ICON={history:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><path d="M3.5 12a8.5 8.5 0 1 0 2.6-6.1"/><path d="M3.5 4.5v4h4M12 7.5V12l3 2"/></svg>',copy:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><rect x="8" y="8" width="12" height="13" rx="2"/><path d="M16 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h3"/></svg>',close:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18"/></svg>'};
 // Header: where (game · league), who (teams + logos), the score, and ONE status line. Times per bookmaker live in the
 // «Матч» tab only.
 function renderHead(){
  const e=st.event,scored=ctx.scoreOf?ctx.scoreOf(e):e,d=scored.display||MatchFormat.displayScore(scored,e),live=st.view==='live'||(e.inLive&&!['results','history'].includes(st.view)),endedAt=Math.max(Number(e.endedAt)||0,...refs(e).map(r=>Number(r.endedAt||r.removedAt)||0)),ended=st.view==='results'||(st.view==='history'&&!e.inLive&&!e.inPrematch&&endedAt>0),fav=ctx.isFavorite(e);
  const status=[];
  if(live)status.push('<span class="chip live"><span class="dot bad" aria-hidden="true"></span>LIVE</span>');
  if(ended)status.push(`<span class="chip ${e.resultVerified||refs(e).some(r=>r.resultVerified)?'good':''}">${e.resultVerified||refs(e).some(r=>r.resultVerified)?'✓ Результат подтверждён':'Завершён'}</span>`);
  if(ended&&endedAt)status.push(`<span class="chip" title="Время окончания">окончание ${esc(ctx.stamp(endedAt,true))}</span>`);
  const meta=[d.bestOf?`Bo${d.bestOf}`:'',live&&d.current>=0&&d.maps.length>1?`карта ${d.current+1}`:'',!live&&!ended&&e.startAt?`начало ${ctx.stamp(e.startAt,true)}`:'',live&&e.enteredLiveAt?`в LIVE с ${ctx.stamp(e.enteredLiveAt)}`:''].filter(Boolean);
  const big=d.series?`${d.series[0]} : ${d.series[1]}`:(d.text||'');
  const sub=d.series&&d.maps.length?d.maps.map((m,i)=>i===d.current&&live?`<b>${m.join(':')}</b>`:m.join(':')).join(' · '):'';
  const logoEvent=withDetailRefs(e);
  const html=`<div class="detail-top"><span class="crumbs">${ctx.gameIcon(e.category)}<span title="${esc(e.category||'')} · ${esc(ctx.leagueTitle(e))}">${esc(e.category||'')} · ${esc(ctx.leagueTitle(e))}</span></span><span class="actions">${ctx.can('scores.history')||ctx.can('odds.history')?`<button class="icon-btn" data-dp="history" aria-label="История счёта и коэффициентов" title="История счёта и коэффициентов">${ICON.history}</button>`:''}<button class="icon-btn" data-dp="fav" aria-pressed="${fav}" aria-label="${fav?'Убрать из избранного':'В избранное'}" title="${fav?'Убрать из избранного':'В избранное'}">${ctx.starIcon(fav)}</button><button class="icon-btn" data-dp="copy" aria-label="Копировать матч" title="Копировать матч · правый клик — другие варианты">${ICON.copy}</button><button class="icon-btn" data-dp="close" aria-label="Закрыть (Esc)" title="Закрыть (Esc)">${ICON.close}</button></span></div>
  <div class="detail-match" title="Правый клик — копировать">${teamLine(e.team1,ctx.logo(logoEvent,1))}${big?`<div class="detail-score"><div class="big num">${esc(big)}</div>${sub?`<div class="sub num">${sub}</div>`:''}</div>`:''}${teamLine(e.team2,ctx.logo(logoEvent,2))}</div>
  ${status.length||meta.length?`<div class="detail-status">${status.join('')}${meta.length?`<span class="meta">${meta.map(esc).join(' · ')}</span>`:''}</div>`:''}`;
  StableDOM.patch($('dpHead'),html);
 }
 function renderTabs(){
  const tabs=tabsFor(st.event,st.view);if(!tabs.some(t=>t[0]===st.tab))st.tab=tabs[0][0];
  StableDOM.patch($('dpTabs'),tabs.map(([id,label])=>`<button class="tab" role="tab" data-dp-tab="${id}" aria-selected="${st.tab===id}">${label}</button>`).join(''));
 }
 function render(){
  if(!st||!root||root.hidden)return;
  if(!$('dpHead'))renderShell();
  renderHead();renderTabs();
  const body=$('dpBody');
  if(st.tab!=='timeline')TimelinePanel.close();
  if(st.tab==='odds')renderOdds(body);
  else if(st.tab==='stats')renderStats(body);
  else if(st.tab==='timeline')renderTimeline(body);
  else renderInfo(body);
 }

 function describe(m,ref){return MarketCanonical.describe(m,st.event,ref.source,nativeTeams(ref));}
 function nativeTeams(ref){const o=ref?.odds;return {team1:o?.team1||(ref?.scoreReversed?ref?.team2:ref?.team1)||st.event.team1,team2:o?.team2||(ref?.scoreReversed?ref?.team1:ref?.team2)||st.event.team2};}
 function outcomeRank(p){return ({home:0,'home-draw':0,over:0,yes:0,odd:0,draw:1,'home-away':1,away:2,'draw-away':2,under:2,no:2,even:2})[String(p?.designation||'')]??5;}
 function providerTabLabel(row){const id=String(row?.id||''),raw=String(row?.name||'');if(id==='all'||/^all$/i.test(raw))return'Все';if(/popular/i.test(raw))return'Популярные';if(/round/i.test(raw))return'Раунды';if(/^match$/i.test(raw))return'Матч';const map=raw.match(/map\s*(\d+)/i)||id.match(/mapnr:mapnr:(\d+)/);if(map)return`Карта ${map[1]}`;const half=raw.match(/half\s*(\d+)/i)||id.match(/halfnr:(\d+)/);if(half)return`Половина ${half[1]}`;if(/kill/i.test(raw))return'Kills';if(/player/i.test(raw))return'Игроки';return raw.replace(/[^\p{L}\p{N}\s.-]/gu,'').trim()||id;}
 const inProviderTab=(m,id)=>id==='all'||(m?.providerTabs||[]).includes(id);
 function resetMarketFilters(){st.providerTab='all';st.scope='all';st.category='all';}

 function quoteMarket(ref){
  // Before the full tree arrives the main-market quote from the list is shown as a real market.
  const q=MatchFormat.orientQuote(ref);if(!q)return null;
  const open=!q.s,teams=nativeTeams(ref);
  // The quote is already in event order; present it with the event's own team names.
  return {key:'quote:winner',type:'moneyline',period:0,title:'Победитель',status:open?'open':q.s==='c'?'closed':'suspended',prices:[{designation:'home',label:st.event.team1,decimal:q.h},...(q.d?[{designation:'draw',label:'Ничья',decimal:q.d}]:[]),{designation:'away',label:st.event.team2,decimal:q.a}],__fromQuote:true,__teams:teams};
 }

 // ------------------------------------------------------------------ comparison (canonical markets, server semantics v2)
 // One row per canonical bet across bookmakers; the bookmaker's own market name is in the title tooltip. Unclassified
 // markets are listed per bookmaker below, never merged.
 const SHORT={astek:'Astek',fonbet:'Fonbet',pinnacle:'Pinnacle',ggbet:'GGBET'};
 function compareHtml(model,{teams,idPrefix='cmp',pickMarket=false,timelineLink=false,track=true}={}){
  const cols=model.books,bySection=new Map();
  for(const g of model.groups){const k=MarketCompare.scopeLabel(g);if(!bySection.has(k))bySection.set(k,[]);bySection.get(k).push(g);}
  const head=`<thead><tr><th scope="col" class="o"><span class="sr-only">Исход</span></th>${cols.map(b=>`<th scope="col"><span class="book-mark ${esc(b)}" aria-hidden="true"></span>${esc(SHORT[b]||b)}</th>`).join('')}</tr></thead>`;
  const cell=(g,b,o)=>{
   const book=g.books[b];if(!book)return '<td class="absent" title="Контора не выставила этот рынок">·</td>';
   if(book.status&&book.status!=='open')return `<td class="susp" title="${book.status==='closed'?'Рынок закрыт':'Рынок приостановлен'}">${book.status==='closed'?'закр.':'⏸'}</td>`;
   const p=book.prices[o],v=p?.value;if(v==null)return '<td class="none">—</td>';
   const t=track?tracker.track(`${st.id}|${idPrefix}|${g.key}|${o}|${b}`,v):{};
   return `<td class="${g.best[o]!=null&&Math.abs(v-g.best[o])<1e-9&&g.bookCount>1?'best':''}">${t.dir?`<span class="chg ${t.dir}" aria-label="${t.dir==='up'?'вырос':'снизился'} с ${esc(MatchFormat.formatPrice(t.was))}">${t.dir==='up'?'▲':'▼'}</span>`:''}${esc(MatchFormat.formatPrice(v))}</td>`;
  };
  return [...bySection].map(([section,groups])=>`<section class="mkt-group" data-market-key="${idPrefix}:s:${esc(section)}"><h4><span>${esc(section)}</span><span>${groups.length}</span></h4>${groups.map(g=>{
   const raw=Object.entries(g.books).map(([b,x])=>`${SHORT[b]||b}: ${x.raw?.title||'—'}${x.at?` · ${ctx.stamp(x.at,false,true)}`:''}`).join('\n');
   return `<div class="cmp ${g.openCount?'':'closed'}" data-market-key="${idPrefix}:${esc(g.key)}"><div class="cmp-title" title="${esc(raw)}"><span>${esc(g.title)}</span>${g.bookCount>1?`<small>${g.bookCount} конт.</small>`:''}${pickMarket?`<button type="button" class="link-btn small" data-tl="market-only" data-market="${esc(g.key)}">только этот</button>`:''}${timelineLink?`<button type="button" class="link-btn small" data-dp-market-timeline="${esc(g.key)}" title="История этого рынка у всех контор">история</button>`:''}</div><div class="cmp-wrap"><table class="cmp-grid" style="--cols:${cols.length}">${head}<tbody>${g.outcomes.map(o=>`<tr><th scope="row">${esc(MarketCompare.outcomeLabel(o,g,teams)||Object.values(g.books).map(x=>x.prices[o]?.label).find(Boolean)||'Исход')}</th>${cols.map(b=>cell(g,b,o)).join('')}</tr>`).join('')}</tbody></table></div></div>`;
  }).join('')}</section>`).join('');
 }
 function oddsModeSwitch(){return `<span class="segmented odds-mode" role="group" aria-label="Вид коэффициентов">${[['compare','Сравнение контор'],['book','Одна контора']].map(([m,l])=>`<button type="button" data-dp-mode="${m}" aria-pressed="${(st.oddsMode||'compare')===m}">${l}</button>`).join('')}</span>`;}
 function renderCompare(body,model){
  const teams={team1:st.event.team1,team2:st.event.team2};
  const scopes=[...new Set(model.groups.map(g=>MarketCompare.scopeLabel(g)))];
  if(st.scope!=='all'&&!scopes.includes(st.scope))st.scope='all';
  const inScope=model.groups.filter(g=>st.scope==='all'||MarketCompare.scopeLabel(g)===st.scope);
  // «Основные» (winners, handicaps, totals) first: a LIVE CS2 match has >1,000 canonical markets with player props.
  const CORE=new Set(['winners','handicaps','totals']),inCat=(g,c)=>c==='all'||(c==='core'?CORE.has(g.category):g.category===c);
  const cats=['core',...Object.keys(MarketCanonical.categoryLabel).filter(k=>k!=='all'&&inScope.some(g=>g.category===k)),...(inScope.some(g=>g.category==='players')?['players']:[])];
  if(!st.cmpCat||(st.cmpCat!=='all'&&!cats.includes(st.cmpCat)))st.cmpCat='core';
  const q=MarketCanonical.norm(st.query);
  const shown=inScope.filter(g=>inCat(g,st.cmpCat)&&(!q||MarketCanonical.norm([g.title,...g.outcomes.map(o=>MarketCompare.outcomeLabel(o,g,teams)||'')].join(' ')).includes(q)));
  if(body.dataset.kind!=='compare'){body.dataset.kind='compare';body.innerHTML=`<div class="odds-controls" id="dpOddsControls"><div class="odds-top" id="dpModeRow"></div><div class="odds-filter"><input id="dpSearch" class="input" type="search" placeholder="Найти рынок или исход" aria-label="Поиск рынков" autocomplete="off"><span class="count" id="dpCount"></span></div><div class="market-tabs" id="dpMarketTabs" role="tablist" aria-label="Карта"></div><div class="market-tabs" id="dpCats" role="tablist" aria-label="Тип рынка"></div><div class="odds-meta" id="dpMeta" role="status"></div></div><div id="dpMarkets"></div>`;$('dpSearch').value=st.query;}
  StableDOM.patch($('dpModeRow'),oddsModeSwitch()+`<span class="muted small">Одинаковые ставки разных контор — в одной строке; название рынка у конторы — в подсказке.</span>`);
  const tabs=scopes.length>1?[`<button type="button" role="tab" data-dp-scope="all" aria-selected="${st.scope==='all'}">Все<b>${model.groups.length}</b></button>`,...scopes.map(sc=>`<button type="button" role="tab" data-dp-scope="${esc(sc)}" aria-selected="${st.scope===sc}">${esc(sc)}<b>${model.groups.filter(g=>MarketCompare.scopeLabel(g)===sc).length}</b></button>`)].join(''):'';
  StableDOM.patch($('dpMarketTabs'),tabs);$('dpMarketTabs').hidden=!tabs;
  const label=k=>k==='players'?'Игроки':k==='core'?'Основные':MarketCanonical.categoryLabel[k];
  const catTabs=[`<button type="button" role="tab" data-dp-cmpcat="all" aria-selected="${st.cmpCat==='all'}">Все рынки<b>${inScope.length}</b></button>`,...cats.map(k=>`<button type="button" role="tab" data-dp-cmpcat="${k}" aria-selected="${st.cmpCat===k}">${esc(label(k))}<b>${inScope.filter(g=>inCat(g,k)).length}</b></button>`)].join('');
  StableDOM.patch($('dpCats'),catTabs);$('dpCats').hidden=!catTabs;
  $('dpCount').textContent=`${shown.length} из ${model.groups.length}`;
  const meta=[];if(st.loading)meta.push('<span class="refreshing">обновляем…</span>');if(model.unknown.length)meta.push(`нераспознанных рынков: ${model.unknown.length} (внизу)`);
  const errors=Object.entries(st.detail?.marketDetailErrors||{});if(errors.length)meta.push(`<span class="warn">не удалось обновить: ${esc(errors.map(([b,e])=>`${SHORT[b]||b} — ${e}`).join('; '))}</span>`);
  StableDOM.patch($('dpMeta'),meta.join(' · '));
  const unknown=model.unknown.length?`<details class="detail-section fold" data-market-key="cmp-unknown" data-fold="cmp-unknown" ${st.folds?.has('cmp-unknown')?'open':''}><summary>${UiKit.chevron('caret')}<span>Нераспознанные рынки</span><span class="n">${model.unknown.length}</span></summary><p class="muted small">Тип этих рынков ещё не сопоставлен с общим справочником, поэтому они показаны отдельно по каждой конторе.</p><table class="src-table"><tbody>${model.unknown.map(u=>`<tr><td><span class="book-mark ${esc(u.source)}" aria-hidden="true"></span> ${esc(SHORT[u.source]||u.source)}</td><td>${esc(u.title)}${u.status!=='open'?' <small class="muted">приостановлен</small>':''}</td><td class="num">${u.prices.map(p=>`${esc(p.label)} <b>${p.value!=null?esc(MatchFormat.formatPrice(p.value)):'—'}</b>`).join(' · ')}</td></tr>`).join('')}</tbody></table></details>`:'';
  // Rendered in pages of 80 markets: the DOM stays small, a refresh patches only what is on screen.
  const limit=st.cmpLimit||80,page=shown.slice(0,limit);
  const html=shown.length?compareHtml({...model,groups:page},{teams,timelineLink:tabsFor(st.event,st.view).some(t=>t[0]==='timeline')})+(shown.length>limit?`<div class="list-more" data-market-key="cmp-more"><button type="button" class="btn" data-dp-more="1">Показать ещё ${Math.min(80,shown.length-limit)} · осталось ${shown.length-limit}</button></div>`:''):state('Нет рынков по фильтру',q?'Измените поиск.':'Выберите другую вкладку.');
  StableDOM.patch($('dpMarkets'),html+unknown);
  root.style.setProperty('--dp-tabs-h',($('dpTabs')?.offsetHeight||0)+'px');
 }
 function renderTimeline(body){
  if(body.dataset.kind!=='timeline'){body.dataset.kind='timeline';body.innerHTML='';}
  TimelinePanel.open(body,st.event,st.view);
  if(st.timelineMarket){body.querySelector(`[data-tl="market-only"][data-market="${CSS.escape(st.timelineMarket)}"]`)?.click();st.timelineMarket='';}
 }

 function renderOdds(body){
  const list=books();
  if((st.oddsMode||'compare')==='compare'){const model=MarketCompare.build(list,{visible:ctx.bookVisible});if(model&&model.groups.length+model.unknown.length){renderCompare(body,model);return;}}
  if(body.dataset.kind==='compare'){body.dataset.kind='';body.innerHTML='';}
  if(st.source&&!list.some(r=>r.source===st.source))st.source=list[0]?.source||'';
  if(!st.source)st.source=list[0]?.source||'';
  const ref=selectedRef();
  const hydrated=ref?.odds&&Array.isArray(ref.odds.markets);
  let markets=hydrated?ref.odds.markets:[];
  const fromQuote=!hydrated&&ref?quoteMarket(ref):null;
  if(fromQuote)markets=[fromQuote];
  const nativeTabs=PLATFORM.has(st.source)&&Array.isArray(ref?.odds?.providerTabs)?ref.odds.providerTabs:[];
  if(st.providerTab!=='all'&&!nativeTabs.some(t=>String(t.id)===st.providerTab))st.providerTab='all';
  const described=markets.map((m,index)=>({m,index,d:m.__fromQuote?{title:'Победитель',period:0,category:'winners',order:0,line:null,family:'moneyline',key:'quote:winner'}:describe(m,ref)}));
  const inTab=described.filter(x=>inProviderTab(x.m,st.providerTab));
  const scopes=[...new Set(inTab.map(x=>x.d.period))].sort((a,b)=>a-b);if(st.scope!=='all'&&!scopes.includes(Number(st.scope)))st.scope='all';
  const inScope=inTab.filter(x=>st.scope==='all'||x.d.period===Number(st.scope));
  const cats=Object.keys(MarketCanonical.categoryLabel).filter(k=>k!=='all'&&inScope.some(x=>x.d.category===k));if(st.category!=='all'&&!cats.includes(st.category))st.category='all';
  const q=MarketCanonical.norm(st.query);
  const label=(p,m)=>m.__fromQuote?p.label:MarketCanonical.outcomeLabel(p,m,st.event,nativeTeams(ref));
  const shown=inScope.filter(x=>(st.category==='all'||x.d.category===st.category)&&(!q||MarketCanonical.norm([x.d.title,...(x.m.prices||[]).map(p=>label(p,x.m))].join(' ')).includes(q)));

  // controls (kept in place across refreshes: the search input keeps focus and value)
  if(!$('dpOddsControls')||!body.contains($('dpOddsControls'))){
   body.innerHTML=`<div class="odds-controls" id="dpOddsControls"><div class="odds-top" id="dpModeRow"></div><div class="book-switch" id="dpBooks" role="group" aria-label="Букмекер"></div><div class="odds-filter"><input id="dpSearch" class="input" type="search" placeholder="Найти рынок или исход" aria-label="Поиск рынков" autocomplete="off"><span class="count" id="dpCount"></span></div><div class="market-tabs" id="dpMarketTabs" role="tablist" aria-label="Рынки"></div><div class="market-tabs" id="dpCats" role="tablist" aria-label="Тип рынка"></div><div class="odds-meta" id="dpMeta" role="status"></div></div><div id="dpMarkets"></div>`;
   $('dpSearch').value=st.query;
  }
  StableDOM.patch($('dpModeRow'),MarketCompare.build(list,{visible:ctx.bookVisible})?oddsModeSwitch():'');$('dpModeRow').hidden=!$('dpModeRow').innerHTML;
  StableDOM.patch($('dpBooks'),list.map(r=>{const n=r.source===st.source?markets.length:(r.odds?.markets?.length||0),health=ctx.bookHealth(r.source);return `<button type="button" data-book-source="${esc(r.source)}" data-dp-book="${esc(r.source)}" aria-pressed="${r.source===st.source}"><span class="book-mark ${esc(r.source)}" aria-hidden="true"></span>${esc(ctx.providerName(r.source))}${n?`<b>${n}</b>`:''}${health&&!health.ok?' <span class="status-text warn" title="'+esc(health.reason)+'">· недоступен</span>':''}</button>`;}).join('')||'<span class="muted">Нет данных букмекеров для этого матча</span>');
  const marketTabs=nativeTabs.length>1?(nativeTabs.some(t=>String(t.id)==='all')?nativeTabs:[{id:'all',name:'All'},...nativeTabs]).map(t=>{const id=String(t.id);return `<button type="button" role="tab" data-dp-ptab="${esc(id)}" aria-selected="${st.providerTab===id}">${esc(providerTabLabel(t))}<b>${described.filter(x=>inProviderTab(x.m,id)).length}</b></button>`;}).join(''):(scopes.length>1?[`<button type="button" role="tab" data-dp-scope="all" aria-selected="${st.scope==='all'}">Все<b>${inTab.length}</b></button>`,...scopes.map(p=>`<button type="button" role="tab" data-dp-scope="${p}" aria-selected="${st.scope===String(p)}">${esc(MarketCanonical.scopeLabel(p))}<b>${inTab.filter(x=>x.d.period===p).length}</b></button>`)].join(''):'');
  StableDOM.patch($('dpMarketTabs'),marketTabs);$('dpMarketTabs').hidden=!marketTabs;
  const catTabs=cats.length>1?[`<button type="button" role="tab" data-dp-cat="all" aria-selected="${st.category==='all'}">Все рынки</button>`,...cats.map(k=>`<button type="button" role="tab" data-dp-cat="${k}" aria-selected="${st.category===k}">${esc(MarketCanonical.categoryLabel[k])}<b>${inScope.filter(x=>x.d.category===k).length}</b></button>`)].join(''):'';
  StableDOM.patch($('dpCats'),catTabs);$('dpCats').hidden=!catTabs;
  $('dpCount').textContent=markets.length?`${shown.length} из ${markets.length}`:'';
  const updated=ref?.odds?.updatedAt||ref?.quote?.at||0,closed=markets.filter(m=>m.status&&m.status!=='open').length,serverError=st.detail?.marketDetailErrors?.[st.source]||'';
  const meta=[];
  if(updated)meta.push(`Обновлено ${esc(ctx.stamp(updated,false,true))}`);
  if(st.loading)meta.push(`<span class="refreshing">${hydrated?'обновляем…':'загружаем все рынки…'}</span>`);
  if(closed)meta.push(`приостановлено: ${closed}`);
  if(ref?.odds?.incompleteMaps)meta.push('данные карт дополняются');
  if(st.error||serverError)meta.push(`<span class="warn">не удалось обновить: ${esc(st.error||serverError)}</span>`);
  StableDOM.patch($('dpMeta'),meta.join(' · '));

  // markets
  let html='';
  if(!ref)html=state('Нет коэффициентов','Ни одна из выбранных контор не даёт линию на этот матч.');
  else if(!markets.length&&st.loading)html=skeletonMarkets();
  else if(!markets.length){const health=ctx.bookHealth(st.source);html=health&&!health.ok?state(`${ctx.providerName(st.source)} временно недоступен`,health.reason||'Источник не отвечает. Остальные конторы работают.','warn'):state('Рынков пока нет','Контора ещё не открыла линию на этот матч.');}
  else if(!shown.length)html=state('Нет рынков по фильтру',q?'Измените поиск.':'Выберите другую вкладку.');
  else{
   const groups=new Map();for(const x of shown){if(!groups.has(x.d.period))groups.set(x.d.period,[]);groups.get(x.d.period).push(x);}
   html=[...groups].sort((a,b)=>a[0]-b[0]).map(([p,rows])=>{rows.sort((a,b)=>a.d.order-b.d.order||(a.d.line??0)-(b.d.line??0)||a.d.title.localeCompare(b.d.title,'ru')||String(a.m.key||'').localeCompare(String(b.m.key||'')));
    return `<section class="mkt-group" data-market-key="period:${p}"><h4><span>${esc(MarketCanonical.scopeLabel(p))}</span><span>${rows.length}</span></h4>${rows.map(({m,d,index})=>{const open=!m.status||m.status==='open',prices=[...(m.prices||[])].sort((a,b)=>outcomeRank(a)-outcomeRank(b)),mk=String(d.key||m.key||index);
     return `<div class="mkt ${open?'':'closed'}" data-market-key="${esc(st.source+':'+mk+':'+(m.key||index))}"><div class="title">${esc(d.title)}${d.line!=null&&LINE_FAMILIES.has(d.family)?`<small>Линия ${esc(d.line)}</small>`:''}${open?'':`<small>${m.status==='closed'?'Закрыт':'Приостановлен'}</small>`}</div><div class="outcomes">${prices.map((price,i)=>{const value=open?MatchFormat.openPrice(price.decimal):null,t=tracker.track(`${st.id}|${st.source}|${mk}|${m.key||index}|${price.designation||i}|${price.points??''}`,value),lab=label(price,m);
      return `<div class="outcome" title="${esc(lab)}"><span class="label">${esc(lab)}</span><span class="value ${value?'':'none'}">${t.dir?`<span class="chg ${t.dir}" aria-label="${t.dir==='up'?'вырос':'снизился'} с ${esc(MatchFormat.formatPrice(t.was))}">${t.dir==='up'?'▲':'▼'}</span>`:''}${value?esc(MatchFormat.formatPrice(value)):'—'}</span></div>`;}).join('')}</div></div>`;}).join('')}</section>`;}).join('');
   if(fromQuote&&st.loading)html+=skeletonMarkets(3);
  }
  StableDOM.patch($('dpMarkets'),html);
  // Market group headers stick right below the (sticky) detail tabs; the controls scroll away with the markets.
  root.style.setProperty('--dp-tabs-h',($('dpTabs')?.offsetHeight||0)+'px');
 }
 function skeletonMarkets(n=6){return `<div aria-hidden="true">${Array.from({length:n},(_,i)=>`<div class="mkt" data-market-key="sk:${i}"><div class="skeleton" style="height:14px;width:${60+(i*17)%35}%"></div><div class="outcomes"><div class="skeleton" style="height:34px"></div><div class="skeleton" style="height:34px"></div></div></div>`).join('')}</div>`;}
 function state(title,text,kind=''){return `<div class="state ${kind}" data-market-key="state"><div class="state-icon" aria-hidden="true">${kind==='warn'?'!':'—'}</div><strong>${esc(title)}</strong><p>${esc(text)}</p></div>`;}

 // «Матч»: one table per bookmaker (link, start, first seen, LIVE/end, score), the tools, then the detailed logs folded.
 function renderInfo(body){
  const e=st.event,rows=refs(e).filter(r=>ctx.bookVisible(r.source)).sort((a,b)=>(BOOK_ORDER[a.source]??9)-(BOOK_ORDER[b.source]??9));
  const live=st.view==='live',results=st.view==='results';
  const seen=new Map(MatchFormat.firstSeen(rows).map(x=>[x.source,x.at]));
  const tools=[['live','results','prematch'].includes(st.view)&&ctx.can('scores.history')?'<button class="btn" data-dp="scores">История счёта</button>':'',['live','prematch','results'].includes(st.view)&&ctx.can('odds.history')&&!ctx.oddsHidden(results?'live':st.view)?'<button class="btn" data-dp="timeline">История коэффициентов</button>':'',ctx.generatorAvailable(e,st.view)?'<button class="btn" data-dp="generator">Генератор CS2</button>':''].filter(Boolean);
  const html=`<div class="detail-section" data-market-key="sources"><h3>Конторы</h3><table class="src-table"><thead><tr><th>Контора</th><th>Начало</th><th>Появился</th><th>${live?'В LIVE':results?'Окончание':'В линии'}</th><th class="num">Счёт</th></tr></thead><tbody>${rows.map(r=>{const url=ctx.eventUrl(r);return `<tr data-market-key="src:${esc(r.source)}"><td><span class="book-mark ${esc(r.source)}" aria-hidden="true"></span> <button class="link-btn" data-open-url="${esc(url)}" data-src-book="${esc(r.source)}" ${url?'':'aria-disabled="true"'} title="${url?'Открыть у букмекера · правый клик — копировать ссылку':'Контора не передала ссылку на этот матч'}">${esc(ctx.providerName(r.source))}</button></td><td>${esc(ctx.stamp(r.startAt,true))}</td><td>${esc(ctx.stamp(seen.get(r.source)||r.firstSeenAt,true))}</td><td>${esc(ctx.stamp(live?r.enteredLiveAt:results?(r.endedAt||r.removedAt):r.firstPrematchAt,true,live))}</td><td class="num">${esc(r.scoreText||'—')}${results&&r.resultVerified?' <span class="verified" title="Результат подтверждён">✓</span>':''}</td></tr>`;}).join('')}</tbody></table></div>
  ${tools.length?`<div class="detail-section" data-market-key="actions"><h3>Инструменты</h3><div class="row-actions">${tools.join('')}</div></div>`:''}
  ${timeline(e)}${ctx.isAdmin?.()?scoreDiagnostics(e):''}`;
  if(body.dataset.kind!=='info'){body.dataset.kind='info';body.innerHTML='';}
  StableDOM.patch(body,html);
 }
 const fold=(key,title,count,inner)=>`<details class="detail-section fold" data-market-key="${key}" data-fold="${key}" ${st.folds?.has(key)?'open':''}><summary>${UiKit.chevron('caret')}<span>${esc(title)}</span>${count!=null?`<span class="n">${count}</span>`:''}</summary>${inner}</details>`;
 // Administrators only: the score each bookmaker reports and whether they differ.
 function scoreDiagnostics(e){const m=ctx.scoreOf?ctx.scoreOf(e).scoreModel:null;if(!m?.providers?.length)return '';return fold('score-diag',`Счёт по конторам${m.disagree?' · расходится':''}`,null,`<table class="src-table"><tbody>${m.providers.map(p=>`<tr><td>${esc(ctx.providerName(p.source))}${p===m.best?' ✓':''}</td><td class="num">${esc(p.text)}</td></tr>`).join('')}</tbody></table>`);}
 function timeline(e){const items=refs(e).filter(r=>ctx.bookVisible(r.source)).flatMap(r=>(r.timeline||r.lifecycle||[]).map(c=>({...c,source:r.source}))).sort((a,b)=>b.at-a.at).slice(0,30);if(!items.length)return '';return fold('timeline','Журнал появления у контор',items.length,`<table class="src-table"><tbody>${items.map(c=>`<tr><td class="num">${esc(ctx.stamp(c.at,true,true))}</td><td>${esc(ctx.providerName(c.source))}</td><td>${c.phase==='results'?'финальный счёт подтверждён':c.type==='entered'?(c.phase==='prematch'?'появился в линии':'появился в LIVE'):(c.phase==='prematch'?'снят с линии':'снят с LIVE')}</td></tr>`).join('')}</tbody></table>`);}

 function statsModule(e){const info=StatisticsClient.info(e);return info?.provider==='dota2'?DotaStatsPanel:info?.provider==='cs2'?Cs2Panel:null;}
 function openStats(){if(!st)return;const m=statsModule(st.event);if(m&&!m.isOpen(st.event.id))m.toggle(st.event);}
 function closeStats(){if(!st)return;for(const m of [DotaStatsPanel,Cs2Panel])if(m.isOpen(st.event.id))m.toggle(st.event);}
 function renderStats(body){
  const m=statsModule(st.event),markup=m?m.markup(st.event):'';
  if(body.dataset.kind!=='stats'){body.dataset.kind='stats';body.innerHTML='';}
  if(!markup){body.innerHTML=`<div class="detail-section"><div class="skeleton" style="height:120px"></div></div>`;return;}
  // The stats panels refresh their own blocks incrementally.
  if(!body.firstElementChild?.matches?.('.stats-wrap'))body.innerHTML=`<div class="stats-wrap detail-section">${markup}</div>`;
  else StableDOM.patch(body.firstElementChild,markup);
 }
 function refreshStats(){if(st?.tab==='stats')render();}

 // ------------------------------------------------------------------ pinnacle live stream (as in 8.x)
 function closeStream(){stream?.close();stream=null;streamKey='';++streamToken;}
 function syncStream(){
  if(!st||st.tab!=='odds'||st.source!=='pinnacle'||!window.EventSource){closeStream();return;}
  const r=books().find(x=>x.source==='pinnacle'),id=sourceId(r),live=!!(st.view==='live'||r?.inLive||r?.enteredLiveAt);
  if(!id||!live){closeStream();return;}
  if(stream&&streamKey===id)return;
  closeStream();const token=streamToken,eventId=st.id;streamKey=id;stream=new EventSource(ServerConfig.streamUrl(`/api/pinnacle/live-stream?id=${encodeURIComponent(id)}`));
  stream.onmessage=ev=>{if(!st||st.id!==eventId||token!==streamToken)return;try{const data=JSON.parse(ev.data);if(data.event){st.liveRef={...data.event,source:'pinnacle'};st.liveAt=Date.now();render();}}catch{}};
 }

 // ------------------------------------------------------------------ interaction
 function onInput(event){if(event.target.id!=='dpSearch'||!st)return;st.query=event.target.value;clearTimeout(searchTimer);searchTimer=setTimeout(render,60);}
 function onClick(event){
  if(!st)return;const t=event.target;
  const tab=t.closest('[data-dp-tab]');if(tab){if(st.tab==='timeline'&&tab.dataset.dpTab!=='timeline')TimelinePanel.close();st.tab=tab.dataset.dpTab;ctx.setPref('detailTab',st.tab);$('dpBody').dataset.kind='';$('dpBody').innerHTML='';$('dpBody').scrollTop=0;if(st.tab==='stats')openStats();render();syncStream();return;}
  const cc=t.closest('[data-dp-cmpcat]');if(cc){st.cmpCat=cc.dataset.dpCmpcat;st.cmpLimit=80;render();return;}
  if(t.closest('[data-dp-more]')){st.cmpLimit=(st.cmpLimit||80)+80;render();return;}
  const mode=t.closest('[data-dp-mode]');if(mode){if((st.oddsMode||'compare')===mode.dataset.dpMode)return;st.oddsMode=mode.dataset.dpMode;ctx.setPref('detailOddsMode',st.oddsMode);resetMarketFilters();$('dpBody').dataset.kind='';$('dpBody').innerHTML='';render();return;}
  const mt=t.closest('[data-dp-market-timeline]');if(mt){st.timelineMarket=mt.dataset.dpMarketTimeline;st.tab='timeline';ctx.setPref('detailTab',st.tab);$('dpBody').dataset.kind='';$('dpBody').innerHTML='';render();return;}
  const book=t.closest('[data-dp-book]');if(book){if(book.dataset.dpBook===st.source)return;st.source=book.dataset.dpBook;ctx.setPref('detailBook',st.source);resetMarketFilters();render();syncStream();return;}
  const ptab=t.closest('[data-dp-ptab]');if(ptab){st.providerTab=ptab.dataset.dpPtab;st.scope='all';st.category='all';render();return;}
  const scope=t.closest('[data-dp-scope]');if(scope){st.scope=scope.dataset.dpScope;st.category='all';st.cmpLimit=80;render();return;}
  const cat=t.closest('[data-dp-cat]');if(cat){st.category=cat.dataset.dpCat;render();return;}
  const action=t.closest('[data-dp]')?.dataset.dp;
  if(action==='close'){hide();return;}
  if(action==='fav'){ctx.toggleFavorite(st.event);render();return;}
  if(action==='copy'){ctx.copyMatch(st.event);return;}
  if(action==='history'){if(tabsFor(st.event,st.view).some(t=>t[0]==='timeline')){st.tab='timeline';ctx.setPref('detailTab',st.tab);$('dpBody').dataset.kind='';$('dpBody').innerHTML='';render();}else ctx.openMatchHistory(st.event,st.view);return;}
  if(action==='scores'){ctx.openScoreHistory(st.event,st.view);return;}
  if(action==='timeline'){ctx.openOddsTimeline(st.event);return;}
  if(action==='generator'){ctx.openGenerator(st.event);return;}
  const link=t.closest('[data-open-url]');if(link?.dataset.openUrl&&link.getAttribute('aria-disabled')!=='true'){ctx.openUrl(link.dataset.openUrl);return;}
 }
 return {configure,show,hide,update,onFeedPatches,refreshStats,isOpen,currentId,render,compareHtml:(...a)=>compareHtml(...a),event:()=>st?.event||null,refFor:source=>st?books().find(r=>r.source===source)||null:null,tabs:()=>st?tabsFor(st.event,st.view).map(t=>t[0]):[],state:()=>st&&{id:st.id,view:st.view,tab:st.tab,source:st.source,providerTab:st.providerTab,scope:st.scope,loading:st.loading}};
})();
