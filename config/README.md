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
- **database** — default credentials and Dokkimi app database URL (SQLite locally, `DOKKIMI_DATABASE_URL` overrides it, e.g. for cloud)
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
```

## Environment Variable Overrides

The config loader applies env var overrides after loading the YAML file. These are used by cloud deployments where containers set env vars:

| Env Var                             | Config Path                      |
| ----------------------------------- | -------------------------------- |
| `CONTROL_TOWER_HOST`                | `services.controlTower.host`     |
| `CONTROL_TOWER_PORT`                | `services.controlTower.port`     |
| `DOKKIMI_MAX_CONCURRENT_NAMESPACES` | `concurrency.maxConcurrentTests` |
| `DOKKIMI_MAX_BOOTING_NAMESPACES`    | `concurrency.maxBootingTests`    |

Control Tower's concurrency comes from `resolveConcurrency()`: a `DOKKIMI_MAX_*` variable wins, then the setting saved with `dokkimi config` (`~/.dokkimi/config.json`), then `config.yaml`. The daemon reads them when it starts; the CLI restarts it, when no run is active, when this command's values differ.

## Configuration Values

### Service Ports

| Service       | Port  | Notes                         |
| ------------- | ----- | ----------------------------- |
| Control Tower | 19001 | Main API server               |
| Interceptor   | 80    | Traffic interception sidecar  |
| Test Agent    | 80    | Test execution container      |
| Chromium      | 9222  | Headless browser for UI tests |
