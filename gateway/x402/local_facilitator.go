package x402

// LocalFacilitator is a self-hosted x402 payment facilitator.
//
// It replaces the dependency on the external x402.org service by:
//   1. Verifying the EIP-3009 TransferWithAuthorization signature locally.
//   2. Submitting the transferWithAuthorization transaction directly to the
//      USDC contract on the settlement chain, paying gas from GatewayKey.
//
// This gives the gateway full control over payment settlement with no
// reliance on any centralised third party.

import (
	"context"
	"crypto/ecdsa"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"log/slog"
	"math/big"
	"strings"
	"time"

	"github.com/ethereum/go-ethereum"
	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/core/types"
	"github.com/ethereum/go-ethereum/crypto"
	"github.com/ethereum/go-ethereum/ethclient"
)

// Pre-computed EIP-712 type hashes (constant across all instances).
var (
	domainTypeHash = crypto.Keccak256Hash([]byte(
		"EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)",
	))
	authTypeHash = crypto.Keccak256Hash([]byte(
		"TransferWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)",
	))
)

// transferWithAuthSig is the 4-byte selector for USDC.transferWithAuthorization.
var transferWithAuthSig = crypto.Keccak256([]byte(
	"transferWithAuthorization(address,address,uint256,uint256,uint256,bytes32,uint8,bytes32,bytes32)",
))[:4]

// LocalFacilitator implements FacilitatorClient without any external dependency.
type LocalFacilitator struct {
	rpcURL     string
	privateKey *ecdsa.PrivateKey
	address    common.Address
	chainID    *big.Int
}

// NewLocalFacilitator creates a LocalFacilitator.
//
//   - rpcURL: JSON-RPC endpoint of the settlement chain (e.g. Base Sepolia).
//   - privateKeyHex: hex-encoded private key of the relayer wallet (pays gas).
//   - chainID: settlement chain ID (e.g. 84532 for Base Sepolia).
func NewLocalFacilitator(rpcURL, privateKeyHex string, chainID *big.Int) (*LocalFacilitator, error) {
	key, err := crypto.HexToECDSA(strings.TrimPrefix(privateKeyHex, "0x"))
	if err != nil {
		return nil, fmt.Errorf("invalid gateway private key: %w", err)
	}
	return &LocalFacilitator{
		rpcURL:     rpcURL,
		privateKey: key,
		address:    crypto.PubkeyToAddress(key.PublicKey),
		chainID:    chainID,
	}, nil
}

// ---------------------------------------------------------------------------
// Shared payment payload parsing
// ---------------------------------------------------------------------------

type localPayload struct {
	Accepted struct {
		Network string `json:"network"`
		Asset   string `json:"asset"`
		PayTo   string `json:"payTo"`
		Amount  string `json:"amount"`
		Extra   struct {
			Name    string `json:"name"`
			Version string `json:"version"`
		} `json:"extra"`
	} `json:"accepted"`
	Payload struct {
		Signature     string `json:"signature"`
		Authorization struct {
			From        string `json:"from"`
			To          string `json:"to"`
			Value       string `json:"value"`
			ValidAfter  string `json:"validAfter"`
			ValidBefore string `json:"validBefore"`
			Nonce       string `json:"nonce"`
		} `json:"authorization"`
	} `json:"payload"`
}

func parseLocalPayload(raw []byte) (*localPayload, error) {
	var p localPayload
	if err := json.Unmarshal(raw, &p); err != nil {
		return nil, fmt.Errorf("parsing payment payload: %w", err)
	}
	return &p, nil
}

// ---------------------------------------------------------------------------
// EIP-712 helpers
// ---------------------------------------------------------------------------

func pad32(n *big.Int) []byte {
	b := n.Bytes()
	if len(b) >= 32 {
		return b[len(b)-32:]
	}
	padded := make([]byte, 32)
	copy(padded[32-len(b):], b)
	return padded
}

func addrPad(a common.Address) []byte {
	padded := make([]byte, 32)
	copy(padded[12:], a.Bytes())
	return padded
}

func domainSeparator(name, version string, chainID *big.Int, contract common.Address) common.Hash {
	enc := make([]byte, 5*32)
	copy(enc[0:32], domainTypeHash.Bytes())
	copy(enc[32:64], crypto.Keccak256([]byte(name)))
	copy(enc[64:96], crypto.Keccak256([]byte(version)))
	copy(enc[96:128], pad32(chainID))
	copy(enc[128:160], addrPad(contract))
	return crypto.Keccak256Hash(enc)
}

func authHash(from, to common.Address, value, validAfter, validBefore *big.Int, nonce [32]byte) common.Hash {
	enc := make([]byte, 7*32)
	copy(enc[0:32], authTypeHash.Bytes())
	copy(enc[32:64], addrPad(from))
	copy(enc[64:96], addrPad(to))
	copy(enc[96:128], pad32(value))
	copy(enc[128:160], pad32(validAfter))
	copy(enc[160:192], pad32(validBefore))
	copy(enc[192:224], nonce[:])
	return crypto.Keccak256Hash(enc)
}

