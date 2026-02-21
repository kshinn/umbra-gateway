# Umbra Gateway


## The Problem

Helios solves trustless state verification, and keeps RPC calls local (as possible) but every `eth_getProof` call still goes to centralized RPC providers who collect:
- Your IP address
- Which addresses you're querying
- Request timing and patterns
- Transaction correlation data

**There is no privacy-preserving RPC alternative.**

## The Solution

A two-component privacy infrastructure:

### 1. Anonymized RPC Gateway
- Tor hidden service (`.onion` endpoint)
- x402 micropayments (pay-per-request in USDC on Base)
- Proxies to execution nodes without logging
- Chainalysis Oracle compliance check (sanctions screening for US deployment...eventually)

### 2. Privacy Wallet Client
- Electron desktop app
- Embedded Helios (WASM) for trustless verification
- Arti (Rust Tor) toggle for all RPC traffic
- x402 payment client for RPC access
- WalletConnect v2 for dApp connectivity (eventually)

## Architecture

```
User Wallet (Electron)          Anonymized RPC Gateway (.onion)
┌──────────────────┐            ┌────────────────────────────┐
│ Helios WASM      │            │ 1. Receive JSON-RPC        │
│ Key Management   │─────Tor────│ 2. x402 payment validation │
│ x402 Client      │            │ 3. Chainalysis check       │
│ WalletConnect    │            │ 4. Proxy to execution node │
└──────────────────┘            └────────────────────────────┘
```

## Key Differentiators

| vs Infura/Alchemy | vs Raw Tor | vs Nym alone |
|-------------------|------------|--------------|
| No metadata collection | x402 monetization model | Production-ready (Arti 1.0) |
| Sanctions compliant | Compliance layer | Toggleable privacy levels |
| Privacy-first design | Sustainable infrastructure | Integrated wallet UX |

## Tech Stack

- **Gateway**: Rust (axum + arti + x402)
- **Client**: Electron + React + @a16z/helios WASM
- **Privacy**: arti-client (Tor), nym-sdk (Nym mixnet)
- **Payments**: x402 protocol on Base (USDC)
- **Compliance**: Chainalysis Sanctions Oracle

## Quick Start

```bash
# Gateway
cd gateway && go run main.go

# Client
cd client && npm install && pnpm dev
```

---

**Conclusion**: Currently, all privacy plays ultimately depend on the RPC layer. Solving RPC privacy is foundational—the other ideas can build on top of this infrastructure.
