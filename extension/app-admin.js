'use strict';
/* Settings → Пользователи (admin.users): per-user capabilities. The server stores and enforces them (/api/admin/users);
   a new user starts with everything off. Changes apply to that user's next request - no reinstall. */
const adminState={users:null,registry:null,at:0,selected:'',draft:null,selection:new Set(),token:'',tokenFor:'',error:'',busy:false};

async function adminLoad(force=false){
 if(!force&&adminState.users&&Date.now()-adminState.at<30000)return;
 const [u,c]=await Promise.all([client.get('/api/admin/users'),adminState.registry?Promise.resolve(adminState.registry):client.get('/api/admin/capabilities')]);
 adminState.users=u.users||[];adminState.registry=c;adminState.at=Date.now();
 if(adminState.selected&&!adminState.users.some(x=>x.id===adminState.selected))adminState.selected='';
}
const adminUser=()=>adminState.users?.find(u=>u.id===adminState.selected)||null;
function adminSelect(id){adminState.selected=id;const u=adminUser();adminState.draft=new Set(u?.capabilities||[]);adminState.selection=new Set();adminState.error='';}
const adminDirty=()=>{const u=adminUser();if(!u||!adminState.draft)return false;return [...adminState.draft].sort().join()!==[...u.capabilities].sort().join();};

