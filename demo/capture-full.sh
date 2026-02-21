#!/usr/bin/env bash
# capture-full.sh — Record a full pcap for post-analysis or replay.
#
# Captures all traffic on both Wi-Fi (en0) and loopback (lo0) for a fixed
# duration, then dumps a summary of what was found.
#
# Usage:
#   ./capture-full.sh [duration_seconds] [output.pcapng]
#
# Examples:
#   ./capture-full.sh 30                          # 30s capture to timestamped file
#   ./capture-full.sh 60 demo-clearnet.pcapng     # 60s capture to named file
#   ./capture-full.sh 60 demo-tor.pcapng          # run again after switching modes

set -euo pipefail

TSHARK="/Applications/Wireshark.app/Contents/MacOS/tshark"
DURATION=${1:-30}
OUTPUT=${2:-"capture-$(date +%Y%m%d-%H%M%S).pcapng"}

echo ""
echo "Capturing ${DURATION}s of traffic → ${OUTPUT}"
echo "Interfaces: en0 (Wi-Fi) + lo0 (loopback/Tor SOCKS)"
echo ""

sudo "$TSHARK" \
  -i en0 -i lo0 \
  -a duration:"$DURATION" \
  -w "$OUTPUT" \
  -f "not arp and not mdns and not ssdp and not icmpv6" \
  2>&1 | grep -v "^Capturing on"

echo ""
echo "Capture complete: $OUTPUT"
echo ""
echo "──────────────────────────────────────"
echo "SUMMARY"
echo "──────────────────────────────────────"
echo ""

# 1. RPC provider DNS queries
echo "▶ DNS queries for known RPC providers:"
"$TSHARK" -r "$OUTPUT" \
  -T fields -e dns.qry.name \
  -Y "dns.qry.name" \
  2>/dev/null \
| grep -E "alchemy|infura|quicknode|ankr|base\.org|coinbase|drpc|llamarpc|rpc\." \
| sort -u \
| sed 's/^/    /' \
|| echo "    (none found — good if using Tor)"

echo ""

# 2. TLS SNI for RPC providers
echo "▶ TLS ClientHello SNI for known RPC providers:"
"$TSHARK" -r "$OUTPUT" \
  -T fields -e tls.handshake.extensions_server_name \
  -Y "tls.handshake.type == 1" \
  2>/dev/null \
| grep -E "alchemy|infura|quicknode|ankr|base\.org|coinbase|drpc|llamarpc|rpc\." \
| sort -u \
| sed 's/^/    /' \
|| echo "    (none found — good if using Tor)"

echo ""

# 3. SOCKS5 traffic (Tor usage)
SOCKS_COUNT=$("$TSHARK" -r "$OUTPUT" \
  -Y "tcp.port == 9150 or tcp.port == 9050" \
  2>/dev/null | wc -l | tr -d ' ')
echo "▶ SOCKS5 packets (Tor): $SOCKS_COUNT"

echo ""

# 4. Any plaintext JSON-RPC (HTTP, not HTTPS)
echo "▶ Plaintext JSON-RPC (unencrypted HTTP):"
"$TSHARK" -r "$OUTPUT" \
  -T fields -e http.request.uri -e http.file_data \
  -Y "http contains \"jsonrpc\"" \
  2>/dev/null \
| head -5 \
| sed 's/^/    /' \
|| echo "    (none found)"

echo ""
echo "──────────────────────────────────────"
echo "Open in Wireshark:  open $OUTPUT"
echo "Or: /Applications/Wireshark.app/Contents/MacOS/Wireshark $OUTPUT"
echo "──────────────────────────────────────"
