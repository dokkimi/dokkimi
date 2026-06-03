# Test Agent

The test-agent orchestrates test execution inside a Docker environment. It waits for all containers (services and databases) to become healthy, then executes test steps according to the configuration.

## Architecture

The test-agent:

1. Reads `expectedNamespaceItemIds` and `testConfig` from the bind-mounted config file
2. Receives health status updates from interceptors and readiness sidecars
3. Waits for all expected items to be ready
4. Executes test steps (sequential and parallel)
5. Notifies Control Tower's `/test-complete` endpoint when complete

## Configuration

The test-agent is configured via environment variables:

- `PORT`: HTTP server port (default: 8080)
- `CONFIG_FILE_PATH`: Path to the config JSON file (required)
- `CONTROL_TOWER_URL`: HTTP URL for Control Tower (required)

## Config File Data

The test-agent reads a JSON config file with the following keys:

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
  "timeoutSeconds": 300,
  "tests": [...]
}
```

### `urlMap`

Service name to URL mapping (used to resolve service names in test requests):

```json
{
  "service-a": {
    "scheme": "http",
    "url": "http://service-a",
    "name": "Service A",
    "port": 3000,
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

```bash
export CONFIG_FILE_PATH=/path/to/config.json
export CONTROL_TOWER_URL=http://localhost:19001
go run .
```

## UI Step Execution

When a test definition contains `action.type == "ui"` steps, the test-agent drives a co-located chromium sidecar via CDP. Control Tower attaches the sidecar when UI steps are detected. Set `BROWSER_URL` to any reachable chromium CDP endpoint.

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
