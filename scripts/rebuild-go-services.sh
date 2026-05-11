#!/bin/bash

# Script to rebuild all Go service Docker images
# This rebuilds: interceptor, test-agent, and db-proxy variants (postgres, mysql, mongo, redis)

set -e  # Exit on any error

cd "$(dirname "$0")/.."
VERSION=$(cat VERSION | tr -d '[:space:]')
echo "======================================"
echo "Rebuilding Go Service Docker Images (v${VERSION})"
echo "======================================"
echo ""

# Array of services to build
services=(
    "interceptor"
    "test-agent"
    "db-proxy/postgres"
    "db-proxy/mysql"
    "db-proxy/mongo"
    "db-proxy/redis"
)

# Build each service
for service in "${services[@]}"; do
    # Extract image name (use last component of path for image tag)
    image_name=$(basename "$service" | sed 's|db-proxy/||')
    if [[ "$service" == db-proxy/* ]]; then
        image_tag="db-proxy-${image_name}"
        # For db-proxy services, use db-proxy/ as build context to include shared module
        build_context="services/db-proxy"
    else
        image_tag="$image_name"
        build_context="services/${service}"
    fi
    
    echo "Building ghcr.io/dokkimi/${image_tag}:${VERSION}..."
    docker build -t "ghcr.io/dokkimi/${image_tag}:${VERSION}" \
        -t "ghcr.io/dokkimi/${image_tag}:latest" \
        --build-arg VERSION="${VERSION}" \
        -f "services/${service}/Dockerfile" \
        "${build_context}"
    echo "✓ Successfully built ghcr.io/dokkimi/${image_tag}:${VERSION}"
    echo ""
done

echo "======================================"
echo "All images built successfully!"
echo "======================================"
echo ""
echo "Built images:"
for service in "${services[@]}"; do
    image_name=$(basename "$service" | sed 's|db-proxy/||')
    if [[ "$service" == db-proxy/* ]]; then
        image_tag="db-proxy-${image_name}"
    else
        image_tag="$image_name"
    fi
    echo "  - ghcr.io/dokkimi/${image_tag}:${VERSION} (+ :latest)"
done
