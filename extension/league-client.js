/* Server publication is explicit. No passwords are saved or logged. */
const LeagueClient=(()=>{
  const base='http://87.199.202.237:8080';
  async function request(path,options={}){
    const response=await fetch(base+path,{cache:'no-store',signal:AbortSignal.timeout(15000),...options});
    const data=await response.json();if(!response.ok)throw Object.assign(new Error(data.error||`HTTP ${response.status}`),{status:response.status});return data;
  }
  async function acceptRules(rules){
    if(!rules||!Array.isArray(rules.links))return;
    const old=await chrome.storage.local.get(['publishedLeagueRevision','sharedVisibilityRevision']);
    if(Number(old.publishedLeagueRevision)>Number(rules.revision))return;
    const patch={publishedLeagueRevision:rules.revision,publishedLeagueLinks:rules.links};
    if(rules.visibility&&Number(rules.visibilityRevision||0)>Number(old.sharedVisibilityRevision||0))Object.assign(patch,rules.visibility,{sharedVisibilityRevision:rules.visibilityRevision});
    if(Number(old.publishedLeagueRevision)!==Number(rules.revision)||patch.sharedVisibilityRevision)await chrome.storage.local.set(patch);
  }
  async function catalog(){const data=await request('/api/leagues');if(!Number.isInteger(data.revision)||!data.visibility)throw new Error('API связей лиг недоступен или несовместим. Остальные разделы продолжат работать.');await acceptRules(data);return data;}
  async function publish(baseRevision,changes){
    const challenge=await request('/api/league-links/challenge');
    if(!challenge?.nonce)throw new Error('Сервер не выдал разрешение на публикацию');
    const result=await request('/api/league-links/publish',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({nonce:challenge.nonce,baseRevision,changes})});
    await acceptRules(result);return result;
  }
  const el=(tag,cls,text)=>{const e=document.createElement(tag);if(cls)e.className=cls;if(text!==undefined)e.textContent=text;return e;};
  async function publishDialog(catalog,changes){
    const dialog=el('dialog','publish-dialog'),form=el('form'),preview=el('div','publish-preview'),error=el('p','form-error'),actions=el('div','dialog-actions'),cancel=el('button','','Отмена'),confirm=el('button','primary','Опубликовать');cancel.type='button';confirm.type='submit';
    const count=changes.upsert.length+changes.remove.length;form.append(el('h2','','Публикация связей'),el('p','muted','Изменений: '+count+'. Они будут применены на сервере ко всем вкладкам.'),preview,error,actions);actions.append(cancel,confirm);dialog.append(form);document.body.append(dialog);
    for(const g of changes.upsert)preview.append(el('p','',((catalog.links||[]).some(x=>x.id===g.id)?'Изменить: ':'Добавить: ')+(g.name||'Группа')+' · '+LeagueModel.members(g).map(r=>r.source+': '+r.league).join(' ↔ ')));
    for(const id of changes.remove)preview.append(el('p','','Разъединить: '+(catalog.links.find(g=>g.id===id)?.name||id)));
    let busy=false;const promise=new Promise(resolve=>{cancel.onclick=()=>{if(!busy){dialog.close();resolve(null);}};dialog.addEventListener('cancel',e=>{if(busy)e.preventDefault();else resolve(null);});form.onsubmit=async e=>{e.preventDefault();if(busy)return;busy=true;confirm.disabled=cancel.disabled=true;error.textContent='';try{const result=await publish(catalog.revision,changes);dialog.close();resolve({result,applied:changes});}catch(e){error.textContent=e.message;busy=false;confirm.disabled=cancel.disabled=false;}};});dialog.showModal();try{return await promise;}finally{dialog.remove();}
  }
  return {base,request,catalog,acceptRules,publishDialog};
})();
