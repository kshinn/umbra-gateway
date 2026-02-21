#!/usr/bin/env bash
# End-to-end smoke test for the x402 gateway.
#
# Usage (direct HTTP, no Tor):
#   JWT_SECRET=<hex> GATEWAY_PAY_TO=0x... docker compose up -d
#   ./test_e2e.sh http://localhost:8080
#
# Usage (via Tor):
#   ONION=$(docker compose exec tor cat /var/lib/tor/hidden_service/hostname)
#   ./test_e2e.sh http://$ONION --tor
#
# Requirements: curl, jq
set -euo pipefail

BASE_URL="${1:-http://localhost:8080}"
TOR_FLAG="${2:-}"

CURL_OPTS=(-s -w "\n%{http_code}")
if [[ "$TOR_FLAG" == "--tor" ]]; then
  CURL_OPTS+=(--socks5-hostname localhost:9050)
fi

RPC_BODY='{"jsonrpc":"2.0","method":"eth_blockNumber","id":1}'

echo "=== Step 1: No credentials → expect 402 ==="
RESPONSE=$(curl "${CURL_OPTS[@]}" -X POST "$BASE_URL/" \
  -H "Content-Type: application/json" \
  -d "$RPC_BODY")
HTTP_CODE=$(echo "$RESPONSE" | tail -1)
BODY=$(echo "$RESPONSE" | head -1)

if [[ "$HTTP_CODE" != "402" ]]; then
  echo "FAIL: expected 402, got $HTTP_CODE"
  exit 1
fi
echo "PASS: got 402"

# Decode the Payment-Required header value to inspect requirements.
# (In a real test, this would be parsed to build the payment.)
echo ""
echo "Payment requirements (from response body):"
echo "$BODY" | jq . 2>/dev/null || echo "$BODY"

echo ""
echo "=== Step 2: Invalid JWT → expect 402 ==="
RESPONSE=$(curl "${CURL_OPTS[@]}" -X POST "$BASE_URL/" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer notavalidtoken" \
  -d "$RPC_BODY")
HTTP_CODE=$(echo "$RESPONSE" | tail -1)

if [[ "$HTTP_CODE" != "402" ]]; then
  echo "FAIL: expected 402 for invalid JWT, got $HTTP_CODE"
  exit 1
fi
echo "PASS: invalid JWT correctly rejected with 402"

echo ""
echo "=== Step 3: POST / with non-POST method → expect 400 ==="
RESPONSE=$(curl "${CURL_OPTS[@]}" -X GET "$BASE_URL/")
HTTP_CODE=$(echo "$RESPONSE" | tail -1)

if [[ "$HTTP_CODE" != "400" ]]; then
  echo "FAIL: expected 400 for GET /, got $HTTP_CODE"
  exit 1
fi
echo "PASS: GET / correctly rejected with 400"

echo ""
echo "=== All basic smoke tests passed ==="
echo ""
echo "To test the full payment flow, run the Node.js x402 client:"
echo "  node scripts/pay_and_call.js $BASE_URL"
