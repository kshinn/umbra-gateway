import React from 'react'
import type { WalletKitTypes } from '@reown/walletkit'
import { hexToUtf8 } from '../walletconnect'

// ---------------------------------------------------------------------------
// Session Proposal Modal
// ---------------------------------------------------------------------------

function ProposalView({
  proposal,
  onApprove,
  onReject,
}: {
  proposal: WalletKitTypes.SessionProposal
  onApprove: () => void
  onReject: () => void
}): React.ReactElement {
  const meta = proposal.params.verifyContext?.verified ?? {}
  const peer = proposal.params.proposer.metadata
  return (
    <>
      <h2 className="text-base font-semibold text-slate-100 mb-1">Connect dApp</h2>
      <p className="text-xs text-slate-400 mb-4">
        A dApp wants to connect to your Umbra wallet on Base Sepolia.
      </p>
      <div className="flex items-center gap-3 bg-surface-2 rounded-lg p-3 mb-4">
        {peer.icons?.[0] && (
          <img src={peer.icons[0]} alt="" className="w-8 h-8 rounded-full shrink-0" />
        )}
        <div className="min-w-0">
          <div className="text-sm font-medium text-slate-200 truncate">{peer.name}</div>
          <div className="text-xs text-slate-500 truncate">{peer.url}</div>
        </div>
        {(meta as { isScam?: boolean }).isScam && (
          <span className="ml-auto text-xs text-red-400 font-medium shrink-0">⚠ Flagged</span>
        )}
      </div>
      <div className="flex gap-2 mt-2">
        <button
          onClick={onReject}
          className="flex-1 py-2 rounded-lg text-sm font-medium bg-surface-2 text-slate-300 hover:bg-surface-3 transition-colors"
        >
          Reject
        </button>
        <button
          onClick={onApprove}
          className="flex-1 py-2 rounded-lg text-sm font-medium bg-accent-green/20 text-accent-green hover:bg-accent-green/30 transition-colors"
        >
          Approve
        </button>
      </div>
    </>
  )
}

// ---------------------------------------------------------------------------
// Signing Request Modal
// ---------------------------------------------------------------------------

const METHOD_LABELS: Record<string, string> = {
  personal_sign: 'Sign Message',
  eth_sign: 'Sign Message',
  eth_signTypedData: 'Sign Typed Data',
  eth_signTypedData_v4: 'Sign Typed Data',
  eth_sendTransaction: 'Sign Transaction',
  eth_signTransaction: 'Sign Transaction',
}

function RequestPayload({
  method,
  params,
}: {
  method: string
  params: unknown[]
}): React.ReactElement {
  if (method === 'personal_sign' || method === 'eth_sign') {
    const raw = method === 'personal_sign' ? (params[0] as string) : (params[1] as string)
    const decoded = hexToUtf8(raw)
    return (
      <div className="bg-surface-2 rounded-lg p-3 text-xs font-mono text-slate-300 break-all max-h-32 overflow-y-auto">
        {decoded}
      </div>
    )
  }

  if (method === 'eth_signTypedData' || method === 'eth_signTypedData_v4') {
    try {
      const parsed = JSON.parse(params[1] as string)
      return (
        <div className="bg-surface-2 rounded-lg p-3 text-xs font-mono text-slate-300 max-h-48 overflow-y-auto whitespace-pre-wrap break-all">
          {JSON.stringify({ domain: parsed.domain, message: parsed.message }, null, 2)}
        </div>
      )
    } catch {
      return (
        <div className="bg-surface-2 rounded-lg p-3 text-xs font-mono text-slate-400 break-all">
          {params[1] as string}
        </div>
      )
    }
  }

  if (method === 'eth_sendTransaction' || method === 'eth_signTransaction') {
    const tx = params[0] as Record<string, string>
    const rows: [string, string][] = [
      ['To', tx.to ?? '—'],
      ['Value', tx.value ? `${BigInt(tx.value).toString()} wei` : '0'],
      ['Data', tx.data && tx.data !== '0x' ? tx.data.slice(0, 10) + '…' : '(none)'],
      ['Gas', tx.gas ?? 'estimated'],
    ]
    return (
      <div className="bg-surface-2 rounded-lg p-3 space-y-1">
        {rows.map(([label, value]) => (
          <div key={label} className="flex gap-2 text-xs">
            <span className="text-slate-500 w-12 shrink-0">{label}</span>
            <span className="text-slate-300 font-mono break-all">{value}</span>
          </div>
        ))}
      </div>
    )
  }

  return (
    <div className="bg-surface-2 rounded-lg p-3 text-xs font-mono text-slate-400 break-all max-h-32 overflow-y-auto">
      {JSON.stringify(params, null, 2)}
    </div>
  )
}

function RequestView({
  request,
  onApprove,
  onReject,
}: {
  request: WalletKitTypes.SessionRequest
  onApprove: () => void
  onReject: () => void
}): React.ReactElement {
  const { method, params } = request.params.request
  const label = METHOD_LABELS[method] ?? method
  const peer = request.params.request as unknown as { peer?: { metadata?: { name?: string } } }
  const dAppName = (peer as unknown as { verifyContext?: { verified?: { origin?: string } } })
    .verifyContext?.verified?.origin ?? request.topic.slice(0, 8)

  return (
    <>
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-base font-semibold text-slate-100">{label}</h2>
        <span className="text-xs text-slate-500 font-mono">{dAppName}</span>
      </div>
      <RequestPayload method={method} params={params as unknown[]} />
      <div className="flex gap-2 mt-4">
        <button
          onClick={onReject}
          className="flex-1 py-2 rounded-lg text-sm font-medium bg-surface-2 text-slate-300 hover:bg-surface-3 transition-colors"
        >
          Reject
        </button>
        <button
          onClick={onApprove}
          className="flex-1 py-2 rounded-lg text-sm font-medium bg-accent-green/20 text-accent-green hover:bg-accent-green/30 transition-colors"
        >
          Approve
        </button>
      </div>
    </>
  )
}

// ---------------------------------------------------------------------------
// Modal shell
// ---------------------------------------------------------------------------

export function WCApprovalModal({
  proposal,
  request,
  onApproveProposal,
  onRejectProposal,
  onApproveRequest,
  onRejectRequest,
}: {
  proposal: WalletKitTypes.SessionProposal | null
  request: WalletKitTypes.SessionRequest | null
  onApproveProposal: () => void
  onRejectProposal: () => void
  onApproveRequest: () => void
  onRejectRequest: () => void
}): React.ReactElement | null {
  if (!proposal && !request) return null

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <div className="w-80 bg-surface-1 border border-surface-3 rounded-xl shadow-2xl p-5">
        {proposal ? (
          <ProposalView
            proposal={proposal}
            onApprove={onApproveProposal}
            onReject={onRejectProposal}
          />
        ) : request ? (
          <RequestView
            request={request}
            onApprove={onApproveRequest}
            onReject={onRejectRequest}
          />
        ) : null}
      </div>
    </div>
  )
}
