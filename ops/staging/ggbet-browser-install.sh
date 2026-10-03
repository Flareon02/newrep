#!/usr/bin/env bash
# Installs the GGBET Firefox browser worker as a sidecar release, independent of the esports-monitor release flow
# (deploy.sh restarts esports-monitor; this never touches it):
#   ggbet-browser-install.sh [commit]   -> /opt/ggbet-browser/releases/<commit>, current symlink, unit, CLI; restarts
#                                          only esports-monitor-ggbet-browser (when already enabled) or enables it.
set -euo pipefail
# IPC group: the worker (ggbetfx) and the server (monitor) only.
getent group esports-ggbet-browser >/dev/null || groupadd --system esports-ggbet-browser
usermod -aG esports-ggbet-browser ggbetfx; usermod -aG esports-ggbet-browser monitor
cd "$(git -C "$(dirname "$0")" rev-parse --show-toplevel)"
REF=${1:-HEAD}; SHA=$(git rev-parse --short=7 "$REF"); BASE=/opt/ggbet-browser REL=/opt/ggbet-browser/releases/$SHA
UNIT=esports-monitor-ggbet-browser MEMORY_HIGH=${MEMORY_HIGH:-2000M} MEMORY_MAX=${MEMORY_MAX:-2300M}
install -d -m 755 "$BASE/releases"
[ ! -e "$REL" ] || { echo "sidecar release $SHA already exists; refusing to overwrite" >&2; exit 1; }
TMP_REL=$(mktemp -d "$BASE/releases/.install-$SHA-XXXXXX")
git archive "$SHA" tools/ggbet-browser server/package.json server/src/ggbet-forensics.js ops/staging/ggbet-browser-netns.sh ops/staging/$UNIT.service | tar -x -C "$TMP_REL"
chmod -R a+rX "$TMP_REL"; mv "$TMP_REL" "$REL"; ln -sfn "$REL" "$BASE/current.tmp"; mv -T "$BASE/current.tmp" "$BASE/current"
sed -e "s/@MEMORY_HIGH@/$MEMORY_HIGH/" -e "s/@MEMORY_MAX@/$MEMORY_MAX/" "$REL/ops/staging/$UNIT.service" > /etc/systemd/system/$UNIT.service
ln -sfn "$BASE/current/tools/ggbet-browser/cli.mjs" /usr/local/bin/ggbet-browser
systemctl daemon-reload
if systemctl is-enabled -q $UNIT 2>/dev/null; then systemctl restart $UNIT; else systemctl enable --now $UNIT; fi
echo "installed $SHA; $(systemctl is-active $UNIT)"
