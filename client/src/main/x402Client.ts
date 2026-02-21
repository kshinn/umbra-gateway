/**
 * x402Client.ts — Payment intercept layer for x402 v2 protocol.
 *
 * Handles the full payment cycle:
 *   1. POST request → if 402, parse Payment-Required header
 *   2. Sign EIP-3009 TransferWithAuthorization
 *   3. POST with Payment-Signature header → receive X-Payment-Token JWT
 *   4. Cache JWT; retry subsequent calls with Authorization: Bearer <token>
 *
 * All requests to a given gateway are serialized through a per-gateway queue.
 * This prevents concurrent payment flows (which cause "payment settlement
 * failed" cascades) and gives Helios's rapid-fire proof requests a buffer
 * while a token is being acquired.
 *
 * After a payment failure a cooldown blocks further attempts for
 * PAYMENT_COOLDOWN_MS, stopping the flood of retries.
 */

import { toHex, getAddress } from 'viem'
import type { PrivateKeyAccount } from 'viem/accounts'
import { gatewayFetch } from './gatewayFetch'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface PaymentRequirement {
  network: string
  asset: string
  payTo: string
  amount: string
  maxAmountRequired: string
  extra?: {
    name?: string
    version?: string
  }
}

interface PaymentRequirements {
  accepts: PaymentRequirement[]
}

interface TokenEntry {
  token: string
  expiresAt: number // unix seconds
}

interface LogEntry {
  ts: number
  direction: 'out' | 'in' | 'info' | 'error'
  message: string
}

export type LogCallback = (entry: LogEntry) => void

// ---------------------------------------------------------------------------
// Token cache (per gateway URL)
// ---------------------------------------------------------------------------

const tokenCache = new Map<string, TokenEntry>()

function getCachedToken(gatewayUrl: string): string | null {
  const entry = tokenCache.get(gatewayUrl)
  if (!entry) return null
  if (Date.now() / 1000 >= entry.expiresAt - 30) {
    // Expire 30 s early to avoid races at the boundary
    tokenCache.delete(gatewayUrl)
    return null
  }
  return entry.token
}

function setCachedToken(gatewayUrl: string, token: string): void {
  // JWT exp claim — decode without verifying (we trust our own gateway)
  let expiresAt = Date.now() / 1000 + 3600 // default 1h
  try {
    const parts = token.split('.')
    if (parts.length === 3) {
      const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'))
      if (typeof payload.exp === 'number') expiresAt = payload.exp
    }
  } catch {
    // ignore parse errors — use default expiry
  }
  tokenCache.set(gatewayUrl, { token, expiresAt })
}

function clearCachedToken(gatewayUrl: string): void {
  tokenCache.delete(gatewayUrl)
}

// ---------------------------------------------------------------------------
// Per-gateway serial request queue
//
// Only one request runs at a time per gateway. This prevents concurrent
// payment flows. Requests that arrive while another is in flight are buffered
// and drained in order. Once a token is cached, subsequent queued requests
// skip straight to the Authorization header path (fast).
// ---------------------------------------------------------------------------

type QueueResult = { result: unknown; creditsRemaining: number | null }

interface QueuedItem {
  task: () => Promise<QueueResult>
  resolve: (v: QueueResult) => void
  reject: (e: unknown) => void
}

const queues = new Map<string, QueuedItem[]>()
const draining = new Set<string>()

function enqueue(gatewayUrl: string, task: () => Promise<QueueResult>): Promise<QueueResult> {
  return new Promise<QueueResult>((resolve, reject) => {
    if (!queues.has(gatewayUrl)) queues.set(gatewayUrl, [])
    queues.get(gatewayUrl)!.push({ task, resolve, reject })
    if (!draining.has(gatewayUrl)) void drainQueue(gatewayUrl)
  })
}

async function drainQueue(gatewayUrl: string): Promise<void> {
  draining.add(gatewayUrl)
  const queue = queues.get(gatewayUrl)!
  while (queue.length > 0) {
    const item = queue.shift()!
    try {
      item.resolve(await item.task())
    } catch (err) {
      item.reject(err)
    }
  }
  draining.delete(gatewayUrl)
}

// ---------------------------------------------------------------------------
// Payment failure cooldown
//
// After a payment is rejected, new payment attempts are blocked for
// PAYMENT_COOLDOWN_MS. Queued requests that would need a new token will fail
// fast with a clear message rather than hammering the gateway.
// ---------------------------------------------------------------------------

