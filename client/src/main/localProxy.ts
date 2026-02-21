/**
 * localProxy.ts — x402-aware local HTTP shim for the Helios light client.
 *
 * Helios doesn't understand x402 payments, so we put a tiny HTTP server
 * between it and the real gateway:
 *
 *   Helios → http://127.0.0.1:<port>  (no auth, plain JSON-RPC)
 *          → localProxy               (handles x402 token acquisition / renewal)
 *          → gateway                  (pays with USDC, returns verified response)
 *
 * The proxy reuses the same token cache as direct user calls in rpc.ts, so a
 * single payment batch covers both Helios's internal proofs and user RPC calls.
 */

import { createServer, Server } from 'http'
import type { AddressInfo } from 'net'
import { x402Request, type LogCallback } from './x402Client'
import { hasKey, loadKey } from './keystore'
import { log } from './logger'

let server: Server | null = null
let currentProxyUrl: string | null = null

// Only forward payment lifecycle events to the activity log — per-request
// noise from Helios's internal eth_getProof / eth_getBlockByHash calls would
// flood the UI.
const proxyLog: LogCallback = (entry) => {
  const msg = entry.message
  if (
    entry.direction === 'error' ||
    msg.includes('token') ||
    msg.includes('credits') ||
    msg.includes('payment') ||
    msg.includes('signing') ||
    msg.includes('submitting')
  ) {
    log(entry.direction, `[proxy] ${msg}`)
  }
}

/**
 * Start the local proxy pointed at gatewayUrl.
 * Returns the local URL to pass to Helios as executionRpc.
 */
export function startLocalProxy(gatewayUrl: string): Promise<string> {
  return new Promise((resolve, reject) => {
    stopLocalProxy().then(() => {
      server = createServer((req, res) => {
        const chunks: Buffer[] = []
        req.on('data', (chunk: Buffer) => chunks.push(chunk))
        req.on('end', () => {
          void handleRequest(gatewayUrl, Buffer.concat(chunks), res)
        })
        req.on('error', (err) => {
          log('error', `[proxy] request error: ${err.message}`)
          res.writeHead(500)
          res.end()
        })
      })

      server.listen(0, '127.0.0.1', () => {
        const port = (server!.address() as AddressInfo).port
        currentProxyUrl = `http://127.0.0.1:${port}`
        log('info', `[proxy] listening on ${currentProxyUrl}`)
        resolve(currentProxyUrl)
      })

      server.on('error', reject)
    })
  })
}

async function handleRequest(gatewayUrl: string, raw: Buffer, res: import('http').ServerResponse): Promise<void> {
  let body: object
  try {
    body = JSON.parse(raw.toString('utf8'))
  } catch {
    res.writeHead(400, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }))
    return
  }

  // If no key is loaded, the proxy can't pay. Return a clear error so Helios
  // fails fast rather than hanging on a 402.
  if (!hasKey()) {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(
      JSON.stringify({
        jsonrpc: '2.0',
        id: (body as { id?: unknown }).id ?? null,
        error: { code: -32000, message: 'No wallet key — import a key to enable Helios' },
      }),
    )
    return
  }

  try {
    const account = loadKey()
    const { result } = await x402Request(gatewayUrl, body, account, proxyLog)
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(result))
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    log('error', `[proxy] gateway error: ${msg}`)
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(
      JSON.stringify({
        jsonrpc: '2.0',
        id: (body as { id?: unknown }).id ?? null,
        error: { code: -32603, message: msg },
      }),
    )
  }
}

/**
 * Stop the proxy server if running.
 */
export function stopLocalProxy(): Promise<void> {
  return new Promise((resolve) => {
    if (!server) {
      resolve()
      return
    }
    server.close(() => {
      server = null
      currentProxyUrl = null
      resolve()
    })
  })
}

export function getProxyUrl(): string | null {
  return currentProxyUrl
}