func eip712Digest(p *localPayload) (common.Hash, [32]byte, error) {
	parts := strings.Split(p.Accepted.Network, ":")
	if len(parts) != 2 {
		return common.Hash{}, [32]byte{}, fmt.Errorf("invalid network: %s", p.Accepted.Network)
	}
	chainID := new(big.Int)
	if _, ok := chainID.SetString(parts[1], 10); !ok {
		return common.Hash{}, [32]byte{}, fmt.Errorf("invalid chainId: %s", parts[1])
	}

	usdcAddr := common.HexToAddress(p.Accepted.Asset)
	from := common.HexToAddress(p.Payload.Authorization.From)
	to := common.HexToAddress(p.Payload.Authorization.To)
	value := mustBI(p.Payload.Authorization.Value)
	validAfter := mustBI(p.Payload.Authorization.ValidAfter)
	validBefore := mustBI(p.Payload.Authorization.ValidBefore)

	nonceHex := strings.TrimPrefix(p.Payload.Authorization.Nonce, "0x")
	nonceBytes, err := hex.DecodeString(nonceHex)
	if err != nil {
		return common.Hash{}, [32]byte{}, fmt.Errorf("invalid nonce: %w", err)
	}
	var nonce [32]byte
	copy(nonce[32-len(nonceBytes):], nonceBytes)

	ds := domainSeparator(p.Accepted.Extra.Name, p.Accepted.Extra.Version, chainID, usdcAddr)
	ah := authHash(from, to, value, validAfter, validBefore, nonce)

	digest := crypto.Keccak256Hash(append([]byte{0x19, 0x01}, append(ds.Bytes(), ah.Bytes()...)...))
	return digest, nonce, nil
}

func mustBI(s string) *big.Int {
	n := new(big.Int)
	n.SetString(s, 10)
	return n
}

// Address returns the Ethereum address of the relayer key (used to log it at startup).
func (f *LocalFacilitator) Address() common.Address { return f.address }

// ---------------------------------------------------------------------------
// Verify — checks the EIP-3009 signature without touching the chain
// ---------------------------------------------------------------------------

func (f *LocalFacilitator) Verify(_ context.Context, payloadBytes, _ []byte) (*VerifyResult, error) {
	p, err := parseLocalPayload(payloadBytes)
	if err != nil {
		return nil, err
	}

	// Check expiry
	validBefore := mustBI(p.Payload.Authorization.ValidBefore)
	if validBefore.Int64() < time.Now().Unix() {
		return nil, fmt.Errorf("authorization expired (validBefore=%d)", validBefore.Int64())
	}

	// Compute EIP-712 digest
	digest, _, err := eip712Digest(p)
	if err != nil {
		return nil, err
	}

	// Decode and normalize signature
	sigHex := strings.TrimPrefix(p.Payload.Signature, "0x")
	sig, err := hex.DecodeString(sigHex)
	if err != nil || len(sig) != 65 {
		return nil, fmt.Errorf("invalid signature")
	}
	if sig[64] >= 27 {
		sig[64] -= 27 // ecrecover expects 0/1
	}

	// Recover signer
	pubBytes, err := crypto.Ecrecover(digest.Bytes(), sig)
	if err != nil {
		return nil, fmt.Errorf("ecrecover: %w", err)
	}
	pub, err := crypto.UnmarshalPubkey(pubBytes)
	if err != nil {
		return nil, fmt.Errorf("unmarshal pubkey: %w", err)
	}
	recovered := crypto.PubkeyToAddress(*pub)
	expected := common.HexToAddress(p.Payload.Authorization.From)
	if recovered != expected {
		return nil, fmt.Errorf("signature mismatch: signed by %s, claimed %s", recovered.Hex(), expected.Hex())
	}

	// Check payTo matches requirements
	authTo := common.HexToAddress(p.Payload.Authorization.To)
	reqPayTo := common.HexToAddress(p.Accepted.PayTo)
	if authTo != reqPayTo {
		return nil, fmt.Errorf("payTo mismatch: auth=%s req=%s", authTo.Hex(), reqPayTo.Hex())
	}

	// Check amount
	authValue := mustBI(p.Payload.Authorization.Value)
	reqAmount := mustBI(p.Accepted.Amount)
	if authValue.Cmp(reqAmount) < 0 {
		return nil, fmt.Errorf("amount too low: authorized %s, required %s", authValue, reqAmount)
	}

	slog.Info("local verify OK", "payer", recovered.Hex(), "amount", authValue.String())
	return &VerifyResult{Payer: recovered.Hex()}, nil
}

