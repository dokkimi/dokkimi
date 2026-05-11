# Interceptor

## Overview

Interceptor is a lightweight Go service that runs as a separate pod for each service in Kubernetes. It intercepts all HTTP and HTTPS traffic from the service, logs requests/responses to the Control Tower, and can mock API responses based on configured mock endpoints. It acts as a transparent proxy that enables request/response logging and API mocking capabilities, including TLS-terminating MITM for outbound HTTPS calls.

## Architecture

- **Language**: Go 1.21+
- **Framework**: Standard library HTTP (no external framework)
- **Deployment**: Separate pod for each service (1:1 ratio)
- **Ports**: Listens on port 80 (HTTP) and port 443 (HTTPS, enabled when CA cert/key are mounted)
- **Communication**: HTTP client calls to Control Tower and Proxy Service
- **Dependencies**: Minimal (only `github.com/google/uuid`)

### Deployment Model: Separate Pods

**Each service has its own dedicated interceptor pod that monitors all outbound traffic from that service.**

This architecture provides:

- **Traffic Monitoring**: All HTTP and HTTPS traffic from the service is intercepted and logged
- **Isolation**: Each service's traffic is monitored independently
- **Per-Service Debugging**: Logs and mocks are scoped to individual services
- **DNS-Based Interception**: Traffic is routed via DNS, capturing all HTTP clients including `fetch()`
- **Clear Origin Attribution**: Each interceptor knows which service's traffic it handles

## Key Features

### 1. Request Interception

- Catches all HTTP requests to the pod on port 80
- Catches all HTTPS requests to the pod on port 443, terminating TLS with on-the-fly per-hostname certificates signed by the Dokkimi CA (see "HTTPS / TLS Termination" below)
- Forwards requests to the actual destination
- Preserves headers, query parameters, and body

### 1a. HTTPS / TLS Termination

When a CA cert and key are mounted (via `DOKKIMI_CA_CERT_PATH` / `DOKKIMI_CA_KEY_PATH`), the interceptor also listens on port 443 and acts as a TLS-terminating MITM proxy:

- On every TLS `ClientHello`, it reads the SNI hostname (e.g., `api.stripe.com`)
- Generates an RSA-2048 leaf certificate signed by the Dokkimi CA, valid for 24 hours, with a SAN matching the hostname
- Caches the cert per hostname for ~1 hour to avoid regenerating on every connection
- After the handshake completes, the request flows through the same proxy/mock/log pipeline as HTTP

The CA itself is generated once per cluster by Control Tower and stored in the `dokkimi-ca` Kubernetes Secret. Service pods automatically receive the CA via mounted file plus `NODE_EXTRA_CA_CERTS`, `SSL_CERT_FILE`, and (for JVM services) a keytool-updated truststore — so the certs the interceptor presents are trusted with no per-service configuration. If the CA env vars are not set, HTTPS interception is disabled and the interceptor logs `"No CA cert/key found, HTTPS interception disabled"` at startup.

### 2. Request/Response Logging

- Logs all requests to Control Tower with:
  - Request method, URL, headers, body
  - Response status, headers, body
  - Action ID for correlation
  - Timestamp and metadata
- **Async logging** - Never blocks request handling
- Uses buffered channels for non-blocking operation

### 3. API Mocking

- Checks for matching mock endpoints from Proxy Service
- Returns mocked responses when matches are found
- Supports configurable response delays
- Can override response status codes, headers, and body
- Fast in-memory cache with periodic refresh

### 4. Ingress Support

- Special handling for Dokkimi ingress requests
- Routes requests based on URL mapping
- Supports namespace-based routing

### 5. Performance

- Minimal latency overhead (< 5ms per request)
- Connection pooling for efficient HTTP clients
- Async operations to prevent blocking

### 6. Health Checks

- `/health` endpoint for Kubernetes liveness/readiness probes
- Returns `{"status":"healthy"}` with HTTP 200 when service is operational
- Used by Kubernetes to detect and restart unhealthy pods

## Project Structure

