/**
 * helios.ts — @a16z/helios light client provider lifecycle.
 *
 * Helios provides trustless RPC verification by running a light client
 * that verifies state against the chain's own proofs.
 *
 * For Base Sepolia (OP Stack): Helios uses kind='opstack'. All RPC traffic
 * (including eth_getProof used internally by Helios) routes through the local
 * x402 proxy, which forwards to the gateway with payment auth. x402 payments
 * settle on Base Sepolia; Helios verifies the same chain.
 */

import { log } from './logger'
import { startLocalProxy, stopLocalProxy } from './localProxy'

// helios is a WASM package; it may not have full TS types
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let heliosProvider: any | null = null
let heliosReady = false          // true only after waitSynced() resolves
let currentExecutionRpc: string | null = null

export type HeliosStatus = 'disconnected' | 'syncing' | 'synced' | 'error'
let heliosStatus: HeliosStatus = 'disconnected'

export function getHeliosStatus(): HeliosStatus {
  return heliosStatus
}

/**
 * Initialize the Helios light client with the given execution RPC URL.
 * Waits for the client to sync before resolving.
 *
 * If Helios WASM is not available (e.g. in non-WASM environments),
 * falls back to direct RPC calls.
 */
export async function initHelios(executionRpc: string): Promise<void> {
  // Tear down any existing instance
  if (heliosProvider) {
    try {
      await heliosProvider.shutdown?.()
    } catch {
      // ignore
    }
    heliosProvider = null
  }

  currentExecutionRpc = executionRpc
  heliosReady = false
  heliosStatus = 'syncing'

  try {
    log('info', 'helios: loading WASM...')
    const { createHeliosProvider } = await import('@a16z/helios')

    // Start the local x402 proxy so Helios can reach the payment-gated gateway.
    // Helios doesn't know about x402 — it sees a plain local HTTP endpoint.
    const proxyUrl = await startLocalProxy(executionRpc)

    log('info', 'helios: initializing light client (base-sepolia)')
    heliosProvider = await createHeliosProvider(
      {
        // Helios talks to the local proxy; the proxy handles x402 auth.
        executionRpc: proxyUrl,
        network: 'base-sepolia',
        // Use 'config' storage in Electron (no localStorage in Node context)
        dbType: 'config',
      },
      'opstack',
    )

    // Subscribe to EIP-1193 provider events for visibility.
    // Wrapped in try-catch: errors inside these callbacks run outside any
    // promise chain and would otherwise become uncaught exceptions.
    heliosProvider.on('connect', (info: { chainId: string }) => {
      try {
        log('info', `helios: connected (chainId ${info?.chainId ?? '?'})`)
      } catch { /* ignore */ }
    })
    heliosProvider.on('disconnect', (err: { message?: string }) => {
      try {
        log('error', `helios: disconnected — ${err?.message ?? 'unknown reason'}`)
      } catch { /* ignore */ }
    })
    heliosProvider.on('chainChanged', (chainId: string) => {
      try {
        log('info', `helios: chain changed to ${chainId}`)
      } catch { /* ignore */ }
    })

    log('info', 'helios: waiting for sync...')
    const t0 = Date.now()
    await heliosProvider.waitSynced()
    heliosReady = true
    log('info', `helios: synced ✓ (${Date.now() - t0}ms)`)
    heliosStatus = 'synced'
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    log('error', `helios: failed to initialize — ${msg}`)
    console.warn('[helios] Failed to initialize light client, using direct RPC:', err)
    heliosProvider = null
    heliosReady = false
    heliosStatus = 'error'
  }
}

/**
 * Shut down the Helios provider (called on app quit / gateway disconnect).
 */
export async function shutdownHelios(): Promise<void> {
  if (heliosProvider) {
    log('info', 'helios: shutting down')
    try {
      await heliosProvider.shutdown?.()
    } catch {
      // ignore
    }
    heliosProvider = null
    heliosReady = false
  }
  await stopLocalProxy()
  currentExecutionRpc = null
  heliosStatus = 'disconnected'
}

/**
 * Returns the active Helios provider, or null if not initialized / not synced.
 */
export function getHeliosProvider(): unknown {
  return heliosProvider
}

/**
 * Returns the current execution RPC URL (gateway URL).
 */
export function getExecutionRpc(): string | null {
  return currentExecutionRpc
}

/**
 * Returns true only after the Helios provider has completed waitSynced().
 * heliosProvider being non-null is not sufficient — it is assigned before
 * waitSynced() resolves, and during that window Helios internally buffers
 * any requests made through it, which causes a backlog burst on sync completion.
 */
export function isHeliosSynced(): boolean {
  return heliosReady
}
