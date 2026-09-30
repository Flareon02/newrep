import { config } from "./config.js";
import { log } from "./logger.js";

// A client that stops reading (sleeping laptop, dead NAT entry) would otherwise
// make Node buffer every pushed event in RAM until the socket times out.
export function safeWrite(res, chunk, limit = config.apiSseMaxBufferBytes) {
  if (res.writableEnded || res.destroyed) return false;
  if (res.writableLength > limit) {
    log.warn(`[api] dropping slow SSE client (${res.writableLength} bytes buffered)`);
    res.destroy();
    return false;
  }
  return res.write(chunk);
}
