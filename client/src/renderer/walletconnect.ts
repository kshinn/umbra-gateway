/**
 * walletconnect.ts — WalletKit singleton for the renderer process.
 *
 * WalletKit runs here (renderer) because it needs browser APIs: WebSocket,
 * localStorage, crypto.subtle. Actual signing is delegated to the main
 * process via window.wc.* IPC so private keys never leave main.
 *
 * Usage from React:
 *   onProposal = (p) => setPendingProposal(p)
 *   onRequest  = (r) => setPendingRequest(r)
 *   onSessionsChange = () => setSessions(getActiveSessions())
 *   await initWalletKit(address)
 *   await pairWC(uri)
 */

import { Core } from '@walletconnect/core'
import { WalletKit, WalletKitTypes } from '@reown/walletkit'
import { buildApprovedNamespaces, getSdkError } from '@walletconnect/utils'
import type { IWalletKit } from '@reown/walletkit'
import type { SessionTypes } from '@walletconnect/types'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const CAIP_CHAIN = 'eip155:84532' // Base Sepolia
const BASE_SEPOLIA_HEX_CHAIN_ID = '0x14a34'

const SUPPORTED_METHODS = [
  'eth_sendTransaction',
  'eth_sign',
  'personal_sign',
  'eth_signTypedData',
  'eth_signTypedData_v4',
  'wallet_switchEthereumChain',
  'wallet_addEthereumChain',
]

// ---------------------------------------------------------------------------
// Singleton state
// ---------------------------------------------------------------------------

let walletKit: IWalletKit | null = null
let walletAddress: string = ''

// React sets these to wire events into component state
let onProposal: ((p: WalletKitTypes.SessionProposal) => void) | null = null
let onRequest: ((r: WalletKitTypes.SessionRequest) => void) | null = null
let onSessionsChange: (() => void) | null = null

export function setOnProposal(cb: ((p: WalletKitTypes.SessionProposal) => void) | null): void { onProposal = cb }
export function setOnRequest(cb: ((r: WalletKitTypes.SessionRequest) => void) | null): void { onRequest = cb }
export function setOnSessionsChange(cb: (() => void) | null): void { onSessionsChange = cb }

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------

export async function initWalletKit(address: string): Promise<void> {
  if (walletKit) return // already initialized
  walletAddress = address

  const projectId = import.meta.env.VITE_WALLETCONNECT_PROJECT_ID as string | undefined
  if (!projectId || projectId === 'your_project_id_here') {
    console.warn('[wc] VITE_WALLETCONNECT_PROJECT_ID not set — WalletConnect disabled')
    return
  }

  const core = new Core({ projectId })

  walletKit = await WalletKit.init({
    core,
    metadata: {
      name: 'Umbra',
      description: 'Privacy-first wallet with anonymous RPC, Helios + Tor',
      url: 'https://umbra.wallet',
      icons: [],
    },
  })

  walletKit.on('session_proposal', (proposal: WalletKitTypes.SessionProposal) => {
    onProposal?.(proposal)
  })

  walletKit.on('session_request', (event: WalletKitTypes.SessionRequest) => {
    onRequest?.(event)
  })

  walletKit.on('session_delete', () => {
    onSessionsChange?.()
  })

  // Re-emit sessions after init (may have persisted sessions from localStorage)
  onSessionsChange?.()
}

// ---------------------------------------------------------------------------
// Pairing
// ---------------------------------------------------------------------------

export async function pairWC(uri: string): Promise<void> {
  if (!walletKit) throw new Error('WalletKit not initialized — set VITE_WALLETCONNECT_PROJECT_ID')
  await walletKit.pair({ uri })
}

// ---------------------------------------------------------------------------
// Session management
// ---------------------------------------------------------------------------

export function getActiveSessions(): Record<string, SessionTypes.Struct> {
  if (!walletKit) return {}
  return walletKit.getActiveSessions()
}

export async function disconnectSession(topic: string): Promise<void> {
  if (!walletKit) return
  await walletKit.disconnectSession({ topic, reason: getSdkError('USER_DISCONNECTED') })
  onSessionsChange?.()
}

