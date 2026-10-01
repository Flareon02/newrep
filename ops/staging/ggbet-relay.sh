#!/usr/bin/env bash
# Connects the staging service to the GGBET bootstrap relay from a client bundle (JSON: url, secret, caB64).
#   esports-monitor-ggbet-relay [/root/ggbet-relay-client.bundle]
# The secret and the CA are stored outside the repository (/etc/esports-monitor, root:monitor 0640); server.env only gets
# the relay URL and the two file paths. TLS verification stays on (the collector pins the relay CA). Restarts the service.
set -euo pipefail
BUNDLE="${1:-/root/ggbet-relay-client.bundle}"; ETC=/etc/esports-monitor; ENVF="$ETC/server.env"
[ -f "$BUNDLE" ] || { echo "bundle not found: $BUNDLE" >&2; exit 1; }
[ -f "$ENVF" ] || { echo "$ENVF missing (run provision.sh first)" >&2; exit 1; }
umask 077
url="$(jq -er '.url' "$BUNDLE")"; secret="$(jq -er '.secret' "$BUNDLE")"
case "$url" in https://*/v1/ggbet/bootstrap) ;; *) echo "bundle url must be https://…/v1/ggbet/bootstrap" >&2; exit 1;; esac
[ "${#secret}" -ge 32 ] || { echo "bundle secret too short" >&2; exit 1; }
jq -er '.caB64' "$BUNDLE" | base64 -d > "$ETC/ggbet-relay-ca.pem.new"
grep -q 'BEGIN CERTIFICATE' "$ETC/ggbet-relay-ca.pem.new" || { rm -f "$ETC/ggbet-relay-ca.pem.new"; echo "bundle CA is not a PEM certificate" >&2; exit 1; }
printf '%s' "$secret" > "$ETC/ggbet-relay-secret.new"
chown root:monitor "$ETC/ggbet-relay-ca.pem.new" "$ETC/ggbet-relay-secret.new"; chmod 0640 "$ETC/ggbet-relay-ca.pem.new" "$ETC/ggbet-relay-secret.new"
mv "$ETC/ggbet-relay-ca.pem.new" "$ETC/ggbet-relay-ca.pem"; mv "$ETC/ggbet-relay-secret.new" "$ETC/ggbet-relay-secret"
grep -v '^GGBET_BOOTSTRAP_RELAY_' "$ENVF" > "$ENVF.new" || true
printf 'GGBET_BOOTSTRAP_RELAY_URL=%s\nGGBET_BOOTSTRAP_RELAY_SECRET_FILE=%s\nGGBET_BOOTSTRAP_RELAY_CA_FILE=%s\n' "$url" "$ETC/ggbet-relay-secret" "$ETC/ggbet-relay-ca.pem" >> "$ENVF.new"
chown root:monitor "$ENVF.new"; chmod 0640 "$ENVF.new"; mv "$ENVF.new" "$ENVF"
systemctl restart esports-monitor.service
echo "relay configured: $url (secret and CA in $ETC, not printed)"