```
interceptor/
├── main.go                    # Entry point, HTTP server setup
├── config.go                  # Configuration loading & validation
├── proxy.go                   # HTTP proxy logic
├── logger.go                  # Async logging to Control Tower
├── mock.go                    # Mock endpoint matching & application
├── cache.go                   # Mock/URL map caching
├── proxy_service_client.go    # Communication with proxy-service
├── types.go                   # Type definitions
├── test_helpers.go            # Test helper functions
├── go.mod                     # Go module definition
├── go.sum                     # Dependency checksums
└── *_test.go                  # Test files
```

## Dependencies

**Minimal dependencies** - Only 1 external package:

- `github.com/google/uuid` - UUID generation for action IDs

All other functionality uses Go standard library.

## Environment Variables

### Required

- `CONTROL_TOWER_URI` - Control Tower API endpoint (e.g., `http://localhost:5000`)
- `API_KEY` - API key for authentication
- `PROXY_SERVICE_URI` - Proxy Service API endpoint (e.g., `http://localhost:5001`)
- `NAMESPACE` - Kubernetes namespace identifier

### Optional

- `PORT` - HTTP server port (default: `80`)
- `DOKKIMI_CA_CERT_PATH` - Path to the Dokkimi CA certificate (PEM). Required to enable HTTPS interception on port 443. In Kubernetes this is mounted from the `dokkimi-ca` Secret at `/etc/dokkimi/ca/tls.crt`.
- `DOKKIMI_CA_KEY_PATH` - Path to the Dokkimi CA private key (PEM, PKCS1 or PKCS8). Required to enable HTTPS interception. Mounted at `/etc/dokkimi/ca/tls.key`.
- `ORIGIN` - Origin identifier (e.g., `"dokkimi"` for ingress requests)
- `ORIGIN_DOMAIN` - Domain of the origin service
- `LOG_ACTIONS` - Enable/disable logging (default: `true`, set to `"false"` to disable)

If `DOKKIMI_CA_CERT_PATH` and `DOKKIMI_CA_KEY_PATH` are not both set, the interceptor still serves HTTP on port 80 but logs `"No CA cert/key found, HTTPS interception disabled"` and skips the 443 listener.

## Building

### Prerequisites

- Go 1.21 or later
- Docker (for building container image)

### Build Binary

```bash
# Build the binary
go build -o interceptor .

# Or with optimizations for production
CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -a -installsuffix cgo -ldflags "-s -w" -o interceptor .
```

### Build Docker Image

The Dockerfile uses a multi-stage build for minimal image size:

```bash
# From the repository root
docker build -f Dockerfile.interceptor -t interceptor:latest .
```

The resulting image:

- Uses `FROM scratch` (minimal base)
- Static binary (no dependencies)
- Expected size: ~5-8MB (can be compressed to ~2-3MB with UPX)

## Running

### Local Development

1. **Set environment variables:**

```bash
export CONTROL_TOWER_URI=http://localhost:5000
export PROXY_SERVICE_URI=http://localhost:5001
export API_KEY=your-api-key
export NAMESPACE=test-namespace
export ORIGIN=test-origin
export ORIGIN_DOMAIN=test.example.com
```

2. **Run the service:**

```bash
go run .
# Or if built:
./interceptor
```

The service will start on port 80 (or the port specified in `PORT` environment variable). If `DOKKIMI_CA_CERT_PATH` and `DOKKIMI_CA_KEY_PATH` are also set, it additionally listens on port 443 for HTTPS.

### Docker

```bash
docker run -p 80:80 -p 443:443 \
  -v $PWD/dokkimi-ca:/etc/dokkimi/ca:ro \
  -e CONTROL_TOWER_URI=http://control-tower:5000 \
  -e PROXY_SERVICE_URI=http://proxy-service:5001 \
  -e API_KEY=your-api-key \
  -e NAMESPACE=test-namespace \
  -e ORIGIN=test-origin \
  -e ORIGIN_DOMAIN=test.example.com \
  -e DOKKIMI_CA_CERT_PATH=/etc/dokkimi/ca/tls.crt \
  -e DOKKIMI_CA_KEY_PATH=/etc/dokkimi/ca/tls.key \
  interceptor:latest
```

