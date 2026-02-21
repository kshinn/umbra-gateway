#!/usr/bin/env bash
# clearnet-rpc.sh — Simulates a standard wallet making direct RPC calls.
#
# Run this while watch-leaks.sh is running in another terminal.
# You will see the DNS queries and TLS SNI for mainnet.base.org appear
# in the leak detector — exactly what your ISP and network observer can see.
#
# This is the "BEFORE" scenario. Our app with Tor never produces these.
#
# Usage: ./clearnet-rpc.sh [ethereum-address]

ADDRESS=${1:-"0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045"}   # vitalik.eth for demo
RPC_URL="https://mainnet.base.org"

echo ""
echo "┌─────────────────────────────────────────────────────────────────┐"
echo "│  CLEARNET RPC — simulating a standard non-private wallet        │"
echo "│  Watch the leak detector terminal for what appears on the wire  │"
echo "└─────────────────────────────────────────────────────────────────┘"
echo ""

run_call() {
  local method=$1
  local params=$2
  local label=$3

  echo "  ▶  $label"
  echo "     curl → $RPC_URL"
  echo "     $(date '+%H:%M:%S') — sending $method ..."

  result=$(curl -s -X POST "$RPC_URL" \
    -H "Content-Type: application/json" \
    -d "{\"jsonrpc\":\"2.0\",\"method\":\"$method\",\"params\":$params,\"id\":1}")

  # Pretty-print the result
  echo "$result" | python3 -m json.tool 2>/dev/null | grep -E '"result"|"error"' | head -3 || echo "$result"
  echo ""
  sleep 1
}

echo "  Querying address: $ADDRESS"
echo ""

# These calls produce visible DNS + TLS SNI for mainnet.base.org in Wireshark
run_call "eth_blockNumber"   "[]"                                        "eth_blockNumber (no address — still leaks you use Base)"
run_call "eth_getBalance"    "[\"$ADDRESS\",\"latest\"]"                 "eth_getBalance  (leaks: which address + which provider)"
run_call "eth_getTransactionCount" "[\"$ADDRESS\",\"latest\"]"           "eth_getTransactionCount (activity pattern leak)"

echo "  Done. Check the leak detector terminal — you should see:"
echo "    • DNS query for  mainnet.base.org"
echo "    • TLS SNI        mainnet.base.org  (even though it's HTTPS)"
echo ""
echo "  An observer can infer:"
echo "    • You are using an Ethereum wallet"
echo "    • You are using the Base network"
echo "    • Which wallet address(es) you queried"
echo "    • When and how often you check your balance"
echo ""
