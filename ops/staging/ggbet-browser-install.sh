#!/usr/bin/env bash
# Installs the experimental GGBET Firefox worker as a sidecar release, independent of the esports-monitor release flow
# (deploy.sh restarts esports-monitor; this never touches it):
#   ggbet-browser-install.sh [commit]   -> /opt/ggbet-browser/releases/<commit>, current symlink, unit, CLI; restarts
#                                          only esports-monitor-ggbet-browser (when already enabled) or enables it.
set -euo pipefail
cd "$(git -C "$(dirname "$0")" rev-parse --show-toplevel)"
REF=${1:-HEAD}; SHA=$(git rev-parse --short=7 "$REF"); BASE=/opt/ggbet-browser REL=/opt/ggbet-browser/releases/$SHA
UNIT=esports-monitor-ggbet-browser MEMORY_HIGH=${MEMORY_HIGH:-2000M} MEMORY_MAX=${MEMORY_MAX:-2300M}
install -d -m 755 "$BASE/releases"; rm -rf "$REL.tmp"; install -d -m 755 "$REL.tmp"
git archive "$SHA" tools/ggbet-browser server/package.json server/src/ggbet-forensics.js ops/staging/ggbet-browser-netns.sh ops/staging/$UNIT.service | tar -x -C "$REL.tmp"
chmod -R a+rX "$REL.tmp"; rm -rf "$REL"; mv "$REL.tmp" "$REL"; ln -sfn "$REL" "$BASE/current.tmp"; mv -T "$BASE/current.tmp" "$BASE/current"
sed -e "s/@MEMORY_HIGH@/$MEMORY_HIGH/" -e "s/@MEMORY_MAX@/$MEMORY_MAX/" "$REL/ops/staging/$UNIT.service" > /etc/systemd/system/$UNIT.service
ln -sfn "$BASE/current/tools/ggbet-browser/cli.mjs" /usr/local/bin/ggbet-browser
systemctl daemon-reload
if systemctl is-enabled -q $UNIT 2>/dev/null; then systemctl restart $UNIT; else systemctl enable --now $UNIT; fi
echo "installed $SHA; $(systemctl is-active $UNIT)"
