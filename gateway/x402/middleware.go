package x402

import (
	"bytes"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"sync"

	"log/slog"
)

// paymentRequiredHeader is the response header that carries the 402 payload.
const paymentRequiredHeader = "Payment-Required"

// paymentSignatureHeader is the request header the client sends its payment in.
const paymentSignatureHeader = "Payment-Signature"

// paymentTokenHeader is the response header carrying the issued batch JWT.
const paymentTokenHeader = "X-Payment-Token"

// creditsRemainingHeader tells the client how many credits remain after this call.
const creditsRemainingHeader = "X-Rpc-Credits-Remaining"

// paymentRequirementsExtra carries EIP-712 domain metadata the facilitator
// needs to verify the client's signature without querying the chain.
type paymentRequirementsExtra struct {
	Name    string `json:"name"`
	Version string `json:"version"`
}

// paymentRequirementsV2 mirrors the x402 v2 PaymentRequirements schema.
type paymentRequirementsV2 struct {
	Scheme            string                   `json:"scheme"`
	Network           string                   `json:"network"`
	Amount            string                   `json:"amount"`
	Asset             string                   `json:"asset"`
	PayTo             string                   `json:"payTo"`
	MaxTimeoutSeconds int                      `json:"maxTimeoutSeconds"`
	Extra             paymentRequirementsExtra `json:"extra"`
}

// paymentResourceV2 identifies the resource being paid for.
type paymentResourceV2 struct {
	URL         string `json:"url"`
	Description string `json:"description"`
	MimeType    string `json:"mimeType"`
}

// paymentRequiredV2 is the full 402 response body (x402 v2).
type paymentRequiredV2 struct {
	X402Version int                     `json:"x402Version"`
	Error       string                  `json:"error"`
	Resource    paymentResourceV2       `json:"resource"`
	Accepts     []paymentRequirementsV2 `json:"accepts"`
}

// MiddlewareConfig groups the dependencies of the x402 middleware.
type MiddlewareConfig struct {
	// Network is the CAIP-2 chain identifier, e.g. "eip155:84532".
	Network string
	// PayTo is the gateway's USDC receiving address.
	PayTo string
	// USDCAddress is the USDC contract on the target network.
	USDCAddress string
	// USDCDomainName is the EIP-712 domain name of the USDC contract.
	// Used by the facilitator to verify the client's EIP-3009 signature.
	USDCDomainName string
	// USDCDomainVersion is the EIP-712 domain version of the USDC contract.
	USDCDomainVersion string
	// GatewayURL is the public URL of this gateway, used in the x402 resource field.
	GatewayURL string
	// MaxAmountRequired is the payment amount (USDC atomic units) for one batch.
	MaxAmountRequired int64
	// RequestsPerPayment is credits issued per batch purchase.
	RequestsPerPayment int64
	// Tokens signs / validates batch JWTs and manages credit counters.
	// Must be non-nil when Facilitator is set.
	Tokens *TokenManager
	// Facilitator handles payment verification and settlement.
	// When nil, the middleware acts as a plain pass-through — no 402 is issued
	// and all requests are forwarded directly to Next. Use this when no
	// facilitator is available for the target chain.
	Facilitator FacilitatorClient
	// Next is the handler to call after a valid token is found (the RPC proxy).
	Next http.Handler
}

// Middleware implements the x402 batch-token payment gate.
type Middleware struct {
	cfg              MiddlewareConfig
	requirementsJSON []byte // JSON of paymentRequirementsV2, passed to the facilitator
	payloadJSON      []byte // JSON of paymentRequiredV2, sent as the 402 body
	payload402       string // base64(payloadJSON), sent in Payment-Required header

	// seenPayments guards against replaying the same payment signature to obtain
	// multiple batch tokens. Key = SHA-256 of the raw payment payload bytes.
	seenMu       sync.Mutex
	seenPayments map[[32]byte]struct{}
}

