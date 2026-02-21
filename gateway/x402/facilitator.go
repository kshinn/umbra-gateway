package x402

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"time"
)

// FacilitatorClient is the interface for x402 payment verification and settlement.
// Implement this interface to support different facilitator backends (Coinbase,
// KiteAI, self-hosted, etc.) or pass nil to the middleware to disable payment
// gating entirely (plain proxy mode).
type FacilitatorClient interface {
	Verify(ctx context.Context, payloadBytes, requirementsBytes []byte) (*VerifyResult, error)
	Settle(ctx context.Context, payloadBytes, requirementsBytes []byte) error
}

// RemoteFacilitator talks to an x402 facilitator REST API.
// It verifies and settles x402 payments without requiring the full x402 SDK.
type RemoteFacilitator struct {
	url    string
	client *http.Client
}

// NewFacilitator creates a RemoteFacilitator that calls facilitatorURL.
func NewFacilitator(facilitatorURL string) *RemoteFacilitator {
	return &RemoteFacilitator{
		url: facilitatorURL,
		client: &http.Client{
			Timeout: 30 * time.Second,
		},
	}
}

// VerifyResult holds the outcome of a verify call.
type VerifyResult struct {
	// Payer is the Ethereum address that authorised the payment.
	Payer string
}

// Verify checks that the payment payload is valid against the requirements.
//
// payloadBytes is the raw JSON unmarshalled from the client's
// Payment-Signature header (after base64-decoding).
// requirementsBytes is the JSON for a PaymentRequirementsV1 struct.
func (f *RemoteFacilitator) Verify(ctx context.Context, payloadBytes, requirementsBytes []byte) (*VerifyResult, error) {
	body, err := f.buildBody(payloadBytes, requirementsBytes)
	if err != nil {
		return nil, err
	}

	var resp struct {
		IsValid        bool   `json:"isValid"`
		InvalidReason  string `json:"invalidReason"`
		InvalidMessage string `json:"invalidMessage"`
		Payer          string `json:"payer"`
	}
	if err := f.post(ctx, "/verify", body, &resp); err != nil {
		return nil, fmt.Errorf("facilitator verify: %w", err)
	}
	if !resp.IsValid {
		reason := resp.InvalidReason
		if resp.InvalidMessage != "" {
			reason += ": " + resp.InvalidMessage
		}
		return nil, fmt.Errorf("payment invalid: %s", reason)
	}
	return &VerifyResult{Payer: resp.Payer}, nil
}

// Settle finalises the on-chain payment. Call after a successful Verify.
func (f *RemoteFacilitator) Settle(ctx context.Context, payloadBytes, requirementsBytes []byte) error {
	body, err := f.buildBody(payloadBytes, requirementsBytes)
	if err != nil {
		return err
	}

	var resp struct {
		Success      bool   `json:"success"`
		ErrorReason  string `json:"errorReason"`
		ErrorMessage string `json:"errorMessage"`
	}
	if err := f.post(ctx, "/settle", body, &resp); err != nil {
		return fmt.Errorf("facilitator settle: %w", err)
	}
	if !resp.Success {
		reason := resp.ErrorReason
		if resp.ErrorMessage != "" {
			reason += ": " + resp.ErrorMessage
		}
		return fmt.Errorf("settlement failed: %s", reason)
	}
	return nil
}

// buildBody constructs the JSON request body for /verify and /settle.
// The x402 facilitator expects:
//
//	{ "x402Version": 1, "paymentPayload": {...}, "paymentRequirements": {...} }
func (f *RemoteFacilitator) buildBody(payloadBytes, requirementsBytes []byte) ([]byte, error) {
	var payload, requirements json.RawMessage = payloadBytes, requirementsBytes

	// Detect x402Version from the payload (field "x402Version").
	var versionProbe struct {
		X402Version int `json:"x402Version"`
	}
	if err := json.Unmarshal(payloadBytes, &versionProbe); err != nil {
		return nil, fmt.Errorf("parsing payment payload: %w", err)
	}
	version := versionProbe.X402Version
	if version == 0 {
		version = 1 // default to v1
	}

	body := map[string]interface{}{
		"x402Version":         version,
		"paymentPayload":      payload,
		"paymentRequirements": requirements,
	}
	return json.Marshal(body)
}

// post sends a POST request to path (relative to f.url) with the given JSON
// body, and JSON-decodes the response into dst.
func (f *RemoteFacilitator) post(ctx context.Context, path string, body []byte, dst interface{}) error {
	url := f.url + path
	slog.Debug("facilitator request", "url", url, "body", string(body))

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, url, bytes.NewReader(body))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")

	resp, err := f.client.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()

	respBody, err := io.ReadAll(resp.Body)
	if err != nil {
		return fmt.Errorf("reading response: %w", err)
	}

	slog.Debug("facilitator response", "url", url, "status", resp.StatusCode, "body", string(respBody))

	if resp.StatusCode >= 400 {
		return fmt.Errorf("facilitator returned %d: %s", resp.StatusCode, respBody)
	}

	return json.Unmarshal(respBody, dst)
}
