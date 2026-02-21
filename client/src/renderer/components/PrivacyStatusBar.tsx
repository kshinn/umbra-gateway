import React, { useState, useEffect } from "react";
import { Eye, ShieldCheck } from "lucide-react";

type TorStatus = "stopped" | "bootstrapping" | "ready" | "error";
type HeliosStatus = "disconnected" | "syncing" | "synced" | "error";

// ---------------------------------------------------------------------------
// Tor indicator (includes gateway connected / routing state)
//
// Dot + icon semantics:
//   Grey          — Tor process stopped
//   Red           — Tor process error
//   Yellow (none) — Tor connected but not routing (all activity local):
//                   stopped, bootstrapping, or no gateway connected
//   Yellow (eye)  — Tor connected, routing to gateway over clearnet (not onion)
//   Green (glasses)— Tor connected, routing through onion network
// ---------------------------------------------------------------------------

function torDotClass(status: TorStatus, usingOnion: boolean): string {
  if (status === "stopped") return "bg-slate-600";
  if (status === "error") return "bg-red-500";
  if (status === "bootstrapping") return "bg-yellow-500 animate-pulse";
  // ready
  return usingOnion ? "bg-accent-green" : "bg-yellow-500";
}

// TODO We probably don't need this since the label almost always "Tor"
function torLabel(
  status: TorStatus,
  usingOnion: boolean,
  gatewayConnected: boolean,
): string {
  if (status === "error") return "Tor error";
  return "Tor";
}

function TorIndicator({
  status,
  usingOnion,
  gatewayConnected,
}: {
  status: TorStatus;
  usingOnion: boolean;
  gatewayConnected: boolean;
}): React.ReactElement {
  const dotClass = torDotClass(status, usingOnion);
  const label = torLabel(status, usingOnion, gatewayConnected);
  const isRouting = gatewayConnected && status === "ready";
  const isRoutingOnion = isRouting && usingOnion;
  const isRoutingClearnet = isRouting && !usingOnion;
  return (
    <span className="flex items-center gap-1.5">
      <span className={`w-1.5 h-1.5 rounded-full ${dotClass}`} />
      <span className={isRoutingOnion ? "text-slate-300" : ""}>{label}</span>
      {isRoutingOnion && (
        <ShieldCheck
          className="w-3.5 h-3.5 shrink-0 text-slate-400"
          aria-hidden
        />
      )}
      {isRoutingClearnet && (
        <Eye className="w-3.5 h-3.5 shrink-0 text-slate-400" aria-hidden />
      )}
    </span>
  );
}

// ---------------------------------------------------------------------------
// x402 indicator
// A payment can be made when: gateway is connected AND wallet has USDC.
// ---------------------------------------------------------------------------

type X402State = "no-gateway" | "no-key" | "no-funds" | "ready";

function x402State(connected: boolean, usdcBalance: string | null): X402State {
  if (!connected) return "no-gateway";
  if (usdcBalance === null) return "no-key";
  if (parseFloat(usdcBalance) <= 0) return "no-funds";
  return "ready";
}

const X402_DOT: Record<X402State, string> = {
  "no-gateway": "bg-slate-600",
  "no-key": "bg-yellow-500 animate-pulse",
  "no-funds": "bg-orange-500",
  ready: "bg-accent-green",
};

function x402Label(state: X402State, usdcBalance: string | null): string {
  if (state === "no-gateway") return "x402 off";
  if (state === "no-key") return "x402";
  if (state === "no-funds") return "x402 · no USDC";
  // Trim trailing zeros: "5.230000" → "5.23"
  const trimmed = parseFloat(usdcBalance!).toFixed(2);
  return `x402 · ${trimmed} USDC`;
}

function X402Indicator({
  state,
  usdcBalance,
}: {
  state: X402State;
  usdcBalance: string | null;
}): React.ReactElement {
  const dotClass = X402_DOT[state];
  const label = x402Label(state, usdcBalance);
  return (
    <span className="flex items-center gap-1.5">
      <span className={`w-1.5 h-1.5 rounded-full ${dotClass}`} />
      <span className={state === "ready" ? "text-slate-300" : ""}>{label}</span>
    </span>
  );
}

// ---------------------------------------------------------------------------
// Network indicator (Helios + gateway proxy — Base Sepolia)
// ---------------------------------------------------------------------------

const NET_DOT: Record<HeliosStatus, string> = {
  disconnected: "bg-slate-600",
  syncing: "bg-yellow-500 animate-pulse",
  synced: "bg-accent-green",
  error: "bg-orange-500",
};

const NET_LABEL: Record<HeliosStatus, string> = {
  disconnected: "Base Sepolia (direct)",
  syncing: "Base Sepolia (syncing)",
  synced: "Base Sepolia",
  error: "Base Sepolia (fallback)",
};

function NetIndicator({
  heliosStatus,
}: {
  heliosStatus: HeliosStatus;
}): React.ReactElement {
  const dotClass = NET_DOT[heliosStatus];
  const label = NET_LABEL[heliosStatus];
  return (
    <span className="flex items-center gap-1.5">
      <span className={`w-1.5 h-1.5 rounded-full ${dotClass}`} />
      <span className={heliosStatus === "synced" ? "text-slate-300" : ""}>
        {label}
      </span>
    </span>
  );
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function PrivacyStatusBar(): JSX.Element {
  const [torStatus, setTorStatus] = useState<TorStatus>("stopped");
  const [torOnion, setTorOnion] = useState(false);
  const [x402Connected, setX402Connected] = useState(false);
  const [x402Usdc, setX402Usdc] = useState<string | null>(null);
  const [netHelios, setNetHelios] = useState<HeliosStatus>("disconnected");

  // Fast loop: Tor + Helios status indicators (needed during bootstrap).
  useEffect(() => {
    let cancelled = false;
    async function pollStatus(): Promise<void> {
      try {
        const [tor, net] = await Promise.all([
          window.tor.getStatus(),
          window.network.getInfo(),
        ]);
        if (!cancelled) {
          setTorStatus(tor.status as TorStatus);
          setTorOnion(tor.usingOnion);
          setNetHelios(net.heliosStatus as HeliosStatus);
        }
      } catch { /* ignore transient IPC errors */ }
    }
    pollStatus();
    const id = setInterval(pollStatus, 5000);
    return () => { cancelled = true; clearInterval(id); };
  }, []);

  // Slow loop: x402 USDC balance — only changes on payment or send.
  useEffect(() => {
    let cancelled = false;
    async function pollX402(): Promise<void> {
      try {
        const x402 = await window.x402.getStatus();
        if (!cancelled) {
          setX402Connected(x402.connected);
          setX402Usdc(x402.usdcBalance);
        }
      } catch { /* ignore transient IPC errors */ }
    }
    pollX402();
    const id = setInterval(pollX402, 30000);
    // Refresh immediately when main signals a balance change (send or payment).
    const unsub = window.events.onX402Refresh(() => { if (!cancelled) void pollX402(); });
    return () => { cancelled = true; clearInterval(id); unsub(); };
  }, []);

  const xState = x402State(x402Connected, x402Usdc);

  return (
    <div
      className="flex items-center gap-3 text-xs text-slate-400"
      style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}
    >
      <TorIndicator
        status={torStatus}
        usingOnion={torOnion}
        gatewayConnected={x402Connected}
      />
      <span className="text-slate-700">|</span>
      <X402Indicator state={xState} usdcBalance={x402Usdc} />
      <span className="text-slate-700">|</span>
      <NetIndicator heliosStatus={netHelios} />
    </div>
  );
}
