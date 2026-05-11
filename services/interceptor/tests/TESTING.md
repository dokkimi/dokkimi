# Interceptor Testing Guide

This directory contains comprehensive test scripts for the Interceptor service.

## Test Scripts

All test scripts are located in the `tests/` directory.

### 1. `test-interceptor.sh` - Basic Test

Simple test that verifies the interceptor starts and responds to health checks.

**Usage:**

```bash
cd tests
./test-interceptor.sh
```

**What it tests:**

- Health check endpoint
- Basic proxy functionality
- Container startup

### 2. `test-comprehensive.sh` - Configuration Tests

Tests the interceptor with different environment variable configurations and a mock target service.

**Usage:**

```bash
cd tests
./test-comprehensive.sh
```

**What it tests:**

- Multiple ENV configurations (logging on/off, custom ports)
- Different HTTP methods (GET, POST, PUT, DELETE)
- Custom headers
- Error scenarios
- Integration with target service

**Configurations tested:**

1. Basic (LOG_ACTIONS=false)
2. Custom port (PORT=8081)
3. Logging enabled (LOG_ACTIONS=true)

### 3. `test-with-mock-service.sh` - Full Integration Test

Creates a complete test environment with mock Control Tower, Proxy Service, and target service.

**Usage:**

```bash
cd tests
./test-with-mock-service.sh
```

**What it tests:**

- Full integration with mock services
- Mock endpoint functionality
- Logging to Control Tower
- URL mapping
- POST requests with body
- All HTTP methods

**Services created:**

- Mock Control Tower (port 5000) - receives logged actions
- Mock Proxy Service (port 5001) - provides mocks and URL maps
- Mock Target Service (port 9000) - receives proxied requests
- Interceptor (port 8080) - the service under test

## Quick Start

### Basic Test (No Dependencies)

```bash
# From interceptor directory
cd tests
./test-interceptor.sh
```

### Full Integration Test

```bash
# From interceptor directory
cd tests
./test-with-mock-service.sh
```

## Manual Testing

### Start Interceptor Manually

```bash
docker run -d \
  --name interceptor-test \
  -p 8080:80 \
  -e CONTROL_TOWER_URI="http://host.docker.internal:5000" \
  -e PROXY_SERVICE_URI="http://host.docker.internal:5001" \
  -e API_KEY="test-key" \
  -e NAMESPACE="test-namespace" \
  -e LOG_ACTIONS="false" \
  interceptor:test
```

### Test Endpoints

```bash
# Health check
curl http://localhost:8080/health

# Proxy request (will return 502 if no target)
curl http://localhost:8080/test

# With custom headers
curl -H "X-Custom-Header: value" http://localhost:8080/test
```

### View Logs

```bash
docker logs -f interceptor-test
```

### Cleanup

```bash
docker stop interceptor-test && docker rm interceptor-test
```

## Test Coverage

The test scripts cover:

- ✅ Health check endpoint
- ✅ Multiple environment configurations
- ✅ Different HTTP methods
- ✅ Request/response proxying
- ✅ Mock endpoint matching
- ✅ Logging functionality
- ✅ Error handling
- ✅ Custom headers
- ✅ POST requests with body
- ✅ URL mapping
- ✅ Cache refresh

## Expected Results

### Health Check

- **Expected**: `{"status":"healthy"}` with HTTP 200
- **If fails**: Check container logs, verify container is running

### Proxy Requests

- **Expected**: HTTP 502 if no target service (this is correct behavior)
- **Expected**: HTTP 200 with response body if target service is available
- **If fails**: Check target service is running and accessible

### Mock Endpoints

- **Expected**: Mocked response with `X-Mocked: true` header
- **If fails**: Check Proxy Service is running and mock is configured

## Troubleshooting

**Container won't start:**

- Verify required environment variables are set
- Check port is available: `lsof -i :8080`
- Check Docker logs: `docker logs interceptor-test`

**Health check fails:**

- Wait 2-3 seconds after container start
- Check container status: `docker ps | grep interceptor-test`
- Verify container is running: `docker logs interceptor-test`

**502 errors:**

- This is expected if no target service is configured
- The interceptor is working correctly, just can't reach a target
- To test with a target, use `test-with-mock-service.sh`

**Cache refresh warnings:**

- Normal if Proxy Service isn't running
- Interceptor will continue to function with stale cache
- Cache will refresh when Proxy Service becomes available
