# Wireshark Demo Runbook

Shows the privacy gap between a standard wallet and ours — side by side on screen.

## Setup (do once before presenting)

```bash
# Make scripts executable
chmod +x demo/*.sh

# Install Wireshark color rules
cp demo/wireshark/colorfilters ~/Library/Application\ Support/Wireshark/colorfilters
```

Open two terminal windows and Wireshark before you start.

In Wireshark:
- Interface: **en0** (Wi-Fi) — capture external traffic
- Also add **lo0** (loopback) to see Tor SOCKS activity
- Start capture, then **Edit → Preferences → Appearance → Coloring Rules → Import** `demo/wireshark/colorfilters`

Display filter to have ready: `dns or tls.handshake.type == 1`

---

## Act 1 — "What every other wallet leaks"

**Terminal 1:**
```bash
demo/watch-leaks.sh
```

**Terminal 2:**
```bash
demo/clearnet-rpc.sh
```

**What the audience sees in Wireshark / Terminal 1:**

| Column | What appears | What it proves |
|--------|-------------|----------------|
| DNS | `mainnet.base.org` | Your ISP knows you use Base |
| TLS SNI | `mainnet.base.org` | Visible even through HTTPS |
| IP dst | `104.18.x.x` (Coinbase CDN) | Provider logs your IP |

Talking point: *"Even though this is HTTPS, the hostname is in the TLS handshake in plaintext. Your ISP, coffee shop router, and VPN provider all see which RPC provider you're hitting and when."*

---

## Act 2 — "Our wallet, clearnet gateway (yellow dot)"

1. Start the app (`pnpm dev`)
2. Import a wallet key
3. Connect to a **clearnet** gateway URL (e.g. `http://localhost:8080`)
4. Status bar shows **yellow Tor dot** ("Tor (clearnet)")

**Terminal 1 (watch-leaks.sh still running):**

You will still see DNS / TLS SNI for the gateway domain. Tor is running but not routing — the yellow indicator is accurate.

Talking point: *"Tor is bootstrapped and ready, but because the gateway isn't a .onion address, traffic still goes over clearnet. The yellow dot tells you exactly that."*

---

## Act 3 — "Our wallet, .onion gateway (green dot)"

1. In the app, disconnect and reconnect to the **`.onion`** gateway URL
2. Status bar shows **green Tor dot** ("Tor")
3. Make a balance check or send a transaction

**Terminal 1 (watch-leaks.sh):**
```
(silence — no RPC provider hostnames appear)
```

**Switch to watch-tor.sh:**
```bash
demo/watch-tor.sh
```

**What appears:**
```
[SOCKS] t=0.012    127.0.0.1:54321 → 127.0.0.1:9150  bytes=42
[GUARD] t=0.034    192.168.1.5 → 185.220.101.x:443   bytes=586
[GUARD] t=0.041    192.168.1.5 → 185.220.101.x:443   bytes=586
```

**What does NOT appear:**
- No DNS query for the gateway
- No TLS SNI containing `base.org`, `alchemy`, `infura`, or your .onion address
- No wallet address in any packet
- No JSON-RPC method names

Talking point: *"An observer — your ISP, a state actor, the conference Wi-Fi — sees only that you're using Tor. They can't tell you're using a crypto wallet, which network, or which address. The green dot confirms it end-to-end."*

---

## Full pcap capture (optional — for deep dives after the talk)

```bash
# Capture 60 seconds of clearnet scenario
demo/capture-full.sh 60 before-tor.pcapng

# Switch the app to .onion, then:
demo/capture-full.sh 60 after-tor.pcapng
```

The script prints a summary diff:
- `before-tor.pcapng` → shows RPC provider DNS + SNI
- `after-tor.pcapng` → shows zero RPC provider metadata

Open either file in Wireshark for the full visual.

---

## Quick filter reference for live Wireshark

| What you want to show | Display filter |
|-----------------------|---------------|
| RPC provider leaks | `dns.qry.name contains "base.org" or tls.handshake.extensions_server_name contains "base.org"` |
| All DNS queries | `dns` |
| TLS handshakes (SNI visible) | `tls.handshake.type == 1` |
| Tor SOCKS5 local | `tcp.port == 9150 or tcp.port == 9050` |
| Anything leaking JSON | `tcp contains "jsonrpc"` |
| Everything interesting | `dns or tls.handshake.type == 1 or tcp.port == 9150` |

---

## Troubleshooting

**`sudo` password prompt in mid-demo**
Run `sudo -v` before you start to cache credentials for 15 minutes.

**tshark not found**
Scripts hardcode `/Applications/Wireshark.app/Contents/MacOS/tshark`. If Wireshark is elsewhere, set:
```bash
export TSHARK="/path/to/tshark"
```

**No packets showing**
Check you're on Wi-Fi (`en0`). If on ethernet, edit the `-i en0` flag to `-i en3` or `-i en4`.

**Wireshark color rules not loading**
Restart Wireshark after copying `colorfilters`. The file must be at:
`~/Library/Application Support/Wireshark/colorfilters`