To run HTTP-only (no HTTPS interception), drop the `-p 443:443`, the `-v` mount, and the two `DOKKIMI_CA_*` env vars.

### Kubernetes

The interceptor is deployed as a separate pod for each service. See Control Tower's Kubernetes service for deployment configuration.

## Testing

### Unit Tests (Go)

Run all unit tests:

```bash
go test ./...
```

### Integration Tests (Shell Scripts)

Integration and end-to-end test scripts are located in the `tests/` directory.

See [tests/TESTING.md](tests/TESTING.md) for complete testing documentation.

Quick start:

```bash
cd tests
./test-quick.sh          # Quick verification test
./test-comprehensive.sh   # Multiple configuration tests
./test-with-mock-service.sh  # Full integration with mock services
```

### Run Tests with Verbose Output

```bash
go test -v ./...
```

### Run Specific Test

```bash
go test -v -run TestHandleRequest ./...
```

### Run Tests with Coverage

```bash
# Generate coverage report
go test -coverprofile=coverage.out ./...

# View coverage summary
go tool cover -func=coverage.out

# View detailed coverage by file
go tool cover -func=coverage.out | grep -E "(config|cache|mock|proxy|logger)"
```

### View HTML Coverage Report

```bash
# Generate HTML report
go tool cover -html=coverage.out -o coverage.html

# Open in browser (macOS)
open coverage.html

# Or view in terminal
go tool cover -html=coverage.out
```

### Current Test Coverage

**86.9%** overall coverage

- `config.go`: 100% ✅
- `cache.go`: 100% ✅
- `mock.go`: ~96%
- `proxy.go`: ~94%
- `logger.go`: ~92%
- `proxy_service_client.go`: ~93%
- `main.go`: 0% (entry point - tested via integration tests)

**Note**: The `main()` function is intentionally not unit tested as it's the entry point. All testable business logic is covered.

### Test Files

- `config_test.go` - Configuration loading and validation
- `cache_test.go` - Cache operations and concurrency
- `mock_test.go` - Mock matching and response generation
- `proxy_test.go` - HTTP proxying and forwarding
- `logger_test.go` - Async logging
- `proxy_service_client_test.go` - Proxy service communication
- `main_test.go` - Request handling and cache refresh
- `test_helpers_test.go` - Helper utilities

## Verification

### Verify Build

```bash
# Check binary was created
ls -lh interceptor

# Check binary is statically linked
file interceptor
# Should show: "statically linked"

# Check binary size (should be ~5-8MB)
du -h interceptor
```

### Verify Configuration

```bash
# Test configuration loading
go run . 2>&1 | head -5
# Should show validation errors if required env vars are missing
```

### Verify Health Check

```bash
# Start the interceptor (see Running section)

# Check health endpoint
curl http://localhost:80/health
# Should return: {"status":"healthy"}
```

### Verify Functionality

1. **Start the interceptor** (see Running section)

2. **Send a test request:**

```bash
curl http://localhost:80/test
```

3. **Check logs** - The request should be logged to Control Tower (if `LOG_ACTIONS=true`)

4. **Check mock functionality:**
   - Configure a mock endpoint via proxy-service
   - Send matching request
   - Should return mocked response

## Development

### Code Style

- Follow Go standard formatting (`go fmt`)
- Use `golangci-lint` for linting (optional)
- Follow Go naming conventions

### Adding New Features

1. Write tests first (TDD approach)
2. Implement feature
3. Ensure tests pass
4. Maintain or improve coverage

### Debugging

```bash
# Run with debug logging
go run . 2>&1 | tee interceptor.log

# Use Delve debugger
dlv debug .
```

## Performance

### Benchmarks

Run benchmarks:

```bash
go test -bench=. -benchmem ./...
```

### Performance Characteristics

- **Latency overhead**: < 5ms per request (excluding network)
- **Throughput**: 2000+ req/s
- **Memory**: ~20-30MB under normal load
- **CPU**: Minimal usage

## Troubleshooting

### Service Won't Start

1. **Check environment variables:**

