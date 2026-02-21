/**
 * pay_and_call.js — Full x402 payment cycle end-to-end test.
 *
 * Walks through the complete flow:
 *   1. Probe → 402 + payment requirements
 *   2. Sign EIP-3009 TransferWithAuthorization with the given private key
 *   3. POST payment → receive batch JWT
 *   4. Make stateful RPC calls (eth_getBalance) with the JWT until credits exhausted
 *
 * Usage:
 *   PRIVATE_KEY=0x... GATEWAY_URL=http://localhost:8080 node pay_and_call.js
 *
 * Or via CLI args:
 *   node pay_and_call.js <gateway-url> <private-key-hex>
 *
 * Requires a Base Sepolia wallet funded with USDC.
 * Get testnet USDC: https://faucet.circle.com
 */

import { privateKeyToAccount } from "viem/accounts";
import { toHex, getAddress, formatEther } from "viem";

// ---------------------------------------------------------------------------
// Config — CLI args take precedence over env vars
// ---------------------------------------------------------------------------

const GATEWAY_URL = process.argv[2] || process.env.GATEWAY_URL || "http://localhost:8080";
const PRIVATE_KEY = process.argv[3] || process.env.PRIVATE_KEY;
const DEBUG = process.env.DEBUG === "1";

function dbg(label, obj) {
  if (!DEBUG) return;
  const replacer = (_, v) => typeof v === "bigint" ? v.toString() : v;
  console.log(`  [debug] ${label}:`, typeof obj === "string" ? obj : JSON.stringify(obj, replacer, 4));
}

if (!PRIVATE_KEY) {
  console.error("Error: private key required");
  console.error("  PRIVATE_KEY=0x... node pay_and_call.js");
  console.error("  node pay_and_call.js <gateway-url> <0x-private-key>");
  process.exit(1);
}

// ---------------------------------------------------------------------------
// EIP-3009 helpers
// ---------------------------------------------------------------------------

function chainIdFromCaip2(network) {
  const parts = network.split(":");
  if (parts.length !== 2 || parts[0] !== "eip155") {
    throw new Error(`Unsupported CAIP-2 network: ${network}`);
  }
  return BigInt(parts[1]);
}

async function signTransferWithAuthorization(account, {
  chainId, usdcAddress, domainName, domainVersion,
  to, value, validAfter, validBefore, nonce,
}) {
  const domain = { name: domainName, version: domainVersion, chainId, verifyingContract: usdcAddress };
  const types = {
    TransferWithAuthorization: [
      { name: "from",        type: "address" },
      { name: "to",          type: "address" },
      { name: "value",       type: "uint256" },
      { name: "validAfter",  type: "uint256" },
      { name: "validBefore", type: "uint256" },
      { name: "nonce",       type: "bytes32" },
    ],
  };
  const message = { from: account.address, to, value, validAfter, validBefore, nonce };
  const signature = await account.signTypedData({
    domain, types, primaryType: "TransferWithAuthorization", message,
  });
  return { signature, message };
}

// ---------------------------------------------------------------------------
// Gateway interaction
// ---------------------------------------------------------------------------

function rpcBody(method, params, id) {
  return JSON.stringify({ jsonrpc: "2.0", method, params, id });
}

async function probeFor402(address) {
  console.log(`\n[1/4] Probing ${GATEWAY_URL} for 402...`);

  const resp = await fetch(`${GATEWAY_URL}/`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: rpcBody("eth_getBalance", [address, "latest"], 1),
  });

  if (resp.status !== 402) {
    const body = await resp.text();
    throw new Error(`Expected 402, got ${resp.status}: ${body}`);
  }

  const headerValue = resp.headers.get("Payment-Required");
  if (!headerValue) {
    throw new Error("402 response is missing Payment-Required header");
  }

  const requirements = JSON.parse(Buffer.from(headerValue, "base64").toString("utf8"));
  dbg("402 payment requirements", requirements);
  const raw = requirements.accepts[0];

  const req = {
    ...raw,
    payTo: getAddress(raw.payTo),
    asset: getAddress(raw.asset),
  };

  console.log(`    network:           ${req.network}`);
  console.log(`    payTo:             ${req.payTo}`);
  console.log(`    asset (USDC):      ${req.asset}`);
  console.log(`    amount:            ${req.amount} atoms (${Number(req.amount) / 1e6} USDC per batch)`);
  console.log(`    maxAmountRequired: ${req.maxAmountRequired} atoms`);

  return req;
}

