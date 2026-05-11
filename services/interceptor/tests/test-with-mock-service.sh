#!/bin/bash

# Advanced Interceptor Test with Mock Services
# Creates a complete test environment with mock Control Tower and Proxy Service

set -e

# Colors
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
BLUE='\033[0;34m'
NC='\033[0m'

cleanup() {
    echo ""
    echo -e "${YELLOW}Cleaning up test containers...${NC}"
    docker stop interceptor-test mock-control-tower mock-proxy-service mock-target 2>/dev/null || true
    docker rm interceptor-test mock-control-tower mock-proxy-service mock-target 2>/dev/null || true
    echo -e "${GREEN}Cleanup complete${NC}"
}

trap cleanup EXIT

echo -e "${BLUE}=== Advanced Interceptor Test with Mock Services ===${NC}"
echo ""

# Step 1: Create mock Control Tower
echo -e "${BLUE}Step 1: Creating mock Control Tower...${NC}"
docker run -d \
  --name mock-control-tower \
  --network host \
  -p 5000:5000 \
  python:3.11-alpine \
  sh -c "pip install flask && python -c \"
from flask import Flask, request, jsonify
app = Flask(__name__)
logged_actions = []

@app.route('/actions/logAction', methods=['POST'])
def log_action():
    data = request.get_json()
    logged_actions.append(data)
    return jsonify({'status': 'logged', 'id': data.get('actionId')}), 200

@app.route('/actions', methods=['GET'])
def get_actions():
    return jsonify({'count': len(logged_actions), 'actions': logged_actions}), 200

if __name__ == '__main__':
    app.run(host='0.0.0.0', port=5000)
\""

sleep 2
echo -e "${GREEN}✓ Mock Control Tower running on port 5000${NC}"

# Step 2: Create mock Proxy Service
echo ""
echo -e "${BLUE}Step 2: Creating mock Proxy Service...${NC}"
docker run -d \
  --name mock-proxy-service \
  --network host \
  -p 5001:5001 \
  python:3.11-alpine \
  sh -c "pip install flask && python -c \"
from flask import Flask, request, jsonify
app = Flask(__name__)

# Mock endpoints storage
mock_endpoints = [
    {
        'method': 'GET',
        'origin': '*',
        'target': '*',
        'path': '/mock-test',
        'responseStatus': 200,
        'responseBody': '{\"mocked\": true, \"message\": \"This is a mocked response\"}'
    }
]

url_map = {
    'localhost:9000': {
        'scheme': 'http',
        'url': 'localhost:9000',
        'name': 'mock-target'
    }
}

@app.route('/proxy-service/interceptor-proxy/<namespace>/mockEndpoints', methods=['GET'])
def get_mocks(namespace):
    api_key = request.headers.get('ApiKey')
    if api_key != 'test-key':
        return jsonify({'error': 'unauthorized'}), 401
    return jsonify(mock_endpoints), 200

@app.route('/proxy-service/interceptor-proxy/<namespace>/urlMap', methods=['GET'])
def get_url_map(namespace):
    api_key = request.headers.get('ApiKey')
    if api_key != 'test-key':
        return jsonify({'error': 'unauthorized'}), 401
    return jsonify(url_map), 200

if __name__ == '__main__':
    app.run(host='0.0.0.0', port=5001)
\""

sleep 2
echo -e "${GREEN}✓ Mock Proxy Service running on port 5001${NC}"

# Step 3: Create mock target service
echo ""
echo -e "${BLUE}Step 3: Creating mock target service...${NC}"
docker run -d \
  --name mock-target \
  --network host \
  -p 9000:9000 \
  python:3.11-alpine \
  sh -c "pip install flask && python -c \"
from flask import Flask, request, jsonify
app = Flask(__name__)

@app.route('/', defaults={'path': ''})
@app.route('/<path:path>')
def catch_all(path):
    return jsonify({
        'path': '/' + path,
        'method': request.method,
        'headers': dict(request.headers),
        'query': dict(request.args),
        'body': request.get_data(as_text=True) or None,
        'source': 'mock-target-service'
    }), 200

if __name__ == '__main__':
    app.run(host='0.0.0.0', port=9000)
\""

sleep 2
echo -e "${GREEN}✓ Mock target service running on port 9000${NC}"

# Step 4: Start interceptor with full configuration
echo ""
echo -e "${BLUE}Step 4: Starting Interceptor with full configuration...${NC}"
docker stop interceptor-test 2>/dev/null || true
docker rm interceptor-test 2>/dev/null || true

