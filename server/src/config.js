import net from "node:net";
import { explicitNetworkMode } from "./egress.js";

const intEnv = (name, fallback, min = 1) => {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value >= min ? Math.floor(value) : fallback;
};

const listEnv = (name, fallback) => String(process.env[name] || fallback)
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean);
const signedIntEnv=(name,fallback)=>{const value=Number(process.env[name]);return Number.isFinite(value)?Math.trunc(value):fallback;};

// ODDS_HISTORY_ENABLED=0 (low-write mode): see oddsHistoryEnabled below.
const oddsHistoryEnabled = !/^(?:0|false|off|no)$/i.test(String(process.env.ODDS_HISTORY_ENABLED || "1").trim());

function bindHost(raw) {
  const value = String(raw || "").trim();
  if (!value) return "0.0.0.0";
  if (value.toLowerCase() === "localhost") return "127.0.0.1";
  return net.isIP(value) ? value : "127.0.0.1";
}

const originList = listEnv("ASTEK_ORIGINS", "https://astekbet.com,https://astekbet-0021.pro")
  .map((value) => value.replace(/\/+$/, ""));

export const config = {
  version: "4.6.0",
  port: intEnv("PORT", 8080),
  // Listen address. Unset: 0.0.0.0 (Docker). 127.0.0.1 / localhost when only a local reverse proxy or tunnel may reach
  // the API. Any other value that is not an IP literal binds 127.0.0.1 (fails closed, never public) and is logged.
  host: bindHost(process.env.HOST),
  dataDir: process.env.DATA_DIR || "/data",
  // Optional shared secret for write/compute endpoints (see src/auth.js). Empty = unauthenticated (legacy behaviour).
  apiToken: String(process.env.API_TOKEN || "").trim(),
  apiSseLimitTotal: intEnv("API_SSE_LIMIT_TOTAL", 64, 4),
  apiMaxConnections: intEnv("API_MAX_CONNECTIONS", 256, 32),
  apiSseMaxBufferBytes: intEnv("API_SSE_MAX_BUFFER_BYTES", 2 * 1024 * 1024, 65536),
  origins: originList.length ? originList : ["https://astekbet.com"],
  origin: originList[0] || "https://astekbet.com",
  ggbetLiveEnabled: !/^(?:0|false|off|no)$/i.test(String(process.env.GGBET_LIVE_ENABLED || "1")),
  // Outbound path of the LIVE odds platform collectors: proxy | relay (GGBET only) | direct. See src/egress.js.
  // GGBET without an explicit mode keeps the 4.5.0 behaviour: relay when a relay URL is configured, otherwise direct.
  ggbetNetworkModeSetting: explicitNetworkMode("ggbet"),
  get ggbetNetworkMode() { return this.ggbetNetworkModeSetting || (this.ggbetBootstrapRelayUrl ? "relay" : "direct"); },
  databetNetworkMode: explicitNetworkMode("databet") || "direct",
  ggbetBootstrapRelayUrl: String(process.env.GGBET_BOOTSTRAP_RELAY_URL || "").trim(),
  ggbetBootstrapRelaySecretFile: String(process.env.GGBET_BOOTSTRAP_RELAY_SECRET_FILE || "/run/secrets/ggbet-relay-secret").trim(),
  ggbetBootstrapRelayCaFile: String(process.env.GGBET_BOOTSTRAP_RELAY_CA_FILE || "/run/secrets/ggbet-relay-ca.pem").trim(),
  ggbetOrigins: listEnv(
    "GGBET_ORIGINS",
    "https://gg.bet,https://gg397.bet,https://gg253.bet,https://gg284.bet,https://ggbets.co,https://ggbet242.com,https://ggbet24.com"
  ).map((value) => value.replace(/\/+$/, "")),
  ggbetRequestTimeoutMs: intEnv("GGBET_REQUEST_TIMEOUT_MS", 12000, 3000),
  ggbetSnapshotIntervalMs: intEnv("GGBET_SNAPSHOT_INTERVAL_MS", 30000, 5000),
  ggbetDegradedSnapshotMs: intEnv("GGBET_DEGRADED_SNAPSHOT_MS", 7000, 3000),
  ggbetSessionRefreshMs: intEnv("GGBET_SESSION_REFRESH_MS", 8 * 60 * 1000, 60 * 1000),
  ggbetBootstrapCacheMs: intEnv("GGBET_BOOTSTRAP_CACHE_MS", 4 * 60 * 1000, 30 * 1000),
  ggbetWatchdogMs: intEnv("GGBET_WATCHDOG_MS", 90000, 30000),
  ggbetMaxBackoffMs: intEnv("GGBET_MAX_BACKOFF_MS", 60000, 5000),
  // DataBet LIVE (public demo.data.bet). The guest token is read from the public SSR page on every
  // session start and kept only in memory; the collector is an ordinary server-side GraphQL-WS client.
  databetLiveEnabled: !/^(?:0|false|off|no)$/i.test(String(process.env.DATABET_LIVE_ENABLED || "1")),
  databetOrigin: (() => { const value = String(process.env.DATABET_ORIGIN || "https://demo.data.bet").trim().replace(/\/+$/, ""); return /^https:\/\/([a-z0-9-]+\.)*data\.bet$/i.test(value) ? value : "https://demo.data.bet"; })(),
  databetLocale: /^[a-z]{2}$/.test(String(process.env.DATABET_LOCALE || "")) ? String(process.env.DATABET_LOCALE) : "en",
  databetRequestTimeoutMs: intEnv("DATABET_REQUEST_TIMEOUT_MS", 12000, 3000),
  databetSnapshotIntervalMs: intEnv("DATABET_SNAPSHOT_INTERVAL_MS", 30000, 5000),
  databetSessionRefreshMs: intEnv("DATABET_SESSION_REFRESH_MS", 10 * 60 * 1000, 60 * 1000),
  databetBootstrapCacheMs: intEnv("DATABET_BOOTSTRAP_CACHE_MS", 4 * 60 * 1000, 30 * 1000),
  databetWatchdogMs: intEnv("DATABET_WATCHDOG_MS", 90000, 30000),
  databetMaxBackoffMs: intEnv("DATABET_MAX_BACKOFF_MS", 60000, 5000),
  // Full market trees are pushed only for events whose odds dialog is open (each detail request
  // extends the window). Every other LIVE event streams fixture + top markets only.
  databetFullMarketsTtlMs: intEnv("DATABET_FULL_MARKETS_TTL_MS", 3 * 60 * 1000, 30 * 1000),
  databetMaxFullEvents: intEnv("DATABET_MAX_FULL_EVENTS", 4, 1),
  databetPublishDebounceMs: intEnv("DATABET_PUBLISH_DEBOUNCE_MS", 400, 1),
  fonbetUrls: listEnv(
    "FONBET_URLS",
    "https://line04w.bk6bba-resources.com/events/listBase?lang=en&scopeMarket=1600,https://line-lb51.bk6bba-resources.com/events/listBase?lang=en&scopeMarket=1600"
  ),
  fonbetDeltaUrls: listEnv(
    "FONBET_DELTA_URLS",
    "https://line-lb54-w.bk6bba-resources.com/ma/events/list?lang=en&scopeMarket=1600,https://line-lb61-w.bk6bba-resources.com/ma/events/list?lang=en&scopeMarket=1600,https://line-vk-w.bk6bba-resources.ru/events/list?lang=en&scopeMarket=1600"
  ),
  liveIntervalMs: intEnv("LIVE_INTERVAL_MS", 5000, 1000),
  astekMaxBackoffMs: intEnv("ASTEK_MAX_BACKOFF_MS", 60000, 5000),
  // Hard safety limits for the shared Astek request gate. The upstream fetches
  // have their own AbortController timeouts; these watchdogs prevent a stuck
  // body/socket from keeping LIVE behind a prematch request for minutes.
  astekGateLiveTimeoutMs: intEnv("ASTEK_GATE_LIVE_TIMEOUT_MS", 9500, 2000),
  astekGatePrematchTimeoutMs: intEnv("ASTEK_GATE_PREMATCH_TIMEOUT_MS", 6500, 2000),
  astekGateDetailTimeoutMs: intEnv("ASTEK_GATE_DETAIL_TIMEOUT_MS", 7500, 2000),
  astekGateResultsTimeoutMs: intEnv("ASTEK_GATE_RESULTS_TIMEOUT_MS", 12000, 3000),
  fonbetLiveIntervalMs: intEnv("FONBET_LIVE_INTERVAL_MS", 15000, 5000),
  fonbetDeltaIntervalMs: intEnv("FONBET_DELTA_INTERVAL_MS", 5000, 1000),
  fonbetFullFallbackIntervalMs: intEnv("FONBET_FULL_FALLBACK_INTERVAL_MS", 15000, 5000),
  fonbetFullResyncMs: intEnv("FONBET_FULL_RESYNC_MS", 900000, 60000),
  fonbetMaxBackoffMs: intEnv("FONBET_MAX_BACKOFF_MS", 60000, 5000),
  fonbetPrematchIntervalMs: intEnv("FONBET_PREMATCH_INTERVAL_MS", 60000, 5000),
  prematchCatalogIntervalMs: intEnv("PREMATCH_CATALOG_INTERVAL_MS", 60000, 10000),
  prematchStaleChampMs: intEnv("PREMATCH_STALE_CHAMP_MS", 600000, 60000),
  prematchConcurrency: intEnv("PREMATCH_CONCURRENCY", 2, 1),
  liveRequestTimeoutMs: intEnv("LIVE_REQUEST_TIMEOUT_MS", 8000, 1000),
  prematchFormatTimeoutMs: intEnv("PREMATCH_FORMAT_TIMEOUT_MS", 8000, 1000),
  requestTimeoutMs: intEnv("REQUEST_TIMEOUT_MS", 20000, 1000),
  upstreamMaxBytes: intEnv("UPSTREAM_MAX_BYTES", 32 * 1024 * 1024, 1024 * 1024),
  apiRateLimitPerMinute: intEnv("API_RATE_LIMIT_PER_MINUTE", 900, 60),
  apiPostRateLimitPerMinute: intEnv("API_POST_RATE_LIMIT_PER_MINUTE", 180, 10),
  apiSseLimitPerIp: intEnv("API_SSE_LIMIT_PER_IP", 24, 2),
  prematchBulkRetryMs: intEnv("PREMATCH_BULK_RETRY_MS", 600000, 60000),
  prematchBulkCount: intEnv("PREMATCH_BULK_COUNT", 50, 20),
  // ODDS_HISTORY_ENABLED=0: no odds journal (odds_entries_v3/odds_state) and no current-snapshot rows with market
  // trees (snapshot_current) are written, and LIVE is not restored from SQLite at startup. Current odds live in RAM.
  oddsHistoryEnabled,
  // A History row whose only change is lastSeenAt (the fixture is simply still listed) is rewritten at most this often;
  // new, changed and removed rows are saved as before, and a clean shutdown saves every current row. 0 = every save
  // (default); 15 min by default when odds history is disabled.
  historyTouchPersistMs: intEnv("HISTORY_TOUCH_PERSIST_MS", oddsHistoryEnabled ? 0 : 15 * 60 * 1000, 0),
  // 0 = keep forever (default). See src/retention.js.
  oddsRetentionDays: intEnv("ODDS_RETENTION_DAYS", 0, 0),
  scoreRetentionDays: intEnv("SCORE_RETENTION_DAYS", 0, 0),
  statisticsRetentionDays: intEnv("STATISTICS_RETENTION_DAYS", 0, 0),
  diskWarnFreeMiB: intEnv("DISK_WARN_FREE_MIB", 1024, 64),
  diskCriticalFreeMiB: intEnv("DISK_CRITICAL_FREE_MIB", 512, 32),
  // History older than this many days stays in SQLite and is read on demand; only the recent "hot" window is resident
  // in RAM. 0 = keep the whole History in memory (the 4.3.x behaviour).
  historyHotDays: intEnv("HISTORY_HOT_DAYS", 7, 0),
  historyTtlMs: intEnv("HISTORY_TTL_MS", 365 * 24 * 60 * 60 * 1000, 60 * 60 * 1000),
  historyMax: intEnv("HISTORY_MAX", 100000, 100),
  defaultPrematchChampId: process.env.PREMATCH_SEED_CHAMP || "2900972",
  resultsCacheMs: intEnv("RESULTS_CACHE_MS", 300000, 10000),
  resultsConcurrency: intEnv("RESULTS_CONCURRENCY", 1, 1),
  resultsDayConcurrency: intEnv("RESULTS_DAY_CONCURRENCY", 1, 1),
  resultsWarmupDelayMs: intEnv("RESULTS_WARMUP_DELAY_MS", 120000, 0),
  resultsMinRequestGapMs: intEnv("RESULTS_MIN_REQUEST_GAP_MS", 1000, 250),
  resultsCurrentCacheMs: intEnv("RESULTS_CURRENT_CACHE_MS", 300000, 10000),
  resultsPastCacheMs: intEnv("RESULTS_PAST_CACHE_MS", 86400100, 60000),
  resultsWarmDays: intEnv("RESULTS_WARM_DAYS", 30, 1),
  // Result archives are durable JSON files. Keep only a small working set in
  // RAM; the 30-day warmup must not turn into a 30-day in-memory archive.
  resultsDayMemoryCache: intEnv("RESULTS_DAY_MEMORY_CACHE", 6, 2),
  resultsRawMemoryCache: intEnv("RESULTS_RAW_MEMORY_CACHE", 12, 2),
  resultsViewMemoryCache: intEnv("RESULTS_VIEW_MEMORY_CACHE", 12, 2),
  resultsWarmIntervalMs: intEnv("RESULTS_WARM_INTERVAL_MS", 10000, 1000),
  lowPriorityIdleWaitMs: intEnv("LOW_PRIORITY_IDLE_WAIT_MS", 4000, 500),
  historyPageCacheMs: intEnv("HISTORY_PAGE_CACHE_MS", 15000, 1000),
  resultsTimezoneOffsetMinutes: signedIntEnv("RESULTS_TIMEZONE_OFFSET_MINUTES", 240),
  fonbetResultsUrls: listEnv(
    "FONBET_RESULTS_URLS",
    "https://clientsapi-lb61-w.bk6bba-resources.com/results/v2/getByDate?lang=en&packetVersion=0&scopeMarket=1600"
  )
};

