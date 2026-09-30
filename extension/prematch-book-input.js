(()=>{
 const ids=params.get('ids');if(!ids)return;
 const box=document.createElement('div');box.className='prematch-book-input controls';box.innerHTML='<select id="prematchBookSource" aria-label="Источник исходов"><option value="average">Усреднить вероятности</option><option value="astek">AstekBet</option><option value="fonbet">Fonbet</option><option value="pinnacle">Pinnacle</option></select><button type="button" id="prematchBookLoad">Взять исходы контор</button><small id="prematchBookStatus" role="status"></small>';
 $('manualInputs').prepend(box);
 const norm=s=>String(s||'').toLowerCase().replace(/\b(esports|gaming|team)\b/g,'').replace(/[^\p{L}\p{N}]/gu,'');
 $('prematchBookLoad').onclick=async()=>{const button=$('prematchBookLoad'),label=$('prematchBookStatus');button.disabled=true;label.textContent='Загрузка…';
  try{const data=await api('/api/prematch/odds?ids='+encodeURIComponent(ids)),source=$('prematchBookSource').value,groups=new Map();
   for(const ref of data.events||[]){if(source!=='average'&&ref.source!==source||ref.odds?.stale)continue;const odds=ref.odds;if(!odds)continue;const a=norm(odds.team1||ref.team1),b=norm(odds.team2||ref.team2),x=norm(targets[0]),y=norm(targets[1]);let reversed=false;if(a===x&&b===y)reversed=false;else if(a===y&&b===x)reversed=true;else continue;
    const seen=new Set();for(const market of odds.markets||[]){if(market.type!=='moneyline'||market.status&&market.status!=='open')continue;const n=Number(market.period)||0;if(seen.has(n))continue;const home=Number(market.prices.find(p=>p.designation==='home')?.decimal),away=Number(market.prices.find(p=>p.designation==='away')?.decimal);if(!(home>1&&away>1)||market.prices.some(p=>p.designation==='draw'))continue;seen.add(n);const pair=reversed?[away,home]:[home,away],prob=(1/pair[0])/(1/pair[0]+1/pair[1]);if(!groups.has(n))groups.set(n,[]);groups.get(n).push({pair,prob});}
   }
   if(!groups.size)throw Error('Открытые исходы выбранной конторы отсутствуют');
   const prices=rows=>source==='average'?[1/(rows.reduce((n,r)=>n+r.prob,0)/rows.length),1/(1-rows.reduce((n,r)=>n+r.prob,0)/rows.length)]:rows[0].pair;
   for(const n of [0,...Array.from({length:Number($('bestOf').value)},(_,i)=>i+1)]){const rows=groups.get(n),pair=rows?prices(rows).map(v=>v.toFixed(3)):['',''];if(n===0){$('manualOdd1').value=pair[0];$('manualOdd2').value=pair[1];}else{const a=document.querySelector(`[data-map-a="${n-1}"]`),b=document.querySelector(`[data-map-b="${n-1}"]`);if(a)a.value=pair[0];if(b)b.value=pair[1];}}
   markDirty();label.textContent=groups.size+' рынков · '+(source==='average'?'без маржи контор':'исходные цены')+' · '+new Date().toLocaleTimeString('ru-RU');
  }catch(error){label.textContent=error.message;}finally{button.disabled=false;}
 };
})();
