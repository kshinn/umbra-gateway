package main

import (
	"fmt"
	"log/slog"
	"math/big"
	"net/http"
	"os"
	"strings"

	"github.com/ethdenver2026/gateway/config"
	"github.com/ethdenver2026/gateway/proxy"
	"github.com/ethdenver2026/gateway/x402"
)

func main() {
	logLevel := slog.LevelInfo
	if os.Getenv("LOG_LEVEL") == "debug" {
		logLevel = slog.LevelDebug
	}
	slog.SetDefault(slog.New(slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{Level: logLevel})))

	cfg, err := config.Load()
	if err != nil {
		slog.Error("config error", "err", err)
		os.Exit(1)
	}

	rpcProxy, err := proxy.NewRPC(cfg.UpstreamRPCURL)
	if err != nil {
		slog.Error("failed to create RPC proxy", "err", err)
		os.Exit(1)
	}

	// Wire up the x402 payment layer.
	//   - FACILITATOR_URL set → remote facilitator (x402.org or compatible)
	//   - GATEWAY_PRIVATE_KEY set → self-hosted local facilitator (no external dependency)
	//   - neither set        → plain pass-through proxy (no payment gate)
	var facilitator x402.FacilitatorClient
	var tokenManager *x402.TokenManager
	switch {
	case cfg.FacilitatorURL != "":
		slog.Info("payment mode: remote facilitator", "url", cfg.FacilitatorURL)
		facilitator = x402.NewFacilitator(cfg.FacilitatorURL)
		store := x402.NewInMemoryTokenStore()
		tokenManager = x402.NewTokenManager(cfg.JWTSecret, cfg.TokenExpiry, store)

	case cfg.GatewayPrivateKey != "":
		chainIDStr := strings.TrimPrefix(cfg.Network, "eip155:")
		chainID := new(big.Int)
		if _, ok := chainID.SetString(chainIDStr, 10); !ok {
			slog.Error("invalid NETWORK for local facilitator", "network", cfg.Network)
			os.Exit(1)
		}
		lf, err := x402.NewLocalFacilitator(cfg.SettlementRPCURL, cfg.GatewayPrivateKey, chainID)
		if err != nil {
			slog.Error("local facilitator init failed", "err", err)
			os.Exit(1)
		}
		slog.Info("payment mode: local facilitator",
			"settlement_rpc", cfg.SettlementRPCURL,
			"relayer", lf.Address().Hex(),
		)
		facilitator = lf
		store := x402.NewInMemoryTokenStore()
		tokenManager = x402.NewTokenManager(cfg.JWTSecret, cfg.TokenExpiry, store)

	default:
		slog.Info("payment mode: disabled (set FACILITATOR_URL or GATEWAY_PRIVATE_KEY to enable)")
	}

	mw, err := x402.NewMiddleware(x402.MiddlewareConfig{
		Network:            cfg.Network,
		PayTo:              cfg.GatewayPayTo,
		USDCAddress:        cfg.USDCAddress,
		USDCDomainName:     cfg.USDCDomainName,
		USDCDomainVersion:  cfg.USDCDomainVersion,
		GatewayURL:         cfg.GatewayURL,
		MaxAmountRequired:  cfg.MaxAmountRequired,
		RequestsPerPayment: cfg.RequestsPerPayment(),
		Tokens:             tokenManager,
		Facilitator:        facilitator,
		Next:               rpcProxy,
	})
	if err != nil {
		slog.Error("failed to create x402 middleware", "err", err)
		os.Exit(1)
	}

	addr := fmt.Sprintf(":%d", cfg.Port)
	slog.Info("gateway starting",
		"addr", addr,
		"upstream", cfg.UpstreamRPCURL,
		"network", cfg.Network,
		"pay_to", cfg.GatewayPayTo,
		"price_per_request", cfg.PricePerRequest,
		"requests_per_payment", cfg.RequestsPerPayment(),
	)

	if err := http.ListenAndServe(addr, mw); err != nil {
		slog.Error("server error", "err", err)
		os.Exit(1)
	}
}
