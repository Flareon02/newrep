#!/usr/bin/env bash
# Resource profile of the application service (limits apply to the service cgroup only, never to the whole VM or sshd).
#   prod     MemoryMax=768M, no swap, 1 CPU      = docker-compose.yml (mem_limit 768m) on the 1 GiB production host
#   tight    MemoryMax=640M, no swap, 1 CPU      = extra safety margin check for production
#   small    MemoryMax=448M, no swap, 1 CPU      = real ceiling for a 1 GiB host that also runs sshd/journald (staging on 847 MiB)
#   relaxed  no limits                           = behaviour on the 2 GB staging VM
set -euo pipefail
profile="${1:-}"; restart=1; [ "${2:-}" = "--no-restart" ] && restart=0
d=/etc/systemd/system/esports-monitor.service.d; install -d "$d"
case "$profile" in
  prod)    printf '[Service]\nMemoryMax=768M\nMemoryHigh=704M\nMemorySwapMax=0\nCPUQuota=100%%\n' > "$d/10-profile.conf";;
  tight)   printf '[Service]\nMemoryMax=640M\nMemoryHigh=576M\nMemorySwapMax=0\nCPUQuota=100%%\n' > "$d/10-profile.conf";;
  small)   printf '[Service]\nMemoryMax=448M\nMemoryHigh=416M\nMemorySwapMax=0\nCPUQuota=100%%\n' > "$d/10-profile.conf";;
  relaxed) printf '[Service]\n' > "$d/10-profile.conf";;
  show|"") cat "$d/10-profile.conf" 2>/dev/null || echo "(no profile)"; exit 0;;
  *) echo "usage: $0 prod|tight|small|relaxed|show [--no-restart]" >&2; exit 2;;
esac
systemctl daemon-reload
[ "$restart" = 1 ] && systemctl restart esports-monitor.service || true
echo "profile: $profile"; systemctl show esports-monitor.service -p MemoryMax -p MemoryHigh -p MemorySwapMax -p CPUQuotaPerSecUSec | sed 's/^/   /'
