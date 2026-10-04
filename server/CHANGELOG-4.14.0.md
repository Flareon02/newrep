# Server 4.14.0 — persistent collector forensics

Adds bounded asynchronous UTC telemetry for AstekBet, Fonbet, Pinnacle, GGBET Node and the existing Firefox IPC source. Request/receive/decode/normalize/state/publish stages, 15-second provider/system heartbeats, incidents with retained context, cross-provider links and recovery survive in a private rotating store. Existing detailed GGBET forensics remain intact.

The read-only `esports-monitor forensic` / `incidents` CLI supports time windows, explicit local-time resolution and evidence-qualified reports. Default retention targets72h / incidents14d, 1GiB cap and 4GiB free-space guard. Logger failure never stops collectors. No API/extension schema, authority, proxy/VPN, DataBet, odds-history or SQLite schema change. Firefox/cloudflared restart is unnecessary.

See [COLLECTOR_FORENSICS.md](../COLLECTOR_FORENSICS.md) for schema, coverage limits, security, queries and rollback. Synthetic acceptance harness uses a separate store and never touches upstream connections.
