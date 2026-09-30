#!/usr/bin/env python3
"""Print the `environment:` block of server/docker-compose.yml as KEY=value lines for a systemd EnvironmentFile.

Staging runs the same code as production, so it must run with the same settings. Reading them from the release's own
compose file keeps the two from drifting. `${VAR:-default}` becomes `default`; `${VAR}` without a default is skipped.
Container-only keys (paths under /run/secrets, DATA_DIR, PORT) are dropped because staging sets its own.
"""
import re, sys

SKIP = {"DATA_DIR", "PORT", "GGBET_BOOTSTRAP_RELAY_SECRET_FILE", "GGBET_BOOTSTRAP_RELAY_CA_FILE", "GGBET_BOOTSTRAP_RELAY_URL", "API_TOKEN"}
lines = open(sys.argv[1], encoding="utf-8").read().splitlines()
inside, indent = False, None
for raw in lines:
    if re.match(r"^\s{4}environment:\s*$", raw):
        inside = True
        continue
    if not inside:
        continue
    if re.match(r"^\s{4}\S", raw) and not raw.strip().startswith("#"):
        break  # next service key (volumes:, healthcheck:, ...)
    m = re.match(r'^\s{6}([A-Z][A-Z0-9_]*):\s*"?(.*?)"?\s*$', raw)
    if not m:
        continue
    key, value = m.groups()
    d = re.fullmatch(r"\$\{[A-Z0-9_]+:-(.*)\}", value)
    if d:
        value = d.group(1)
    elif value.startswith("${"):
        continue
    if key in SKIP:
        continue
    print(f"{key}={value}")
