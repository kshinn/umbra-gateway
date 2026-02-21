import React, { useState } from 'react'

const RPC_METHODS = [
  'eth_blockNumber',
  'eth_chainId',
  'eth_gasPrice',
  'eth_getBalance',
  'eth_syncing',
  'net_version',
]

interface RpcTestPanelProps {
  connected: boolean
  hasKey: boolean
}

export function RpcTestPanel({ connected, hasKey }: RpcTestPanelProps): JSX.Element {
  const [method, setMethod] = useState('eth_blockNumber')
  const [sending, setSending] = useState(false)
  const [lastResult, setLastResult] = useState<string | null>(null)
  const [error, setError] = useState('')

  async function handleSend(): Promise<void> {
    setError('')
    setLastResult(null)
    setSending(true)
    try {
      const params: unknown[] = []
      if (method === 'eth_getBalance') {
        const address = await window.wallet.getAddress()
        params.push(address, 'latest')
      }
      const result = await window.rpc.call(method, params)
      setLastResult(JSON.stringify(result, null, 2))
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setSending(false)
    }
  }

  const canSend = connected && hasKey && !sending

  return (
    <div className="panel">
      <div className="panel-title">Test RPC Call</div>

      <div className="flex gap-2 items-center">
        <select
          className="input flex-1"
          value={method}
          onChange={(e) => setMethod(e.target.value)}
          disabled={!canSend}
        >
          {RPC_METHODS.map((m) => (
            <option key={m} value={m}>
              {m}
            </option>
          ))}
        </select>

        <button
          className="btn-primary whitespace-nowrap"
          onClick={handleSend}
          disabled={!canSend}
        >
          {sending ? 'Sending...' : 'Send'}
        </button>
      </div>

      {!connected && (
        <p className="text-slate-500 text-xs mt-2">Connect a gateway to send RPC calls.</p>
      )}
      {connected && !hasKey && (
        <p className="text-slate-500 text-xs mt-2">Import a wallet key to sign payments.</p>
      )}

      {lastResult && (
        <pre className="mt-3 text-xs text-accent-green bg-surface-0 rounded p-2 overflow-auto max-h-24">
          {lastResult}
        </pre>
      )}

      {error && <p className="text-accent-red text-xs mt-2">{error}</p>}
    </div>
  )
}
