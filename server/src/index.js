import {startSqliteHistory} from './match-history.js';
import { log } from "./logger.js";
import path from "node:path";
import fs from "node:fs";
import {stopMatcher} from './matcher-client.js';
import { config } from "./config.js";
import { createApi } from "./api.js";
import { FonbetCollector } from "./fonbet.js";
import { LiveCollector } from "./live.js";
import { GgbetLiveCollector } from "./ggbet.js";
import { DatabetLiveCollector } from "./databet.js";
import { PrematchCollector } from "./prematch.js";
import { SnapshotState } from "./state.js";
import { ResultsService } from "./results.js";
import { ensureDataDir, flushJsonWrites, astekRequestStatus } from "./utils.js";
import {checkpointSqliteStorage,closeSqliteStorage,storageMetrics} from "./sqlite-storage.js";

import { loadMatcherAliases, flushMatcherAliases } from "./entity-resolver.js";
import {teamLogos} from './team-logos.js';
import {GgbetSupervisor} from './ggbet-supervisor.js';
import { BrowserGgbetSource } from './ggbet-browser-source.js';
import { startCollectorForensics } from './collector-forensic-runtime.js';

import {PinnacleCollector} from './pinnacle.js';
import {HltvService} from './hltv-service.js';
import {OddsService} from './odds-service.js';
import {CrossbetService} from './crossbet.js';
import {startRetention} from './retention.js';
import {checkProxyEgress,proxyDiagnostics} from './egress.js';
const pinnacleLiveState=new SnapshotState('pinnacle-live',60000);
const pinnaclePrematchState=new SnapshotState('pinnacle-prematch',300000);
const startedAt = Date.now();
await ensureDataDir();
log.info(`[storage] ${JSON.stringify(storageMetrics({checkIntegrity:false}))}`);
const eventHistory=startSqliteHistory({enabled:config.sqliteHistoryEnabled,dataDir:config.dataDir,retentionDays:Math.max(config.oddsRetentionDays,config.scoreRetentionDays)||7,minFreeMiB:config.historyMinFreeMiB});
await loadMatcherAliases();

const liveState = new SnapshotState("live", Math.max(config.liveIntervalMs * 4, 60000));
const prematchState = new SnapshotState("prematch", Math.max(config.prematchCatalogIntervalMs * 5, 300000));
const fonbetLiveState = new SnapshotState("fonbet-live", Math.max(config.fonbetLiveIntervalMs * 4, 60000));
const fonbetPrematchState = new SnapshotState("fonbet-prematch", Math.max(config.fonbetPrematchIntervalMs * 4, 300000));
const ggbetLiveState = new SnapshotState("ggbet-live", Math.max(config.ggbetSnapshotIntervalMs * 4, 120000));
// DataBet is a second, independent LIVE odds provider; the extension shows either GGBET or DataBet, never both.
const databetLiveState = new SnapshotState("databet-live", Math.max(config.databetSnapshotIntervalMs * 4, 120000));
// Load persistent generations sequentially. On a 1 GB VPS, parsing all large
// history JSON files in parallel briefly duplicates hundreds of MiB and can
// hit the cgroup limit before the API even starts.
for (const state of [liveState,prematchState,fonbetLiveState,fonbetPrematchState,ggbetLiveState,databetLiveState,pinnaclePrematchState,pinnacleLiveState]) await state.load();

