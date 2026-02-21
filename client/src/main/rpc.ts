/**
 * rpc.ts — IPC handler for JSON-RPC calls through the gateway.
 *
 * Routes calls through x402Client (handles payment) and uses
 * Helios for trustless verification where available.
 */

import {
  formatEther,
  formatUnits,
  encodeFunctionData,
  parseEther,
  parseUnits,
} from "viem";
import { baseSepolia } from "viem/chains";
import { x402Request } from "./x402Client";
import { loadKey } from "./keystore";
import { emitLog, log } from "./logger";
import { getHeliosProvider, isHeliosSynced } from "./helios";

/** Unwrap RPC response; throw on JSON-RPC error. */
function unwrapRpcResult<T>(raw: unknown): T {
  const res = raw as { result?: T; error?: { message?: string } };
  if (res.error)
    throw new Error(res.error.message ?? JSON.stringify(res.error));
  return res.result as T;
}

/** Parse hex string to BigInt; treat empty or "0x" as 0n (some RPCs return "0x" for zero). */
function hexToBigInt(hex: string | undefined): bigint {
  if (hex === undefined || hex === "" || hex === "0x") return 0n;
  return BigInt(hex);
}

// ERC-20 transfer ABI fragment
const ERC20_TRANSFER_ABI = [
  {
    name: "transfer",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "to", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ name: "", type: "bool" }],
  },
] as const;

