import { createHash, timingSafeEqual } from "node:crypto";

// Optional shared-token protection for endpoints that write state, start
// CPU-heavy jobs or make the server contact third parties. Disabled unless
// API_TOKEN is set, so existing installations keep working unchanged.
// Read-only feeds stay open: the browser EventSource API used by the extension
// for a few streams cannot send an Authorization header.
export const MIN_TOKEN_LENGTH = 16;

const PROTECTED_GET = new Set([
  "/api/league-links/challenge", // first step of publishing league rules
  "/api/hltv/search",            // each of these can trigger an outbound HLTV request
  "/api/hltv/team",
  "/api/hltv/player",
]);

const digest = (value) => createHash("sha256").update(String(value)).digest();

export function requiresToken(method, pathname) {
  if (method === "OPTIONS") return false;
  if (method === "POST") return true;
  return method === "GET" && PROTECTED_GET.has(pathname);
}

export function extractToken(headers = {}) {
  const auth = String(headers.authorization || "");
  const bearer = /^Bearer\s+(\S+)$/i.exec(auth);
  return bearer ? bearer[1] : String(headers["x-api-token"] || "").trim();
}

// Processes inside the container (deploy probes via `docker exec`) reach the
// API over loopback. Published ports arrive through the Docker bridge, never
// from the container's own loopback.
export const isLoopback = (address) => /^(?:::1|127\.\d+\.\d+\.\d+|::ffff:127\.\d+\.\d+\.\d+)$/.test(String(address || ""));

export function createAuthorizer(token, { trustLoopback = true } = {}) {
  const value = String(token || "").trim();
  if (value && value.length < MIN_TOKEN_LENGTH) throw new Error(`API_TOKEN must be at least ${MIN_TOKEN_LENGTH} characters`);
  const expected = value ? digest(value) : null;
  return {
    enabled: !!expected,
    // Returns true when the request may proceed.
    allows(req, pathname) {
      if (!expected) return true;
      if (!requiresToken(req.method, pathname)) return true;
      if (trustLoopback && isLoopback(req.socket?.remoteAddress)) return true;
      const given = extractToken(req.headers);
      return !!given && timingSafeEqual(digest(given), expected);
    },
  };
}