const liveCollector = new LiveCollector(liveState);
const prematchCollector = new PrematchCollector(prematchState);
const pinnacleCollector=new PinnacleCollector(pinnaclePrematchState,{liveState:pinnacleLiveState});
const fonbetCollector = new FonbetCollector(fonbetLiveState, fonbetPrematchState);
// GGBET forensics/session supervisor (observe-only; see ggbet-supervisor.js). Its state lives in DATA_DIR/ggbet-forensics.
const ggbetSupervisor = config.ggbetForensicsEnabled ? new GgbetSupervisor({ dir: path.join(config.dataDir, 'ggbet-forensics'), mode: config.ggbetNetworkMode, statusFile: config.ggbetEgressStatusFile, version: config.version, release: (() => { try { return path.basename(fs.realpathSync(path.resolve(process.cwd(), '..'))); } catch { return ''; } })(), raw: config.ggbetForensicsRaw, maxBytes: config.ggbetForensicsMaxMiB * 1048576, minFreeMiB: config.ggbetForensicsMinFreeMiB }) : null;
const ggbetBrowser = config.ggbetBrowserSource ? new BrowserGgbetSource({ socketPath: config.ggbetBrowserSocket, pollMs: config.ggbetBrowserPollMs, ipcStaleMs: config.ggbetBrowserIpcStaleMs, stateFile: path.join(config.dataDir, 'ggbet-browser-arbiter.json'), log }) : null;
const ggbetCollector = new GgbetLiveCollector(ggbetLiveState, { observer: ggbetSupervisor, browser: ggbetBrowser });
ggbetSupervisor?.attach(ggbetCollector);
const databetCollector = new DatabetLiveCollector(databetLiveState);
const collectorForensics = startCollectorForensics({ config, liveState, prematchState, fonbetLiveState, fonbetPrematchState, pinnacleLiveState, pinnaclePrematchState, fonbetCollector, ggbetCollector, ggbetBrowser });
// GGBET is LIVE-only until its ENDED/final-result transport is verified against production.
const resultsService = new ResultsService(liveState, fonbetLiveState, prematchState, fonbetPrematchState);
resultsService.setPriorityProbe(()=>{const gate=astekRequestStatus();return !!(liveCollector.running||prematchCollector.running||fonbetCollector.running||['live','prematch','detail'].includes(gate.activeKind));});
await resultsService.load();
await prematchCollector.load();

const hltvService=new HltvService();
const oddsService=new OddsService(hltvService);
const crossbetService=new CrossbetService();
const server = createApi({ ggbetSupervisor, liveCollector,crossbetService,hltvService,oddsService,pinnacleLiveState,pinnaclePrematchState,pinnacleCollector,ggbetLiveState,ggbetCollector,databetLiveState,databetCollector,liveState, prematchState, fonbetLiveState, fonbetPrematchState, prematchCollector, fonbetCollector, resultsService, startedAt });
if(String(process.env.HOST||'').trim()&&!/^localhost$/i.test(String(process.env.HOST).trim())&&String(process.env.HOST).trim()!==config.host)log.warn(`[api] HOST is not an IP address; listening on ${config.host} instead`);
server.listen(config.port, config.host, () => {
  log.info(`[api] listening on ${config.host.includes(":")?`[${config.host}]`:config.host}:${config.port}`);
  log.info(`[api] AstekBet upstream ${config.origins.join(", ")}`);
  log.info(`[api] Fonbet upstream ${config.fonbetUrls.join(", ")}`);
  const proxy=proxyDiagnostics(),via=mode=>mode==='proxy'?`proxy ${proxy.proxyHost}:${proxy.proxyPort}`:mode;
  log.info(`[api] GGBET LIVE network ${via(config.ggbetNetworkMode)}: ${config.ggbetNetworkMode==='relay'?`bootstrap relay ${config.ggbetBootstrapRelayUrl}`:`bootstrap ${config.ggbetOrigins.join(", ")} (trusted only) + WebSocket`}`);
  log.info(`[api] DataBet LIVE ${config.databetLiveEnabled?`network ${via(config.databetNetworkMode)}: bootstrap ${config.databetOrigin}/${config.databetLocale}/esports/live + WebSocket`:"disabled (DATABET_LIVE_ENABLED=0)"}`);
  log.info(`[storage] odds history ${config.oddsHistoryEnabled?'enabled':'disabled (ODDS_HISTORY_ENABLED=0): no odds journal, no current-snapshot rows, LIVE starts empty'}`);
  if([config.ggbetNetworkMode,config.databetNetworkMode].includes('proxy'))startEgressCheck();
  liveCollector.start();
  prematchCollector.start();
  fonbetCollector.start();ggbetSupervisor?.start();ggbetBrowser?.start();ggbetCollector.start();databetCollector.start();pinnacleCollector.start();
  resultsService.start();
  retention=startRetention({statistics:server.statistics,activeKeys:server.activeEventKeys,settings:config.sqliteHistoryEnabled?{...config,oddsRetentionDays:0,scoreRetentionDays:0}:config});
});

