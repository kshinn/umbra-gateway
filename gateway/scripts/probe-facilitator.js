/**
 * probe-facilitator.js — Directly interrogates the x402.org facilitator.
 *
 * 1. Fetches https://www.x402.org/protected to capture real payment requirements
 * 2. Signs a payment using those exact requirements
 * 3. POSTs directly to the facilitator /verify (no gateway in the loop)
 *
 * Usage:
 *   PRIVATE_KEY=0x... node probe-facilitator.js
 */

import { privateKeyToAccount } from "viem/accounts";
import { toHex, getAddress } from "viem";

const PRIVATE_KEY = process.env.PRIVATE_KEY;
if (!PRIVATE_KEY) { console.error("PRIVATE_KEY required"); process.exit(1); }

const account = privateKeyToAccount(PRIVATE_KEY);
const FACILITATOR = "https://www.x402.org/facilitator";

// ---------------------------------------------------------------------------
// Step 1: get real requirements from x402.org/protected
// ---------------------------------------------------------------------------
console.log("=== Step 1: fetching payment requirements from x402.org/protected ===");
const probeResp = await fetch("https://www.x402.org/protected");
console.log("status:", probeResp.status);

const allHeaders = {};
for (const [k, v] of probeResp.headers) allHeaders[k] = v;
console.log("headers:", JSON.stringify(allHeaders, null, 2));

const rawBody = await probeResp.text();
console.log("body:", rawBody);

// Try both header name casings
const prHeader = probeResp.headers.get("x-payment-required")
  || probeResp.headers.get("payment-required");
if (!prHeader) { console.error("No payment-required header found"); process.exit(1); }

const requirements = JSON.parse(Buffer.from(prHeader, "base64").toString("utf8"));
console.log("\nDecoded requirements:", JSON.stringify(requirements, null, 2));

// ---------------------------------------------------------------------------
// Step 2: sign using the real requirements
// ---------------------------------------------------------------------------
const req = requirements.accepts?.[0] ?? requirements;
console.log("\n=== Step 2: signing with real requirements ===");
console.log("scheme:", req.scheme);
console.log("network:", req.network);
console.log("extra:", JSON.stringify(req.extra));

const chainId       = BigInt(req.network.split(":")[1]);
const domainName    = req.extra?.name    ?? "USDC";
const domainVersion = req.extra?.version ?? "2";
const usdcAddress   = getAddress(req.asset);
const payTo         = getAddress(req.payTo);
const value         = BigInt(req.maxAmountRequired ?? req.amount);
const validAfter    = 0n;
const validBefore   = BigInt(Math.floor(Date.now() / 1000) + 300);
const nonce         = toHex(crypto.getRandomValues(new Uint8Array(32)));

console.log(`domain: name="${domainName}" version="${domainVersion}" chainId=${chainId}`);
console.log(`verifyingContract: ${usdcAddress}`);

const signature = await account.signTypedData({
  domain: { name: domainName, version: domainVersion, chainId, verifyingContract: usdcAddress },
  types: {
    TransferWithAuthorization: [
      { name: "from",        type: "address" },
      { name: "to",          type: "address" },
      { name: "value",       type: "uint256" },
      { name: "validAfter",  type: "uint256" },
      { name: "validBefore", type: "uint256" },
      { name: "nonce",       type: "bytes32" },
    ],
  },
  primaryType: "TransferWithAuthorization",
  message: { from: account.address, to: payTo, value, validAfter, validBefore, nonce },
});
console.log("signature:", signature.slice(0, 20) + "...");

// ---------------------------------------------------------------------------
// Step 3: POST /verify with correct v2 structure
//
// v2 embeds the chosen requirements inside paymentPayload.accepted.
// No separate paymentRequirements field — it's self-contained.
// ---------------------------------------------------------------------------
console.log(`\n=== Step 3: POST /verify with v2 structure ===`);

const paymentPayload = {
  x402Version: 2,
  resource: requirements.resource,  // url/description/mimeType from the 402
  accepted: req,                     // the chosen requirements entry (has scheme, network, amount, extra…)
  payload: {
    signature,
    authorization: {
      from:        account.address,
      to:          payTo,
      value:       value.toString(),
      validAfter:  validAfter.toString(),
      validBefore: validBefore.toString(),
      nonce,
    },
  },
};

const body = JSON.stringify({ x402Version: 2, paymentPayload, paymentRequirements: req });

console.log("request body:", JSON.stringify(JSON.parse(body), null, 2));

const resp = await fetch(`${FACILITATOR}/verify`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body,
});

const text = await resp.text();
console.log(`response (${resp.status}):`, text);