export const urls = {
  prematchCatalog:origin=>`${origin}/service-api/LineFeed/GetChampsZip?sport=40&lng=en_GB&tf=2200000&tz=4&country=15&partner=75&virtualSports=true&gr=34`,
  prematchGames:(origin,ids,count=50)=>`${origin}/service-api/LineFeed/Get1x2_VZip?sports=40&champs=${ids.join(',')}&count=${count}&lng=en_GB&tf=2200000&tz=4&mode=4&country=15&partner=75&getEmpty=true&gr=34`,
  // HAR-confirmed aggregate line endpoint. We probe the observed 50-row window
  // and fall back only for leagues that are missing/incomplete.
  prematchBulk:(origin,count=50)=>`${origin}/service-api/LineFeed/Get1x2_VZip?sports=40&count=${count}&lng=en_GB&tf=2200000&tz=4&mode=4&country=15&partner=75&getEmpty=true&gr=34`,
  live: (origin) => `${origin}/service-api/LiveFeed/Get1x2_VZip?sports=40&count=1000&gr=34&mode=4&country=15&partner=75&getEmpty=true&noFilterBlockEvent=true`,
  resultsChamps: (origin, dateFrom, dateTo, variant='plural') => {
    const url=new URL(`${origin}/service-api/result/web/api/v2/champs`);
    const params={sportIds:40,presenceOfVideoBroadcast:false,country:15,gr:34,lng:'en',ref:75,dateFrom:Math.floor(dateFrom/1000),dateTo:Math.floor(dateTo/1000)};
    if(variant==='both')params.sportId=40;
    for(const [key,value] of Object.entries(params).sort())url.searchParams.set(key,String(value));
    return url.href;
  },
  results: (origin, champId, dateFrom, dateTo, variant='both') => {
    const url = new URL(`${origin}/service-api/result/web/api/v3/games`);
    if(variant==='both')url.searchParams.set("champId", String(champId));
    url.searchParams.set("champIds", String(champId));
    url.searchParams.set("country", "15");
    url.searchParams.set("dateFrom", String(Math.floor(Number(dateFrom) / 1000)));
    url.searchParams.set("dateTo", String(Math.floor(Number(dateTo) / 1000)));
    url.searchParams.set("gr", "34");
    url.searchParams.set("lng", "en");
    url.searchParams.set("ref", "75");
    return url.href;
  },
  fonbetResults: (baseUrl, lineDate) => {
    const url = new URL(baseUrl);
    url.searchParams.set("lang", "en");
    url.searchParams.set("packetVersion", "0");
    url.searchParams.set("scopeMarket", "1600");
    url.searchParams.set("lineDate", String(lineDate));
    return url.href;
  }
};
