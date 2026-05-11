#!/bin/bash

# Script to rebuild the Node/NestJS service Docker image.
# Build context is the repo root (required for yarn workspace dependencies).
#
# Note: the image uses the dokkimi/ prefix (not ghcr.io/dokkimi/) because it is
# only used locally in K8s test definitions, not pushed to a container registry.

set -e  # Exit on any error

cd "$(dirname "$0")/.."
VERSION=$(cat VERSION | tr -d '[:space:]')
echo "======================================"
echo "Rebuilding Node Service Docker Image (v${VERSION})"
echo "======================================"
echo ""

# After the service consolidation (docs/implemented/SERVICE_CONSOLIDATION.md),
# Control Tower is the only NestJS service — LPS, TVS, and CWS now live inside
# it as feature modules.
services=(
    "control-tower"
)

# Build each service (context is repo root for workspace deps)
for service in "${services[@]}"; do
    echo "Building dokkimi/${service}:${VERSION}..."
    docker build -t "dokkimi/${service}:${VERSION}" \
        -t "dokkimi/${service}:latest" \
        --build-arg VERSION="${VERSION}" \
        -f "services/${service}/Dockerfile" \
        .
    echo "✓ Successfully built dokkimi/${service}:${VERSION}"
    echo ""
done

echo "======================================"
echo "All images built successfully!"
echo "======================================"
echo ""
echo "Built images:"
for service in "${services[@]}"; do
    echo "  - dokkimi/${service}:${VERSION} (+ :latest)"
done