// ERC-20 balanceOf ABI fragment
const ERC20_BALANCE_ABI = [
  {
    name: "balanceOf",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
] as const;

// Base Sepolia USDC contract address
const USDC_ADDRESS = "0x036CbD53842c5426634e7929541eC2318f3dCF7e" as const;

let gatewayUrl: string | null = null;

export function setGateway(url: string): void {
  gatewayUrl = url;
}

export function clearGateway(): void {
  gatewayUrl = null;
}

export function getGatewayUrl(): string | null {
  return gatewayUrl;
}

export async function getX402UsdcBalance(
  address: `0x${string}`,
): Promise<string> {
  if (!gatewayUrl) throw new Error("No gateway connected.");
  const data = encodeFunctionData({
    abi: ERC20_BALANCE_ABI,
    functionName: "balanceOf",
    args: [address],
  });
  const raw = await rpcCall("eth_call", [{ to: USDC_ADDRESS, data }, "latest"]);
  const hex = unwrapRpcResult<string>(raw);
  return formatUnits(hexToBigInt(hex), 6);
}

/**
 * Execute a JSON-RPC call.
 *
 * When Helios is synced, routes through heliosProvider.request() for
 * trustless state verification. The Helios light client internally calls
 * the local x402 proxy, which handles payment to the gateway transparently.
 *
 * Falls back to a direct x402 gateway call when Helios is not yet synced.
 */

// Methods that require EVM execution — Helios cannot trustlessly verify these
// (it would need full state to run the EVM). Routing them through Helios only
// adds a proxy hop where a payment error silently becomes a "0x" result.
// These always go straight to the direct x402 path.
const HELIOS_BYPASS = new Set(["eth_estimateGas", "eth_createAccessList"]);

export async function rpcCall(
  method: string,
  params: unknown[],
): Promise<unknown> {
  if (!gatewayUrl)
    throw new Error("No gateway connected. Set a gateway URL first.");

  const helios = getHeliosProvider();
  if (helios && isHeliosSynced() && !HELIOS_BYPASS.has(method)) {
    emitLog({
      ts: Date.now(),
      direction: "out",
      message: `→ ${method} (helios)`,
    });
    try {
      // eslint-disable-next-line @typescript-eslint/no-unsafe-call
      const result = await helios.request({ method, params });
      const preview = JSON.stringify(result)?.slice(0, 60);
      emitLog({
        ts: Date.now(),
        direction: "in",
        message: `← ${method}: ${preview}`,
      });
      // Wrap in a JSON-RPC envelope to match the shape the renderer expects.
      return { jsonrpc: "2.0", id: Date.now(), result };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log("error", `helios request failed, falling back to direct: ${msg}`);
      // Fall through to direct gateway call below.
    }
  }

  // Direct x402 path — used when Helios isn't synced or returned an error.
  const account = loadKey();
  const rpcBody = { jsonrpc: "2.0", method, params, id: Date.now() };

  emitLog({
    ts: Date.now(),
    direction: "out",
    message: `→ ${method} (direct)`,
  });

  const { result, creditsRemaining } = await x402Request(
    gatewayUrl,
    rpcBody,
    account,
    emitLog,
  );

  const rpcResult = result as { result?: unknown; error?: unknown };
  if (rpcResult.error) {
    emitLog({
      ts: Date.now(),
      direction: "error",
      message: `← error: ${JSON.stringify(rpcResult.error)}`,
    });
  } else {
    const preview = JSON.stringify(rpcResult.result)?.slice(0, 60);
    emitLog({
      ts: Date.now(),
      direction: "in",
      message: `← ${method}: ${preview}${creditsRemaining !== null ? ` [credits: ${creditsRemaining}]` : ""}`,
    });
  }

  return rpcResult;
}

/**
 * Get ETH and USDC balances for the stored key's address.
 * All RPC goes through the gateway (no direct/public RPC).
 */
export async function getBalances(): Promise<{
  address: string;
  ethBalance: string;
  usdcBalance: string;
}> {
  if (!gatewayUrl)
    throw new Error("No gateway connected. Set a gateway URL first.");
  const account = loadKey();
  const address = account.address as `0x${string}`;

  const usdcData = encodeFunctionData({
    abi: ERC20_BALANCE_ABI,
    functionName: "balanceOf",
    args: [address],
  });

  const [ethRaw, usdcRaw] = await Promise.all([
    rpcCall("eth_getBalance", [address, "latest"]),
    rpcCall("eth_call", [{ to: USDC_ADDRESS, data: usdcData }, "latest"]),
  ]);

  const ethHex = unwrapRpcResult<string>(ethRaw);
  const usdcHex = unwrapRpcResult<string>(usdcRaw);
  return {
    address: account.address,
    ethBalance: formatEther(hexToBigInt(ethHex)),
    usdcBalance: formatUnits(hexToBigInt(usdcHex), 6),
  };
}

/**
 * Sign and broadcast a token transfer through the x402 gateway.
 *
 * All RPC (nonce, gas price, broadcast) goes through the gateway so no
 * traffic leaks to a non-proxied RPC.
 *
 * @param symbol  - 'ETH' or 'USDC'
 * @param to      - recipient address
 * @param amountHuman - amount in human-readable units (e.g. "0.01" ETH)
 * @returns transaction hash
 */
export async function sendToken(
  symbol: string,
  to: string,
  amountHuman: string,
): Promise<string> {
  if (!gatewayUrl)
    throw new Error("No gateway connected. Set a gateway URL first.");

  const account = loadKey();
  const toAddr = to as `0x${string}`;

  const [nonceRaw, gasPriceRaw] = await Promise.all([
    rpcCall("eth_getTransactionCount", [account.address, "pending"]),
    rpcCall("eth_gasPrice", []),
  ]);
  const nonce = Number(unwrapRpcResult<string>(nonceRaw));
  const gasPrice = BigInt(unwrapRpcResult<string>(gasPriceRaw) ?? "0x0");

  let signedTx: `0x${string}`;

  if (symbol === "ETH") {
    signedTx = await account.signTransaction({
      type: "legacy",
      to: toAddr,
      value: parseEther(amountHuman),
      nonce,
      gasPrice,
      gas: 21000n,
      chainId: baseSepolia.id,
    });
  } else if (symbol === "USDC") {
    const data = encodeFunctionData({
      abi: ERC20_TRANSFER_ABI,
      functionName: "transfer",
      args: [toAddr, parseUnits(amountHuman, 6)],
    });
    signedTx = await account.signTransaction({
      type: "legacy",
      to: USDC_ADDRESS,
      data,
      value: 0n,
      nonce,
      gasPrice,
      gas: 65000n,
      chainId: baseSepolia.id,
    });
  } else {
    throw new Error(`Unknown token: ${symbol}`);
  }

  log(
    "info",
    `→ sending ${amountHuman} ${symbol} to ${to.slice(0, 6)}...${to.slice(-4)}`,
  );
  const raw = await rpcCall("eth_sendRawTransaction", [signedTx]);
  const res = raw as { result?: string; error?: { message?: string } };
  if (res.error)
    throw new Error(res.error.message ?? JSON.stringify(res.error));
  const txHash = res.result!;
  log("info", `✓ tx broadcast: ${txHash}`);
  return txHash;
}
