#!/usr/bin/env bash
# ui-smoke.sh — end-to-end smoke test for test-agent's UI executor.
#
# Spins up chromedp/headless-shell in Docker, runs the gated Go integration
# tests against it, then tears down. Intended for local dev and CI.
#
# Requires: docker, go, a working internet connection for the first image pull.
#
# Env overrides:
#   DOKKIMI_UI_SMOKE_IMAGE   chromium image tag (default: chromedp/headless-shell:latest)
#   DOKKIMI_UI_SMOKE_PORT    host port to expose CDP on (default: 9222)
#   DOKKIMI_UI_TEST_HOST     hostname chromium uses to reach the host (default: host.docker.internal)

set -euo pipefail

IMAGE="${DOKKIMI_UI_SMOKE_IMAGE:-chromedp/headless-shell:latest}"
PORT="${DOKKIMI_UI_SMOKE_PORT:-9222}"
CONTAINER="dokkimi-ui-smoke-chromium"

# Always run from the test-agent module root, no matter where the caller is.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MODULE_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
cd "${MODULE_DIR}"

cleanup() {
  echo "==> Stopping chromium sidecar"
  docker rm -f "${CONTAINER}" >/dev/null 2>&1 || true
}
trap cleanup EXIT

echo "==> Removing any previous smoke container"
docker rm -f "${CONTAINER}" >/dev/null 2>&1 || true

echo "==> Starting chromium sidecar (${IMAGE}) on :${PORT}"
docker run -d \
  --name "${CONTAINER}" \
  --add-host=host.docker.internal:host-gateway \
  -p "${PORT}:9222" \
  "${IMAGE}" \
  >/dev/null

echo "==> Waiting for chromium CDP endpoint to respond..."
for attempt in $(seq 1 30); do
  if curl -sSf "http://localhost:${PORT}/json/version" >/dev/null 2>&1; then
    echo "    chromium ready (attempt ${attempt})"
    break
  fi
  if [ "${attempt}" -eq 30 ]; then
    echo "!!  chromium failed to become ready within 30s"
    docker logs "${CONTAINER}" || true
    exit 1
  fi
  sleep 1
done

export DOKKIMI_UI_BROWSER_URL="http://localhost:${PORT}"
export DOKKIMI_UI_TEST_HOST="${DOKKIMI_UI_TEST_HOST:-host.docker.internal}"

echo "==> Running UI integration tests"
echo "    DOKKIMI_UI_BROWSER_URL=${DOKKIMI_UI_BROWSER_URL}"
echo "    DOKKIMI_UI_TEST_HOST=${DOKKIMI_UI_TEST_HOST}"
go test -vet=off -count=1 -v \
  -run 'TestBrowserClient_|TestUIExecutor_Integration_' \
  .

echo ""
echo "==> Smoke tests passed"
