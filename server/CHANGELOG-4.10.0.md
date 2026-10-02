# Server 4.10.0 — GGBET forensics, observe-only pricing guard, one isolated Mullvad egress

No change to Astek, Fonbet, Pinnacle, DataBet, odds history, users/capabilities or the extension. The GGBET session
architecture is unchanged (one bootstrap, one long-lived WebSocket, light catalog streams, leased full markets).

## Forensic log (ggbet-forensics.js)
- `DATA_DIR/ggbet-forensics/`: `events/YYYYMMDDTHH.ndjson` (completed hours gzipped), `incidents/incident-*.json`,
  `state.json`. Dirs 0700, files 0600, owner = service user. 24 h rolling for events (incidents 7 days).
- Redaction BEFORE writing: values of token/cookie/authorization/password/secret/private-key keys, JWT/JWE-looking
  strings, WireGuard-key-shaped strings and registered secrets are replaced. Cookie NAMES and the JWE protected-header
  fields alg/enc/currency/locale/isAuthorized/label/exp are kept.
- Disk guard: `GGBET_FORENSICS_MAX_MIB` (2048) size cap — oldest hour deleted first; below
  `GGBET_FORENSICS_MIN_FREE_MIB` (8192) free, raw frames stop first. `GGBET_FORENSICS_RAW=1` (default 0) also keeps
  sanitized raw data frames; `GGBET_FORENSICS_ENABLED=0` turns everything off.

## Pricing guard (ggbet-pricing-guard.js) — observe only
- RAW `typeId 96` (Total kills odd/even) markets; outcome ids 1 = odd, 2 = even. Unusual = max/min ratio >
  `GGBET_PRICING_GUARD_MAX_RATIO` (1.04, not yet validated on long-run data).
- HEALTHY → SUSPECT on the first unusual sample (a following normal sample clears it); CONFIRMED only with
  ≥ `MIN_SAMPLES` (3) unusual samples spanning ≥ `WINDOW_MS` (120 s) on ≥ `MIN_EVENTS` (1) events; back to HEALTHY after
  `RECOVER_SAMPLES` (2) normal samples. CONFIRMED writes an incident. It never changes the egress or the session;
  `GGBET_PRICING_GUARD_MODE=enforce` is ignored (reported).

## Session/egress supervisor (ggbet-supervisor.js)
- One bootstrap = one session (S1, S2, …): bootstrap diagnostics, JWE header metadata, WS connects/reconnects/closes,
  first/last good pricing, guard state, end reason; per-egress statistics; egress change history; `state.json`.
- Only action: when the OPERATOR selects another egress (status file changed) the old session ends and the collector
  drops token + WebSocket (`resetForEgressChange`) → clean bootstrap through the new egress.

## One isolated Mullvad egress (GGBET_NETWORK_MODE=netns)
- `ops/staging/ggbet-egress.sh select <name.conf>`: namespace `ggbet-egress` with that WireGuard config, CONNECT-only
  proxy (`tools/ggbet-egress-proxy.mjs`, allow-list gg.bet/*.gg.bet, score-board.databet.cloud, ipinfo.io; port 443)
  on `/run/ggbet-egress/connect.sock`, run as the service user via a transient unit. Verifies the host IP and default
  route are unchanged, else tears down. No automatic rotation.
- egress.js `NetnsConnectAgent`: GGBET bootstrap and WebSocket through that socket (TLS end-to-end).

## Diagnostics
- CLI `esports-monitor-ggbet status|vpns|sessions|history|incidents [id]|tail [--json]`, `select <name.conf>`.
- `GET /api/admin/ggbet-forensics` (admin.diagnostics; token-protected in open mode too). `/health` unchanged.

Tests: `server/test/ggbet-forensics.test.js` (12).