const PAYMENT_COOLDOWN_MS = 8000
const lastPaymentFailure = new Map<string, number>()

function isInCooldown(gatewayUrl: string): boolean {
  const t = lastPaymentFailure.get(gatewayUrl)
  return t !== undefined && Date.now() - t < PAYMENT_COOLDOWN_MS
}

function cooldownRemaining(gatewayUrl: string): number {
  const t = lastPaymentFailure.get(gatewayUrl) ?? 0
  return Math.max(0, Math.ceil((PAYMENT_COOLDOWN_MS - (Date.now() - t)) / 1000))
}

// ---------------------------------------------------------------------------
// EIP-3009 helpers
// ---------------------------------------------------------------------------

function chainIdFromCaip2(network: string): bigint {
  const parts = network.split(':')
  if (parts.length !== 2 || parts[0] !== 'eip155') {
    throw new Error(`Unsupported CAIP-2 network: ${network}`)
  }
  return BigInt(parts[1])
}

async function signTransferWithAuthorization(
  account: PrivateKeyAccount,
  {
    chainId,
    usdcAddress,
    domainName,
    domainVersion,
    to,
    value,
    validAfter,
    validBefore,
    nonce,
  }: {
    chainId: bigint
    usdcAddress: `0x${string}`
    domainName: string
    domainVersion: string
    to: `0x${string}`
    value: bigint
    validAfter: bigint
    validBefore: bigint
    nonce: `0x${string}`
  },
): Promise<string> {
  const domain = {
    name: domainName,
    version: domainVersion,
    chainId,
    verifyingContract: usdcAddress,
  }

  const types = {
    TransferWithAuthorization: [
      { name: 'from', type: 'address' },
      { name: 'to', type: 'address' },
      { name: 'value', type: 'uint256' },
      { name: 'validAfter', type: 'uint256' },
      { name: 'validBefore', type: 'uint256' },
      { name: 'nonce', type: 'bytes32' },
    ],
  } as const

  const message = {
    from: account.address,
    to,
    value,
    validAfter,
    validBefore,
    nonce,
  }

  return account.signTypedData({
    domain,
    types,
    primaryType: 'TransferWithAuthorization',
    message,
  })
}

// ---------------------------------------------------------------------------
// Core request logic (runs serially via the queue)
// ---------------------------------------------------------------------------

