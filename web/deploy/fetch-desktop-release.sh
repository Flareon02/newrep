#!/bin/bash
# Installs a published desktop release (GitHub release desktop-v<version>) into the gateway's public download folder
# (/downloads/desktop/ on the website: Settings → Аккаунт download + the updater's primary latest.json).
# Every file is checked against the release's SHA256SUMS.txt before it replaces anything. Run as root.
#   web/deploy/fetch-desktop-release.sh 1.0.0
set -euo pipefail
V=${1:?version}
REPO=${REPO:-Flareon02/newrep}
DEST=/var/lib/esportsdata-web/downloads/desktop
BASE="https://github.com/$REPO/releases/download/desktop-v$V"
TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT
FILES="EsportsData-Desktop-Windows-x64.zip EsportsData-Desktop-Windows-x64-setup.exe EsportsData-Desktop-Windows-x64-setup.exe.sig SHA256SUMS.txt manifest.json latest.json"
for f in $FILES; do curl -fsSL --retry 3 -o "$TMP/$f" "$BASE/$f"; done
( cd "$TMP" && sha256sum -c SHA256SUMS.txt )
node -e "const m=require('$TMP/manifest.json'),l=require('$TMP/latest.json');if(m.version!=='$V'||l.version!=='$V')throw Error('version mismatch');if(!l.platforms['windows-x86_64'].signature)throw Error('unsigned');console.log('manifest',m.version,m.commit.slice(0,10),m.sha256)"
install -d -m 0755 -o esportsdata-web -g esportsdata-web "$DEST"
for f in $FILES; do install -m 0644 -o esportsdata-web -g esportsdata-web "$TMP/$f" "$DEST/$f.new"; done
for f in $FILES; do mv -f "$DEST/$f.new" "$DEST/$f"; done
echo "desktop $V installed in $DEST"
