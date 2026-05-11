# Dokkimi Architecture

How Dokkimi works, from `dokkimi run` to test results.

---

## System Overview

Dokkimi deploys user-defined services into isolated Kubernetes namespaces, intercepts all traffic between them, runs test steps, validates assertions, and reports results. It runs in two modes:

- **Local** — Control Tower runs locally as a background daemon, SQLite for storage

PostgreSQL is only used when Control Tower is packaged into a Docker image and tested via Dokkimi's own definitions. In normal use, it's always SQLite.

---

## Services

### Node.js / NestJS

Backend is a single service — **Control Tower** on port `19001`. Log ingestion, test
validation, and K8s cluster watching live as feature modules inside it.

| Service                | Port  | Responsibility                                                                                                                                                    |
| ---------------------- | ----- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Control Tower (CT)** | 19001 | REST API, K8s orchestration, namespace lifecycle, ConfigMap management, log ingestion, test-completion + assertion validation, K8s namespace-termination polling. |

CT's internal feature modules:

| Module                                | Responsibility                                                                                                          |
| ------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `namespace/` + `namespace-lifecycle/` | K8s orchestration                                                                                                       |
| `runs/`                               | Run creation, deployment, status, stop/delete                                                                           |
| `log-processing/` (formerly LPS)      | Log ingestion (`POST /logs/*`), writes to DB                                                                            |
| `log-query/`                          | Log read path (`GET /logs/*/instance/:id`)                                                                              |
| `test-validation/` (formerly TVS)     | Assertion matching, updates test status, calls `RunsService` in-process                                                 |
| `cluster-watcher/` (formerly CWS)     | Polls K8s for TERMINATING namespaces; marks instances STOPPED and calls `RunsService.handleInstancesStopped` in-process |
| `health/`                             | Single aggregated `/health`; readiness updates from sidecars via `POST /health/status`                                  |

### Go (run inside K8s pods as sidecars)

| Service         | Responsibility                                                                                                                                                                                                         |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Interceptor** | HTTP traffic interception, mock responses, log publishing to Control Tower. Two variants: shared (external traffic) and sidecar (service-to-service)                                                                   |
| **Test Agent**  | Reads test config from ConfigMap, executes HTTP requests in sequence, POSTs `/test-complete` to Control Tower                                                                                                          |
| **DB Proxy**    | Wire protocol proxy sidecar for databases. Transparent TCP proxy that parses each database's native wire protocol to extract and log queries without modifying traffic. Variants for PostgreSQL, MySQL, MongoDB, Redis |

### Applications

| App                  | Technology         | Purpose                                                       |
| -------------------- | ------------------ | ------------------------------------------------------------- |
| **CLI**              | Node.js/TypeScript | Primary interface: `dokkimi run`, `validate`, `inspect`, etc. |
| **VSCode Extension** | TypeScript         | Definition validation and diagnostics                         |

---

## Data Flow: `dokkimi run`

```
User runs: dokkimi run [target]
       │
       ▼
┌─ CLI ─────────────────────────────────────┐
│ 1. Resolve definitions from .dokkimi/     │
│ 2. Interpolate ${{VAR}} from config.yaml  │
│ 3. Ensure background services running     │
│ 4. POST /runs to Control Tower            │
└───────────────┬───────────────────────────┘
                │
                ▼
┌─ Control Tower ───────────────────────────┐
│ 1. Create Run record (PENDING → RUNNING)  │
│ 2. Create K8s namespace                   │
│ 3. For each service in definition:        │
│    - Create Deployment with sidecars:     │
│      * Sidecar Interceptor (HTTP logging) │
│      * Fluent Bit (console log capture)   │
│      * DNSMasq (service discovery)        │
│      * DB Proxy (for databases)           │
│    - Create ConfigMap (test config)       │
│ 4. Deploy Test Agent pod                  │
└───────────────┬───────────────────────────┘
                │
                ▼
┌─ Inside K8s Namespace ────────────────────┐
│                                           │
│  Services start → health checks pass      │
│                                           │
│  Test Agent:                              │
│    1. Reads test steps from ConfigMap     │
│    2. Executes HTTP requests in order     │
│    3. Interceptors capture all traffic    │
│    4. POSTs /test-complete to CT          │
│                                           │
│  Interceptors → POST /logs/* → CT         │
│  Fluent Bit  → POST /logs/console → CT    │
│  DB Proxy    → POST /logs/database → CT   │
└───────────────┬───────────────────────────┘
                │
                ▼
┌─ Control Tower: log-processing module ────┐
│ 1. Receives HTTP/console/DB/test-exec     │
│    logs on /logs/*                        │
│ 2. Writes to database                     │
└───────────────┬───────────────────────────┘
                │
                ▼
┌─ Control Tower: test-validation module ───┐
│ 1. Receives POST /test-complete from      │
│    test-agent                             │
│ 2. Queries HTTP logs from database        │
│ 3. Evaluates assertions against logs      │
│ 4. Writes assertion results to database   │
│ 5. Calls RunsService.handleValidation-    │
│    Complete in-process (no HTTP hop)      │
└───────────────┬───────────────────────────┘
                │
                ▼
┌─ Cleanup ─────────────────────────────────┐
│ CT runs: stops instance (K8s namespace    │
│          deletion)                        │
│ cluster-watcher module polls K8s,         │
│   detects namespace is gone,              │
│   calls RunsService.handleInstances-      │
│   Stopped in-process                      │
└───────────────┬───────────────────────────┘
                │
                ▼
┌─ CLI ─────────────────────────────────────┐
│ Polls CT for results → displays to user   │
└───────────────────────────────────────────┘
```

