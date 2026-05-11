#!/bin/bash

# Script to rebuild all Docker images (Go services, Node services, and tools)

set -e  # Exit on any error

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$REPO_ROOT"

"$SCRIPT_DIR/rebuild-go-services.sh"
"$SCRIPT_DIR/rebuild-node-services.sh"

echo ""
echo "======================================"
echo "All Docker images rebuilt successfully!"
echo "======================================"
