package x402

import (
	"errors"
	"fmt"
	"sync"
	"sync/atomic"
	"time"

	"github.com/golang-jwt/jwt/v5"
	"github.com/google/uuid"
)

// ErrTokenExhausted is returned when all credits for a token have been used.
var ErrTokenExhausted = errors.New("token credits exhausted")

// ErrTokenNotFound is returned when the token ID is not registered in the store.
var ErrTokenNotFound = errors.New("token not found in store")

// Claims is the JWT payload for a batch RPC token.
type Claims struct {
	jwt.RegisteredClaims
	// TokenID is a server-generated UUID used as the key in the counter store.
	TokenID string `json:"tid"`
	// RequestsTotal is the total number of RPC calls this token authorises.
	// The server-side counter is authoritative; this field is informational and
	// protected by HMAC-SHA256 signature — clients cannot increase it.
	RequestsTotal int64 `json:"requests_total"`
}

// TokenCounterStore manages server-side authoritative request counters.
// Implementations must be safe for concurrent use.
type TokenCounterStore interface {
	// RegisterToken initialises a counter for a newly issued token with the
	// given total allowance. Calling RegisterToken again for the same tokenID
	// is a no-op — issuance happens exactly once.
	RegisterToken(tokenID string, total int64) error

	// UseRequest atomically increments the used counter and returns the number
	// of remaining credits. Returns ErrTokenExhausted when the allowance is
	// reached and ErrTokenNotFound if the token was never registered.
	UseRequest(tokenID string, total int64) (remaining int64, err error)
}

// entry holds the atomic counter and the total allowance for a single token.
type entry struct {
	counter *atomic.Int64
	total   int64
}

// InMemoryTokenStore is an in-memory TokenCounterStore.
// NOTE: state is lost on process restart — acceptable for a hackathon demo.
// Replace with a Redis-backed implementation for production.
type InMemoryTokenStore struct {
	mu      sync.Mutex
	entries map[string]*entry
}

// NewInMemoryTokenStore creates an empty in-memory token counter store.
func NewInMemoryTokenStore() *InMemoryTokenStore {
	return &InMemoryTokenStore{entries: make(map[string]*entry)}
}

// RegisterToken stores the total allowance for a newly issued token.
// If tokenID already exists the call is a no-op (idempotent).
func (s *InMemoryTokenStore) RegisterToken(tokenID string, total int64) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if _, exists := s.entries[tokenID]; !exists {
		s.entries[tokenID] = &entry{counter: &atomic.Int64{}, total: total}
	}
	return nil
}

// UseRequest atomically consumes one credit and returns the number remaining.
// The total parameter comes from the signed JWT claims — it cannot be forged.
func (s *InMemoryTokenStore) UseRequest(tokenID string, total int64) (int64, error) {
	s.mu.Lock()
	e, ok := s.entries[tokenID]
	s.mu.Unlock()

	if !ok {
		return 0, ErrTokenNotFound
	}

	// Increment first. If we go over, decrement and report exhausted.
	// The rollback is safe: only one goroutine can push `used` past `total`
	// per increment, and we always roll it back, so the counter never
	// permanently exceeds `total`.
	used := e.counter.Add(1)
	if used > total {
		e.counter.Add(-1)
		return 0, ErrTokenExhausted
	}
	return total - used, nil
}

// TokenManager issues and validates batch JWT tokens.
type TokenManager struct {
	secret []byte
	expiry time.Duration
	store  TokenCounterStore
}

// NewTokenManager creates a TokenManager with the given HMAC secret, token
// lifetime, and counter store.
func NewTokenManager(secret []byte, expiry time.Duration, store TokenCounterStore) *TokenManager {
	return &TokenManager{
		secret: secret,
		expiry: expiry,
		store:  store,
	}
}

// IssueToken signs a new batch JWT for payer with requestsTotal credits and
// registers it in the counter store. Returns the signed token string.
func (m *TokenManager) IssueToken(payer string, requestsTotal int64) (string, error) {
	tokenID := uuid.New().String()
	now := time.Now()

	claims := &Claims{
		RegisteredClaims: jwt.RegisteredClaims{
			Subject:   payer,
			IssuedAt:  jwt.NewNumericDate(now),
			ExpiresAt: jwt.NewNumericDate(now.Add(m.expiry)),
		},
		TokenID:       tokenID,
		RequestsTotal: requestsTotal,
	}

	token := jwt.NewWithClaims(jwt.SigningMethodHS256, claims)
	signed, err := token.SignedString(m.secret)
	if err != nil {
		return "", fmt.Errorf("signing token: %w", err)
	}

	if err := m.store.RegisterToken(tokenID, requestsTotal); err != nil {
		return "", fmt.Errorf("registering token: %w", err)
	}

	return signed, nil
}

// ValidateToken parses and verifies the JWT signature and expiry, returning
// the embedded claims.
func (m *TokenManager) ValidateToken(tokenString string) (*Claims, error) {
	token, err := jwt.ParseWithClaims(tokenString, &Claims{}, func(t *jwt.Token) (interface{}, error) {
		if _, ok := t.Method.(*jwt.SigningMethodHMAC); !ok {
			return nil, fmt.Errorf("unexpected signing method: %v", t.Header["alg"])
		}
		return m.secret, nil
	})
	if err != nil {
		return nil, err
	}
	claims, ok := token.Claims.(*Claims)
	if !ok || !token.Valid {
		return nil, errors.New("invalid token claims")
	}
	return claims, nil
}

// UseRequest atomically consumes one credit from the token and returns the
// remaining count.
func (m *TokenManager) UseRequest(claims *Claims) (int64, error) {
	return m.store.UseRequest(claims.TokenID, claims.RequestsTotal)
}
