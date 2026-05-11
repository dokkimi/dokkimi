# Build stage
FROM golang:1.25-alpine AS builder

WORKDIR /build

# Copy shared module first
COPY shared ./shared

# Copy service-specific files to maintain directory structure
COPY mysql ./mysql

WORKDIR /build/mysql

RUN --mount=type=cache,target=/go/pkg/mod \
    go mod download

# Update go.mod if needed
RUN go mod tidy

ARG VERSION=dev
RUN CGO_ENABLED=0 GOOS=linux GOARCH=amd64 \
    go build \
      -ldflags="-s -w -X dokkimi.com/db-proxy-shared.Version=${VERSION}" \
      -trimpath \
      -o /build/db-proxy-mysql \
      .

# Get ca-certificates from Alpine
FROM alpine:latest AS certs
RUN apk --no-cache add ca-certificates

# Runtime stage - scratch with only binary and ca-certificates
FROM scratch
COPY --from=certs /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/
COPY --from=builder /build/db-proxy-mysql /db-proxy
ENTRYPOINT ["/db-proxy"]

