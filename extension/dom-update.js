/* Update text/attributes in place so feed refreshes keep focus and open details. */
const StableDOM=(()=>{
 const key=n=>n.nodeType===1?(n.dataset.leagueRow||n.dataset.logKey||n.dataset.marketKey||n.dataset.bookSource||n.dataset.cs2Round||n.dataset.hawkMap||''):'';
 function morph(parent,fresh){const keyed=new Map([...parent.childNodes].filter(key).map(n=>[key(n),n]));let cursor=parent.firstChild;
  for(const desired of [...fresh.childNodes]){let node=key(desired)?keyed.get(key(desired)):cursor&&!key(cursor)&&cursor.nodeType===desired.nodeType&&cursor.nodeName===desired.nodeName?cursor:null;
   if(!node||node.nodeName!==desired.nodeName){node=desired.cloneNode(true);parent.insertBefore(node,cursor);}
   else{if(node!==cursor)parent.insertBefore(node,cursor);if(node.nodeType===3){if(node.nodeValue!==desired.nodeValue)node.nodeValue=desired.nodeValue;}
    else if(node.nodeType===1){for(const a of [...node.attributes])if(!desired.hasAttribute(a.name)&&a.name!=='open'&&!(a.name==='src'&&node.matches?.('img.team-logo')&&desired.getAttribute('data-src')===node.getAttribute('data-src')))node.removeAttribute(a.name);for(const a of desired.attributes)if(a.name!=='open'&&node.getAttribute(a.name)!==a.value)node.setAttribute(a.name,a.value);morph(node,desired);}}
   cursor=node.nextSibling;
  }while(cursor){const next=cursor.nextSibling;cursor.remove();cursor=next;}
 }
 function patch(node,html){if(!node)return;const scroller=node.closest('dialog'),top=scroller?.getBoundingClientRect().top||0,anchor=scroller?.scrollTop>80?[...node.querySelectorAll('[data-log-key],[data-market-key]')].find(n=>n.getBoundingClientRect().bottom>top+50):null,before=anchor?.getBoundingClientRect().top;
  const t=document.createElement('template');t.innerHTML=html;morph(node,t.content);
  if(anchor?.isConnected&&scroller)scroller.scrollTop+=anchor.getBoundingClientRect().top-before;
 }
 return {patch};
})();
