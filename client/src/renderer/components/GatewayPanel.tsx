import React, { useState } from "react";

const DEMO_ONION_GATEWAY_URL =
  "http://yai4cgbt272me46hkisdiiy24wnbhwnf7kgl7652juxxaqyr7ik4w5qd.onion";

interface GatewayPanelProps {
  onConnect: (url: string) => void;
  onDisconnect: () => void;
  connected: boolean;
  gatewayUrl: string;
}

export function GatewayPanel({
  onConnect,
  onDisconnect,
  connected,
  gatewayUrl,
}: GatewayPanelProps): JSX.Element {
  const [inputUrl, setInputUrl] = useState(
    gatewayUrl || DEMO_ONION_GATEWAY_URL,
  );
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState("");

  async function handleConnect(): Promise<void> {
    setError("");
    setConnecting(true);
    try {
      const url = inputUrl.trim().replace(/\/$/, "");
      await window.rpc.setGateway(url);
      onConnect(url);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setConnecting(false);
    }
  }

  async function handleDisconnect(): Promise<void> {
    await window.rpc.disconnectGateway();
    onDisconnect();
  }

  return (
    <div className="panel">
      <div className="panel-title">Gateway</div>

      <div className="space-y-2">
        <input
          type="url"
          className="input"
          placeholder={DEMO_ONION_GATEWAY_URL}
          value={inputUrl}
          onChange={(e) => setInputUrl(e.target.value)}
          disabled={connected}
          onKeyDown={(e) => e.key === "Enter" && !connected && handleConnect()}
        />

        {!connected ? (
          <button
            className="btn-primary w-full"
            onClick={handleConnect}
            disabled={connecting || !inputUrl.trim()}
          >
            {connecting ? "Connecting..." : "Connect"}
          </button>
        ) : (
          <div className="space-y-2">
            <div className="flex items-center gap-2 text-xs text-accent-green">
              <span className="w-2 h-2 rounded-full bg-accent-green inline-block" />
              Connected
            </div>
            <button
              className="btn-ghost w-full text-xs"
              onClick={handleDisconnect}
            >
              Disconnect
            </button>
          </div>
        )}

        {error && <p className="text-accent-red text-xs">{error}</p>}
      </div>
    </div>
  );
}
