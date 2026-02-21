#!/usr/bin/env bash
# watch-leaks.sh — Live "leak detector" using tshark.
#
# Prints DNS queries and TLS ServerName Indication (SNI) as they happen.
# Run this in one terminal while making wallet calls in another.
#
# What each line tells you:
#   DNS  col — you queried this hostname (tells your ISP and any observer
#               which RPC provider you are using)
#   SNI  col — the hostname inside the TLS handshake (visible even when
#               DNS is encrypted, e.g. DoH/DoT)
#
# When using our .onion gateway over Tor:
#   • No DNS queries for RPC providers appear
#   • No recognisable SNI appears (only noise from other apps)
#   • The wallet address and JSON-RPC method names are never on the wire

set -euo pipefail

TSHARK="/Applications/Wireshark.app/Contents/MacOS/tshark"

# Highlight-friendly header
echo ""
echo "┌─────────────────────────────────────────────────────────────────┐"
echo "│  LEAK DETECTOR — watching DNS + TLS SNI on en0 + lo0           │"
echo "│  RPC provider queries will appear below if traffic is clearnet  │"
echo "│  Press Ctrl-C to stop                                           │"
echo "└─────────────────────────────────────────────────────────────────┘"
echo ""
printf "%-12s  %-5s  %-45s  %s\n" "TIME(s)" "PROTO" "HOST/SNI" "SRC→DST"
printf "%-12s  %-5s  %-45s  %s\n" "───────────" "─────" "────────────────────────────────────────────" "──────────────────"

sudo "$TSHARK" \
  -i en0 -i lo0 \
  -l \
  -n \
  -T fields \
  -e frame.time_relative \
  -e _ws.col.Protocol \
  -e dns.qry.name \
  -e tls.handshake.extensions_server_name \
  -e ip.src \
  -e ip.dst \
  -Y "dns.qry.name or tls.handshake.type == 1" \
  -E separator='|' \
  -E header=n \
  2>/dev/null \
| awk -F'|' '
{
  time  = $1
  proto = $2
  dns   = $3
  sni   = $4
  src   = $5
  dst   = $6

  host = (dns != "") ? dns : sni
  if (host == "") next

  # Flag known RPC providers
  flag = ""
  if (host ~ /alchemy|infura|quicknode|ankr|base\.org|coinbase|drpc|llamarpc|rpc\./) {
    flag = "  ◀ RPC PROVIDER"
  }

  printf "%-12s  %-5s  %-45s  %s→%s%s\n",
    substr(time,1,10), (dns!="")?"DNS":"SNI", host, src, dst, flag
}
'