---

## K8s Namespace Structure

Each test run gets an isolated namespace. A typical namespace contains:

```
dokkimi-{run-id}/
├── user-service (Deployment)
│   ├── main container (user's image)
│   ├── sidecar-interceptor (Go, captures HTTP)
│   ├── fluent-bit (captures stdout/stderr)
│   └── dnsmasq (DNS routing)
├── postgres-db (Deployment)
│   ├── postgres container
│   └── db-proxy sidecar (health + queries)
├── shared-interceptor (Deployment)
│   └── interceptor (external traffic + mocks)
├── test-agent (Deployment)
│   └── test-agent (executes test steps)
├── dokkimi-interceptor-config (ConfigMap)
│   ├── testConfig (test steps for test-agent)
│   ├── httpMocks (mock rules for interceptors)
│   ├── urlMap (service discovery routing)
│   └── databaseMap (database connection info)
└── Ingress (external access routing)
```

### Sidecar Pattern

Every user service gets three sidecars:

1. **Sidecar Interceptor** — sits between the service and all outbound HTTP. Captures request/response pairs, POSTs them to Control Tower's `log-processing` module, and can serve mock responses based on ConfigMap rules.
2. **Fluent Bit** — tails the container's stdout/stderr, forwards structured console logs to Control Tower.
3. **DNSMasq** — rewrites DNS so service-to-service calls route through the interceptor.

Databases additionally get a **DB Proxy** sidecar — a transparent wire protocol proxy that sits between the application and the database. Client connections hit the proxy port, which forwards traffic to the real database while parsing the native wire protocol (MongoDB OP_MSG, PostgreSQL frontend/backend messages, MySQL packet protocol, Redis RESP) to extract queries and results for logging. The proxy also runs adaptive health checks (1.5s polling while booting, 20s once healthy) and reports readiness to Control Tower. MongoDB uses a sentinel document written by the final init script to ensure health checks don't pass before database initialization completes.

### DB Proxy Variants

Each variant is a standalone Go binary that shares infrastructure from `services/db-proxy/shared/` (config loading, adaptive health checker, async query logger).

| Variant    | Proxy Port | Wire Protocol                          | Health Check                                   |
| ---------- | ---------- | -------------------------------------- | ---------------------------------------------- |
| MongoDB    | 17017      | OP_MSG BSON parsing                    | Sentinel document in `dokkimi_internal.health` |
| PostgreSQL | 15432      | PG frontend/backend message protocol   | `db.Ping()` (TCP only after init completes)    |
| MySQL      | 13306      | MySQL packet protocol (4-byte framing) | `db.Ping()` (TCP only after init completes)    |
| Redis      | 16379      | RESP2/RESP3                            | Redis `PING` command                           |

All variants log asynchronously via a buffered channel (capacity 1000) and POST each entry to Control Tower's `/logs/database` endpoint.

---

## Database

