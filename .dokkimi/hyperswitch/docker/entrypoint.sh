#!/bin/bash
# Wait for postgres and redis before starting the router.

echo "Waiting for hs-postgres:5432..."
while ! (echo > /dev/tcp/hs-postgres/5432) 2>/dev/null; do sleep 1; done
echo "Postgres is up."

echo "Waiting for hs-redis:6379..."
while ! (echo > /dev/tcp/hs-redis/6379) 2>/dev/null; do sleep 1; done
echo "Redis is up."

exec /local/bin/router -f /local/config/docker_compose.toml
