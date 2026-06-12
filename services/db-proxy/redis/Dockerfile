# Build stage
FROM golang:1.26-alpine AS builder

WORKDIR /build

# Copy shared module first
COPY shared ./shared

# Copy service-specific files to maintain directory structure
COPY redis ./redis

WORKDIR /build/redis

RUN --mount=type=cache,target=/go/pkg/mod \
    go mod download

ARG VERSION=dev
RUN --mount=type=cache,target=/go/pkg/mod \
    --mount=type=cache,target=/root/.cache/go-build \
    CGO_ENABLED=0 GOOS=linux GOARCH=amd64 \
    go build \
      -ldflags="-s -w -X github.com/dokkimi/dokkimi/services/db-proxy/shared.Version=${VERSION}" \
      -trimpath \
      -o /build/db-proxy-redis \
      .

# Get ca-certificates from Alpine
FROM alpine:3.21 AS certs
RUN apk --no-cache add ca-certificates

# Runtime stage - scratch with only binary and ca-certificates
FROM scratch
COPY --from=certs /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/
COPY --from=builder /build/db-proxy-redis /db-proxy
ENTRYPOINT ["/db-proxy"]
