#!/bin/bash
set -e

cd "$(dirname "$0")/.."

GO_DIRS=(
  services/interceptor
  services/test-agent
  services/db-proxy/postgres
  services/db-proxy/mysql
  services/db-proxy/mongo
  services/db-proxy/redis
  services/db-proxy/shared
)

ERRORS=0

echo "Running gofmt..."
for dir in "${GO_DIRS[@]}"; do
  BAD=$(gofmt -l "$dir/" 2>/dev/null)
  if [ -n "$BAD" ]; then
    echo "  needs formatting: $BAD"
    ERRORS=1
  fi
done

echo "Running go vet..."
for dir in "${GO_DIRS[@]}"; do
  if [ -f "$dir/go.mod" ]; then
    (cd "$dir" && go vet ./...) || ERRORS=1
  fi
done

if [ "$1" = "--fix" ]; then
  echo "Fixing formatting..."
  for dir in "${GO_DIRS[@]}"; do
    gofmt -w "$dir/" 2>/dev/null
  done
fi

if [ "$ERRORS" -ne 0 ]; then
  echo ""
  echo "Issues found."
  exit 1
fi

echo "All clean."
