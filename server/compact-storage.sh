#!/bin/sh
set -eu
cat <<'MSG'
Server 4.1.0 does not run the legacy NDJSON -> SQLite compaction workflow.
Production data was already migrated/compacted by 4.0.x and schema remains v3.
This script intentionally performs no writes.

Use /health to inspect runtime.storage. For an explicit offline integrity check,
stop the server first and use the documented storage status command knowingly;
it can scan the full database and may take time.
MSG
