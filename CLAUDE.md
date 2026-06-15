# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Non-Negotiables

1. **Use the Dokkimi MCP tools for definition files and test authoring** — call `get_reference` to look up the relevant spec section before writing or editing definition files. Use `validate_file`, `list_fragments`, `resolve_definition`, `run_tests`, and `dump_results` for the corresponding workflows. Do not guess field names, operators, or file structure.
2. **Use `dump_results` (or `dokkimi dump`) to debug failed runs** — returns a JSON snapshot of the last run (definition, logs, assertion results, artifacts). Use `--failed` to limit to failed instances.
3. **Read architecture docs before writing code** — `docs/ARCHITECTURE.md`
4. **This is greenfield / rewrite** — no backwards compatibility required. Prefer correctness and clean design.
5. **Yarn only** — use `yarn`, never `npm`.

## Project Overview

**Dokkimi** manages isolated Docker environments for microservice testing: create networks, manage DBs, intercept/log traffic, mock endpoints, run test suites.

Users define their test environment in `.dokkimi/` YAML/JSON files (services, databases, mocks, tests). The CLI resolves those definitions, spins up a Docker network, deploys everything with interceptor sidecars, runs the test suite, and reports results.

## Build Commands

```bash
yarn dev:cli              # Start Control Tower + CLI (development, watch mode)
yarn build                # Full build: shared → services → apps
yarn build:shared         # Build only shared packages
yarn build:services       # Build only services
yarn lint                 # ESLint
yarn lint:fix             # ESLint with auto-fix
yarn format               # Prettier (write)
yarn format:check         # Prettier (check only)
```

After changing shared types: `cd shared/config && yarn build`

To expose the dev CLI as `dokkimi` on your PATH: `yarn link` (after `yarn dev:cli` has built once). Reverse with `yarn unlink`.

## Testing

```bash
# TypeScript
yarn workspace control-tower test                    # All CT unit tests
yarn workspace control-tower test -- --testPathPattern=runs  # Single test file/pattern
yarn workspace @dokkimi/definition-validator test    # Validator tests

# Go (run from each service directory)
cd services/interceptor && go test ./...
cd services/test-agent && go test -vet=off ./...     # -vet=off for pre-existing warnings
cd services/db-proxy/postgres && go test ./...       # also: mysql, mongo, redis
```

## Prisma

```bash
cd shared/prisma
npx prisma generate                                  # Generate client (must run before CT builds)
npx prisma validate                                  # Validate schema
npx prisma migrate dev --name <name>                 # Create migration
npx prisma migrate deploy                            # Apply migrations
```

Two schemas exist at `shared/prisma/`: `schema.sqlite.prisma` (CLI/local) and `schema.postgresql.prisma` (cloud). Keep models identical between them.

## Docker Images

```bash
./scripts/rebuild-go-services.sh     # Build all Go sidecar images (ghcr.io/dokkimi/*)
./scripts/rebuild-node-services.sh   # Build Control Tower image (dokkimi/control-tower)
./scripts/rebuild-all.sh             # Both + tools
```

Go sidecars use `ghcr.io/dokkimi/<name>` prefix. Control Tower uses `dokkimi/control-tower` (no `ghcr.io/` — local only, not pushed to registry).

## Architecture

### Services

| Service                   | Language          | Deployment                               | Port  |
| ------------------------- | ----------------- | ---------------------------------------- | ----- |
| **Control Tower**         | NestJS/TypeScript | Single process (CLI daemon) or container | 19001 |
| **Interceptor**           | Go                | 1:1 sidecar per service container        | —     |
| **Test Agent**            | Go                | One container per test run               | 8080  |
| **DB Proxy** (4 variants) | Go                | 1 sidecar per database container         | —     |

### Control Tower Module Boundaries

All backend logic lives in Control Tower as separate NestJS modules. Keep module public surface narrow — cross-module communication goes through explicitly re-exported services.

- **`runs/` + `namespace/` + `namespace-lifecycle/`** — REST API and Docker orchestration
- **`log-processing/`** — log ingestion (`POST /logs/{http,console,database,test-execution,test-validation}`), marked `@SkipThrottle()` for high-volume sidecar traffic
- **`test-validation/`** — receives pre-validated assertion results from test-agent, stores them, handles `POST /test-complete`, then calls `RunsService.handleValidationComplete` in-process
- **`health/`** — aggregated liveness + `POST /health/status` readiness endpoint for sidecars

### Apps

| App                  | Path           | Purpose                                                         |
| -------------------- | -------------- | --------------------------------------------------------------- |
| **CLI**              | `apps/cli`     | Primary interface: `dokkimi run`, `validate`, `inspect`, `dump` |
| **VSCode Extension** | `apps/vscode`  | Definition file authoring: autocomplete, validation, snippets   |
| **Landing**          | `apps/landing` | Astro marketing/docs website                                    |

### Shared Packages

Build order matters: `shared/config → shared/platform → shared/telemetry → shared/definition-validator → shared/definition-resolver → shared/service-manager`

| Package                         | Path                          | Purpose                                                |
| ------------------------------- | ----------------------------- | ------------------------------------------------------ |
| `@dokkimi/config`               | `shared/config`               | Config loader (reads `config/config.yaml`)             |
| `@dokkimi/platform`             | `shared/platform`             | OS-agnostic platform utilities                         |
| `@dokkimi/definition-validator` | `shared/definition-validator` | Validates `.dokkimi/` definition files                 |
| `@dokkimi/definition-resolver`  | `shared/definition-resolver`  | Resolves `$ref` fragments and `${{VAR}}` interpolation |
| `@dokkimi/service-manager`      | `shared/service-manager`      | Manages Control Tower as a background daemon           |
| `@dokkimi/telemetry`            | `shared/telemetry`            | Telemetry/observability                                |

### Sidecar Image Tags

`services/control-tower/src/constants/image-tags.ts` resolves sidecar images using `APP_VERSION` env var, falling back to `:latest`. When running locally via CLI, `APP_VERSION` is unset so `:latest` is used.

### Database

- Prisma is the DB abstraction layer
- CLI/local: SQLite (`file:~/.dokkimi/dokkimi.db`)
- Cloud: PostgreSQL + TimescaleDB (`postgres-db:5432`)
- Both schemas at `shared/prisma/` have identical models

## Notes on Docs

If you make architectural changes, update `docs/ARCHITECTURE.md` to keep it accurate.
