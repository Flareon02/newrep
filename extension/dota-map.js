/* Dota lane state: T1, T2, T3, melee barracks, ranged barracks;
 * t4 has the two base towers. Coordinates follow the reference lane diagram. */
(function(root){
 const layout={
  radiant:{top:[[120,190],[120,310],[120,450],[96,486],[144,486]],mid:[[340,380],[280,440],[230,490],[192,490],[230,530]],bot:[[530,600],[410,600],[265,600],[230,576],[230,624]],t4:[[120,570],[150,600]]},
  dire:{top:[[235,70],[355,70],[505,70],[542,46],[542,94]],mid:[[430,290],[490,230],[540,180],[540,142],[578,180]],bot:[[650,480],[650,360],[650,216],[626,180],[674,180]],t4:[[620,70],[650,100]]}
 };
 function model(value){return Object.entries(layout).flatMap(([side,lanes])=>Object.entries(lanes).flatMap(([lane,points])=>{
  const raw=value?.[side]?.[lane],bits=typeof raw==='string'&&/^[01]+$/.test(raw)?raw:'';
  return points.map(([x,y],index)=>({side,lane,index,x,y,kind:lane!=='t4'&&index>=3?'barracks':'tower',state:index<bits.length?(bits[index]==='1'?'intact':'destroyed'):'unknown'}));
 }));}
 function render(value){if(!value)return '<div class="hawk-empty-visual">Нет данных о постройках</div>';
  return '<div class="hawk-map-card"><svg class="hawk-minimap" viewBox="60 10 675 655" role="img" aria-label="Постройки Dota 2. Radiant снизу слева, Dire сверху справа"><path class="map-lane" d="M120 450V70H505 M265 600H650V216 M230 490 540 180"/>'+model(value).map(p=>`<g class="map-structure ${p.side} ${p.state}" data-side="${p.side}" data-lane="${p.lane}" data-index="${p.index}" transform="translate(${p.x} ${p.y})">${p.kind==='tower'?'<circle r="14"/>':'<rect x="-14" y="-14" width="28" height="28"/>'}</g>`).join('')+'</svg></div>';
 }
 const api={layout,model,render};if(typeof module==='object'&&module.exports)module.exports=api;else root.DotaMap=api;
})(globalThis);