// NewMiddleware builds the x402 middleware from cfg.
func NewMiddleware(cfg MiddlewareConfig) (*Middleware, error) {
	req := paymentRequirementsV2{
		Scheme:            "exact",
		Network:           cfg.Network,
		Amount:            fmt.Sprintf("%d", cfg.MaxAmountRequired),
		PayTo:             cfg.PayTo,
		MaxTimeoutSeconds: 60,
		Asset:             cfg.USDCAddress,
		Extra: paymentRequirementsExtra{
			Name:    cfg.USDCDomainName,
			Version: cfg.USDCDomainVersion,
		},
	}

	requirementsJSON, err := json.Marshal(req)
	if err != nil {
		return nil, fmt.Errorf("marshalling payment requirements: %w", err)
	}

	payloadRequired := paymentRequiredV2{
		X402Version: 2,
		Error:       "Payment required",
		Resource: paymentResourceV2{
			URL:         cfg.GatewayURL,
			Description: fmt.Sprintf("RPC access: %d credits per payment", cfg.RequestsPerPayment),
			MimeType:    "",
		},
		Accepts: []paymentRequirementsV2{req},
	}
	payloadJSON, err := json.Marshal(payloadRequired)
	if err != nil {
		return nil, fmt.Errorf("marshalling payment required payload: %w", err)
	}

	return &Middleware{
		cfg:              cfg,
		requirementsJSON: requirementsJSON,
		payloadJSON:      payloadJSON,
		payload402:       base64.StdEncoding.EncodeToString(payloadJSON),
		seenPayments:     make(map[[32]byte]struct{}),
	}, nil
}

// ServeHTTP implements http.Handler.
func (m *Middleware) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	// Only allow POST to / (standard JSON-RPC endpoint).
	if r.Method != http.MethodPost || r.URL.Path != "/" {
		http.Error(w, "only POST / is supported", http.StatusBadRequest)
		return
	}

	// Pass-through mode: no facilitator configured, skip payment gate entirely.
	if m.cfg.Facilitator == nil {
		m.cfg.Next.ServeHTTP(w, r)
		return
	}

	// --- Path 1: client presents a batch JWT ---
	if authHeader := r.Header.Get("Authorization"); strings.HasPrefix(authHeader, "Bearer ") {
		tokenStr := strings.TrimPrefix(authHeader, "Bearer ")
		handled := m.serveWithToken(w, r, tokenStr)
		if handled {
			return
		}
		// Token invalid/expired — fall through to payment path.
	}

	// --- Path 2: client presents an x402 payment payload ---
	if paymentHeader := r.Header.Get(paymentSignatureHeader); paymentHeader != "" {
		m.handlePayment(w, r, paymentHeader)
		return
	}

	// --- Path 3: no credentials — return 402 ---
	m.send402(w)
}

// serveWithToken validates the JWT and, if credits remain, proxies the request.
// Returns true if the request is fully handled; false if the token is
// structurally invalid/expired and the caller should try the payment path.
func (m *Middleware) serveWithToken(w http.ResponseWriter, r *http.Request, tokenStr string) bool {
	claims, err := m.cfg.Tokens.ValidateToken(tokenStr)
	if err != nil {
		// Malformed or expired JWT — let the caller fall through.
		return false
	}

	remaining, err := m.cfg.Tokens.UseRequest(claims)
	if err != nil {
		switch {
		case errors.Is(err, ErrTokenExhausted):
			slog.Info("token exhausted", "tid", claims.TokenID)
			m.send402(w)
		case errors.Is(err, ErrTokenNotFound):
			// Valid JWT signature but no counter entry — server was restarted.
			// The client holds a legitimately issued but now-unredeemable token.
			// Return 402 directly; do NOT fall through to the payment path,
			// which could cause an accidental double-charge if the request also
			// carries a Payment-Signature header.
			slog.Warn("token not in store (server restarted?)", "tid", claims.TokenID)
			m.send402WithReason(w, "token_not_found")
		default:
			http.Error(w, "internal error", http.StatusInternalServerError)
		}
		return true
	}

	// Extract the RPC method from the request body for logging.
	bodyBytes, err := io.ReadAll(r.Body)
	r.Body.Close()
	method := ""
	if err == nil {
		var rpcReq map[string]interface{}
		if err := json.Unmarshal(bodyBytes, &rpcReq); err == nil {
			if m, ok := rpcReq["method"].(string); ok {
				method = m
			}
		}
	}
	// Restore the body for the next handler.
	r.Body = io.NopCloser(bytes.NewReader(bodyBytes))

	slog.Info("proxying RPC request", "method", method, "tid", claims.TokenID, "remaining", remaining)
	w.Header().Set(creditsRemainingHeader, fmt.Sprintf("%d", remaining))
	m.cfg.Next.ServeHTTP(w, r)
	return true
}