docker run -d \
  --name interceptor-test \
  --network host \
  -p 8080:80 \
  -e CONTROL_TOWER_URI="http://host.docker.internal:5000" \
  -e PROXY_SERVICE_URI="http://host.docker.internal:5001" \
  -e API_KEY="test-key" \
  -e NAMESPACE="test-namespace" \
  -e LOG_ACTIONS="true" \
  -e ORIGIN="test-origin" \
  -e ORIGIN_DOMAIN="test.example.com" \
  interceptor:test

sleep 3
echo -e "${GREEN}✓ Interceptor started${NC}"

# Step 5: Run comprehensive tests
echo ""
echo -e "${BLUE}Step 5: Running Tests${NC}"
echo ""

# Test 1: Health check
echo -e "${YELLOW}Test 1: Health Check${NC}"
HEALTH=$(curl -s http://localhost:8080/health)
if echo "$HEALTH" | grep -q "healthy"; then
    echo -e "  ${GREEN}✓ PASS: $HEALTH${NC}"
else
    echo -e "  ${RED}✗ FAIL: $HEALTH${NC}"
fi

# Test 2: Mock endpoint
echo ""
echo -e "${YELLOW}Test 2: Mock Endpoint${NC}"
MOCK_RESPONSE=$(curl -s http://localhost:8080/mock-test)
if echo "$MOCK_RESPONSE" | grep -q "mocked"; then
    echo -e "  ${GREEN}✓ PASS: Mock endpoint working${NC}"
    echo "  Response: $MOCK_RESPONSE"
else
    echo -e "  ${YELLOW}⚠ Mock endpoint: $MOCK_RESPONSE${NC}"
fi

# Test 3: Proxy to target service
echo ""
echo -e "${YELLOW}Test 3: Proxy to Target Service${NC}"
PROXY_RESPONSE=$(curl -s -H "Host: localhost:9000" http://localhost:8080/api/test)
if echo "$PROXY_RESPONSE" | grep -q "mock-target-service"; then
    echo -e "  ${GREEN}✓ PASS: Proxy working${NC}"
    echo "  Response: $(echo "$PROXY_RESPONSE" | head -c 150)..."
else
    echo -e "  ${YELLOW}⚠ Proxy response: $(echo "$PROXY_RESPONSE" | head -c 100)${NC}"
fi

# Test 4: Check logging
echo ""
echo -e "${YELLOW}Test 4: Logging to Control Tower${NC}"
sleep 2  # Give time for async logging
LOGS=$(curl -s http://localhost:5000/actions)
if echo "$LOGS" | grep -q "actions"; then
    ACTION_COUNT=$(echo "$LOGS" | grep -o '"count":[0-9]*' | grep -o '[0-9]*')
    echo -e "  ${GREEN}✓ PASS: $ACTION_COUNT actions logged${NC}"
else
    echo -e "  ${YELLOW}⚠ Logging check: $LOGS${NC}"
fi

# Test 5: POST request with body
echo ""
echo -e "${YELLOW}Test 5: POST Request with Body${NC}"
POST_RESPONSE=$(curl -s -X POST \
  -H "Content-Type: application/json" \
  -H "Host: localhost:9000" \
  -d '{"test": "data", "value": 123}' \
  http://localhost:8080/api/post-test)
if echo "$POST_RESPONSE" | grep -q "test"; then
    echo -e "  ${GREEN}✓ PASS: POST request with body working${NC}"
else
    echo -e "  ${YELLOW}⚠ POST response: $(echo "$POST_RESPONSE" | head -c 100)${NC}"
fi

# Test 6: Different HTTP methods
echo ""
echo -e "${YELLOW}Test 6: Different HTTP Methods${NC}"
for method in GET POST PUT DELETE; do
    RESPONSE=$(curl -s -X $method -H "Host: localhost:9000" http://localhost:8080/test 2>&1)
    if [ $? -eq 0 ] || echo "$RESPONSE" | grep -q "method"; then
        echo -e "  ${GREEN}✓ $method method works${NC}"
    else
        echo -e "  ${YELLOW}⚠ $method method: $(echo "$RESPONSE" | head -c 50)${NC}"
    fi
done

# Summary
echo ""
echo -e "${BLUE}=== Test Summary ===${NC}"
echo ""
echo "Services running:"
docker ps --format "table {{.Names}}\t{{.Status}}\t{{.Ports}}" | grep -E "(NAME|interceptor|mock)"
echo ""
echo "To view logs:"
echo "  docker logs -f interceptor-test"
echo "  docker logs -f mock-control-tower"
echo "  docker logs -f mock-proxy-service"
echo ""
echo "To check logged actions:"
echo "  curl http://localhost:5000/actions"
echo ""
echo -e "${GREEN}All tests completed!${NC}"

