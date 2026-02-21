/// <reference types="vite/client" />

interface LogEntry {
  ts: number
  direction: 'out' | 'in' | 'info' | 'error'
  message: string
}

interface Balances {
  address: string
  ethBalance: string
  usdcBalance: string
}

interface RpcResult {
  jsonrpc: string
  id: number
  result?: unknown
  error?: { code: number; message: string }
}

type TorStatus = 'stopped' | 'bootstrapping' | 'ready' | 'error'
type HeliosStatus = 'disconnected' | 'syncing' | 'synced' | 'error'

interface Window {
  wallet: {
    hasKey: () => Promise<boolean>
    generateAccount: () => Promise<{ mnemonic: string; address: string }>
    importKey: (input: string) => Promise<{ ok: boolean }>
    getAddress: () => Promise<string>
    clearKey: () => Promise<{ ok: boolean }>
  }
  rpc: {
    setGateway: (url: string) => Promise<{ ok: boolean }>
    disconnectGateway: () => Promise<{ ok: boolean }>
    call: (method: string, params: unknown[]) => Promise<RpcResult>
    getBalances: () => Promise<Balances>
    sendToken: (symbol: string, to: string, amount: string) => Promise<{ txHash: string }>
  }
  tor: {
    getStatus: () => Promise<{ status: TorStatus; socksPort: number | null; bootstrapPercent: number; usingOnion: boolean }>
  }
  helios: {
    getStatus: () => Promise<{ status: HeliosStatus }>
  }
  x402: {
    getStatus: () => Promise<{ connected: boolean; usdcBalance: string | null }>
  }
  network: {
    getInfo: () => Promise<{ name: string; heliosStatus: HeliosStatus }>
  }
  events: {
    onLog: (cb: (entry: LogEntry) => void) => () => void
    onX402Refresh: (cb: () => void) => () => void
  }
  wc: {
    signMessage: (message: string) => Promise<string>
    signTypedData: (raw: string) => Promise<string>
    sendTransaction: (txParams: Record<string, string>) => Promise<string>
  }
}
