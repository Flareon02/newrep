export const BOOK_SOURCES = Object.freeze(['astek','fonbet','pinnacle','ggbet','databet']);
// GGBET and DataBet are alternative LIVE odds providers: a view shows one of them, never both.
export const LIVE_ODDS_PROVIDERS = Object.freeze(['ggbet','databet']);
export const PREMATCH_SOURCES = Object.freeze(['astek','fonbet','pinnacle']);
export const LIVE_SOURCES = BOOK_SOURCES;
export const isBookSource = (value) => BOOK_SOURCES.includes(String(value || ''));
export const providerName = (source) => ({astek:'AstekBet',fonbet:'Fonbet',pinnacle:'Pinnacle',ggbet:'GGBET',databet:'DataBet'})[source] || String(source || '');
