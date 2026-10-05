'use strict';
/* Small shared UI components (9.3): game listbox, context menu, disclosure chevron, stream links.
   Plain DOM, no framework; markup helpers are pure functions (unit-tested through extension/test/ui-kit.test.mjs). */
const UiKit=(()=>{
 const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
 // One chevron for every collapsible thing; it points right when closed and down when open (CSS rotates it).
 const chevron=(cls='chev')=>`<svg class="${cls}" viewBox="0 0 16 16" aria-hidden="true" focusable="false"><path d="M6 3.5 10.5 8 6 12.5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
 // "Collapse all / expand all" in one compact toggle: two chevrons that flip.
 const foldIcon=open=>open
  ?'<svg viewBox="0 0 16 16" aria-hidden="true" focusable="false"><path d="M4.5 6.5 8 3l3.5 3.5M4.5 13 8 9.5l3.5 3.5" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>'
  :'<svg viewBox="0 0 16 16" aria-hidden="true" focusable="false"><path d="M4.5 3 8 6.5 11.5 3M4.5 9.5 8 13l3.5-3.5" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>';

 // ------------------------------------------------------------------ stream links
 const SERVICES=[
  [/(^|\.)twitch\.tv$/,'twitch','Twitch','<path d="M4 3h17v11.5l-5 5h-4l-3 3v-3H4V3zm2 2v12h4v2l2-2h4l3-3V5H6zm5 3h2v5h-2V8zm4.5 0h2v5h-2V8z"/>'],
  [/(^|\.)(youtube\.com|youtu\.be)$/,'youtube','YouTube','<path d="M21.6 7.2a2.6 2.6 0 0 0-1.8-1.8C18.2 5 12 5 12 5s-6.2 0-7.8.4A2.6 2.6 0 0 0 2.4 7.2 27 27 0 0 0 2 12a27 27 0 0 0 .4 4.8 2.6 2.6 0 0 0 1.8 1.8C5.8 19 12 19 12 19s6.2 0 7.8-.4a2.6 2.6 0 0 0 1.8-1.8A27 27 0 0 0 22 12a27 27 0 0 0-.4-4.8zM10 15V9l5.2 3L10 15z"/>'],
  [/(^|\.)kick\.com$/,'kick','Kick','<path d="M4 4h5.5v5h1.8V7.2h1.8V5.4H15V4h5v5.5h-1.8v1.8h-1.8v1.4h1.8v1.8h1.8V20h-5v-1.4h-1.9v-1.8h-1.8V15H9.5v5H4V4z"/>'],
  [/(^|\.)(vk\.com|vkvideo\.ru|vk\.ru)$/,'vk','VK Видео','<path d="M3 6h3.6c.2 4.3 2 6.2 3.5 6.6V6h3.3v3.7c1.5-.2 3-1.9 3.6-3.7h3.3a9.8 9.8 0 0 1-4.4 6 9.9 9.9 0 0 1 5.1 6.2h-3.6a6.3 6.3 0 0 0-4-4.6v4.6h-.4C7.2 18.2 3.2 14.1 3 6z"/>'],
  [/(^|\.)trovo\.live$/,'trovo','Trovo','<circle cx="12" cy="12" r="8" fill="none" stroke="currentColor" stroke-width="2.2"/><path d="M10 8.5v7l5.5-3.5z"/>'],
 ];
 function service(url){let host='';try{const u=new URL(url);if(!['https:','http:'].includes(u.protocol))return null;host=u.hostname.toLowerCase();}catch{return null;}for(const [re,key,label,svg] of SERVICES)if(re.test(host))return {key,label,svg};return {key:'other',label:'Трансляция',svg:'<path d="M8 5v14l11-7L8 5z"/>'};}
 // One component for every stream list: same height, radius and type; service icon + channel name (truncated, full
 // name in the tooltip). Links with an unusable URL are left out.
 function streamLinks(links,{label='Трансляции',empty='Трансляций нет'}={}){
  const list=(Array.isArray(links)?links:[]).map(l=>({...l,svc:service(l?.url)})).filter(l=>l.svc);
  if(!list.length)return `<div class="streams"><span class="streams-label muted">${esc(empty)}</span></div>`;
  return `<div class="streams" role="group" aria-label="${esc(label)}"><span class="streams-label">${esc(label)}</span>${list.map(l=>{const name=String(l.name||l.language||'').trim()||l.svc.label,title=[l.svc.label,l.language&&l.language!==name?l.language:'',name].filter(Boolean).join(' · ');return `<button type="button" class="stream ${l.svc.key}" data-open-url="${esc(l.url)}" title="${esc(title)}" aria-label="${esc(title)}"><svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">${l.svc.svg}</svg><span>${esc(name)}</span></button>`;}).join('')}</div>`;
 }

 // ------------------------------------------------------------------ listbox (game filter)
 // A button that opens a list of options with icons; full keyboard support (arrows, Home/End, Enter, Esc, typeahead).
 function listbox({button,list,render,onChange}){
  let options=[],value='',active=-1,typed='',typedAt=0;
  const open=()=>!list.hidden;
  function paint(){
   const cur=options.find(o=>o.value===value)||options[0];
   if(cur)button.innerHTML=`${render.icon(cur)}<span class="lb-label">${esc(cur.label)}</span><span class="lb-count">${esc(cur.count??'')}</span>${chevron('lb-caret')}`;
   button.setAttribute('aria-label',`Игра: ${cur?.label||''}${cur?.count!=null?', '+cur.count:''}`);
   if(open())drawList();
  }
  function drawList(){
   list.innerHTML=options.map((o,i)=>`<div class="lb-option" role="option" id="${list.id}-o${i}" data-index="${i}" aria-selected="${o.value===value}"${i===active?' data-active="true"':''}>${render.icon(o)}<span class="lb-label">${esc(o.label)}</span><span class="lb-count">${esc(o.count??'')}</span></div>`).join('');
   if(active>=0){list.setAttribute('aria-activedescendant',`${list.id}-o${active}`);list.querySelector('[data-active]')?.scrollIntoView({block:'nearest'});}else list.removeAttribute('aria-activedescendant');
  }
  function show(){if(open())return;active=Math.max(0,options.findIndex(o=>o.value===value));list.hidden=false;button.setAttribute('aria-expanded','true');drawList();list.focus({preventScroll:true});document.addEventListener('pointerdown',outside,true);}
  function hide(focus=true){if(!open())return;list.hidden=true;button.setAttribute('aria-expanded','false');document.removeEventListener('pointerdown',outside,true);if(focus)button.focus({preventScroll:true});}
  function outside(e){if(!list.contains(e.target)&&!button.contains(e.target))hide(false);}
  function choose(i){const o=options[i];hide();if(!o||o.value===value)return;value=o.value;paint();onChange(o);}
  function move(to){if(!options.length)return;active=Math.max(0,Math.min(options.length-1,to));drawList();}
  button.addEventListener('click',()=>open()?hide():show());
  button.addEventListener('keydown',e=>{if(['ArrowDown','ArrowUp'].includes(e.key)){e.preventDefault();show();}});
  list.addEventListener('click',e=>{const o=e.target.closest('[data-index]');if(o)choose(Number(o.dataset.index));});
  list.addEventListener('pointermove',e=>{const o=e.target.closest('[data-index]');if(o&&Number(o.dataset.index)!==active){active=Number(o.dataset.index);for(const n of list.querySelectorAll('[data-active]'))n.removeAttribute('data-active');o.dataset.active='true';list.setAttribute('aria-activedescendant',o.id);}});
  list.addEventListener('keydown',e=>{
   if(e.key==='ArrowDown'){e.preventDefault();move(active+1);}else if(e.key==='ArrowUp'){e.preventDefault();move(active-1);}
   else if(e.key==='Home'){e.preventDefault();move(0);}else if(e.key==='End'){e.preventDefault();move(options.length-1);}
   else if(e.key==='Enter'||e.key===' '){e.preventDefault();choose(active);}else if(e.key==='Escape'){e.preventDefault();e.stopPropagation();hide();}else if(e.key==='Tab')hide(false);
   else if(e.key.length===1&&/\S/.test(e.key)){const now=Date.now();typed=(now-typedAt<700?typed:'')+e.key.toLowerCase();typedAt=now;const i=options.findIndex((o,k)=>k>0&&o.label.toLowerCase().startsWith(typed));if(i>=0)move(i);}
  });
  return {set(next,current){const sig=JSON.stringify([next,current]);if(sig===this.sig)return;this.sig=sig;options=next;value=current;paint();},value:()=>value,close:()=>hide(false),isOpen:open};
 }

 // ------------------------------------------------------------------ context menu
 let menu=null,menuReturn=null;
 function closeMenu(focus=true){if(!menu)return;menu.remove();menu=null;document.removeEventListener('pointerdown',menuOutside,true);window.removeEventListener('blur',closeQuiet);window.removeEventListener('resize',closeQuiet);document.removeEventListener('scroll',closeQuiet,true);if(focus&&menuReturn?.isConnected)menuReturn.focus({preventScroll:true});menuReturn=null;}
 const closeQuiet=()=>closeMenu(false);
 function menuOutside(e){if(menu&&!menu.contains(e.target))closeMenu(false);}
 // items: [{label, hint?, run?, disabled?, note?}] - a disabled item explains why (e.g. "ссылка недоступна").
 function contextMenu({x,y,title='',items,returnFocus=null}){
  closeMenu(false);menuReturn=returnFocus||document.activeElement;
  menu=document.createElement('div');menu.className='ctx-menu';menu.setAttribute('role','menu');if(title)menu.setAttribute('aria-label',title);
  menu.innerHTML=(title?`<div class="ctx-title" aria-hidden="true">${esc(title)}</div>`:'')+items.map((it,i)=>`<button type="button" role="menuitem" data-i="${i}" ${it.disabled?'aria-disabled="true"':''} title="${esc(it.note||it.hint||'')}"><span>${esc(it.label)}</span>${it.hint?`<small>${esc(it.hint)}</small>`:''}</button>`).join('');
  document.body.appendChild(menu);
  const r=menu.getBoundingClientRect(),vw=innerWidth,vh=innerHeight;menu.style.left=Math.max(4,Math.min(x,vw-r.width-4))+'px';menu.style.top=Math.max(4,Math.min(y,vh-r.height-4))+'px';
  const buttons=[...menu.querySelectorAll('[role=menuitem]')],focusAt=i=>buttons[(i+buttons.length)%buttons.length]?.focus({preventScroll:true});
  menu.addEventListener('click',e=>{const b=e.target.closest('[data-i]');if(!b)return;const it=items[Number(b.dataset.i)];if(it.disabled)return;closeMenu();it.run?.();});
  menu.addEventListener('keydown',e=>{const i=buttons.indexOf(document.activeElement);if(e.key==='ArrowDown'){e.preventDefault();focusAt(i+1);}else if(e.key==='ArrowUp'){e.preventDefault();focusAt(i-1);}else if(e.key==='Home'){e.preventDefault();focusAt(0);}else if(e.key==='End'){e.preventDefault();focusAt(-1);}else if(e.key==='Escape'){e.preventDefault();e.stopPropagation();closeMenu();}else if(e.key==='Tab'){e.preventDefault();closeMenu();}});
  setTimeout(()=>{document.addEventListener('pointerdown',menuOutside,true);window.addEventListener('blur',closeQuiet);window.addEventListener('resize',closeQuiet);document.addEventListener('scroll',closeQuiet,true);},0);
  focusAt(Math.max(0,items.findIndex(it=>!it.disabled)));
  return menu;
 }
 // ------------------------------------------------------------------ pure decisions (tested)
 // A click on a match row while the panel is open: the same match closes it, unless a price cell of another bookmaker
 // was clicked (that switches the bookmaker); any other match switches the panel to it.
 function panelClick({openId=null,id,cellBook=null,source=null}){if(openId==null)return 'open';if(String(openId)!==String(id))return 'switch';return cellBook&&cellBook!==source?'book':'close';}
 const matchName=e=>`${String(e?.team1||'').trim()} - ${String(e?.team2||'').trim()}`;
 const matchCopies=e=>[{id:'match',label:'Копировать матч',value:matchName(e)},{id:'team1',label:`Копировать «${e.team1}»`,value:String(e.team1||'')},{id:'team2',label:`Копировать «${e.team2}»`,value:String(e.team2||'')}];
 // The bookmaker's own match URL when the feed carries one (http/https only); never built or guessed.
 function bookLink(ref){try{const u=new URL(String(ref?.url||''));return ['https:','http:'].includes(u.protocol)?u.href:'';}catch{return '';}}
 return {esc,chevron,foldIcon,service,streamLinks,listbox,contextMenu,closeMenu,menuOpen:()=>!!menu,panelClick,matchName,matchCopies,bookLink};
})();
if(typeof module==='object'&&module.exports)module.exports=UiKit;
