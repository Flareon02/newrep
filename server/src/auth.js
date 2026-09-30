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

// A token that is set but too short is a configuration mistake. Refusing to start would turn it into a
// crash loop, and silently running open would hide it, so the server stays up, protected endpoints are
// refused (fail closed) with an explicit message, and /health reports `misconfigured`.
export function createAuthorizer(token) {
  const value = String(token || "").trim();
  const misconfigured = !!value && value.length < MIN_TOKEN_LENGTH;
  const expected = value && !misconfigured ? digest(value) : null;
  return {
    enabled: !!value,
    misconfigured,
    mode: !value ? "open" : misconfigured ? "misconfigured" : "token",
    // Returns true when the request may proceed.
    allows(req, pathname) {
      if (!value) return true;
      if (!requiresToken(req.method, pathname)) return true;
      if (misconfigured) return false;
      const given = extractToken(req.headers);
      return !!given && timingSafeEqual(digest(given), expected);
    },
  };
}
