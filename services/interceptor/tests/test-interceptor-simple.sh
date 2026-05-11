#!/bin/bash
# Simple test script for Interceptor

echo "=== Starting Interceptor Test ==="
echo ""

# Stop and remove existing container if running
docker stop interceptor-test 2>/dev/null || true
docker rm interceptor-test 2>/dev/null || true

echo "Starting interceptor container on port 8080..."
echo "Note: Control Tower and Proxy Service don't need to be running for basic tests"
echo ""

# Start container with minimal config
docker run -d \
  --name interceptor-test \
  -p 8080:80 \
  -e CONTROL_TOWER_URI="http://host.docker.internal:5000" \
  -e PROXY_SERVICE_URI="http://host.docker.internal:5001" \
  -e API_KEY="test-key" \
  -e NAMESPACE="test-namespace" \
  -e LOG_ACTIONS="false" \
  interceptor:test

echo "Waiting for container to start..."
sleep 3

echo ""
echo "=== Test 1: Health Check ==="
curl -s http://localhost:8080/health
echo ""
echo ""

echo "=== Test 2: Proxy Request (will fail but shows interceptor is working) ==="
echo "Making request to http://localhost:8080/test..."
curl -v http://localhost:8080/test 2>&1 | head -20
echo ""

echo ""
echo "=== Container Logs ==="
docker logs interceptor-test | tail -10

echo ""
echo "=== Container Status ==="
docker ps | grep interceptor-test

echo ""
echo "=== To stop: docker stop interceptor-test && docker rm interceptor-test ==="
