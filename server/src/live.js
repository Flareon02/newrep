import { log } from "./logger.js";
import { config, urls } from "./config.js";
import { fetchJson, withAstekRequest } from "./utils.js";
import { parseLiveFeed } from "./parsers.js";

const jitter=(ms)=>Math.max(250,Math.round(ms*(0.9+Math.random()*0.2)));

export class LiveCollector {
  constructor(state) {
    this.state = state;
    this.running = false;
    this.timer = null;
    this.originIndex = 0;
    this.failures = 0;
    this.stopped = false;
    this.current = null;
    this.lastFingerprint = "";
    this.lastTransport = "full";
  }

  async poll() {
    if (this.running || this.stopped) return false;
    this.running = true;
    try {
      const usedOrigin=config.origins[this.originIndex||0];
      let result;
      try {result=await withAstekRequest('live',(gateSignal)=>fetchJson(urls.live(usedOrigin), `${usedOrigin}/live/esports`, {timeoutMs:config.liveRequestTimeoutMs,signal:gateSignal}));}
      catch(error){this.originIndex=((this.originIndex||0)+1)%config.origins.length;throw error;}
      if(result.fingerprint&&result.fingerprint===this.lastFingerprint){
        await this.state.unchanged(result);
        this.failures=0;
        log.debug(`[live] unchanged, HTTP ${result.status}, ${result.elapsedMs} ms, ${usedOrigin}`);
        return true;
      }
      let events = parseLiveFeed(result.payload, usedOrigin);
      await this.state.success(events, result);
      this.lastFingerprint=result.fingerprint||"";
      this.failures=0;
      log.debug(`[live] ${events.length} events, HTTP ${result.status}, ${result.elapsedMs} ms, ${usedOrigin}`);
      return true;
    } catch (error) {
      this.failures++;
      await this.state.failure(error);
      log.warn(`[live] ${error.message}`);
      return false;
    } finally {
      this.running = false;
    }
  }

  nextDelay(success){
    if(success)return jitter(config.liveIntervalMs);
    const n=Math.min(6,Math.max(1,this.failures));
    return jitter(Math.min(config.astekMaxBackoffMs,config.liveIntervalMs*(2**n)));
  }

  schedule(delay=0){
    if(this.stopped)return;
    clearTimeout(this.timer);
    this.timer=setTimeout(async()=>{
      this.current=this.poll();
      const ok=await this.current;
      this.current=null;
      this.schedule(this.nextDelay(ok));
    },delay);
    this.timer.unref?.();
  }

  start() { this.stopped=false;this.schedule(0); }
  async stop(){this.stopped=true;clearTimeout(this.timer);if(this.current)await this.current.catch(()=>{});}
}
