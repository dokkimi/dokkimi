#!/bin/bash
# Quick test to verify interceptor works

set -e

echo "=== Quick Interceptor Test ==="
echo ""

# Cleanup
docker stop interceptor-test 2>/dev/null || true
docker rm interceptor-test 2>/dev/null || true

echo "Starting interceptor..."
docker run -d \
  --name interceptor-test \
  -p 8080:80 \
  -e CONTROL_TOWER_URI="http://host.docker.internal:5000" \
  -e PROXY_SERVICE_URI="http://host.docker.internal:5001" \
  -e API_KEY="test-key" \
  -e NAMESPACE="test-namespace" \
  -e LOG_ACTIONS="false" \
  --add-host=host.docker.internal:host-gateway \
  interceptor:test

sleep 3

echo ""
echo "=== Test Results ==="

# Test 1: Health check
echo -n "Health check: "
HEALTH=$(curl -s http://localhost:8080/health 2>&1)
if echo "$HEALTH" | grep -q "healthy"; then
    echo "✓ PASS - $HEALTH"
else
    echo "✗ FAIL - $HEALTH"
    exit 1
fi

# Test 2: Proxy (will return 502, but shows it's working)
echo -n "Proxy request: "
PROXY=$(curl -s -w "\n%{http_code}" http://localhost:8080/test 2>&1 | tail -1)
if [ "$PROXY" = "502" ] || [ "$PROXY" = "000" ]; then
    echo "✓ PASS - HTTP $PROXY (expected, no target service)"
else
    echo "? UNEXPECTED - HTTP $PROXY"
fi

# Test 3: Different port configuration
echo ""
echo "Testing custom port configuration..."
docker stop interceptor-test 2>/dev/null || true
docker rm interceptor-test 2>/dev/null || true

docker run -d \
  --name interceptor-test \
  -p 8081:8081 \
  -e PORT="8081" \
  -e CONTROL_TOWER_URI="http://host.docker.internal:5000" \
  -e PROXY_SERVICE_URI="http://host.docker.internal:5001" \
  -e API_KEY="test-key" \
  -e NAMESPACE="test-namespace" \
  -e LOG_ACTIONS="false" \
  --add-host=host.docker.internal:host-gateway \
  interceptor:test

sleep 3

echo -n "Custom port (8081) health check: "
HEALTH2=$(curl -s http://localhost:8081/health 2>&1)
if echo "$HEALTH2" | grep -q "healthy"; then
    echo "✓ PASS - $HEALTH2"
else
    echo "✗ FAIL - $HEALTH2"
fi

echo ""
echo "=== All Tests Complete ==="
echo ""
echo "Containers running:"
docker ps | grep interceptor-test
echo ""
echo "To cleanup: docker stop interceptor-test && docker rm interceptor-test"
