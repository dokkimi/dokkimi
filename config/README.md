# Dokkimi Configuration

This directory contains the YAML configuration for all Dokkimi services.

## Directory Structure

```
config/
└── config.yaml    # Single configuration file for all environments
```

**Note**: The TypeScript configuration package lives in `shared/config/` (the loader, types, and validator).

## Configuration File

`config.yaml` contains local/CLI defaults. Cloud deployments override specific values via environment variables set on containers.

Key sections:

- **services** — ports and hosts for Control Tower, interceptor, test agent, chromium
- **concurrency** — concurrency limits for test runs
- **database** — default credentials and Dokkimi app database URL (SQLite locally, Prisma reads `DATABASE_URL` from env for cloud)
- **storage** — local storage paths for run artifacts and init files
- **logging** — format and level
- **cors** — allowed origins for local development

## TypeScript Configuration Package

Located in `shared/config/`, this package provides:

1. **Type Definitions** (`config.types.ts`): `DokkimiConfig` interface
2. **Configuration Loader** (`config.loader.ts`): loads and validates YAML, singleton access, env var overrides
3. **Validator** (`config.validator.ts`): validates configuration against schema
4. **Go Service Builders** (`go-service-env.builder.ts`): type-safe env var builders for Go sidecars

## Usage

```typescript
import { loadConfig, getConfig } from '@dokkimi/config';

// Load config (uses config/config.yaml by default)
loadConfig();
const config = getConfig();

// CI mode — applies concurrency defaults for parallel runs
loadConfig(undefined, { ci: true });
```

## Environment Variable Overrides

The config loader applies env var overrides after loading the YAML file. These are used by cloud deployments where containers set env vars:

| Env Var                             | Config Path                      |
| ----------------------------------- | -------------------------------- |
| `CONTROL_TOWER_HOST`                | `services.controlTower.host`     |
| `CONTROL_TOWER_PORT`                | `services.controlTower.port`     |
| `DOKKIMI_MAX_CONCURRENT_NAMESPACES` | `concurrency.maxConcurrentTests` |
| `DOKKIMI_MAX_BOOTING_NAMESPACES`    | `concurrency.maxBootingTests`    |

CI mode (via `loadConfig(undefined, { ci: true })` or `process.env.CI`) sets concurrency defaults (`maxConcurrentTests: 3`, `maxBootingTests: 1`) unless explicitly overridden.

## Configuration Values

### Service Ports

| Service       | Port  | Notes                         |
| ------------- | ----- | ----------------------------- |
| Control Tower | 19001 | Main API server               |
| Interceptor   | 80    | Traffic interception sidecar  |
| Test Agent    | 80    | Test execution container      |
| Chromium      | 9222  | Headless browser for UI tests |
