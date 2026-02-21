import React, { useState, useEffect, useCallback } from 'react'
import type { SessionTypes } from '@walletconnect/types'
import {
  initWalletKit,
  pairWC,
  getActiveSessions,
  disconnectSession,
  setOnProposal,
  setOnRequest,
  setOnSessionsChange,
} from '../walletconnect'

interface Props {
  hasKey: boolean
  onProposal: (p: import('@reown/walletkit').WalletKitTypes.SessionProposal) => void
  onRequest: (r: import('@reown/walletkit').WalletKitTypes.SessionRequest) => void
}

export function WalletConnectPanel({ hasKey, onProposal, onRequest }: Props): React.ReactElement {
  const [uri, setUri] = useState('')
  const [sessions, setSessions] = useState<SessionTypes.Struct[]>([])
  const [pairing, setPairing] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const refreshSessions = useCallback(() => {
    setSessions(Object.values(getActiveSessions()))
  }, [])

  // Wire WalletKit event callbacks and init once a key exists
  useEffect(() => {
    if (!hasKey) return

    setOnProposal(onProposal)
    setOnRequest(onRequest)
    setOnSessionsChange(refreshSessions)

    window.wallet.getAddress().then((address) => {
      initWalletKit(address).then(refreshSessions).catch(console.error)
    })

    return () => {
      setOnProposal(null)
      setOnRequest(null)
      setOnSessionsChange(null)
    }
  }, [hasKey, onProposal, onRequest, refreshSessions])

  const handlePair = useCallback(async () => {
    const trimmed = uri.trim()
    if (!trimmed) return
    setError(null)
    setPairing(true)
    try {
      await pairWC(trimmed)
      setUri('')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Pairing failed')
    } finally {
      setPairing(false)
    }
  }, [uri])

  const handleDisconnect = useCallback(async (topic: string) => {
    await disconnectSession(topic)
    refreshSessions()
  }, [refreshSessions])

  return (
    <div className="bg-surface-1 border border-surface-3 rounded-xl p-4 flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <span className="text-sm font-medium text-slate-200">WalletConnect</span>
        {sessions.length > 0 && (
          <span className="text-xs text-slate-500">{sessions.length} session{sessions.length !== 1 ? 's' : ''}</span>
        )}
      </div>

      {/* URI input + pair button */}
      <div className="flex gap-2">
        <input
          type="text"
          value={uri}
          onChange={(e) => setUri(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && handlePair()}
          placeholder="wc:…"
          disabled={!hasKey || pairing}
          className="flex-1 bg-surface-2 border border-surface-3 rounded-lg px-3 py-1.5 text-xs text-slate-200 placeholder-slate-600 focus:outline-none focus:border-slate-500 disabled:opacity-40"
        />
        <button
          onClick={handlePair}
          disabled={!hasKey || !uri.trim() || pairing}
          className="px-3 py-1.5 rounded-lg text-xs font-medium bg-surface-2 text-slate-300 hover:bg-surface-3 disabled:opacity-40 transition-colors"
        >
          {pairing ? '…' : 'Pair'}
        </button>
      </div>

      {error && <p className="text-xs text-red-400">{error}</p>}

      {!hasKey && (
        <p className="text-xs text-slate-500">Import a wallet key to use WalletConnect.</p>
      )}

      {/* Active sessions */}
      {sessions.length > 0 && (
        <div className="flex flex-col gap-1.5">
          {sessions.map((session) => (
            <div
              key={session.topic}
              className="flex items-center gap-2 bg-surface-2 rounded-lg px-3 py-2"
            >
              {session.peer.metadata.icons?.[0] && (
                <img
                  src={session.peer.metadata.icons[0]}
                  alt=""
                  className="w-4 h-4 rounded-full shrink-0"
                />
              )}
              <span className="flex-1 text-xs text-slate-300 truncate">
                {session.peer.metadata.name}
              </span>
              <button
                onClick={() => handleDisconnect(session.topic)}
                className="text-xs text-slate-500 hover:text-red-400 transition-colors shrink-0"
              >
                ✕
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