async function processRequest(
  gatewayUrl: string,
  endpoint: string,
  rpcBody: object,
  account: PrivateKeyAccount,
  log: LogCallback,
): Promise<QueueResult> {
  const method = (rpcBody as { method?: string }).method ?? '?'

  // --- Fast path: use cached token ---
  const cached = getCachedToken(gatewayUrl)
  if (cached) {
    log({ ts: Date.now(), direction: 'out', message: `→ ${method} (cached token)` })
    const resp = await gatewayFetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cached}` },
      body: JSON.stringify(rpcBody),
    })
    const creditsRemaining = parseCredits(resp.headers.get('X-Rpc-Credits-Remaining'))
    if (resp.status === 200) {
      const body = await resp.json()
      log({ ts: Date.now(), direction: 'in', message: `← ${method}: result (credits: ${creditsRemaining ?? '?'})` })
      return { result: body, creditsRemaining }
    }
    if (resp.status === 402) {
      clearCachedToken(gatewayUrl)
      log({ ts: Date.now(), direction: 'info', message: '← token exhausted, re-paying...' })
    } else {
      const text = await resp.text()
      throw new Error(`Gateway error ${resp.status}: ${text}`)
    }
  }

  // --- Cooldown check ---
  if (isInCooldown(gatewayUrl)) {
    throw new Error(`x402 payment cooling down — ${cooldownRemaining(gatewayUrl)}s remaining`)
  }

  // --- Probe → 402 ---
  log({ ts: Date.now(), direction: 'out', message: `→ probe 402...` })
  const probeResp = await gatewayFetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(rpcBody),
  })

  if (probeResp.status !== 402) {
    if (probeResp.status === 200) {
      const body = await probeResp.json()
      log({ ts: Date.now(), direction: 'in', message: `← result (no payment required)` })
      return { result: body, creditsRemaining: null }
    }
    const text = await probeResp.text()
    throw new Error(`Expected 402, got ${probeResp.status}: ${text}`)
  }

  const headerValue = probeResp.headers.get('Payment-Required')
  if (!headerValue) throw new Error('402 response missing Payment-Required header')

  const requirements: PaymentRequirements = JSON.parse(
    Buffer.from(headerValue, 'base64').toString('utf8'),
  )
  const raw = requirements.accepts[0]
  const req: PaymentRequirement = {
    ...raw,
    payTo: getAddress(raw.payTo),
    asset: getAddress(raw.asset),
  }

  log({
    ts: Date.now(),
    direction: 'in',
    message: `← Payment required: ${req.amount} USDC atoms (network: ${req.network})`,
  })

  // --- Sign EIP-3009 ---
  const chainId = chainIdFromCaip2(req.network)

  const BASE_SEPOLIA_CHAIN_ID = 84532n
  if (chainId !== BASE_SEPOLIA_CHAIN_ID) {
    throw new Error(
      `x402: gateway requested payment on unsupported network ${req.network} — only eip155:84532 (Base Sepolia) is accepted`,
    )
  }

  const value = BigInt(req.amount)
  log({
    ts: Date.now(),
    direction: 'info',
    message: `→ signing EIP-3009: ${account.address} → ${req.payTo} (${value} atoms on ${req.network})`,
  })

  const validAfter = 0n
  const validBefore = BigInt(Math.floor(Date.now() / 1000) + 300) // 5-min window
  const nonce = toHex(crypto.getRandomValues(new Uint8Array(32)))
  const domainName = req.extra?.name ?? 'USDC'
  const domainVersion = req.extra?.version ?? '2'

  const signature = await signTransferWithAuthorization(account, {
    chainId,
    usdcAddress: req.asset as `0x${string}`,
    domainName,
    domainVersion,
    to: req.payTo as `0x${string}`,
    value,
    validAfter,
    validBefore,
    nonce: nonce as `0x${string}`,
  })

  // --- Build payment payload ---
  const paymentPayload = {
    x402Version: 2,
    resource: { url: endpoint, description: 'RPC access', mimeType: '' },
    accepted: req,
    payload: {
      signature,
      authorization: {
        from: account.address,
        to: req.payTo,
        value: value.toString(),
        validAfter: validAfter.toString(),
        validBefore: validBefore.toString(),
        nonce,
      },
    },
  }
  const paymentHeader = Buffer.from(JSON.stringify(paymentPayload)).toString('base64')

  // --- Submit payment ---
  log({ ts: Date.now(), direction: 'out', message: '→ submitting payment...' })
  const payResp = await gatewayFetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Payment-Signature': paymentHeader },
    body: JSON.stringify(rpcBody),
  })

  const rawBody = await payResp.text()
  if (payResp.status !== 200) {
    log({ ts: Date.now(), direction: 'error', message: `✗ payment failed: ${rawBody.trim()}` })
    lastPaymentFailure.set(gatewayUrl, Date.now())
    throw new Error(`Payment rejected (${payResp.status}): ${rawBody.trim()}`)
  }

  const token = payResp.headers.get('X-Payment-Token')
  if (!token) throw new Error('Gateway did not return X-Payment-Token')

  setCachedToken(gatewayUrl, token)
  lastPaymentFailure.delete(gatewayUrl)
  log({ ts: Date.now(), direction: 'in', message: `← token issued` })

  // --- Execute original request with the new token ---
  const rpcResp = await gatewayFetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify(rpcBody),
  })

  const creditsRemaining = parseCredits(rpcResp.headers.get('X-Rpc-Credits-Remaining'))
  if (rpcResp.status !== 200) {
    const errBody = await rpcResp.text()
    throw new Error(`RPC request failed after payment (${rpcResp.status}): ${errBody}`)
  }

  const rpcResult = await rpcResp.json()
  log({
    ts: Date.now(),
    direction: 'in',
    message: `← result (credits: ${creditsRemaining ?? '?'})`,
  })

  return { result: rpcResult, creditsRemaining }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function x402Request(
  gatewayUrl: string,
  rpcBody: object,
  account: PrivateKeyAccount,
  log: LogCallback,
): Promise<{ result: unknown; creditsRemaining: number | null }> {
  const endpoint = gatewayUrl.endsWith('/') ? gatewayUrl : `${gatewayUrl}/`
  return enqueue(gatewayUrl, () => processRequest(gatewayUrl, endpoint, rpcBody, account, log))
}

function parseCredits(header: string | null): number | null {
  if (!header) return null
  const n = parseInt(header, 10)
  return isNaN(n) ? null : n
}
