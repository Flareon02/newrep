const AstekMarketNames=(()=>{
  // The server is the primary source of market captions. Client-side aliases
  // exist only to repair old cached/server rows that used generic sports names
  // for Dota 2 Astek ids. Never overwrite a meaningful current caption.
  const officialRaw=new Map([
    [2436,'Тотал по картам'],
    [2438,'Фора по картам'],
    [2683,'Фраги, фора'],
    [2685,'Фраги, тотал'],
    [2687,'Фраги, тотал чет/нечет'],
    [2850,'Карта/Матч'],
    [6993,'Команда 1 выиграет хотя бы одну карту'],
    [6995,'Команда 2 выиграет хотя бы одну карту'],
    [11211,'Вторая карта/Матч']
  ]);
  const dotaByGs=new Map([
    [1,'Победитель'],
    [33,'Точный счёт'],
    [752,'Тотал по картам'],
    [753,'Фора по картам'],
    [890,'Фраги, тотал чет/нечет'],
    [4856,'Победитель и чётность фрагов'],
    [4927,'Героев в живых при разрушении трона'],
    [5476,'Последняя цифра общего числа фрагов']
  ]);
  const wrongDotaTitles=new Map([
    ['team 1 to score their goal in time interval','Точный счёт'],
    ['total knockdowns in bout','Тотал по картам'],
    ['to knock down opponent','Фора по картам'],
    ['iran, top goalscorer in the tournament','Фраги, тотал чет/нечет'],
    ['количество нокдаунов в бое','Тотал по картам'],
    ['отправит соперника в нокдаун','Фора по картам'],
    ['лучшая команда азии','Фраги, фора'],
    ['лучшая команда африки','Фраги, тотал']
  ]);
  const clean=s=>String(s||'').trim().replace(/\s+/g,' ');
  const number=v=>{const n=Number(v);return Number.isInteger(n)&&n>0?n:null;};
  function groupId(m){
    const candidates=[m?.semanticGroup,m?.GS,m?.gs,m?.groupShortId,m?.shortGroupId,m?.marketGroupShortId,m?.group?.GS,m?.group?.gs,m?.raw?.GS,m?.raw?.gs,m?.raw?.groupShortId,m?.meta?.GS,m?.meta?.gs];
    for(const value of candidates){const n=number(value);if(n)return n;}
    const raw=String(m?.key||m?.marketKey||m?.id||'');
    const match=raw.match(/(?:^|[:/_-])gs[:=_-]?(\d+)(?:$|[:/_-])/i)||raw.match(/\bGS\s*[:=]\s*(\d+)\b/i);
    return match?number(match[1]):null;
  }
  function rawGroupId(m){
    const candidates=[m?.rawGroup,m?.G,m?.g,m?.groupId,m?.group?.G,m?.raw?.G,m?.meta?.G];
    for(const value of candidates){const n=number(value);if(n)return n;}
    return null;
  }
  function isDota(event){return /(?:^|\b)dota\s*2?(?:\b|$)/i.test(String(event?.category||event?.sport||event?.game||event?.league||''));}
  function technical(title){return !title||/^(?:рынок|market|исход|outcome)\s*\d+$/i.test(title);}
  function title(m,event,source='astek'){
    const original=clean(m?.title||m?.name||'');
    if(source!=='astek'||!isDota(event))return original;
    const repaired=wrongDotaTitles.get(original.toLowerCase());
    if(repaired)return repaired;
    // A current server caption is authoritative; this prevents the extension
    // from replacing "Тотал по картам" with an older local alias.
    if(!technical(original))return original;
    const raw=rawGroupId(m),byRaw=raw&&officialRaw.get(raw);if(byRaw)return byRaw;
    const gs=groupId(m),byGs=gs&&dotaByGs.get(gs);if(byGs)return byGs;
    return original;
  }
  return {title,groupId,rawGroupId};
})();
