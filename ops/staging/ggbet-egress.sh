#!/usr/bin/env bash
# One isolated GGBET egress through ONE Mullvad WireGuard config, chosen by the operator (no automatic rotation).
#   esports-monitor-ggbet-egress discover            configs in /root/.secrets/mullvad (name, mode, size; never contents)
#   esports-monitor-ggbet-egress select <name.conf>  (re)create namespace ggbet-egress with that config + CONNECT proxy
#   esports-monitor-ggbet-egress status | down
# The host namespace is never changed: default route, SSH, cloudflared and every other collector stay as they are.
# Inside the namespace runs tools/ggbet-egress-proxy.mjs as the service user (transient unit esports-monitor-ggbet-egress),
# listening only on /run/ggbet-egress/connect.sock. The service uses it with GGBET_NETWORK_MODE=netns.
# Config contents (keys, addresses, DNS) are read inside this script only and never printed or stored elsewhere.
set -euo pipefail
DIR=/root/.secrets/mullvad NS=ggbet-egress IF=wgge0 RUN=/run/ggbet-egress UNIT=esports-monitor-ggbet-egress
APP=/opt/esports-monitor/current SVC_USER=monitor
PROXY_JS=${GGBET_EGRESS_PROXY:-$APP/tools/ggbet-egress-proxy.mjs}   # override only for smoke tests of an undeployed build
route_sig(){ ip route show default; ip -6 route show default; }
outside_ip(){ curl -s --max-time 10 https://api.ipify.org; }
perms(){ chmod 700 "$DIR"; find "$DIR" -maxdepth 1 -type f -name '*.conf' ! -perm 600 -exec chmod 600 {} +; }
down(){ systemctl stop "$UNIT" 2>/dev/null || true; ip netns del "$NS" 2>/dev/null || true; rm -rf /etc/netns/"$NS"; rm -f "$RUN"/connect.sock "$RUN"/status.json; }
case "${1:-}" in
  discover) perms; find "$DIR" -maxdepth 1 -type f -name '*.conf' -printf '{"configFile":"%f","mode":"%m","owner":"%u:%g","size":%s}\n' | sort ;;
  status)
    echo "namespace: $(ip netns list | grep -w "$NS" || echo none)"; echo "proxy unit: $(systemctl is-active "$UNIT" 2>/dev/null || true)"
    [ -f "$RUN/status.json" ] && jq -c . "$RUN/status.json" || echo "no active egress"
    echo "outside default route: $(ip route show default)" ;;
  down) down; echo "egress down; host route: $(ip route show default)" ;;
  select)
    NAME=$(basename "${2:?config name}"); CONF="$DIR/$NAME"; perms
    [ -f "$CONF" ] || { echo "no such config: $NAME" >&2; exit 2; }
    R0="$(route_sig)"; I0="$(outside_ip)"
    down; umask 077
    ip netns add "$NS"; ip link add "$IF" type wireguard; ip link set "$IF" netns "$NS"
    wg-quick strip "$CONF" | ip netns exec "$NS" wg setconf "$IF" /dev/stdin
    awk -F'=' 'tolower($1)~/^[ \t]*address[ \t]*$/{gsub(/[ \t]/,"",$2);n=split($2,a,",");for(i=1;i<=n;i++)print a[i]}' "$CONF" | while read -r a; do ip -n "$NS" addr add "$a" dev "$IF"; done
    install -d -m 755 /etc/netns/"$NS"
    awk -F'=' 'tolower($1)~/^[ \t]*dns[ \t]*$/{gsub(/[ \t]/,"",$2);n=split($2,a,",");for(i=1;i<=n;i++)print "nameserver " a[i]}' "$CONF" > /etc/netns/"$NS"/resolv.conf; chmod 644 /etc/netns/"$NS"/resolv.conf
    ip -n "$NS" link set lo up; ip -n "$NS" link set "$IF" up; ip -n "$NS" route add default dev "$IF"
    if ip -n "$NS" -6 addr show dev "$IF" | grep -q 'inet6 '; then ip -n "$NS" -6 route add default dev "$IF"; fi
    if [ "$R0" != "$(route_sig)" ] || [ "$I0" != "$(outside_ip)" ]; then echo "ISOLATION BROKEN - tearing down" >&2; down; exit 3; fi
    INFO=$(ip netns exec "$NS" curl -s --max-time 15 https://am.i.mullvad.net/json || echo '{}')
    install -d -m 750 -o root -g "$SVC_USER" "$RUN"; install -d -m 700 -o "$SVC_USER" -g "$SVC_USER" "$RUN/sock"
    systemd-run --quiet --unit="$UNIT" --property=NetworkNamespacePath=/run/netns/"$NS" --property=User="$SVC_USER" --property=Group="$SVC_USER" \
      --property=NoNewPrivileges=yes --property=ProtectSystem=strict --property=ReadWritePaths="$RUN/sock" --property=ProtectHome=yes \
      /usr/local/bin/node "$PROXY_JS" --socket "$RUN/sock/connect.sock" --resolv /etc/netns/"$NS"/resolv.conf
    for _ in $(seq 1 20); do [ -S "$RUN/sock/connect.sock" ] && break; sleep 0.25; done
    ln -sfn "$RUN/sock/connect.sock" "$RUN/connect.sock"
    jq -n --arg id "mullvad:${NAME%.conf}" --arg cf "$NAME" --arg ns "$NS" --arg at "$(date -u +%FT%T.%3NZ)" --argjson i "$INFO" \
      '{id:$id,configFile:$cf,namespace:$ns,activatedAt:$at,exitIp:$i.ip,country:$i.country,city:$i.city,hostname:$i.mullvad_exit_ip_hostname,mullvad:$i.mullvad_exit_ip}' > "$RUN/status.json"
    chown root:"$SVC_USER" "$RUN/status.json"; chmod 640 "$RUN/status.json"
    echo "active egress:"; jq -c . "$RUN/status.json"; echo "outside default route unchanged: $(ip route show default)" ;;
  *) sed -n '2,9p' "$0"; exit 2 ;;
esac
