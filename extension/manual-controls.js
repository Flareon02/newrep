'use strict';
function renderManualMaps(){
 const old=[...$('manualMapInputs').querySelectorAll('.manual-map-row')].map(row=>[...row.querySelectorAll('input')].map(x=>x.value));
 $('manualMapInputs').innerHTML=Array.from({length:Number($('bestOf').value)},(_,i)=>`<div class="manual-map-row"><input data-map-name="${i}" placeholder="Карта ${i+1} · название" aria-label="Название карты ${i+1}" value="${esc(old[i]?.[0]||'')}" maxlength="60"><input data-map-a="${i}" inputmode="decimal" placeholder="П1 · карта ${i+1}" aria-label="Победа команды 1 на карте ${i+1}" value="${esc(old[i]?.[1]||'')}"><input data-map-b="${i}" inputmode="decimal" placeholder="П2 · карта ${i+1}" aria-label="Победа команды 2 на карте ${i+1}" value="${esc(old[i]?.[2]||'')}"></div>`).join('');
}
function initManual(){
 const manual=$('manualMode').checked;$('manualInputs').hidden=!manual;$('teamPickers').hidden=manual;$('importHar').hidden=manual;$('mapControls').hidden=manual;
 const hint=$('mapControls').nextElementSibling;if(hint)hint.hidden=manual;const help=document.querySelector('.import-help');if(help)help.hidden=manual;
 if(!$('manualName1').value)$('manualName1').value=targets[0]||'Команда 1';if(!$('manualName2').value)$('manualName2').value=targets[1]||'Команда 2';
 renderManualMaps();renderPicks();
}
function manualValues(){return {names:[$('manualName1').value,$('manualName2').value],odds:[$('manualOdd1').value,$('manualOdd2').value],bestOf:$('bestOf').value,margin:$('margin').value,maxOdds:$('maxOdds').value,maps:[...$('manualMapInputs').querySelectorAll('.manual-map-row')].map(row=>{const fields=[...row.querySelectorAll('input')];return {name:fields[0].value,odds:fields.slice(1).map(x=>x.value)};})};}
async function generateManual(){
 if(running)return;const values=manualValues();
 running=true;$('setup').querySelectorAll('button,select,input').forEach(x=>{if(!['margin','maxOdds'].includes(x.id))x.disabled=true;});$('progressBox').hidden=false;$('progress').value=0;$('progressText').textContent='Отправляем ввод серверу…';status('Расчёт выполняется на сервере…');
 try{
  const job=await api('/api/odds/manual',values);jobId=job.id;const deadline=Date.now()+180000;
  for(;;){if(Date.now()>deadline)throw Error('Сервер не завершил расчёт вовремя. Попробуйте ещё раз.');await new Promise(r=>setTimeout(r,700));const j=await api('/api/odds/job?id='+encodeURIComponent(jobId));$('progress').value=j.progress;$('progressText').textContent='Серверный расчёт · '+j.progress+'%';if(j.status==='error')throw Error(j.error);if(j.status==='done'){showResult(j.result);break;}}
 }catch(e){status(e.message,true);$('setup').open=true;}
 finally{running=false;$('setup').querySelectorAll('button,select,input').forEach(x=>x.disabled=false);$('progressBox').hidden=true;renderPicks();}
}
$('manualMode').onchange=()=>{initManual();markDirty();if(!$('manualMode').checked)boot().catch(e=>status(e.message,true));else status('Введите коэффициенты. HLTV не требуется; расчёт выполнит сервер.');};
$('manualInputs').oninput=markDirty;

boot().catch(e=>status(e.message,true));