async function settingsUsers(body){
 const draw=()=>{if(settingsState.section!=='users')return;body.innerHTML=adminMarkup();adminBind(body,draw);};
 draw();
 try{await adminLoad();adminState.error='';}catch(error){adminState.error=errorText(error);}
 draw();
}
function adminMarkup(){
 const users=adminState.users,u=adminUser(),reg=adminState.registry;
 const list=!users?'<div class="skeleton" style="height:120px"></div>':users.length?`<div class="admin-users" role="listbox" aria-label="Пользователи">${users.map(x=>`<button type="button" role="option" class="admin-user" data-admin-user="${esc(x.id)}" aria-selected="${x.id===adminState.selected}"><b>${esc(x.name)}</b><small>${x.role==='admin'?'администратор':`${x.capabilities.length} прав`}${x.disabled?' · отключён':''}</small></button>`).join('')}</div>`:'<p class="muted">Пользователей пока нет.</p>';
 const token=adminState.token?`<div class="admin-token" role="status"><b>Ключ доступа${adminState.tokenFor?' · '+esc(adminState.tokenFor):''}</b><code id="adminToken">${esc(adminState.token)}</code><button type="button" class="btn" data-admin="copy-token">Копировать</button><small>Показывается один раз. Передайте его пользователю: он вставит ключ в «Настройки → Подключение».</small></div>`:'';
 let editor='<p class="muted">Выберите пользователя слева.</p>';
 if(u&&reg){
  const groups=Object.entries(reg.groups||{}),isAdmin=u.role==='admin';
  const caps=groups.map(([g,label])=>{const items=(reg.capabilities||[]).filter(c=>c.group===g);if(!items.length)return '';const all=items.every(c=>adminState.selection.has(c.key));
   return `<section class="admin-group"><label class="admin-group-head"><input type="checkbox" data-admin-group="${esc(g)}" ${all?'checked':''} ${isAdmin?'disabled':''}><b>${esc(label)}</b></label>${items.map(c=>{const on=isAdmin||adminState.draft.has(c.key);return `<label class="admin-cap"><input type="checkbox" data-admin-pick="${esc(c.key)}" ${adminState.selection.has(c.key)?'checked':''} ${isAdmin?'disabled':''}><span>${esc(c.label)}</span><code>${esc(c.key)}</code><span class="pill ${on?'on':'off'}">${on?'вкл':'выкл'}</span></label>`;}).join('')}</section>`;}).join('');
  editor=`<div class="admin-head"><label class="field"><span>Имя</span><input id="adminName" class="input" value="${esc(u.name)}" maxlength="80"></label><label class="field"><span>Роль</span><select id="adminRole" class="select"><option value="user">Пользователь</option><option value="admin">Администратор</option></select></label><label class="check"><input type="checkbox" id="adminDisabled" ${u.disabled?'checked':''}> Отключён</label></div>
   ${isAdmin?'<p class="muted">У администратора все права; список ниже не применяется.</p>':`<p class="muted">Отметьте права и нажмите «Включить выбранные» или «Выключить выбранные». Новый пользователь начинает со всеми правами выключенными.</p>`}
   <div class="admin-caps">${caps}</div>
   <div class="row-actions admin-actions"><button type="button" class="btn" data-admin="enable" ${isAdmin?'disabled':''}>Включить выбранные</button><button type="button" class="btn" data-admin="disable" ${isAdmin?'disabled':''}>Выключить выбранные</button><button type="button" class="btn" data-admin="disable-all" ${isAdmin?'disabled':''}>Выключить все</button><span class="spacer"></span><button type="button" class="btn primary" data-admin="save" ${adminState.busy?'disabled':''}>Сохранить${adminDirty()?' ·  есть изменения':''}</button></div>
   <div class="row-actions"><button type="button" class="btn ghost" data-admin="rotate">Новый ключ</button><button type="button" class="btn ghost danger" data-admin="delete">Удалить пользователя</button></div>`;
 }
 return `<h2>Пользователи</h2><p class="lead">Кто что видит: разделы, конторы, данные и инструменты. Права проверяет сервер — выключенное недоступно и через API.</p>
  ${adminState.error?`<div class="banner bad" role="alert">${esc(adminState.error)}</div>`:''}${token}
  <div class="admin-layout"><section class="setting-card"><h3>Пользователи</h3>${list}<form id="adminCreate" class="admin-create"><input id="adminNewName" class="input" placeholder="Имя нового пользователя" maxlength="80" required><button class="btn" type="submit">Создать</button></form></section>
  <section class="setting-card admin-editor">${editor}</section></div>`;
}
function adminBind(body,draw){
 const u=adminUser();if(u&&$('adminRole'))$('adminRole').value=u.role;
 body.querySelectorAll('[data-admin-user]').forEach(b=>b.onclick=()=>{if(adminDirty()&&!confirmLeave())return;adminSelect(b.dataset.adminUser);draw();});
 body.querySelectorAll('[data-admin-pick]').forEach(c=>c.onchange=()=>{if(c.checked)adminState.selection.add(c.dataset.adminPick);else adminState.selection.delete(c.dataset.adminPick);draw();});
 body.querySelectorAll('[data-admin-group]').forEach(c=>c.onchange=()=>{const keys=(adminState.registry?.capabilities||[]).filter(x=>x.group===c.dataset.adminGroup).map(x=>x.key);for(const k of keys)if(c.checked)adminState.selection.add(k);else adminState.selection.delete(k);draw();});
 $('adminCreate')?.addEventListener('submit',async e=>{e.preventDefault();const name=$('adminNewName').value.trim();if(!name)return;try{const r=await client.post('/api/admin/users',{name});adminState.token=r.token;adminState.tokenFor=r.user.name;await adminLoad(true);adminSelect(r.user.id);}catch(error){adminState.error=errorText(error);}draw();});
 body.querySelectorAll('[data-admin]').forEach(b=>b.onclick=async()=>{
  const action=b.dataset.admin,user=adminUser();
  if(action==='copy-token'){try{await navigator.clipboard.writeText(adminState.token);toast('Ключ скопирован');}catch(error){report(error);}return;}
  if(!user)return;
  if(action==='enable'){for(const k of adminState.selection)adminState.draft.add(k);draw();return;}
  if(action==='disable'){for(const k of adminState.selection)adminState.draft.delete(k);draw();return;}
  if(action==='disable-all'){adminState.draft=new Set();draw();return;}
  adminState.busy=true;draw();
  try{
   if(action==='save'){await client.post('/api/admin/users/'+encodeURIComponent(user.id),{name:$('adminName').value,role:$('adminRole').value,disabled:$('adminDisabled').checked,capabilities:[...adminState.draft]});await adminLoad(true);adminSelect(user.id);toast('Права сохранены');loadEntitlements();}
   if(action==='rotate'){const r=await client.post('/api/admin/users/'+encodeURIComponent(user.id)+'/token',{});adminState.token=r.token;adminState.tokenFor=user.name;toast('Новый ключ создан; старый больше не действует');}
   if(action==='delete'){if(!adminState.confirmDelete||adminState.confirmDelete!==user.id){adminState.confirmDelete=user.id;toast('Нажмите «Удалить пользователя» ещё раз для подтверждения');}else{await client.post('/api/admin/users/'+encodeURIComponent(user.id)+'/delete',{});adminState.confirmDelete='';adminState.selected='';await adminLoad(true);toast('Пользователь удалён');}}
   adminState.error='';
  }catch(error){adminState.error=errorText(error);}
  finally{adminState.busy=false;draw();}
 });
}
// Leaving unsaved capability changes needs a second click (the viewer cannot show confirm dialogs).
function confirmLeave(){if(adminState.leaveArmed===adminState.selected){adminState.leaveArmed='';return true;}adminState.leaveArmed=adminState.selected;toast('Есть несохранённые изменения. Нажмите ещё раз, чтобы перейти без сохранения.');return false;}
