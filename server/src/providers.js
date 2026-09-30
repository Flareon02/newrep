export const BOOK_SOURCES = Object.freeze(['astek','fonbet','pinnacle','ggbet']);
export const PREMATCH_SOURCES = Object.freeze(['astek','fonbet','pinnacle']);
export const LIVE_SOURCES = BOOK_SOURCES;
export const isBookSource = (value) => BOOK_SOURCES.includes(String(value || ''));
export const providerName = (source) => ({astek:'AstekBet',fonbet:'Fonbet',pinnacle:'Pinnacle',ggbet:'GGBET'})[source] || String(source || '');
