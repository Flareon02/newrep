import {stopMatcher} from './matcher-client.js';
import { config } from "./config.js";
import { createApi } from "./api.js";
import { FonbetCollector } from "./fonbet.js";
import { LiveCollector } from "./live.js";
import { GgbetLiveCollector } from "./ggbet.js";
import { PrematchCollector } from "./prematch.js";
import { SnapshotState } from "./state.js";
import { ResultsService } from "./results.js";
import { ensureDataDir, flushJsonWrites, astekRequestStatus } from "./utils.js";
import {checkpointSqliteStorage,closeSqliteStorage,storageMetrics} from "./sqlite-storage.js";

import { loadMatcherAliases, flushMatcherAliases } from "./entity-resolver.js";

import {PinnacleCollector} from './pinnacle.js';
import {HltvService} from './hltv-service.js';
import {OddsService} from './odds-service.js';
import {CrossbetService} from './crossbet.js';
const pinnacleLiveState=new SnapshotState('pinnacle-live',60000);
const pinnaclePrematchState=new SnapshotState('pinnacle-prematch',300000);
const startedAt = Date.now();
await ensureDataDir();
console.log(`[storage] ${JSON.stringify(storageMetrics({checkIntegrity:false}))}`);
await loadMatcherAliases();

const liveState = new SnapshotState("live", Math.max(config.liveIntervalMs * 4, 60000));
const prematchState = new SnapshotState("prematch", Math.max(config.prematchCatalogIntervalMs * 5, 300000));
const fonbetLiveState = new SnapshotState("fonbet-live", Math.max(config.fonbetLiveIntervalMs * 4, 60000));
const fonbetPrematchState = new SnapshotState("fonbet-prematch", Math.max(config.fonbetPrematchIntervalMs * 4, 300000));
const ggbetLiveState = new SnapshotState("ggbet-live", Math.max(config.ggbetSnapshotIntervalMs * 4, 120000));
// Load persistent generations sequentially. On a 1 GB VPS, parsing all large
// history JSON files in parallel briefly duplicates hundreds of MiB and can
// hit the cgroup limit before the API even starts.
for (const state of [liveState,prematchState,fonbetLiveState,fonbetPrematchState,ggbetLiveState,pinnaclePrematchState,pinnacleLiveState]) await state.load();

const liveCollector = new LiveCollector(liveState);
const prematchCollector = new PrematchCollector(prematchState);
const pinnacleCollector=new PinnacleCollector(pinnaclePrematchState,{liveState:pinnacleLiveState});
const fonbetCollector = new FonbetCollector(fonbetLiveState, fonbetPrematchState);
const ggbetCollector = new GgbetLiveCollector(ggbetLiveState);
// GGBET is LIVE-only until its ENDED/final-result transport is verified against production.
const resultsService = new ResultsService(liveState, fonbetLiveState, prematchState, fonbetPrematchState);
resultsService.setPriorityProbe(()=>{const gate=astekRequestStatus();return !!(liveCollector.running||prematchCollector.running||fonbetCollector.running||['live','prematch','detail'].includes(gate.activeKind));});
await resultsService.load();
await prematchCollector.load();

const hltvService=new HltvService();
const oddsService=new OddsService(hltvService);
const crossbetService=new CrossbetService();
const server = createApi({ liveCollector,crossbetService,hltvService,oddsService,pinnacleLiveState,pinnaclePrematchState,pinnacleCollector,ggbetLiveState,ggbetCollector,liveState, prematchState, fonbetLiveState, fonbetPrematchState, prematchCollector, fonbetCollector, resultsService, startedAt });
server.listen(config.port, "0.0.0.0", () => {
  console.log(`[api] listening on 0.0.0.0:${config.port}`);
  console.log(`[api] AstekBet upstream ${config.origins.join(", ")}`);
  console.log(`[api] Fonbet upstream ${config.fonbetUrls.join(", ")}`);
  console.log(`[api] GGBET LIVE bootstrap ${config.ggbetBootstrapRelayUrl?`relay ${config.ggbetBootstrapRelayUrl}`:config.ggbetOrigins.join(", ")}`);
  liveCollector.start();
  prematchCollector.start();
  fonbetCollector.start();ggbetCollector.start();pinnacleCollector.start();
  resultsService.start();
});

let shuttingDown=false;
async function shutdown(exitCode=0,reason='signal',{persist=true}={}) {
  if(shuttingDown)return;shuttingDown=true;
  console.log(`[api] shutting down (${reason}${persist?'':' / no-persist'})`);
  const deadline=setTimeout(() => process.exit(exitCode||1), persist?30000:5000);deadline.unref();
  const closed=new Promise(resolve=>server.close(()=>resolve()));
  await Promise.allSettled([liveCollector.stop(),prematchCollector.stop(),fonbetCollector.stop(),ggbetCollector.stop(),resultsService.stop(),pinnacleCollector.stop()]);
  await Promise.allSettled([server.stopStatistics(),oddsService.stop()]);
  if(persist){
    await Promise.allSettled([liveState.save(),prematchState.save(),fonbetLiveState.save(),fonbetPrematchState.save(),ggbetLiveState.save(),pinnaclePrematchState.save(),pinnacleLiveState.save(),flushMatcherAliases()]);
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
process.on('uncaughtException',error=>{console.error('[fatal] uncaughtException',error?.stack||error);shutdown(1,'uncaughtException',{persist:false}).catch(()=>process.exit(1));});
process.on('unhandledRejection',reason=>{console.error('[fatal] unhandledRejection',reason?.stack||reason);shutdown(1,'unhandledRejection',{persist:false}).catch(()=>process.exit(1));});
server.on('error',error=>{console.error('[api] server error',error?.stack||error);if(error?.code==='EADDRINUSE'||error?.code==='EACCES')shutdown(1,'server error',{persist:false}).catch(()=>process.exit(1));});
