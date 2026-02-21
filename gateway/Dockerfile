# syntax=docker/dockerfile:1
FROM golang:1.26-alpine AS builder

WORKDIR /app

# Cache module downloads separately from source.
COPY go.mod go.sum ./
RUN go mod download

COPY . .
RUN CGO_ENABLED=0 GOOS=linux go build -trimpath -ldflags="-s -w" -o gateway .

# ---- Final image ----
FROM alpine:3.19

# ca-certificates lets the gateway make TLS calls to the Coinbase facilitator.
RUN apk --no-cache add ca-certificates

WORKDIR /app
COPY --from=builder /app/gateway .

EXPOSE 8080

ENTRYPOINT ["./gateway"]
