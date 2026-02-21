package proxy

import (
	"log/slog"
	"net/http"
	"net/http/httputil"
	"net/url"
)

// RPC is a reverse proxy that forwards JSON-RPC requests to an upstream node.
// It strips client-identifying headers before forwarding.
type RPC struct {
	proxy *httputil.ReverseProxy
}

// NewRPC creates a new RPC reverse proxy targeting upstreamURL.
func NewRPC(upstreamURL string) (*RPC, error) {
	target, err := url.Parse(upstreamURL)
	if err != nil {
		return nil, err
	}

	rp := httputil.NewSingleHostReverseProxy(target)

	// Wrap the default director to strip identifying headers.
	base := rp.Director
	rp.Director = func(req *http.Request) {
		base(req)
		// Strip all headers that could identify or correlate the originating client.
		req.Header.Del("X-Forwarded-For")
		req.Header.Del("X-Forwarded-Host")
		req.Header.Del("X-Forwarded-Proto")
		req.Header.Del("X-Real-Ip")
		req.Header.Del("Forwarded")
		req.Header.Del("Via")
		// Strip x402 and auth headers — upstream must not see these.
		req.Header.Del("Authorization")
		req.Header.Del("Payment-Signature")
		req.Header.Del("X-Payment")
		// Force the Host header to match the upstream to avoid leaking the
		// client's original Host and to prevent host-header routing issues.
		req.Host = target.Host
	}

	// Propagate upstream errors to the client as 502.
	// Log the full error server-side but return a generic message to the client
	// to avoid leaking the upstream RPC URL or internal connection details.
	rp.ErrorHandler = func(w http.ResponseWriter, _ *http.Request, err error) {
		slog.Error("upstream RPC error", "err", err)
		http.Error(w, "upstream unavailable", http.StatusBadGateway)
	}

	return &RPC{proxy: rp}, nil
}

// ServeHTTP forwards the request to the upstream RPC node.
func (r *RPC) ServeHTTP(w http.ResponseWriter, req *http.Request) {
	r.proxy.ServeHTTP(w, req)
}
