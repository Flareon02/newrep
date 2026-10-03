#!/usr/bin/env bash
# Isolated, FAIL-CLOSED network namespace for the experimental GGBET Firefox worker (one Mullvad WireGuard tunnel).
#   esports-monitor-ggbet-browser-netns up | ensure | down | status | leaktest
# ensure (systemd ExecStartPre): keep an intact namespace (only lo + tunnel, killswitch loaded, default via the tunnel),
# rebuild anything else; exits non-zero (worker does not start) when the tunnel cannot be verified.
# Fail-closed by construction: the namespace has ONLY lo + the WireGuard interface (no veth/bridge, no route to the
# host network); the tunnel's encrypted UDP socket lives in the host namespace. nftables inside the namespace drops
# every packet that would leave through anything but lo or the tunnel (defence in depth). DNS = the VPN's resolver
# (reachable only through the tunnel). The host namespace (default route, SSH, cloudflared, production) is never changed.
# The config is dedicated to the browser worker (outside /root/.secrets/mullvad, so the production egress controller
# never selects it) and read inside this script only; no key, address or DNS value is printed.
set -euo pipefail
CONF=${GGBET_BROWSER_VPN_CONF:-/root/.secrets/mullvad-browser/hr-zag-wg-002.conf}
NS=ggbet-browser IF=wgbr0 RUN=/run/ggbet-browser HOST_IP_FILE=/run/ggbet-browser/host-ip
route_sig(){ ip route show default; ip -6 route show default; }
inns(){ ip netns exec "$NS" "$@"; }
mullvad(){ inns curl -s --max-time "${1:-12}" https://am.i.mullvad.net/json; }
down(){ ip netns pids "$NS" 2>/dev/null | xargs -r kill 2>/dev/null || true; ip netns del "$NS" 2>/dev/null || true; rm -rf /etc/netns/"$NS"; }
up(){
  [ -r "$CONF" ] || { echo "config not readable: $CONF" >&2; exit 1; }
  R0="$(route_sig)"; HOST_IP="$(curl -s --max-time 10 https://api.ipify.org)"; install -d -m 755 "$RUN"; echo "$HOST_IP" > "$HOST_IP_FILE"
  down; umask 077
  ip netns add "$NS"; ip link add "$IF" type wireguard; ip link set "$IF" netns "$NS"
  wg-quick strip "$CONF" | inns wg setconf "$IF" /dev/stdin
  awk -F'=' 'tolower($1)~/^[ \t]*address[ \t]*$/{gsub(/[ \t]/,"",$2);n=split($2,a,",");for(i=1;i<=n;i++)print a[i]}' "$CONF" | while read -r a; do ip -n "$NS" addr add "$a" dev "$IF"; done
  install -d -m 755 /etc/netns/"$NS"
  awk -F'=' 'tolower($1)~/^[ \t]*dns[ \t]*$/{gsub(/[ \t]/,"",$2);n=split($2,a,",");for(i=1;i<=n;i++)print "nameserver " a[i]}' "$CONF" > /etc/netns/"$NS"/resolv.conf; chmod 644 /etc/netns/"$NS"/resolv.conf
  ip -n "$NS" link set lo up; ip -n "$NS" link set "$IF" up; ip -n "$NS" route add default dev "$IF"
  if ip -n "$NS" -6 addr show dev "$IF" | grep -q 'inet6 '; then ip -n "$NS" -6 route add default dev "$IF"; fi
  # Defence in depth: only lo and the tunnel may carry traffic out of this namespace.
  inns nft -f - <<EOF
table inet killswitch {
  chain output { type filter hook output priority 0; policy drop; oifname "lo" accept; oifname "$IF" accept; }
  chain input { type filter hook input priority 0; policy drop; iifname "lo" accept; iifname "$IF" ct state established,related accept; }
}
EOF
  [ "$R0" = "$(route_sig)" ] || { echo "HOST ROUTE CHANGED - tearing down" >&2; down; exit 3; }
  ifaces=$(ip -n "$NS" -br link | awk '{print $1}' | tr '\n' ' '); echo "namespace interfaces: $ifaces"
  echo "exit: $(mullvad | jq -c '{ip,country,city,mullvad_exit_ip,mullvad_exit_ip_hostname}')"
}
intact(){
  ip netns list | grep -qw "$NS" || return 1
  [ "$(ip -n "$NS" -br link | awk '{print $1}' | sort | tr '\n' ' ')" = "lo $IF " ] || return 1
  inns nft list table inet killswitch >/dev/null 2>&1 || return 1
  ip -n "$NS" route show default | grep -q "dev $IF" || return 1
}
case "${1:-}" in
  up) up ;;
  ensure)
    if intact; then echo "namespace intact; exit: $(mullvad 10 | jq -c '{ip,mullvad_exit_ip_hostname}' 2>/dev/null || echo unreachable)"
    else echo "namespace missing or not fail-closed - rebuilding"; up; intact || { echo "namespace still not intact" >&2; down; exit 4; }; fi ;;
  down) down; echo "browser namespace removed; host route: $(ip route show default)" ;;
  status) echo "namespace: $(ip netns list | grep -w "$NS" || echo none)"; ip -n "$NS" -br link 2>/dev/null; echo "routes: $(ip -n "$NS" route 2>/dev/null | tr '\n' ';')"; echo "exit: $(mullvad 8 | jq -c '{ip,country,city,mullvad_exit_ip_hostname}' 2>/dev/null || echo unreachable)" ;;
  leaktest)
    # Proves fail-closed without touching the host: VPN up -> Mullvad exit; tunnel down -> NO connectivity at all
    # (neither by name nor by IP literal), never the host IP; DNS only via the tunnel; host route unchanged.
    R0="$(route_sig)"; HOST_IP="$(cat "$HOST_IP_FILE" 2>/dev/null || curl -s --max-time 10 https://api.ipify.org)"
    UP=$(mullvad); UPIP=$(echo "$UP" | jq -r '.ip // empty')
    echo "VPN_UP_EXIT: $(echo "$UP" | jq -c '{ip,country,city,mullvad_exit_ip,mullvad_exit_ip_hostname}') host_ip_seen=$([ "$UPIP" = "$HOST_IP" ] && echo YES || echo no)"
    NSIP=$(awk '/^nameserver/{print $2; exit}' /etc/netns/"$NS"/resolv.conf)
    echo "DNS_PATH: resolver_route_dev=$(ip -n "$NS" route get "$NSIP" 2>/dev/null | grep -o 'dev [^ ]*' | head -1) resolves_gg.bet=$(inns getent hosts gg.bet >/dev/null && echo yes || echo no) host_stub_answers=$(inns python3 -c 'import socket,sys; s=socket.socket(socket.AF_INET,socket.SOCK_DGRAM); s.settimeout(3); q=bytes.fromhex("abcd01000001000000000000")+b"\x05gg\x05bet\x00"+bytes.fromhex("00010001"); s.sendto(q,("127.0.0.53",53));
