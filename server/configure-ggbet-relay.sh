#!/bin/sh
set -eu
HERE="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
cd "$HERE"
BUNDLE="${1:-/root/ggbet-relay-client.bundle}"
[ -f "$BUNDLE" ] || { echo "Relay bundle not found: $BUNDLE" >&2; exit 1; }
mkdir -p "$HERE/secrets"
TMP_SECRET="$HERE/secrets/.ggbet-relay-secret.tmp"
TMP_CA="$HERE/secrets/.ggbet-relay-ca.pem.tmp"
TMP_URL="$HERE/.ggbet-relay-url.tmp"
umask 077
python3 - "$BUNDLE" "$TMP_SECRET" "$TMP_CA" "$TMP_URL" <<'PY'
import base64,json,sys
from urllib.parse import urlparse
src,secret_path,ca_path,url_path=sys.argv[1:]
with open(src,'r',encoding='utf-8') as f: x=json.load(f)
url=str(x.get('url') or '').strip(); secret=str(x.get('secret') or '').strip(); ca_b64=str(x.get('caB64') or '').strip()
p=urlparse(url)
if p.scheme!='https' or not p.hostname or p.path!='/v1/ggbet/bootstrap': raise SystemExit('Invalid relay URL in bundle')
if len(secret)<32: raise SystemExit('Invalid relay secret in bundle')
try: ca=base64.b64decode(ca_b64,validate=True)
except Exception as e: raise SystemExit('Invalid relay CA in bundle') from e
if b'BEGIN CERTIFICATE' not in ca: raise SystemExit('Relay CA is not a PEM certificate')
open(secret_path,'w',encoding='utf-8').write(secret+'\n')
open(ca_path,'wb').write(ca)
open(url_path,'w',encoding='utf-8').write(url+'\n')
PY
mv "$TMP_SECRET" "$HERE/secrets/ggbet-relay-secret"
mv "$TMP_CA" "$HERE/secrets/ggbet-relay-ca.pem"
chmod 600 "$HERE/secrets/ggbet-relay-secret" "$HERE/secrets/ggbet-relay-ca.pem"
URL="$(cat "$TMP_URL")"; rm -f "$TMP_URL"
if [ -f "$HERE/.env" ]; then
  grep -v '^GGBET_BOOTSTRAP_RELAY_URL=' "$HERE/.env" > "$HERE/.env.next" || true
else
  : > "$HERE/.env.next"
fi
printf 'GGBET_BOOTSTRAP_RELAY_URL=%s\n' "$URL" >> "$HERE/.env.next"
mv "$HERE/.env.next" "$HERE/.env"
chmod 600 "$HERE/.env"
SECRET="$(cat "$HERE/secrets/ggbet-relay-secret")"
TEST="$(curl -fsS --max-time 15 --cacert "$HERE/secrets/ggbet-relay-ca.pem" -H "Authorization: Bearer $SECRET" -H 'X-Relay-Force: 1' "$URL")"
printf '%s' "$TEST" | python3 -c 'import json,sys;x=json.load(sys.stdin);assert x.get("ok") and len(x.get("token", ""))>100 and x.get("wsUrl","").startswith("wss://");print("Relay test: OK; token length:",len(x["token"]),"endpoint:",x["wsUrl"])'
echo "Relay configuration installed without exposing the secret in Docker environment variables."
echo "You can now run: ./upgrade.sh"
