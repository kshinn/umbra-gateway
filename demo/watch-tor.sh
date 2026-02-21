#!/usr/bin/env bash
# watch-tor.sh — Show what Wireshark sees when traffic goes through Tor.
#
# Displays:
#   1. SOCKS5 handshake on loopback (app → Tor daemon)      ← wallet activity
#   2. Tor guard connections on en0 (new circuits only)     ← what observer sees
#
# The key point: Wireshark sees *only* these two things.
#   • No DNS queries for RPC providers
#   • No TLS SNI for RPC providers or the .onion gateway
#   • No wallet addresses, no JSON-RPC method names

set -euo pipefail

TSHARK="/Applications/Wireshark.app/Contents/MacOS/tshark"

# ANSI colours
GREEN='\033[0;32m'
DIM='\033[2m'
RESET='\033[0m'

echo ""
echo "┌─────────────────────────────────────────────────────────────────┐"
echo "│  TOR TRAFFIC MONITOR — SOCKS5 local + guard node connections    │"
echo "│  This is all an observer can see when the app uses Tor          │"
echo "│  Press Ctrl-C to stop                                           │"
echo "└─────────────────────────────────────────────────────────────────┘"
echo ""
printf "${GREEN}[SOCKS]${RESET} = wallet → Tor daemon (loopback)    "
printf "${DIM}[GUARD]${RESET} = new circuits to guard relays (observer view)\n"
echo ""

# ── Stream 1: SOCKS5 on loopback ─────────────────────────────────────────────
# Every packet between the app and the local Tor daemon.
# High-value: these represent actual wallet RPC calls in flight.
(
  sudo "$TSHARK" \
    -i lo0 \
    -l \
    -n \
    -T fields \
    -e frame.time_relative \
    -e ip.src \
    -e ip.dst \
    -e tcp.dstport \
    -e tcp.srcport \
    -e data.len \
    -Y "tcp.port == 9150 or tcp.port == 9050" \
    -E separator='|' \
    -E header=n \
    2>/dev/null \
  | awk -F'|' -v green='\033[0;32m' -v reset='\033[0m' '{
      if ($6 == "" || $6 == "0") next   # skip ACKs with no data
      printf green "[SOCKS]" reset " t=%-8s  %s:%s → %s:%s  bytes=%s\n",
        substr($1,1,7), $2,$5, $3,$4, $6
    }'
) &
SOCKS_PID=$!

# ── Stream 2: Guard relay connections on en0 ─────────────────────────────────
# Only TCP SYN packets (new connection opens) — suppresses the constant per-cell
# chatter that happens on established circuits.
# Low-value for wallet debugging; shown only to demonstrate what an observer
# sees: opaque IP:port pairs, no SNI, no DNS, no payload.
(
  sudo "$TSHARK" \
    -i en0 \
    -l \
    -n \
    -T fields \
    -e frame.time_relative \
    -e ip.src \
    -e ip.dst \
    -e tcp.dstport \
    -e frame.len \
    -Y "(tcp.dstport == 443 or tcp.dstport == 9001 or tcp.dstport == 9030) and tcp.flags.syn == 1 and tcp.flags.ack == 0" \
    -E separator='|' \
    -E header=n \
    2>/dev/null \
  | awk -F'|' -v dim='\033[2m' -v reset='\033[0m' '{
      printf dim "[GUARD]" reset " t=%-8s  %s → %s:%s  new-circuit\n",
        substr($1,1,7), $2, $3, $4
    }'
) &
GUARD_PID=$!

trap "kill $SOCKS_PID $GUARD_PID 2>/dev/null; exit 0" INT TERM
wait
