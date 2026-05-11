#!/bin/bash

# Test script for Interceptor
# This script helps test the interceptor container locally

set -e

echo "=== Interceptor Test Script ==="
echo ""

# Colors for output
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m' # No Color

# Check if container is running
CONTAINER_NAME="interceptor-test"
if docker ps | grep -q "$CONTAINER_NAME"; then
    echo -e "${YELLOW}Container $CONTAINER_NAME is already running${NC}"
    echo "Stopping existing container..."
    docker stop $CONTAINER_NAME > /dev/null 2>&1 || true
    docker rm $CONTAINER_NAME > /dev/null 2>&1 || true
fi

echo "Starting interceptor container..."
echo ""
echo "Note: This requires the following environment variables:"
echo "  - CONTROL_TOWER_URI (e.g., http://host.docker.internal:5000)"
echo "  - PROXY_SERVICE_URI (e.g., http://host.docker.internal:5001)"
echo "  - API_KEY"
echo "  - NAMESPACE"
echo ""

# Set default values if not provided
CONTROL_TOWER_URI=${CONTROL_TOWER_URI:-"http://host.docker.internal:5000"}
PROXY_SERVICE_URI=${PROXY_SERVICE_URI:-"http://host.docker.internal:5001"}
API_KEY=${API_KEY:-"test-api-key"}
NAMESPACE=${NAMESPACE:-"test-namespace"}

echo "Using configuration:"
echo "  CONTROL_TOWER_URI: $CONTROL_TOWER_URI"
echo "  PROXY_SERVICE_URI: $PROXY_SERVICE_URI"
echo "  API_KEY: $API_KEY"
echo "  NAMESPACE: $NAMESPACE"
echo ""

# Start the container
docker run -d \
  --name $CONTAINER_NAME \
  -p 8080:80 \
  -e CONTROL_TOWER_URI="$CONTROL_TOWER_URI" \
  -e PROXY_SERVICE_URI="$PROXY_SERVICE_URI" \
  -e API_KEY="$API_KEY" \
  -e NAMESPACE="$NAMESPACE" \
  -e ORIGIN="test-origin" \
  -e ORIGIN_DOMAIN="test.example.com" \
  interceptor:test

echo -e "${GREEN}Container started!${NC}"
echo "Waiting for container to be ready..."
sleep 2

# Test health check
echo ""
echo "=== Testing Health Check ==="
HEALTH_RESPONSE=$(curl -s -w "\nHTTP_CODE:%{http_code}" http://localhost:8080/health || echo "HTTP_CODE:000")
HTTP_CODE=$(echo "$HEALTH_RESPONSE" | grep "HTTP_CODE" | cut -d: -f2)
BODY=$(echo "$HEALTH_RESPONSE" | grep -v "HTTP_CODE")

if [ "$HTTP_CODE" = "200" ]; then
    echo -e "${GREEN}✓ Health check passed${NC}"
    echo "Response: $BODY"
else
    echo -e "${RED}✗ Health check failed (HTTP $HTTP_CODE)${NC}"
    echo "Response: $BODY"
fi

# Test proxy functionality (this will fail if no target, but shows it's working)
echo ""
echo "=== Testing Proxy Functionality ==="
echo "Making a test request to httpbin.org (this will be proxied)..."
PROXY_RESPONSE=$(curl -s -w "\nHTTP_CODE:%{http_code}" -m 5 http://localhost:8080/get 2>&1 || echo "HTTP_CODE:000")
PROXY_HTTP_CODE=$(echo "$PROXY_RESPONSE" | grep "HTTP_CODE" | cut -d: -f2)

if [ "$PROXY_HTTP_CODE" = "200" ] || [ "$PROXY_HTTP_CODE" = "502" ] || [ "$PROXY_HTTP_CODE" = "000" ]; then
    if [ "$PROXY_HTTP_CODE" = "200" ]; then
        echo -e "${GREEN}✓ Proxy request succeeded${NC}"
    elif [ "$PROXY_HTTP_CODE" = "502" ]; then
        echo -e "${YELLOW}⚠ Proxy returned 502 (Bad Gateway) - this is expected if target is unreachable${NC}"
        echo "This means the interceptor is working but couldn't reach the target"
    else
        echo -e "${YELLOW}⚠ Request timed out or failed - interceptor is running but target may be unreachable${NC}"
    fi
else
    echo -e "${RED}✗ Unexpected response (HTTP $PROXY_HTTP_CODE)${NC}"
fi

# Show container logs
echo ""
echo "=== Container Logs (last 10 lines) ==="
docker logs --tail 10 $CONTAINER_NAME

echo ""
echo "=== Test Complete ==="
echo ""
echo "Container is running. You can:"
echo "  - View logs: docker logs -f $CONTAINER_NAME"
echo "  - Stop container: docker stop $CONTAINER_NAME"
echo "  - Remove container: docker rm $CONTAINER_NAME"
echo ""
echo "Test endpoints:"
echo "  - Health: curl http://localhost:8080/health"
echo "  - Proxy: curl http://localhost:8080/<any-path>"