// handlePayment processes an incoming x402 payment:
// verify → settle → issue batch JWT → return token to client.
func (m *Middleware) handlePayment(w http.ResponseWriter, r *http.Request, encoded string) {
	payloadBytes, err := base64.StdEncoding.DecodeString(encoded)
	if err != nil {
		http.Error(w, "invalid Payment-Signature encoding", http.StatusBadRequest)
		return
	}

	// Deduplication: reject payment payloads we have already processed.
	// This prevents a client from replaying one payment to receive multiple
	// batch tokens. We use the SHA-256 of the raw payload as the key.
	payloadHash := sha256.Sum256(payloadBytes)
	m.seenMu.Lock()
	_, seen := m.seenPayments[payloadHash]
	if !seen {
		m.seenPayments[payloadHash] = struct{}{}
	}
	m.seenMu.Unlock()

	if seen {
		http.Error(w, "payment already processed", http.StatusConflict)
		return
	}

	// Use the request context so client disconnects propagate to facilitator calls.
	ctx := r.Context()

	result, err := m.cfg.Facilitator.Verify(ctx, payloadBytes, m.requirementsJSON)
	if err != nil {
		slog.Warn("payment verification failed", "err", err)
		// Remove the hash so the client can retry with a valid payment.
		m.seenMu.Lock()
		delete(m.seenPayments, payloadHash)
		m.seenMu.Unlock()
		http.Error(w, "payment verification failed", http.StatusPaymentRequired)
		return
	}

	if err := m.cfg.Facilitator.Settle(ctx, payloadBytes, m.requirementsJSON); err != nil {
		slog.Warn("payment settlement failed", "err", err)
		// Do NOT remove the hash here: the payment may have been partially settled.
		// The facilitator is expected to be idempotent; the client should contact
		// support if they believe they were charged without receiving a token.
		http.Error(w, fmt.Sprintf("payment settlement failed: %v", err), http.StatusPaymentRequired)
		return
	}

	tokenStr, err := m.cfg.Tokens.IssueToken(result.Payer, m.cfg.RequestsPerPayment)
	if err != nil {
		slog.Error("failed to issue batch token", "err", err)
		http.Error(w, "internal error", http.StatusInternalServerError)
		return
	}

	slog.Info("issued batch token", "payer", result.Payer, "credits", m.cfg.RequestsPerPayment)

	w.Header().Set(paymentTokenHeader, tokenStr)
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	_ = json.NewEncoder(w).Encode(map[string]interface{}{
		"message": "payment accepted — retry your RPC request with the token",
		"credits": m.cfg.RequestsPerPayment,
		"hint":    "set Authorization: Bearer <token from X-Payment-Token header>",
	})
}

// send402 writes a standard 402 Payment Required response.
func (m *Middleware) send402(w http.ResponseWriter) {
	m.send402WithReason(w, "")
}

// send402WithReason writes a 402 response with an optional machine-readable
// reason code so clients can distinguish different 402 causes.
func (m *Middleware) send402WithReason(w http.ResponseWriter, reason string) {
	w.Header().Set(paymentRequiredHeader, m.payload402)
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusPaymentRequired)

	body := struct {
		X402Version int                     `json:"x402Version"`
		Error       string                  `json:"error"`
		Resource    paymentResourceV2       `json:"resource"`
		Accepts     []paymentRequirementsV2 `json:"accepts"`
		Reason      string                  `json:"reason,omitempty"`
	}{}
	_ = json.Unmarshal(m.payloadJSON, &body)
	body.Reason = reason
	_ = json.NewEncoder(w).Encode(body)
}