// ---------------------------------------------------------------------------
// Session proposal approve / reject
// ---------------------------------------------------------------------------

export async function approveProposal(proposal: WalletKitTypes.SessionProposal): Promise<void> {
  if (!walletKit) return
  const { id, params } = proposal
  try {
    const approvedNamespaces = buildApprovedNamespaces({
      proposal: params,
      supportedNamespaces: {
        eip155: {
          chains: [CAIP_CHAIN],
          methods: SUPPORTED_METHODS,
          events: ['accountsChanged', 'chainChanged'],
          accounts: [`${CAIP_CHAIN}:${walletAddress}`],
        },
      },
    })
    await walletKit.approveSession({ id, namespaces: approvedNamespaces })
  } catch (err) {
    // buildApprovedNamespaces throws if dApp requires unsupported methods/chains
    await walletKit.rejectSession({ id, reason: getSdkError('USER_REJECTED') })
    throw err
  }
  onSessionsChange?.()
}

export async function rejectProposal(proposal: WalletKitTypes.SessionProposal): Promise<void> {
  if (!walletKit) return
  await walletKit.rejectSession({ id: proposal.id, reason: getSdkError('USER_REJECTED') })
}

// ---------------------------------------------------------------------------
// Session request approve / reject
// ---------------------------------------------------------------------------

export async function approveRequest(event: WalletKitTypes.SessionRequest): Promise<void> {
  if (!walletKit) return
  const { topic, id, params } = event
  const { method, params: reqParams } = params.request

  try {
    const result = await handleMethod(method, reqParams as unknown[])
    await walletKit.respondSessionRequest({
      topic,
      response: { id, jsonrpc: '2.0', result },
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'User rejected'
    await walletKit.respondSessionRequest({
      topic,
      response: { id, jsonrpc: '2.0', error: { code: 5000, message } },
    })
    throw err
  }
}

export async function rejectRequest(event: WalletKitTypes.SessionRequest): Promise<void> {
  if (!walletKit) return
  const { topic, id } = event
  await walletKit.respondSessionRequest({
    topic,
    response: { id, jsonrpc: '2.0', error: { code: 4001, message: 'User rejected the request' } },
  })
}

// ---------------------------------------------------------------------------
// Method dispatch
// ---------------------------------------------------------------------------

async function handleMethod(method: string, params: unknown[]): Promise<unknown> {
  switch (method) {
    case 'personal_sign':
      // params: [message (hex), address]
      return window.wc.signMessage(params[0] as string)

    case 'eth_sign':
      // params: [address, message (hex)]
      return window.wc.signMessage(params[1] as string)

    case 'eth_signTypedData':
    case 'eth_signTypedData_v4':
      // params: [address, typedDataJson]
      return window.wc.signTypedData(params[1] as string)

    case 'eth_sendTransaction':
      // params: [txObject]
      return window.wc.sendTransaction(params[0] as Record<string, string>)

    case 'wallet_switchEthereumChain': {
      const chainId = (params[0] as { chainId: string }).chainId
      if (chainId !== BASE_SEPOLIA_HEX_CHAIN_ID) {
        throw new Error(`Chain ${chainId} not supported — Umbra is Base Sepolia only`)
      }
      return null
    }

    case 'wallet_addEthereumChain':
      // Acknowledge; we don't actually add chains
      return null

    default:
      throw new Error(`Unsupported method: ${method}`)
  }
}

// ---------------------------------------------------------------------------
// Helpers (exported for use in modals)
// ---------------------------------------------------------------------------

/** Decode a hex string to UTF-8 text; returns raw hex on failure. */
export function hexToUtf8(hex: string): string {
  try {
    const clean = hex.startsWith('0x') ? hex.slice(2) : hex
    const bytes = new Uint8Array(clean.match(/.{1,2}/g)!.map((b) => parseInt(b, 16)))
    return new TextDecoder().decode(bytes)
  } catch {
    return hex
  }
}
