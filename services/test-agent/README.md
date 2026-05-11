# Test Agent

The test-agent is a service that orchestrates test execution inside a Kubernetes namespace. It waits for all namespace items (services and databases) to become healthy, then executes test requests according to the test configuration.

## Architecture

The test-agent:

1. Reads `expectedNamespaceItemIds` and `testConfig` from the ConfigMap
2. Receives health status updates from interceptors and readiness sidecars
3. Waits for all expected items to be ready
4. Executes test requests (sequential groups of parallel requests)
5. Notifies Control Tower's `/test-complete` endpoint when complete

## Configuration

The test-agent is configured via environment variables:

- `PORT`: HTTP server port (default: 8080)
- `K8S_NAMESPACE`: Kubernetes namespace name (required)
- `CONFIG_MAP_NAME`: Name of ConfigMap to read from (default: `dokkimi-interceptor-config`)
- `CONTROL_TOWER_URL`: HTTP URL for Control Tower (required) — `/test-complete` is appended for completion notifications

## ConfigMap Data

The test-agent reads the following from the ConfigMap:

### `expectedNamespaceItemIds`

JSON array of instance item IDs that must be healthy before tests run:

```json
["uuid-service-a", "uuid-service-b", "uuid-postgres-db"]
```

### `testConfig`

Test configuration:

```json
{
  "testRunId": "uuid-test-run",
  "callbackUrl": "https://validation.dokkimi.com/test-complete",
  "timeoutSeconds": 300,
  "requests": [
    [
      {
        "method": "POST",
        "service": "service-a",
        "path": "/api/users",
        "body": { "name": "test" }
      }
    ],
    [
      { "method": "GET", "service": "service-a", "path": "/api/users" },
      { "method": "GET", "service": "service-b", "path": "/api/data" }
    ]
  ]
}
```

### `urlMap`

Service name to URL mapping (used to resolve service names in test requests):

```json
{
  "service-a": {
    "scheme": "http",
    "url": "http://service-a:3000",
    "name": "Service A",
    "instanceItemId": "uuid-service-a"
  }
}
```

## Health Status Endpoint

The test-agent exposes `/health/status` endpoint that receives POST requests from interceptors and readiness sidecars:

```json
{
  "instanceId": "uuid",
  "instanceItemName": "service-a",
  "ready": true,
  "timestamp": "2024-01-01T12:00:00Z",
  "details": {
    "checkDuration": 10,
    "statusCode": 200
  }
}
```

## Test Execution

Tests are executed in sequential groups, with requests within each group executed in parallel:

1. Group 1: Execute all requests in parallel, wait for all to complete
2. Group 2: Execute all requests in parallel, wait for all to complete
3. ... and so on

## Completion Notification

When tests complete, the test-agent POSTs to `${CONTROL_TOWER_URL}/test-complete`:

```json
{
  "testRunId": "uuid-test-run",
  "status": "success",
  "message": ""
}
```

## Building

```bash
go build -o test-agent .
```

## Docker

```bash
docker build -t dokkimi/test-agent:latest .
```

## Development

Run locally (requires kubeconfig):

```bash
export K8S_NAMESPACE=dokkimi-test
export CONTROL_TOWER_URL=http://localhost:19001
go run .
```

## UI Step Execution

When a test definition contains `action.type == "ui"` steps, the test-agent drives a co-located chromium sidecar via CDP. In production, Control Tower attaches the sidecar to the test-agent pod when UI steps are detected (see `docs/proposed/UI_E2E_TESTING.md`). Locally, set `BROWSER_URL` to any reachable chromium CDP endpoint.

```bash
export BROWSER_URL=http://localhost:9222   # optional; empty = no UI support
```

If a UI step is encountered when `BROWSER_URL` is unset, the step fails loudly rather than silently.

### Smoke test

`tests/ui-smoke.sh` spins up `chromedp/headless-shell` in Docker, runs the gated integration tests (browser client + full executor), and tears down:

```bash
./tests/ui-smoke.sh
```

Requires Docker. On Linux, the script passes `--add-host=host.docker.internal:host-gateway` so chromium can reach the test's httptest fixture running on the host. On Docker Desktop (Mac/Windows) this works out of the box.

Tests are gated on `DOKKIMI_UI_BROWSER_URL` — unset, they skip, so `go test ./...` stays green without Docker.
