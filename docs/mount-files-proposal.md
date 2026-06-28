# Feature: Mount Files in SERVICE Containers

## Problem

Services often need config files, TLS certs, or other artifacts mounted into the container. Today the only workaround is building a wrapper Docker image that COPYs the file in — adding friction for every third-party service that needs configuration.

This has come up in every third-party service we've tested:

- **Hyperswitch** required a 146KB TOML config file. We built a wrapper Dockerfile that COPYs the config and an entrypoint script that waits for Postgres/Redis before launching the router.
- **Lago** required an RSA private key file, a patched rake file (dev-only gem crashes in production), and a custom entrypoint that waits for Postgres/Redis, runs Rails migrations, seeds the org via `rails runner`, and starts the server. The wrapper Dockerfile installs `postgresql-client` just for the seed step. Five layers of workarounds for what's fundamentally "mount a key file and override the entrypoint."

## Proposed API

New `mountFiles` field on SERVICE items:

```yaml
type: SERVICE
name: hs-server
image: docker.juspay.io/juspaydotin/hyperswitch-router:latest
port: 8080
mountFiles:
  - source: ../config/docker_compose.toml
    target: /local/config/docker_compose.toml
  - source: ../scripts/entrypoint.sh
    target: /entrypoint.sh
```

| Field    | Type   | Description                                        |
| -------- | ------ | -------------------------------------------------- |
| `source` | string | Relative path from the definition file to the file |
| `target` | string | Absolute path inside the container                 |

Files are mounted read-only.

## Implementation

~60-80 lines across 5 files, following the existing DATABASE `initFilePath` pattern:

1. **shared/definition-validator/validate-items.ts** — validate `mountFiles` array on SERVICE items (source is a relative path, target is an absolute path)
2. **shared/definition-resolver/resolve.ts** — resolve source paths relative to the definition file, read contents, apply path-traversal safety checks (same as init files)
3. **services/control-tower/src/storage/run-storage.service.ts** — write mount files to a staging directory on the host before container launch (parallel to `writeInitFiles` / `getInitFilesDir`)
4. **services/control-tower/src/namespace-lifecycle/docker/docker-service-group.service.ts** — add bind mounts (`staging-dir/filename:target:ro`) when creating the service container
5. **Type definitions** — add `mountFiles?: { source: string; target: string }[]` to the SERVICE item interface

### Security

Copy the path-traversal validation from DATABASE init files — source paths must resolve within the `.dokkimi/` directory tree.

## Impact

Eliminates the need for wrapper Docker images in most cases. The Hyperswitch demo's `docker/` folder (Dockerfile, entrypoint.sh, baked config) would reduce to a single `mountFiles` entry on the SERVICE item. The Lago demo's wrapper (RSA key, patched rake file, entrypoint) would reduce to two or three `mountFiles` entries plus an `entrypoint` override.