SQLite, single file at `~/.dokkimi/dokkimi.db`. A PostgreSQL Prisma schema also exists for when Control Tower runs inside a Docker image (tested by Dokkimi's own definitions), but normal usage is always SQLite.

Log ingestion is HTTP-only — interceptors, Fluent Bit, and DB Proxy POST to Control Tower.

---

## Communication Patterns

| From            | To                             | Method               | Purpose                                                                                |
| --------------- | ------------------------------ | -------------------- | -------------------------------------------------------------------------------------- |
| CLI             | Control Tower                  | HTTP REST            | Create runs, submit definitions, poll results                                          |
| Control Tower   | K8s API                        | K8s Client           | Create/delete namespaces, deployments, ConfigMaps                                      |
| Test Agent      | Interceptor                    | HTTP                 | Test step execution — requests route through the interceptor, enabling traffic capture |
| Interceptor     | Control Tower `/logs/*`        | HTTP POST            | HTTP traffic logs                                                                      |
| Fluent Bit      | Control Tower `/logs/console`  | HTTP POST            | Console logs                                                                           |
| DB Proxy        | Control Tower `/logs/database` | HTTP POST            | Database logs                                                                          |
| Sidecars        | Control Tower `/health/status` | HTTP POST            | Readiness updates                                                                      |
| Test Agent      | Control Tower `/test-complete` | HTTP POST            | Test completion notification                                                           |
| CT modules      | DB                             | Prisma               | Query HTTP logs, write assertion results                                               |
| test-validation | RunsService (in-process)       | direct injected call | Signal validation complete → CT updates run status                                     |
| cluster-watcher | RunsService (in-process)       | direct injected call | Signal instance STOPPED → CT advances run                                              |

---

## Service Manager

The CLI uses `@dokkimi/service-manager` to manage Control Tower as a background daemon:

1. **Startup**: `dokkimi run` calls `ensureServicesRunning()` which:
   - Checks Docker and K8s are running (auto-starts Docker on macOS)
   - Runs Prisma migrations if needed
   - Health-checks each service at its configured port
   - Spawns any unhealthy services as detached child processes
   - Writes PIDs to `~/.dokkimi/daemon.json`

2. **Health checks**: Each service exposes `GET /health` returning `{ status, service }`. The service-manager polls these to verify readiness.

3. **Logs**: Each service writes to `~/.dokkimi/logs/{service}.log` via a rotating file writer (10 MB max, 1 backup).

4. **Shutdown**: `dokkimi shutdown` sends SIGTERM to each process group, with SIGKILL fallback after 3 seconds.

---

## Definition Resolution

Before any run, the CLI resolves `.dokkimi/` definition files:

1. **Scan** — find all `.json`, `.yaml`, `.yml` files in `.dokkimi/`
2. **Parse** — YAML or JSON
3. **Resolve `$ref`** — inline shared fragments from `shared/` directory
4. **Interpolate `${{VAR}}`** — replace build-time variables from `config.yaml` env map
5. **Validate** — check required fields, types, constraints
6. **Submit** — send resolved definitions to Control Tower

---

## Config

Configuration lives in `config/environments/desktop.yaml` (or `cloud.yaml`). Loaded at startup by `@dokkimi/config`. Services read their port, database URL, timeouts, and feature flags from this config.

User-level project config lives in `.dokkimi/config.yaml`:

```yaml
dokkimi: 0.1.0 # Version pin (CLI warns if outdated)
env: # Build-time variables
  REGISTRY: ghcr.io/org
  IMAGE_TAG: v1.2.3
```

---

## npm Package Layout

When installed via `npm install -g dokkimi`, the package preserves the monorepo structure so `resolveAppRoot()` can locate services:

```
dokkimi/
├── package.json              # workspaces: [] (marker for resolveAppRoot)
├── apps/cli/dist/            # Compiled CLI
├── services/
│   └── control-tower/dist/   # Compiled NestJS (single service)
├── shared/
│   ├── config/dist/          # Config loader
│   ├── prisma/               # Schema + migrations
│   └── ...                   # Other shared packages
├── config/environments/
│   └── desktop.yaml          # Runtime config
└── node_modules/             # Production dependencies
```

---

## Key Design Decisions

1. **Namespace-per-run isolation** — each test run gets its own K8s namespace. Services can't interfere with each other across runs.

2. **Sidecar interceptors over shared proxy** — each service gets its own interceptor sidecar for service-to-service traffic. A shared interceptor handles external/mock traffic. This avoids a single point of failure and enables per-service traffic capture.

3. **Separation of concerns via modules** — CT ships as one process, but log ingestion, test validation, and cluster watching are isolated NestJS modules with narrow public surfaces. This keeps the code organized while avoiding inter-service HTTP overhead.

4. **ConfigMap-driven test execution** — test steps are written to a ConfigMap that the test-agent reads. This decouples test configuration from the agent binary and allows dynamic updates.

5. **HTTP POST for log ingestion** — interceptor sidecars, Fluent Bit, and DB Proxy all post directly to Control Tower's log-processing module.

6. **Wire protocol proxies over query-execution endpoints** — DB Proxy variants parse each database's native wire protocol (MongoDB OP_MSG, PostgreSQL messages, MySQL packets, Redis RESP) to transparently intercept and log queries. This means applications connect normally to the proxy port with no driver changes, and the proxy forwards traffic unmodified while extracting query text, results, duration, and errors for logging.
