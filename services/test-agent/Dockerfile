# Build stage
FROM golang:1.26-alpine AS builder

WORKDIR /app

# Copy go mod files
COPY go.mod go.sum* ./

# Download dependencies
RUN --mount=type=cache,target=/go/pkg/mod \
    go mod download

# Copy source code
COPY . .

# Update go.mod if needed
RUN go mod tidy

# Build the application
ARG VERSION=dev
RUN CGO_ENABLED=0 GOOS=linux GOARCH=amd64 \
    go build \
      -a \
      -installsuffix cgo \
      -ldflags="-s -w -X main.Version=${VERSION}" \
      -trimpath \
      -o test-agent \
      .

# Get ca-certificates from Alpine
FROM alpine:latest AS certs
RUN apk --no-cache add ca-certificates

# Runtime stage - scratch with only binary and ca-certificates
FROM scratch
COPY --from=certs /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/
COPY --from=builder /app/test-agent /test-agent
EXPOSE 8080
ENTRYPOINT ["/test-agent"]