try: s.recv(512); print("YES")
except Exception: print("no")' 2>/dev/null || echo no) resolver_answers=$(inns python3 -c 'import socket; socket.getaddrinfo("gg.bet",443); print("yes")' 2>/dev/null || echo no)"
    ip -n "$NS" link set "$IF" down
    A=$(inns curl -s --max-time 8 https://api.ipify.org || echo FAILED); B=$(inns curl -s --max-time 8 --resolve api.ipify.org:443:104.26.12.205 https://api.ipify.org || echo FAILED); C=$(inns getent hosts gg.bet >/dev/null && echo RESOLVED || echo FAILED)
    echo "VPN_DOWN_RESULT: by_name=$A by_ip_literal=$B dns=$C routes=[$(ip -n "$NS" route | tr '\n' ';')] host_ip_seen=$([ "$A" = "$HOST_IP" ] || [ "$B" = "$HOST_IP" ] && echo YES || echo no)"
    ip -n "$NS" link set "$IF" up; ip -n "$NS" route add default dev "$IF"; if ip -n "$NS" -6 addr show dev "$IF" | grep -q 'inet6 '; then ip -n "$NS" -6 route add default dev "$IF" 2>/dev/null || true; fi
    echo "VPN_RESTORED: $(mullvad | jq -c '{ip,mullvad_exit_ip_hostname}')"
    echo "HOST_ROUTE_UNCHANGED: $([ "$R0" = "$(route_sig)" ] && echo yes || echo NO)" ;;
  *) sed -n '2,3p' "$0"; exit 2 ;;
esac
