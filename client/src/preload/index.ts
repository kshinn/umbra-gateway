import { contextBridge, ipcRenderer } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'

// ---------------------------------------------------------------------------
// Types (shared with renderer via global window augmentation)
// ---------------------------------------------------------------------------

export interface LogEntry {
  ts: number
  direction: 'out' | 'in' | 'info' | 'error'
  message: string
}

export interface Balances {
  address: string
  ethBalance: string
  usdcBalance: string
}

export interface RpcResult {
  result?: unknown
  error?: unknown
}

// ---------------------------------------------------------------------------
// Expose electron internals (devtools etc.) in dev mode
// ---------------------------------------------------------------------------

if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('electron', electronAPI)
  } catch (error) {
    console.error(error)
  }
}

// ---------------------------------------------------------------------------
// wallet API
// ---------------------------------------------------------------------------

contextBridge.exposeInMainWorld('wallet', {
  hasKey: (): Promise<boolean> => ipcRenderer.invoke('wallet:hasKey'),

  generateAccount: (): Promise<{ mnemonic: string; address: string }> =>
    ipcRenderer.invoke('wallet:generateAccount'),

  importKey: (input: string): Promise<{ ok: boolean }> =>
    ipcRenderer.invoke('wallet:importKey', input),

  getAddress: (): Promise<string> => ipcRenderer.invoke('wallet:getAddress'),

  clearKey: (): Promise<{ ok: boolean }> => ipcRenderer.invoke('wallet:clearKey'),
})

// ---------------------------------------------------------------------------
// rpc API
// ---------------------------------------------------------------------------

contextBridge.exposeInMainWorld('rpc', {
  setGateway: (url: string): Promise<{ ok: boolean }> =>
    ipcRenderer.invoke('rpc:setGateway', url),

  disconnectGateway: (): Promise<{ ok: boolean }> =>
    ipcRenderer.invoke('rpc:disconnectGateway'),

  call: (method: string, params: unknown[]): Promise<RpcResult> =>
    ipcRenderer.invoke('rpc:call', method, params),

  getBalances: (): Promise<Balances> => ipcRenderer.invoke('rpc:getBalances'),

  sendToken: (symbol: string, to: string, amount: string): Promise<{ txHash: string }> =>
    ipcRenderer.invoke('rpc:sendToken', symbol, to, amount),
})

// ---------------------------------------------------------------------------
// tor API
// ---------------------------------------------------------------------------

contextBridge.exposeInMainWorld('tor', {
  getStatus: (): Promise<{ status: string; socksPort: number | null; bootstrapPercent: number; usingOnion: boolean }> =>
    ipcRenderer.invoke('tor:getStatus'),
})

// ---------------------------------------------------------------------------
// helios API
// ---------------------------------------------------------------------------

contextBridge.exposeInMainWorld('helios', {
  getStatus: (): Promise<{ status: string }> => ipcRenderer.invoke('helios:getStatus'),
})

// ---------------------------------------------------------------------------
// x402 API
// ---------------------------------------------------------------------------

contextBridge.exposeInMainWorld('x402', {
  getStatus: (): Promise<{ connected: boolean; usdcBalance: string | null }> =>
    ipcRenderer.invoke('x402:getStatus'),
})

// ---------------------------------------------------------------------------
// network API
// ---------------------------------------------------------------------------

contextBridge.exposeInMainWorld('network', {
  getInfo: (): Promise<{ name: string; heliosStatus: string }> =>
    ipcRenderer.invoke('network:getInfo'),
})

// ---------------------------------------------------------------------------
// wc API — WalletConnect signing (WalletKit runs in renderer; signs in main)
// ---------------------------------------------------------------------------

contextBridge.exposeInMainWorld('wc', {
  signMessage: (message: string): Promise<string> =>
    ipcRenderer.invoke('wc:signMessage', message),
  signTypedData: (raw: string): Promise<string> =>
    ipcRenderer.invoke('wc:signTypedData', raw),
  sendTransaction: (txParams: Record<string, string>): Promise<string> =>
    ipcRenderer.invoke('wc:sendTransaction', txParams),
})

// ---------------------------------------------------------------------------
// events API — streaming log from main process
// ---------------------------------------------------------------------------

contextBridge.exposeInMainWorld('events', {
  onLog: (cb: (entry: LogEntry) => void): (() => void) => {
    const listener = (_: Electron.IpcRendererEvent, entry: LogEntry): void => cb(entry)
    ipcRenderer.on('log', listener)
    return () => ipcRenderer.removeListener('log', listener)
  },
  onX402Refresh: (cb: () => void): (() => void) => {
    const listener = (): void => cb()
    ipcRenderer.on('x402:refresh', listener)
    return () => ipcRenderer.removeListener('x402:refresh', listener)
  },
})
