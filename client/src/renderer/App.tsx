import React, { useState, useEffect, useCallback } from "react";
import { WalletPanel } from "./components/WalletPanel";
import { GatewayPanel } from "./components/GatewayPanel";
import { RpcTestPanel } from "./components/RpcTestPanel";
import { ActivityLog } from "./components/ActivityLog";
import { PrivacyStatusBar } from "./components/PrivacyStatusBar";
import { WalletConnectPanel } from "./components/WalletConnectPanel";
import { WCApprovalModal } from "./components/WCApprovalModal";
import type { LogEntry } from "./components/ActivityLog";
import type { WalletKitTypes } from "@reown/walletkit";
import {
  approveProposal,
  rejectProposal,
  approveRequest,
  rejectRequest,
} from "./walletconnect";

export default function App(): JSX.Element {
  const [connected, setConnected] = useState(false);
  const [gatewayUrl, setGatewayUrl] = useState("http://localhost:8080");
  const [hasKey, setHasKey] = useState(false);
  const [logs, setLogs] = useState<LogEntry[]>([]);

  // WalletConnect approval state
  const [pendingProposal, setPendingProposal] =
    useState<WalletKitTypes.SessionProposal | null>(null);
  const [pendingRequest, setPendingRequest] =
    useState<WalletKitTypes.SessionRequest | null>(null);

  // Check initial key state
  useEffect(() => {
    window.wallet.hasKey().then(setHasKey);
  }, []);

  // Subscribe to log stream from main process
  useEffect(() => {
    const unsub = window.events.onLog((entry) => {
      setLogs((prev) => [...prev, entry]);
    });
    return unsub;
  }, []);

  const handleConnect = useCallback((url: string) => {
    setGatewayUrl(url);
    setConnected(true);
  }, []);

  const handleDisconnect = useCallback(() => {
    setConnected(false);
  }, []);

  const handleKeyChange = useCallback(() => {
    window.wallet.hasKey().then(setHasKey);
  }, []);

  // WalletConnect modal handlers
  const handleApproveProposal = useCallback(async () => {
    if (!pendingProposal) return;
    await approveProposal(pendingProposal).catch(console.error);
    setPendingProposal(null);
  }, [pendingProposal]);

  const handleRejectProposal = useCallback(async () => {
    if (!pendingProposal) return;
    await rejectProposal(pendingProposal).catch(console.error);
    setPendingProposal(null);
  }, [pendingProposal]);

  const handleApproveRequest = useCallback(async () => {
    if (!pendingRequest) return;
    await approveRequest(pendingRequest).catch(console.error);
    setPendingRequest(null);
  }, [pendingRequest]);

  const handleRejectRequest = useCallback(async () => {
    if (!pendingRequest) return;
    await rejectRequest(pendingRequest).catch(console.error);
    setPendingRequest(null);
  }, [pendingRequest]);

  return (
    <div className="flex flex-col h-full bg-surface-0 text-slate-200 select-none">
      {/* Title bar */}
      <div
        className="flex items-center justify-between px-4 py-2 bg-surface-1 border-b border-surface-3"
        style={{ WebkitAppRegion: "drag" } as React.CSSProperties}
      >
        <span className="text-sm font-semibold text-slate-200 mx-20">
          Full Stack Privacy
        </span>
        <div className="flex items-center gap-4">
          <PrivacyStatusBar />
        </div>
      </div>

      {/* Content */}
      <div className="flex flex-col flex-1 gap-3 p-4 overflow-hidden">
        {/* Top row: wallet + gateway + walletconnect */}
        <div className="grid grid-cols-2 gap-3">
          <WalletPanel onKeyChange={handleKeyChange} connected={connected} />
          <GatewayPanel
            connected={connected}
            gatewayUrl={gatewayUrl}
            onConnect={handleConnect}
            onDisconnect={handleDisconnect}
          />
          {/*<WalletConnectPanel
            hasKey={hasKey}
            onProposal={setPendingProposal}
            onRequest={setPendingRequest}
          />*/}
        </div>

        {/* RPC test */}
        <RpcTestPanel connected={connected} hasKey={hasKey} />

        {/* Activity log — fills remaining space */}
        <div className="flex flex-col flex-1 min-h-0">
          <ActivityLog entries={logs} />
        </div>
      </div>

      {/* WalletConnect approval modals */}
      <WCApprovalModal
        proposal={pendingProposal}
        request={pendingRequest}
        onApproveProposal={handleApproveProposal}
        onRejectProposal={handleRejectProposal}
        onApproveRequest={handleApproveRequest}
        onRejectRequest={handleRejectRequest}
      />
    </div>
  );
}
