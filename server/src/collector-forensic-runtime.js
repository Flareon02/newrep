import path from 'node:path';
import {astekRequestStatus} from './utils.js';
import { CollectorForensics, setCollectorForensics, eventCounts } from './collector-forensics.js';

export function stateHeartbeat(states, logger, provider, now = Date.now()) {
  const channels = states.filter(Boolean).map(s => ({ name: s.name, lastSuccessfulAt: s.lastSuccessfulUpdateAt || 0, lastProgressAt: s.lastProgressAt || 0, staleAfterMs: s.staleAfterMs, eventCount: s.events?.length || 0, error: !!s.lastError, partial: !!s.partial, updating: !!s.updating }));
  const live = channels.find(s => s.name === 'live' || s.name.endsWith('-live')) || channels[0];
  const last = Math.max(live?.lastSuccessfulAt || 0, live?.updating ? live.lastProgressAt : 0), stale = !last || now - last > live.staleAfterMs;
  const quiet = !live?.eventCount || now - (logger.providers.get(provider)?.changedAt || now) > 30000;
  const state = stale ? 'STALE' : live.error || live.partial ? 'DEGRADED' : quiet ? 'HEALTHY_QUIET' : 'HEALTHY_ACTIVE';
  return { collectorState: state, transportState: stale ? 'NO_RECENT_SUCCESS' : 'POLLING', channels, ...eventCounts(states.find(s => s?.name === live?.name)?.events || []), lastSuccessfulAgeMs: last ? now - last : null };
}
export function browserHeartbeat(source, health, now = Date.now()) {
  const status = source.status(now), pages = status.selected || [], ipcFresh = status.ipc.fresh;
  const unavailable = pages.some(p => ['STALE', 'VPN_DOWN', 'UNAVAILABLE'].includes(p.pageState)), degraded = pages.some(p => !['HEALTHY', 'QUIET'].includes(p.pageState));
  const collectorState = !ipcFresh ? 'DISCONNECTED' : health?.vpnState !== 'UP' || !health?.browserRunning || unavailable ? 'STALE' : degraded ? 'DEGRADED' : !pages.length || pages.every(p => p.pageState === 'QUIET') ? 'HEALTHY_QUIET' : 'HEALTHY_ACTIVE';
  return { collectorState, transportState: ipcFresh ? 'LOCAL_IPC_CONNECTED' : 'LOCAL_IPC_UNAVAILABLE', workerInstance: status.worker?.id, browserSessionId: status.worker?.sessionId, ipc: status.ipc, eventCount: pages.length, marketCount: health?.marketCount ?? pages.reduce((n, p) => n + (p.marketCount || 0), 0), outcomeCount: health?.outcomeCount ?? null,
    pageStates: pages, vpnState: health?.vpnState ?? status.worker?.vpnState, vpnExit: health?.vpnExit ?? status.worker?.vpnExit, firefoxPid: health?.browserPid ?? null, firefoxPssMiB: health?.firefoxPssMiB ?? null, firefoxProcesses: health?.firefoxProcesses ?? null, workerRssMiB: health?.workerRssMiB ?? null,
    pageCount: health?.pagesActive ?? pages.length, wsFrameAgeMs: health?.lastWsFrameAgeMs ?? null, wsFramesTotal: health?.wsFramesTotal ?? null, discovery: health?.discoveryLists ?? null, discoveryAgeMs: health?.globalListAgeMs ?? null, bidiState: health ? health.browserRunning ? 'CONNECTED' : 'DISCONNECTED' : 'UNKNOWN', recoveryCount: health?.pageRecoveries ?? null, restartCount: health?.restartCount ?? null };
}
export function startCollectorForensics({ config, liveState, prematchState, fonbetLiveState, fonbetPrematchState, pinnacleLiveState, pinnaclePrematchState, fonbetCollector, ggbetCollector, ggbetBrowser }) {
  if (!config.collectorForensicsEnabled) return null;
  const logger = new CollectorForensics({ dir: config.collectorForensicsDir || path.join(config.dataDir, 'collector-forensics'), retentionMs: config.collectorForensicsHours * 3600000, maxBytes: config.collectorForensicsMaxMiB * 1048576, minFreeMiB: config.collectorForensicsMinFreeMiB });
  setCollectorForensics(logger);
  logger.register('astek', () => ({...stateHeartbeat([liveState, prematchState], logger, 'astek'),requestGate:astekRequestStatus()}));
  logger.register('fonbet', () => ({ ...stateHeartbeat([fonbetLiveState, fonbetPrematchState], logger, 'fonbet'), providerVersion: fonbetCollector.packetVersion, fullRequests: fonbetCollector.fullRequests, deltaRequests: fonbetCollector.deltaRequests, fullResyncs: fonbetCollector.deltaFallbacks, lastPayloadBytes: fonbetCollector.lastBytes, retryCount: fonbetCollector.failures }));
  logger.register('pinnacle', () => stateHeartbeat([pinnacleLiveState, pinnaclePrematchState], logger, 'pinnacle'));
  if (config.ggbetLiveEnabled) logger.register('ggbet-node', () => {
    const status = ggbetCollector.status(), age = status.freshnessMs, snapshotAge=status.lastSnapshotAt?Date.now()-Date.parse(status.lastSnapshotAt):null,p=logger.providers.get('ggbet-node');
    return { collectorState: !status.connected || !status.acknowledged ? 'DISCONNECTED' : age == null || age > config.ggbetWatchdogMs || (snapshotAge!=null&&snapshotAge>2*config.ggbetSnapshotIntervalMs+5000) ? 'STALE' : status.lastError || status.degradedPolling || (p?.publishAt&&ggbetCollector.events.size&&Date.now()-p.publishAt>30000)? 'DEGRADED' : ggbetCollector.events.size?'HEALTHY_ACTIVE':'HEALTHY_QUIET', transportState: status.acknowledged ? 'CONNECTED_ACKNOWLEDGED' : 'DISCONNECTED', ...eventCounts([...ggbetCollector.events.values()]), collectorSession:status.sessionStartedAt,collectorFailures:status.failures,upstreamAgeMs: age,snapshotAgeMs:snapshotAge, lastSnapshotAt: status.lastSnapshotAt, lastPushAt: status.lastPushAt, subscriptions: status.subscriptions, networkMode: status.networkMode, bootstrapMode: status.bootstrapMode, reconnectCount: status.reconnects, errorCount: status.failures };
  });
  if (ggbetBrowser) logger.register('ggbet-browser', async () => {
    let health = null;
    try { health = await ggbetBrowser.request(ggbetBrowser.socketPath, '/health', 1000); }
    catch { /* Existing feed freshness still supplies evidence; health-only timeout is not a fake page outage. */ }
    if(health&&health.wsFramesTotal>0&&health.wsFramesTotal!==logger.browserFrames){const previous=logger.browserFrames;logger.browserFrames=health.wsFramesTotal;logger.record('ggbet-browser','ws_frame_received',{operation:'worker-frame-counter',measurement:'aggregate worker health; not an individual frame callback',framesSinceProbe:previous==null?null:Math.max(0,health.wsFramesTotal-previous),wsFramesTotal:health.wsFramesTotal,upstreamAgeMs:health.lastWsFrameAgeMs,observedLastFrameAt:health.lastWsFrameAgeMs==null?null:new Date(Date.now()-health.lastWsFrameAgeMs).toISOString()});}
    const row = browserHeartbeat(ggbetBrowser, health);
    if (!health && ggbetBrowser.ipcFresh()) { row.collectorState = ggbetBrowser.feed?.vpnState!=='UP'||!ggbetBrowser.feed?.browserRunning||row.pageStates.some(p=>['STALE','VPN_DOWN','UNAVAILABLE'].includes(p.pageState))?'STALE':row.pageStates.some(p => !['HEALTHY', 'QUIET'].includes(p.pageState)) ? 'DEGRADED' : 'HEALTHY_QUIET'; row.healthProbeState = 'UNAVAILABLE'; }
    return row;
  });
  logger.start(); return logger;
}