```bash
env | grep -E "(CONTROL_TOWER|PROXY_SERVICE|API_KEY|NAMESPACE)"
```

2. **Check port availability:**

```bash
lsof -i :80
```

3. **Check logs:**

```bash
# If running in Docker
docker logs <container-id>

# If running locally
# Check stdout/stderr
```

### Logs Not Appearing in Control Tower

1. **Verify Control Tower is running and accessible**
2. **Check `LOG_ACTIONS` environment variable** (should be `true` or unset)
3. **Check API key is correct**
4. **Check network connectivity** to Control Tower

### Mocks Not Working

1. **Verify proxy-service is running**
2. **Check mock cache is refreshing** (logs will show refresh attempts)
3. **Verify mock endpoint configuration** matches request
4. **Check URL map is loaded** correctly

## Architecture Decisions

### Why Go?

- **Minimal image size**: ~5-8MB (vs 150-200MB for Node.js)
- **Fast**: Excellent for network services
- **Simple**: Easy to learn and maintain
- **Production proven**: Used by Docker, Kubernetes, etc. for network services

### Language Choice

Go was chosen for this service because:

- **Minimal image size**: ~5-8MB static binary (vs 150-200MB for Node.js)
- **Fast**: Excellent performance for network services
- **Simple**: Standard library handles HTTP perfectly
- **Production proven**: Used by Docker, Kubernetes, etc. for network services
- **Consistency**: Matches proxy-service language choice

#### Detailed Language Comparison

**Go ✅ (Chosen)**

- ✅ Smallest practical binary: ~5-8MB (can compress to 2-3MB)
- ✅ Static compilation: Single binary, no runtime needed
- ✅ Fast: Excellent for network services
- ✅ Low memory: ~20-30MB under load
- ✅ Great HTTP support: Standard library is excellent
- ✅ Concurrency: Goroutines perfect for async logging
- ✅ Already in codebase: proxy-service uses Go
- ✅ Easy to learn: Simple syntax, good docs
- ❌ You don't know Go (but it's learnable)

**Rust** (Alternative considered)

- ✅ Smallest binary: ~2-3MB (can compress to <1MB)
- ✅ Fastest: Zero-cost abstractions
- ✅ Memory safe: No GC, compile-time guarantees
- ✅ Modern: Excellent tooling, cargo
- ❌ Steeper learning curve: Ownership, lifetimes
- ❌ More verbose: More code for simple tasks
- ❌ Longer compile times: Slower iteration
- ❌ Not in codebase: Would be the only Rust service

**Node.js/Deno/Bun** (Not suitable)

- ❌ Large image size: 150-200MB+ (even with Alpine)
- ❌ Runtime overhead: V8 engine, npm packages
- ❌ Memory usage: Higher baseline memory
- ✅ You know JavaScript: Familiar language
- ✅ Fast development: Quick iteration
- ❌ Not suitable for lightweight services: Image size is critical

**Conclusion**: Go provides the best balance of small image size, performance, simplicity, and maintainability for a sidecar service where footprint is critical.

### Why Minimal Dependencies?

- Smaller binary size
- Faster builds
- Fewer security vulnerabilities
- Easier to maintain

### Why Async Logging?

- Never blocks request handling
- Prevents latency spikes
- Handles Control Tower failures gracefully
- Uses buffered channels for efficiency

## Related Services

- **control-tower**: Receives logged actions
- **proxy-service**: Provides mock endpoints and URL maps

## Migration from Old Code

The new implementation is **fully backward compatible**:

- ✅ Same environment variables
- ✅ Same API contract with Control Tower
- ✅ Same API contract with proxy-service
- ✅ Same log format
- ✅ Same mock endpoint format

**No changes needed in other services!**

## Future Enhancements

1. **Request Transformation**: Modify requests before forwarding
2. **Response Transformation**: Modify responses before returning
3. **Request Replay**: Replay logged requests
4. **Traffic Analysis**: Analyze patterns in logged traffic
5. **Security Scanning**: Scan requests for vulnerabilities
6. **Metrics**: Prometheus metrics endpoint
7. **Health Checks**: `/health` endpoint

## License

[Your License Here]