// Diagnostics only: which public IP/country/ASN the proxy presents (never the credentials). Collectors do not depend on it.
let egressTimer=null;
function startEgressCheck(){
  const run=()=>checkProxyEgress().then(e=>log.info(`[egress] proxy egress ${e.error?`check failed: ${e.error}`:`${e.ip} ${e.country} ${e.asn} ${e.org}`}`)).catch(()=>{});
  run();egressTimer=setInterval(run,30*60*1000);egressTimer.unref?.();
}
let shuttingDown=false,retention=null;
async function shutdown(exitCode=0,reason='signal',{persist=true}={}) {
  if(shuttingDown)return;shuttingDown=true;
  log.info(`[api] shutting down (${reason}${persist?'':' / no-persist'})`);clearInterval(egressTimer);
  const deadline=setTimeout(() => process.exit(exitCode||1), persist?30000:5000);deadline.unref();
  const closed=new Promise(resolve=>server.close(()=>resolve()));
  await Promise.allSettled([liveCollector.stop(),prematchCollector.stop(),fonbetCollector.stop(),ggbetCollector.stop(),databetCollector.stop(),resultsService.stop(),pinnacleCollector.stop()]);
  try{ggbetSupervisor?.stop();}catch{}
  try{ggbetBrowser?.stop();}catch{}
  await eventHistory?.stop();
  await collectorForensics?.stop();
  await retention?.stop();
  await Promise.allSettled([server.stopStatistics(),oddsService.stop()]);
  if(persist){
    await Promise.allSettled([liveState.save(),prematchState.save(),fonbetLiveState.save(),fonbetPrematchState.save(),ggbetLiveState.save(),databetLiveState.save(),pinnaclePrematchState.save(),pinnacleLiveState.save(),flushMatcherAliases(),teamLogos.flush()]);
    await flushJsonWrites();
    checkpointSqliteStorage();
  }
  try{crossbetService.stop();}catch{}
  await Promise.allSettled([stopMatcher()]);
  await Promise.race([closed,new Promise(r=>setTimeout(r,persist?2000:750))]);
  clearTimeout(deadline);
  closeSqliteStorage();
  process.exit(exitCode);
}
process.on("SIGTERM",()=>shutdown(0,'SIGTERM',{persist:true}));
process.on("SIGINT",()=>shutdown(0,'SIGINT',{persist:true}));
// Unknown fatal exceptions are deliberately NOT persisted. Known collectors
// isolate malformed upstream packets locally; if something escapes those
// boundaries, Docker restarts the process from the last durable generation
// instead of saving potentially inconsistent in-memory state over good data.
process.on('uncaughtException',error=>{log.error('[fatal] uncaughtException',error?.stack||error);shutdown(1,'uncaughtException',{persist:false}).catch(()=>process.exit(1));});
process.on('unhandledRejection',reason=>{log.error('[fatal] unhandledRejection',reason?.stack||reason);shutdown(1,'unhandledRejection',{persist:false}).catch(()=>process.exit(1));});
server.on('error',error=>{log.error('[api] server error',error?.stack||error);if(error?.code==='EADDRINUSE'||error?.code==='EACCES')shutdown(1,'server error',{persist:false}).catch(()=>process.exit(1));});