// ---------------------------------------------------------------------------
// Settle — submits transferWithAuthorization to the USDC contract
// ---------------------------------------------------------------------------

func (f *LocalFacilitator) Settle(ctx context.Context, payloadBytes, _ []byte) error {
	p, err := parseLocalPayload(payloadBytes)
	if err != nil {
		return err
	}

	_, nonce32, err := eip712Digest(p)
	if err != nil {
		return err
	}

	from := common.HexToAddress(p.Payload.Authorization.From)
	to := common.HexToAddress(p.Payload.Authorization.To)
	value := mustBI(p.Payload.Authorization.Value)
	validAfter := mustBI(p.Payload.Authorization.ValidAfter)
	validBefore := mustBI(p.Payload.Authorization.ValidBefore)
	usdcAddr := common.HexToAddress(p.Accepted.Asset)

	// Decode signature → v, r, s
	sigHex := strings.TrimPrefix(p.Payload.Signature, "0x")
	sig, err := hex.DecodeString(sigHex)
	if err != nil || len(sig) != 65 {
		return fmt.Errorf("invalid signature for settlement")
	}
	var r, s [32]byte
	copy(r[:], sig[:32])
	copy(s[:], sig[32:64])
	v := sig[64]
	if v < 27 {
		v += 27 // USDC contract expects 27/28
	}

	// ABI-encode transferWithAuthorization(address,address,uint256,uint256,uint256,bytes32,uint8,bytes32,bytes32)
	callData := packTransferWithAuth(from, to, value, validAfter, validBefore, nonce32, v, r, s)

	client, err := ethclient.DialContext(ctx, f.rpcURL)
	if err != nil {
		return fmt.Errorf("rpc connect: %w", err)
	}
	defer client.Close()

	txNonce, err := client.PendingNonceAt(ctx, f.address)
	if err != nil {
		return fmt.Errorf("pending nonce: %w", err)
	}

	// Gas estimation with safe fallback
	gasLimit := uint64(100_000)
	if est, err := client.EstimateGas(ctx, ethereum.CallMsg{
		From: f.address,
		To:   &usdcAddr,
		Data: callData,
	}); err == nil {
		gasLimit = est * 12 / 10 // 20% buffer
	}

	// EIP-1559 fee params
	header, err := client.HeaderByNumber(ctx, nil)
	if err != nil {
		return fmt.Errorf("latest header: %w", err)
	}
	tip := big.NewInt(1e9) // 1 gwei priority fee
	feeCap := new(big.Int).Add(header.BaseFee, tip)

	tx := types.NewTx(&types.DynamicFeeTx{
		ChainID:   f.chainID,
		Nonce:     txNonce,
		GasTipCap: tip,
		GasFeeCap: feeCap,
		Gas:       gasLimit,
		To:        &usdcAddr,
		Value:     new(big.Int),
		Data:      callData,
	})

	signed, err := types.SignTx(tx, types.NewLondonSigner(f.chainID), f.privateKey)
	if err != nil {
		return fmt.Errorf("signing settlement tx: %w", err)
	}

	if err := client.SendTransaction(ctx, signed); err != nil {
		return fmt.Errorf("transaction_failed: %w", err)
	}

	slog.Info("settlement tx submitted",
		"hash", signed.Hash().Hex(),
		"from", from.Hex(),
		"to", to.Hex(),
		"value", value.String(),
	)
	return nil
}

// ---------------------------------------------------------------------------
// Manual ABI encoding for transferWithAuthorization
// ---------------------------------------------------------------------------

// packTransferWithAuth manually ABI-encodes the transferWithAuthorization call.
// This avoids a runtime abi.JSON parse and keeps the import footprint small.
func packTransferWithAuth(
	from, to common.Address,
	value, validAfter, validBefore *big.Int,
	nonce [32]byte,
	v uint8,
	r, s [32]byte,
) []byte {
	// Each argument occupies one 32-byte slot.
	// Addresses: right-aligned in 32 bytes (left zero-padded).
	// uint256: big-endian, left zero-padded.
	// bytes32: as-is.
	// uint8: right-aligned in 32 bytes.
	data := make([]byte, 4+9*32)
	copy(data[:4], transferWithAuthSig)
	offset := 4
	copy(data[offset+12:offset+32], from.Bytes()); offset += 32
	copy(data[offset+12:offset+32], to.Bytes()); offset += 32
	copy(data[offset:offset+32], pad32(value)); offset += 32
	copy(data[offset:offset+32], pad32(validAfter)); offset += 32
	copy(data[offset:offset+32], pad32(validBefore)); offset += 32
	copy(data[offset:offset+32], nonce[:]); offset += 32
	data[offset+31] = v; offset += 32
	copy(data[offset:offset+32], r[:]); offset += 32
	copy(data[offset:offset+32], s[:]); offset += 32
	return data
}
