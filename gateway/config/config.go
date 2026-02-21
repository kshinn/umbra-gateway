package config

import (
	"encoding/hex"
	"fmt"
	"os"
	"strconv"
	"time"

	"github.com/joho/godotenv"
)

// Config holds all gateway configuration.
type Config struct {
	// UpstreamRPCURL is the Ethereum RPC endpoint to proxy to.
	UpstreamRPCURL string

	// GatewayPayTo is the gateway's USDC-receiving wallet address.
	GatewayPayTo string

	// USDCAddress is the USDC contract address on the target network.
	// Base Sepolia default: 0x036CbD53842c5426634E7929541eC2318f3dCF7e
	USDCAddress string

	// USDCDomainName is the EIP-712 domain name for the USDC contract.
	// Base Sepolia USDC uses "USDC".
	USDCDomainName string

	// USDCDomainVersion is the EIP-712 domain version for the USDC contract.
	USDCDomainVersion string

	// GatewayURL is the public URL of this gateway, used in the x402 resource field.
	GatewayURL string

	// FacilitatorURL is the x402 facilitator endpoint.
	// When empty and GatewayPrivateKey is set, the gateway uses its own local facilitator.
	FacilitatorURL string

	// GatewayPrivateKey is the hex-encoded private key used by the local facilitator
	// to submit transferWithAuthorization transactions and pay gas.
	// The derived address should hold enough native token for gas.
	GatewayPrivateKey string

	// SettlementRPCURL is the JSON-RPC endpoint for the settlement chain.
	// Defaults to the public Base Sepolia endpoint.
	SettlementRPCURL string

	// Network is the CAIP-2 network identifier (e.g. "eip155:84532" for Base Sepolia).
	Network string

	// PricePerRequest is the cost per RPC call in USDC atomic units (6 decimals).
	// 100 = 0.0001 USDC
	PricePerRequest int64

	// MaxAmountRequired is the total payment amount advertised in the 402 response.
	// requests_total = MaxAmountRequired / PricePerRequest
	MaxAmountRequired int64

	// JWTSecret is the HMAC-SHA256 key used to sign batch tokens.
	JWTSecret []byte

	// TokenExpiry is how long issued batch tokens remain valid.
	TokenExpiry time.Duration

	// Port is the HTTP listen port.
	Port int
}

// Load reads configuration from environment variables.
// A .env file in the working directory is loaded if present (dev convenience).
func Load() (*Config, error) {
	_ = godotenv.Load() // no-op if .env absent (production uses real env vars)
	cfg := &Config{
		UpstreamRPCURL:    getEnv("UPSTREAM_RPC_URL", "https://sepolia.base.org"),
		GatewayPayTo:      getEnv("GATEWAY_PAY_TO", ""),
		USDCAddress:       getEnv("USDC_ADDRESS", "0x036CbD53842c5426634E7929541eC2318f3dCF7e"),
		USDCDomainName:    getEnv("USDC_DOMAIN_NAME", "USDC"),
		USDCDomainVersion: getEnv("USDC_DOMAIN_VERSION", "2"),
		GatewayURL:        getEnv("GATEWAY_URL", "http://localhost:8080"),
		FacilitatorURL:    getEnv("FACILITATOR_URL", ""),
		GatewayPrivateKey: getEnv("GATEWAY_PRIVATE_KEY", ""),
		SettlementRPCURL:  getEnv("SETTLEMENT_RPC_URL", "https://sepolia.base.org"),
		Network:           getEnv("NETWORK", "eip155:84532"),
		PricePerRequest:   int64(getEnvInt("PRICE_PER_REQUEST", 100)),
		MaxAmountRequired: int64(getEnvInt("MAX_AMOUNT_REQUIRED", 10000)),
		Port:              getEnvInt("PORT", 8080),
		TokenExpiry:       time.Duration(getEnvInt("TOKEN_EXPIRY_HOURS", 168)) * time.Hour, // 7 days
	}

	// Payment-related fields are only required when a facilitator is configured.
	if cfg.FacilitatorURL != "" {
		jwtHex := getEnv("JWT_SECRET", "")
		if jwtHex == "" {
			return nil, fmt.Errorf("JWT_SECRET env var is required when FACILITATOR_URL is set (32-byte hex)")
		}
		secret, err := hex.DecodeString(jwtHex)
		if err != nil {
			return nil, fmt.Errorf("JWT_SECRET must be valid hex: %w", err)
		}
		if len(secret) < 32 {
			return nil, fmt.Errorf("JWT_SECRET must be at least 32 bytes (64 hex chars)")
		}
		cfg.JWTSecret = secret

		if cfg.GatewayPayTo == "" {
			return nil, fmt.Errorf("GATEWAY_PAY_TO env var is required when FACILITATOR_URL is set")
		}
		if cfg.PricePerRequest <= 0 {
			return nil, fmt.Errorf("PRICE_PER_REQUEST must be positive")
		}
		if cfg.MaxAmountRequired < cfg.PricePerRequest {
			return nil, fmt.Errorf("MAX_AMOUNT_REQUIRED must be >= PRICE_PER_REQUEST")
		}
	}

	return cfg, nil
}

// RequestsPerPayment returns the number of RPC credits issued per payment.
func (c *Config) RequestsPerPayment() int64 {
	return c.MaxAmountRequired / c.PricePerRequest
}

func getEnv(key, fallback string) string {
	if v, ok := os.LookupEnv(key); ok {
		return v
	}
	return fallback
}

func getEnvInt(key string, fallback int) int {
	v := getEnv(key, "")
	if v == "" {
		return fallback
	}
	n, err := strconv.Atoi(v)
	if err != nil {
		return fallback
	}
	return n
}
