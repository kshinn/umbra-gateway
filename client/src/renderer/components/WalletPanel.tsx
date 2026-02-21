import React, { useState, useEffect, useCallback } from 'react'
import { TOKENS, type Token } from '../tokens'

interface WalletPanelProps {
  onKeyChange: () => void
  connected: boolean
}

// Views for the pre-key flow
type SetupView = 'choose' | 'creating' | 'review' | 'importing'

interface GeneratedAccount {
  mnemonic: string
  address: string
}

// ---------------------------------------------------------------------------
// Helper: token logo
// ---------------------------------------------------------------------------

function TokenLogo({ token }: { token: Token }): JSX.Element {
  return (
    <div
      className={`w-8 h-8 rounded-full ${token.logoBg} flex items-center justify-center text-sm font-bold text-white shrink-0`}
    >
      {token.logoChar}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Send form (shown inline when user picks a token)
// ---------------------------------------------------------------------------

interface SendFormProps {
  token: Token
  maxAmount: string
  onDone: () => void
}

function SendForm({ token, maxAmount, onDone }: SendFormProps): JSX.Element {
  const [to, setTo] = useState('')
  const [amount, setAmount] = useState('')
  const [busy, setBusy] = useState(false)
  const [txHash, setTxHash] = useState('')
  const [error, setError] = useState('')

  function handleMax(): void {
    if (token.symbol === 'ETH') {
      // Leave a small buffer for gas
      const max = Math.max(0, parseFloat(maxAmount) - 0.0005)
      setAmount(max > 0 ? max.toFixed(6) : '0')
    } else {
      setAmount(maxAmount)
    }
  }

  async function handleSend(): Promise<void> {
    setError('')
    setTxHash('')
    if (!/^0x[0-9a-fA-F]{40}$/.test(to)) {
      setError('Invalid recipient address')
      return
    }
    const parsed = parseFloat(amount)
    if (isNaN(parsed) || parsed <= 0) {
      setError('Enter a valid amount')
      return
    }
    setBusy(true)
    try {
      const { txHash: hash } = await window.rpc.sendToken(token.symbol, to, amount)
      setTxHash(hash)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  if (txHash) {
    return (
      <div className="space-y-3">
        <div className="panel-title">Sent!</div>
        <p className="text-xs text-slate-400">Transaction broadcast successfully.</p>
        <p className="text-xs text-accent-green font-mono break-all">{txHash}</p>
        <button className="btn-primary w-full" onClick={onDone}>
          Done
        </button>
      </div>
    )
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <TokenLogo token={token} />
          <span className="panel-title">Send {token.symbol}</span>
        </div>
        <button className="text-slate-500 hover:text-slate-300 text-xs" onClick={onDone}>
          ✕ Cancel
        </button>
      </div>

      <div>
        <label className="text-xs text-slate-400">To</label>
        <input
          className="input font-mono text-xs mt-1 w-full"
          placeholder="0x..."
          value={to}
          onChange={(e) => setTo(e.target.value)}
          spellCheck={false}
        />
      </div>

      <div>
        <label className="text-xs text-slate-400">Amount</label>
        <div className="flex gap-1 mt-1">
          <input
            className="input font-mono text-xs flex-1"
            placeholder="0.00"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            type="number"
            min="0"
            step="any"
          />
          <button className="btn-ghost text-xs" onClick={handleMax}>
            Max
          </button>
        </div>
      </div>

      {error && <p className="text-accent-red text-xs">{error}</p>}

      <button
        className="btn-primary w-full"
        onClick={handleSend}
        disabled={busy || !to || !amount}
      >
        {busy ? 'Broadcasting...' : `Send ${token.symbol}`}
      </button>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export function WalletPanel({ onKeyChange, connected }: WalletPanelProps): JSX.Element {
  // Key state
  const [hasKey, setHasKey] = useState(false)
  const [address, setAddress] = useState<string | null>(null)

  // Setup flow
  const [setupView, setSetupView] = useState<SetupView>('choose')
  const [generated, setGenerated] = useState<GeneratedAccount | null>(null)
  const [confirmed, setConfirmed] = useState(false)
  const [importInput, setImportInput] = useState('')
  const [setupBusy, setSetupBusy] = useState(false)
  const [setupError, setSetupError] = useState('')
  const [copied, setCopied] = useState(false)

  // Token balances: symbol → formatted string
  const [balances, setBalances] = useState<Record<string, string>>({})
  const [loadingBalances, setLoadingBalances] = useState(false)
  const [balanceError, setBalanceError] = useState('')
  const [copiedAddr, setCopiedAddr] = useState(false)

  // Send flow
  const [sendingToken, setSendingToken] = useState<Token | null>(null)

  // -------------------------------------------------------------------------
  // Balances
  // -------------------------------------------------------------------------

  const fetchBalances = useCallback(async () => {
    setLoadingBalances(true)
    setBalanceError('')
    try {
      const b = await window.rpc.getBalances()
      setBalances({ ETH: b.ethBalance, USDC: b.usdcBalance })
    } catch (e) {
      setBalanceError((e as Error).message)
    } finally {
      setLoadingBalances(false)
    }
  }, [])

  // -------------------------------------------------------------------------
  // Init
  // -------------------------------------------------------------------------

  useEffect(() => {
    window.wallet.hasKey().then(setHasKey)
  }, [])

  useEffect(() => {
    if (hasKey) {
      window.wallet.getAddress().then(setAddress).catch(() => {})
      // Only auto-fetch if a gateway is already connected; otherwise the user
      // sees a spurious "No gateway connected" error and stale 0 balances.
      if (connected) fetchBalances()
    } else {
      setAddress(null)
      setBalances({})
    }
  }, [hasKey, connected, fetchBalances])

  // -------------------------------------------------------------------------
  // Address copy
  // -------------------------------------------------------------------------

  async function handleCopyAddress(): Promise<void> {
    if (!address) return
    await navigator.clipboard.writeText(address)
    setCopiedAddr(true)
    setTimeout(() => setCopiedAddr(false), 2000)
  }

  function truncate(addr: string): string {
    return `${addr.slice(0, 6)}...${addr.slice(-4)}`
  }

  // -------------------------------------------------------------------------
  // Create flow
  // -------------------------------------------------------------------------

  async function handleCreate(): Promise<void> {
    setSetupError('')
    setSetupView('creating')
    setConfirmed(false)
    try {
      const result = await window.wallet.generateAccount()
      setGenerated(result)
      setSetupView('review')
    } catch (e) {
      setSetupError((e as Error).message)
      setSetupView('choose')
    }
  }

  async function handleCopyMnemonic(): Promise<void> {
    if (!generated) return
    await navigator.clipboard.writeText(generated.mnemonic)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  function handleConfirmCreate(): void {
    setGenerated(null)
    setConfirmed(false)
    setHasKey(true)
    onKeyChange()
  }

  // -------------------------------------------------------------------------
  // Import flow
  // -------------------------------------------------------------------------

  async function handleImport(): Promise<void> {
    setSetupError('')
    setSetupBusy(true)
    try {
      await window.wallet.importKey(importInput.trim())
      setImportInput('')
      setHasKey(true)
      onKeyChange()
    } catch (e) {
      setSetupError((e as Error).message)
    } finally {
      setSetupBusy(false)
    }
  }

  // -------------------------------------------------------------------------
  // Remove key
  // -------------------------------------------------------------------------

  async function handleClear(): Promise<void> {
    await window.wallet.clearKey()
    setHasKey(false)
    setAddress(null)
    setBalances({})
    setSendingToken(null)
    setSetupView('choose')
    onKeyChange()
  }

  // =========================================================================
  // Render: key loaded
  // =========================================================================

  if (hasKey) {
    return (
      <div className="panel">
        {/* Address row */}
        <div className="flex items-center justify-between mb-3">
          <div>
            <div className="panel-title mb-0">Wallet</div>
            {address && (
              <div className="text-accent-blue font-mono text-xs mt-0.5">{truncate(address)}</div>
            )}
          </div>
          <div className="flex items-center gap-1">
            {address && (
              <button className="btn-ghost text-xs" onClick={handleCopyAddress}>
                {copiedAddr ? 'Copied!' : 'Copy'}
              </button>
            )}
            <button className="btn-danger text-xs" onClick={handleClear}>
              Remove
            </button>
          </div>
        </div>

        {/* Send form or token list */}
        {sendingToken ? (
          <SendForm
            token={sendingToken}
            maxAmount={balances[sendingToken.symbol] ?? '0'}
            onDone={() => { setSendingToken(null); fetchBalances() }}
          />
        ) : (
          <>
            <div className="divide-y divide-surface-3">
              {TOKENS.map((token) => {
                const bal = balances[token.symbol]
                const display = loadingBalances
                  ? '...'
                  : bal !== undefined
                    ? parseFloat(bal).toFixed(token.decimals === 18 ? 4 : 2)
                    : '—'

                return (
                  <div key={token.symbol} className="flex items-center gap-2.5 py-2.5">
                    <TokenLogo token={token} />
                    <div className="flex-1 min-w-0">
                      <div className="text-sm font-medium text-slate-200">{token.symbol}</div>
                      <div className="text-xs text-slate-500">{token.name}</div>
                    </div>
                    <div className="text-right mr-2">
                      <div className="text-sm font-mono text-slate-200">{display}</div>
                    </div>
                    <button
                      className="btn-ghost text-xs shrink-0"
                      onClick={() => setSendingToken(token)}
                    >
                      Send
                    </button>
                  </div>
                )
              })}
            </div>

            <div className="mt-2 flex items-center justify-between">
              {balanceError && <p className="text-accent-red text-xs">{balanceError}</p>}
              <button
                className="btn-ghost text-xs ml-auto"
                onClick={fetchBalances}
                disabled={loadingBalances}
              >
                {loadingBalances ? 'Refreshing...' : '↻ Refresh'}
              </button>
            </div>
          </>
        )}
      </div>
    )
  }

  // =========================================================================
  // Render: setup flows
  // =========================================================================

  // Choose
  if (setupView === 'choose' || setupView === 'creating') {
    return (
      <div className="panel">
        <div className="panel-title">Wallet</div>
        <div className="space-y-2">
          <button
            className="btn-primary w-full"
            onClick={handleCreate}
            disabled={setupView === 'creating'}
          >
            {setupView === 'creating' ? 'Generating...' : 'Create New Account'}
          </button>
          <button
            className="btn-ghost w-full"
            onClick={() => { setSetupError(''); setSetupView('importing') }}
            disabled={setupView === 'creating'}
          >
            Import Existing
          </button>
          {setupError && <p className="text-accent-red text-xs">{setupError}</p>}
        </div>
      </div>
    )
  }

  // Review mnemonic
  if (setupView === 'review' && generated) {
    const words = generated.mnemonic.split(' ')
    return (
      <div className="panel">
        <div className="panel-title">Back Up Seed Phrase</div>
        <div className="space-y-3">
          <p className="text-xs text-yellow-400">
            Write these 12 words down in order. This is the only way to recover your account.
          </p>
          <div className="grid grid-cols-3 gap-1">
            {words.map((word, i) => (
              <div
                key={i}
                className="flex items-center gap-1 bg-surface-3 rounded px-2 py-1 text-xs font-mono"
              >
                <span className="text-slate-500 w-4 text-right shrink-0">{i + 1}.</span>
                <span className="text-slate-200">{word}</span>
              </div>
            ))}
          </div>
          <div className="text-xs text-slate-500 font-mono">
            {truncate(generated.address)}
          </div>
          <div className="flex gap-2">
            <button className="btn-ghost flex-1 text-xs" onClick={handleCopyMnemonic}>
              {copied ? 'Copied!' : 'Copy'}
            </button>
            <button
              className="btn-primary flex-1 text-xs"
              onClick={() => setConfirmed(true)}
              disabled={confirmed}
            >
              {confirmed ? "Saved ✓" : "I've saved it"}
            </button>
          </div>
          <button className="btn-primary w-full" onClick={handleConfirmCreate} disabled={!confirmed}>
            Open Wallet
          </button>
        </div>
      </div>
    )
  }

  // Import
  return (
    <div className="panel">
      <div className="panel-title">Import Account</div>
      <div className="space-y-2">
        <textarea
          className="input font-mono text-xs resize-none h-20 w-full"
          placeholder="12 or 24-word seed phrase, or 0x private key"
          value={importInput}
          onChange={(e) => setImportInput(e.target.value)}
          spellCheck={false}
        />
        <div className="flex gap-2">
          <button
            className="btn-ghost flex-1 text-xs"
            onClick={() => { setSetupError(''); setImportInput(''); setSetupView('choose') }}
          >
            Back
          </button>
          <button
            className="btn-primary flex-1 text-xs"
            onClick={handleImport}
            disabled={setupBusy || !importInput.trim()}
          >
            {setupBusy ? 'Importing...' : 'Import'}
          </button>
        </div>
        {setupError && <p className="text-accent-red text-xs">{setupError}</p>}
      </div>
    </div>
  )
}