async function payGateway(account, req) {
  console.log(`\n[2/4] Signing EIP-3009 TransferWithAuthorization...`);

  const chainId     = chainIdFromCaip2(req.network);
  const value       = BigInt(req.amount);
  const validAfter  = 0n;
  const validBefore = BigInt(Math.floor(Date.now() / 1000) + 300);
  const nonce       = toHex(crypto.getRandomValues(new Uint8Array(32)));

  const domainName    = req.extra?.name    ?? "USDC";
  const domainVersion = req.extra?.version ?? "2";
  console.log(`    domain:    name="${domainName}" version="${domainVersion}"`);

  const { signature, message } = await signTransferWithAuthorization(account, {
    chainId,
    usdcAddress: req.asset,
    domainName,
    domainVersion,
    to:          req.payTo,
    value,
    validAfter,
    validBefore,
    nonce,
  });

  console.log(`    from:      ${account.address}`);
  console.log(`    to:        ${req.payTo}`);
  console.log(`    value:     ${value} (${Number(value) / 1e6} USDC)`);
  console.log(`    signature: ${signature.slice(0, 20)}...`);

  dbg("EIP-3009 signed message", { ...message, signature });

  const paymentPayload = {
    x402Version: 2,
    resource: { url: GATEWAY_URL + "/", description: "RPC access", mimeType: "" },
    accepted: req,
    payload: {
      signature,
      authorization: {
        from:        account.address,
        to:          req.payTo,
        value:       value.toString(),
        validAfter:  validAfter.toString(),
        validBefore: validBefore.toString(),
        nonce,
      },
    },
  };
  dbg("payment payload (pre-base64)", paymentPayload);

  const paymentHeader = Buffer.from(JSON.stringify(paymentPayload)).toString("base64");

  console.log(`\n[3/4] Submitting payment to gateway (initial call: eth_getBalance)...`);

  const resp = await fetch(`${GATEWAY_URL}/`, {
    method: "POST",
    headers: {
      "Content-Type":      "application/json",
      "Payment-Signature": paymentHeader,
    },
    body: rpcBody("eth_getBalance", [account.address, "latest"], 2),
  });

  const rawBody = await resp.text();
  dbg("gateway payment response", { status: resp.status, body: rawBody });

  if (resp.status !== 200) {
    throw new Error(`Payment rejected (${resp.status}): ${rawBody}`);
  }

  const body = JSON.parse(rawBody);
  const token = resp.headers.get("X-Payment-Token");
  if (!token) {
    throw new Error("Gateway did not return X-Payment-Token");
  }

  const creditsRemaining = resp.headers.get("X-Rpc-Credits-Remaining");
  const balanceHex = body.result;
  const balanceEth = balanceHex && balanceHex !== "0x"
    ? formatEther(BigInt(balanceHex))
    : "0";

  console.log(`    status:            ${resp.status} OK`);
  console.log(`    credits remaining: ${creditsRemaining ?? "?"}`);
  console.log(`    token:             ${token.slice(0, 40)}...`);
  console.log(`    eth_getBalance:    ${balanceHex} → ${balanceEth} ETH`);

  if (body.error) {
    console.warn(`    WARNING rpc error: ${JSON.stringify(body.error)}`);
  }

  return token;
}

async function makeRpcCalls(token, address, count = 5) {
  console.log(`\n[4/4] Making ${count} eth_getBalance calls with batch token...`);

  for (let i = 1; i <= count; i++) {
    const resp = await fetch(`${GATEWAY_URL}/`, {
      method: "POST",
      headers: {
        "Content-Type":  "application/json",
        "Authorization": `Bearer ${token}`,
      },
      body: rpcBody("eth_getBalance", [address, "latest"], 100 + i),
    });

    const remaining = resp.headers.get("X-Rpc-Credits-Remaining");
    const body = await resp.json();

    if (resp.status !== 200) {
      throw new Error(`RPC call ${i} failed (${resp.status}): ${JSON.stringify(body)}`);
    }

    const balanceHex = body.result;
    const balanceEth = balanceHex && balanceHex !== "0x"
      ? formatEther(BigInt(balanceHex))
      : "0";
    const errNote = body.error ? `  ERROR: ${JSON.stringify(body.error)}` : "";

    console.log(`    call ${i}: ${balanceHex} → ${balanceEth} ETH  credits_remaining=${remaining}${errNote}`);
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const account = privateKeyToAccount(PRIVATE_KEY);
  console.log(`Wallet:  ${account.address}`);
  console.log(`Gateway: ${GATEWAY_URL}`);

  const req   = await probeFor402(account.address);
  const token = await payGateway(account, req);
  await makeRpcCalls(token, account.address, 5);

  console.log("\nDone. Full request → payment → auth → response cycle complete.");
}

main().catch((err) => {
  console.error("\nFailed:", err.message);
  if (DEBUG) console.error(err);
  process.exit(1);
});
