# Dokkimi

## What is Dokkimi?

Dokkimi is a platform for testing microservice architectures. It spins up isolated Docker environments where you can deploy your services, databases, message brokers, and mocks together as a complete environment. An interceptor sidecar is injected into each service to capture all inter-service HTTP traffic, and a broker-proxy sidecar is injected alongside each broker to capture all published and delivered messages — giving you full visibility into how your services communicate. You can then run automated test suites that make requests, query databases, and assert on responses, inter-service calls, message logs, and even console logs — all without modifying your application code.

Key capabilities:

- **Isolated environments** — each test run gets its own Docker network with dedicated services, databases, and message brokers
- **Traffic interception** — all HTTP traffic between services is captured and available for assertions
- **Message log interception** — all messages published to and delivered from message brokers are captured and available for assertions
- **Mock external APIs** — intercept outbound requests to third-party services and return controlled responses
- **Automated testing** — sequential and parallel test steps with rich assertions on responses, inter-service traffic, message logs, and logs
- **Database seeding** — initialize databases with SQL or JS scripts before tests run

## Definition Files

You are helping a developer write Dokkimi definition files. These are JSON or YAML files in a `.dokkimi/` folder that describe the test environment: services, databases, message brokers, mocks, and automated tests.

This document is the complete reference. All valid fields, types, operators, and constraints are documented below.

## .dokkimi/ Folder

The only requirement is that a `.dokkimi/` folder exists at the repo root. Users can organize files inside however they want — there are no required subfolder conventions. All `**/*.json`, `**/*.yaml`, and `**/*.yml` files inside `.dokkimi/` are scanned.

A common convention (but not required) is:

```
.dokkimi/
├── definitions/       # Runnable definition files
├── shared/            # Shared fragments: items and UI action steps (referenced via $ref)
└── init-files/        # Database init scripts (SQL, JS)
```

## Two File Types (Shape Detection)

Dokkimi distinguishes file types by their JSON shape, not by folder or naming convention:

**Runnable definition** — has top-level `name` (string) + `items` (array):

```json
{
  "name": "my-test-suite",
  "config": {
    "timeoutSeconds": 300,
    "browser": { "version": "148.0.7778.56" }
  },
  "variables": { ... },
  "items": [ ... ],
  "tests": [ ... ]
}
```

**Shared fragment** — any JSON file that does NOT have both `name` + `items`. Typically a single item object:

```json
{
  "type": "DATABASE",
  "name": "postgres-db",
  "database": "postgres"
}
```

Fragments are not runnable on their own — they exist to be referenced via `$ref` from runnable definitions.

## .dokignore

You can create a `.dokkimi/.dokignore` file to exclude files from cloud/CI test runs. It uses the same syntax as `.gitignore`:

```
# Ignore experimental definitions
experiments/

# Ignore a specific file
definitions/broken-test.json

# Ignore all files matching a pattern
**/wip-*.json
```

Paths are relative to the `.dokkimi/` directory. Ignored files are still valid for local runs — `.dokignore` only affects cloud/CI pipelines. The VSCode extension will also skip diagnostics for ignored files.

## Config File

The `.dokkimi/` folder can contain a project-level config file: `config.yaml`, `config.yml`, or `config.json` (first match wins). This file is **not** a definition — the resolver loads it by name and never treats it as a fragment or runnable definition.

```yaml
dokkimi: 0.1.0
env:
  REGISTRY: ghcr.io/dokkimi
  IMAGE_TAG: v1.2.3
  STRIPE_TEST_KEY: sk_test_abc123
```

### Fields

| Field     | Type   | Description                                                                                           |
| --------- | ------ | ----------------------------------------------------------------------------------------------------- |
| `dokkimi` | string | Target Dokkimi version. The CLI warns if your installed version is older.                             |
| `env`     | object | Flat `string → string` map of build-time values. Keys must be alphanumeric + underscores (`/^\w+$/`). |

### Build-time interpolation: `${{VAR}}`

Any string value in a definition or shared fragment can reference a config env variable with `${{VAR}}`. These are resolved **at build time** by the definition resolver, before the definition is sent to Control Tower.

```json
{
  "type": "SERVICE",
  "name": "my-service",
  "image": "${{REGISTRY}}/my-service:${{IMAGE_TAG}}",
  "port": 3000,
  "healthCheck": "/health"
}
```

After resolution, the image becomes `ghcr.io/dokkimi/my-service:v1.2.3`.

Works in any string field — env values, URLs, mock bodies, etc.:

```json
{
  "env": [{ "name": "STRIPE_API_KEY", "value": "${{STRIPE_TEST_KEY}}" }]
}
```

### `${{VAR}}` vs `{{VAR}}`

These are related but distinct systems:

| Syntax     | Resolved   | By                  | Scope                                                                        |
| ---------- | ---------- | ------------------- | ---------------------------------------------------------------------------- |
| `${{VAR}}` | Build time | Definition resolver | Config values from `config.yaml` `env` only                                  |
| `{{VAR}}`  | Build time | Definition resolver | Item fields — merged map of `config.yaml` env + definition-level `variables` |
| `{{VAR}}`  | Runtime    | Test agent          | Test steps — `variables` / `extract` / loop variables                        |

In **item fields** (env values, images, passwords, etc.), `{{VAR}}` resolves at build time against a merged variables map: config.yaml `env` entries are loaded first, then definition-level `variables` are merged on top (overwriting collisions). Unresolved `{{VAR}}` in items is an error — items are fully resolved before they reach Control Tower.

In **test steps** (action URLs, headers, body, queries, assertion values), `{{VAR}}` resolves at runtime by the test agent. Definition-level and test-level variables, loop variables, and extracted variables all resolve at runtime.

`${{VAR}}` always and only resolves from `config.yaml` `env`. If a `${{VAR}}` reference does not match any key in `env`, the resolver **errors**.

### Combining both

You can use `${{}}` inside a `variables` value to compose variables from config:

```json
{
  "variables": {
    "baseUrl": "${{API_HOST}}/v1"
  }
}
```

This resolves `${{API_HOST}}` at build time. The resulting string becomes available as `{{baseUrl}}` — in item fields (resolved at build time) and in test steps (resolved at runtime).

### Build-time `{{VAR}}` in items

Definition-level `variables` can be used in item fields to share values across items:

```yaml
name: my-tests
variables:
  REDIS_PASSWORD: changeme
items:
  - type: DATABASE
    name: my-redis
    database: redis
    dbPassword: '{{REDIS_PASSWORD}}'
  - type: SERVICE
    name: my-server
    port: 3000
    healthCheck: /health
    env:
      - name: REDIS_URL
        value: 'redis://:{{REDIS_PASSWORD}}@my-redis:6379'
```

The password is defined once. Shared fragments referenced via `$ref` also pick up definition-level variables — fragments stay generic and reusable across definitions.

Config.yaml `env` values are available as `{{VAR}}` in items too — they seed the merged map. For keys not overridden by a definition variable, `{{FOO}}` and `${{FOO}}` resolve to the same value. Definition-level variables override config.yaml keys with the same name.

Variable values are not recursively resolved — if a variable's value contains `{{OTHER}}`, that inner reference stays literal. However, two-pass interaction with `${{}}` works: if `{{VAR}}` resolves to a string containing `${{KEY}}`, the subsequent `${{}}` pass resolves it from config.yaml.

---

## Best Practices (IMPORTANT)

**Always use shared fragments and `$ref`.** Do NOT copy-paste item definitions into every definition file. Instead:

1. Create each SERVICE, DATABASE, BROKER, and MOCK as a **shared fragment** in a separate file (e.g., `.dokkimi/shared/my-service.json`).
2. In runnable definitions, reference them with `$ref`:

```json
{
  "name": "my-test",
  "items": [
    { "$ref": "../shared/my-service.json" },
    { "$ref": "../shared/postgres-db.json" },
    { "$ref": "../shared/mock-stripe.json" }
  ],
  "tests": [ ... ]
}
```

3. **Do NOT override `name` on a `$ref`** unless you intentionally want a second instance with a different name. The fragment already has a `name` — overriding it creates a differently-named copy.
4. Override only fields that differ per-definition (e.g., a different `initFilePath`).
5. For repeated UI flows (e.g., login), create a **step fragment** in `shared/` and reference it with `$ref` inside the UI action's `steps` array.

**Split tests across multiple definition files.** Each definition file is a self-contained test environment. Group related tests together rather than putting everything in one giant file. For example:

- `.dokkimi/definitions/user-tests.json` — tests for user service
- `.dokkimi/definitions/payment-tests.json` — tests for payment flow

---

## Item Types

### SERVICE

A containerized application deployed with an interceptor sidecar for traffic capture.

**Required fields:**

| Field         | Type              | Description                                                                                                         |
| ------------- | ----------------- | ------------------------------------------------------------------------------------------------------------------- |
| `type`        | `"SERVICE"`       | Item type                                                                                                           |
| `name`        | string            | Unique name (1-63 chars, lowercase alphanumeric + hyphens, must start/end with alphanumeric). Used as DNS hostname. |
| `port`        | integer (1-65535) | Port the service listens on                                                                                         |
| `healthCheck` | string            | Health check: HTTP path (e.g., `"/health"`) or `"tcp"` for TCP port check                                           |

**Optional fields:**

| Field         | Type          | Default | Description                                                                                                                        |
| ------------- | ------------- | ------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `description` | string        | —       | Human-readable description (max 500 chars)                                                                                         |
| `image`       | string        | —       | Docker image URI (e.g., `"my-service:latest"`).                                                                                    |
| `uiPath`      | string        | —       | URL path to service's UI (e.g., `"/"`, `"/app"`) — enables "Open UI" button                                                        |
| `command`     | string[]      | —       | Override Docker image's default CMD (e.g., `["server", "/data"]`)                                                                  |
| `entrypoint`  | string[]      | —       | Override Docker image's ENTRYPOINT (e.g., `["/bin/sh", "-c", "..."]`)                                                              |
| `mountFiles`  | array         | —       | Files to mount into the container (read-only). Each entry: `{ "source": "../path/to/file", "target": "/absolute/container/path" }` |
| `env`         | array         | —       | Environment variables: `[{ "name": "KEY", "value": "VALUE" }, ...]`                                                                |
| `minCpu`      | number (≥ 0)  | —       | Minimum CPU cores (e.g., 0.25)                                                                                                     |
| `minMemory`   | number (≥ 0)  | —       | Minimum memory in MB                                                                                                               |
| `maxCpu`      | number (≥ 0)  | —       | Maximum CPU cores                                                                                                                  |
| `maxMemory`   | number (≥ 0)  | —       | Maximum memory in MB                                                                                                               |
| `stage`       | integer (≥ 0) | `0`     | Deployment stage. Items deploy in stage order — stage N+1 starts after stage N is healthy. Sort key, not index (gaps are fine).    |

**Full example:**

```json
{
  "type": "SERVICE",
  "name": "api-gateway",
  "image": "api-gateway:latest",
  "port": 3000,
  "healthCheck": "/health",
  "uiPath": "/",
  "env": [
    {
      "name": "DATABASE_URL",
      "value": "postgresql://dokkimi:dokkimi@postgres-db:5432/dokkimi"
    },
    { "name": "REDIS_URL", "value": "redis://redis-cache:6379" },
    { "name": "USER_SERVICE_URL", "value": "http://user-service:3000" },
    { "name": "NODE_ENV", "value": "test" }
  ],
  "minCpu": 0.25,
  "minMemory": 256,
  "maxCpu": 1,
  "maxMemory": 1024
}
```

**Important notes:**

- Environment variables use `{ "name": "KEY", "value": "VALUE" }` format (array of objects, NOT a flat `{ "KEY": "VALUE" }` object).
- **Service names are DNS hostnames.** Use the service `name` as the hostname when one service connects to another (e.g., `"postgresql://dokkimi:dokkimi@postgres-db:5432/dokkimi"` where `postgres-db` is a DATABASE item name).
- Services connect to databases using the database item's `name` as the hostname and the database's default port.

---

### WORKER

A background process (queue consumer, event processor, cron daemon) that doesn't serve HTTP. Workers get an interceptor for outbound traffic capture but no health check — they are marked READY immediately on container creation. If the container crashes, the run fails.

**Required fields:**

| Field  | Type       | Description                                                                                               |
| ------ | ---------- | --------------------------------------------------------------------------------------------------------- |
| `type` | `"WORKER"` | Item type                                                                                                 |
| `name` | string     | Unique name (1-63 chars, lowercase alphanumeric + hyphens). Used as DNS hostname for service connections. |

**Optional fields:**

| Field         | Type          | Default | Description                                                                                |
| ------------- | ------------- | ------- | ------------------------------------------------------------------------------------------ |
| `description` | string        | —       | Human-readable description (max 500 chars)                                                 |
| `image`       | string        | —       | Docker image URI                                                                           |
| `command`     | string[]      | —       | Override the Docker image's CMD                                                            |
| `entrypoint`  | string[]      | —       | Override the Docker image's ENTRYPOINT                                                     |
| `env`         | array         | —       | Environment variables (`[{ "name": "KEY", "value": "VALUE" }]`)                            |
| `mountFiles`  | array         | —       | Files to mount (read-only): `[{ "source": "relative/path", "target": "/absolute/path" }]`  |
| `minCpu`      | number (≥ 0)  | —       | Minimum CPU cores                                                                          |
| `minMemory`   | number (≥ 0)  | —       | Minimum memory in MB                                                                       |
| `maxCpu`      | number (≥ 0)  | —       | Maximum CPU cores                                                                          |
| `maxMemory`   | number (≥ 0)  | —       | Maximum memory in MB                                                                       |
| `stage`       | integer (≥ 0) | `0`     | Deployment stage. Items deploy in stage order — stage N+1 starts after stage N is healthy. |

**Example:**

```json
{
  "type": "WORKER",
  "name": "appwrite-worker-db",
  "image": "appwrite/appwrite:latest",
  "command": ["php", "app/worker.php", "databases"],
  "env": [
    { "name": "_APP_REDIS_HOST", "value": "appwrite-redis" },
    { "name": "_APP_REDIS_PORT", "value": "6379" }
  ]
}
```

---

### DATABASE

A managed database instance. Dokkimi provisions the database container, sets up credentials, and runs init scripts automatically.

**Required fields:**

| Field      | Type         | Description                                                                                               |
| ---------- | ------------ | --------------------------------------------------------------------------------------------------------- |
| `type`     | `"DATABASE"` | Item type                                                                                                 |
| `name`     | string       | Unique name (1-63 chars, lowercase alphanumeric + hyphens). Used as DNS hostname for service connections. |
| `database` | enum         | Database engine: `"postgres"`, `"mysql"`, `"mongodb"`, `"redis"`                                          |

**Optional fields:**

| Field           | Type          | Default     | Description                                                                                                 |
| --------------- | ------------- | ----------- | ----------------------------------------------------------------------------------------------------------- |
| `description`   | string        | —           | Human-readable description (max 500 chars)                                                                  |
| `image`         | string        | —           | Custom Docker image (overrides engine default, e.g. `"getlago/postgres-partman:15.0-alpine"`)               |
| `version`       | string        | per engine  | Database image version tag (e.g. `"16"` for postgres:16). See defaults below.                               |
| `dbName`        | string        | `"dokkimi"` | Database/schema name                                                                                        |
| `dbUser`        | string        | `"dokkimi"` | Database username                                                                                           |
| `dbPassword`    | string        | `"dokkimi"` | Database password                                                                                           |
| `noAuth`        | boolean       | `false`     | Skip all authentication. Database starts without credentials. Cannot combine with dbName/dbUser/dbPassword. |
| `initFilePath`  | string        | —           | Relative path from this file to a single init script                                                        |
| `initFilePaths` | string[]      | —           | Relative paths to multiple init scripts (executed in order). Use one or the other, not both.                |
| `minCpu`        | number (≥ 0)  | —           | Minimum CPU cores                                                                                           |
| `minMemory`     | number (≥ 0)  | —           | Minimum memory in MB                                                                                        |
| `maxCpu`        | number (≥ 0)  | —           | Maximum CPU cores                                                                                           |
| `maxMemory`     | number (≥ 0)  | —           | Maximum memory in MB                                                                                        |
| `stage`         | integer (≥ 0) | `0`         | Deployment stage. Items deploy in stage order — stage N+1 starts after stage N is healthy.                  |

**Database engine details:**

| Engine     | Default version | Default image  | Port  | Default connection string                                         |
| ---------- | --------------- | -------------- | ----- | ----------------------------------------------------------------- |
| `postgres` | `15`            | postgres:15    | 5432  | `postgresql://dokkimi:dokkimi@{name}:5432/dokkimi`                |
| `mysql`    | `8`             | mysql:8        | 3306  | `mysql://dokkimi:dokkimi@{name}:3306/dokkimi`                     |
| `mongodb`  | `7`             | mongo:7        | 27017 | `mongodb://dokkimi:dokkimi@{name}:27017/dokkimi?authSource=admin` |
| `redis`    | `7`             | redis:7-alpine | 6379  | `redis://:dokkimi@{name}:6379`                                    |

Use the `version` field to pin a specific database version (e.g. `"version": "16"` produces `postgres:16`). Version must start with a digit (e.g. `"16"`, `"8.0"`, `"7.2-alpine"`) — values like `"latest"` are rejected. The version string is used verbatim as the image tag — for Redis, that means `"version": "7"` produces `redis:7` (Debian-based); use `"7-alpine"` for the smaller Alpine variant.

**Connection string details (IMPORTANT):**

- **PostgreSQL / MySQL**: Standard `user:password@host:port/dbname` format. No special options needed.
- **MongoDB**: You **must** include `?authSource=admin` in the connection string. Dokkimi creates MongoDB users as root users via `MONGO_INITDB_ROOT_USERNAME`, which authenticate against the `admin` database. Without `?authSource=admin`, authentication will fail.
- **Redis**: The password goes before the hostname with a colon prefix: `redis://:password@host:port`. Note the `://:` — there is no username for Redis, just `:<password>@`.

**Examples for each database type:**

PostgreSQL:

```json
{
  "type": "DATABASE",
  "name": "postgres-db",
  "database": "postgres",
  "dbName": "myapp",
  "dbUser": "appuser",
  "dbPassword": "secret",
  "initFilePath": "../init-files/schema.sql"
}
```

MySQL:

```json
{
  "type": "DATABASE",
  "name": "mysql-db",
  "database": "mysql",
  "initFilePaths": ["../init-files/schema.sql", "../init-files/seed.sql"]
}
```

MongoDB:

```json
{
  "type": "DATABASE",
  "name": "mongo-db",
  "database": "mongodb",
  "initFilePath": "../init-files/init.js"
}
```

Redis:

```json
{
  "type": "DATABASE",
  "name": "redis-cache",
  "database": "redis"
}
```

**Init script readiness:** For MongoDB, Dokkimi guarantees that all init scripts have fully executed before tests begin. It injects a small sentinel script that runs after your init files, and the database is only marked as ready once the sentinel is confirmed. This eliminates flaky failures caused by tests starting before seeded data is available.

**Reserved database name:** The `dokkimi_internal` database is reserved for Dokkimi's internal use (readiness checks). Do not use this name in your init scripts or application code.

**Connecting services to databases:** Use the database item's `name` as the hostname in your service's environment variables:

```json
{
  "type": "SERVICE",
  "name": "my-service",
  "port": 3000,
  "healthCheck": "/health",
  "env": [
    {
      "name": "DATABASE_URL",
      "value": "postgresql://dokkimi:dokkimi@postgres-db:5432/dokkimi"
    },
    { "name": "REDIS_URL", "value": "redis://:dokkimi@redis-cache:6379" },
    {
      "name": "MONGO_URL",
      "value": "mongodb://dokkimi:dokkimi@mongo-db:27017/dokkimi?authSource=admin"
    }
  ]
}
```

---

### MOCK

An HTTP mock that intercepts outbound requests from services and returns controlled responses. When a service tries to call an external API (e.g., Stripe, Twilio), the interceptor sidecar matches the request against defined mocks and returns the mock response instead.

**HTTP and HTTPS both work — no code changes needed.** The interceptor listens on port 80 for HTTP and on port 443 for HTTPS, terminating TLS with per-hostname certificates signed by a Dokkimi CA that is generated once per environment and automatically mounted into every service container (`NODE_EXTRA_CA_CERTS` for Node.js, `SSL_CERT_FILE` for Python/Go/curl/etc., and a Java truststore for JVM services). You write `mockTarget` exactly the same way for either protocol — `"api.stripe.com"` matches both `http://api.stripe.com` and `https://api.stripe.com`. Leave your service's code calling the real Auth0/Stripe/Twilio URLs as-is; DNS in the network routes the hostname to the interceptor, the interceptor presents a trusted cert, terminates TLS, matches the request against your mocks, and serves the response.

**Required fields:**

| Field        | Type     | Description                                                                  |
| ------------ | -------- | ---------------------------------------------------------------------------- |
| `type`       | `"MOCK"` | Item type                                                                    |
| `name`       | string   | Unique name (1-63 chars)                                                     |
| `mockTarget` | string   | Target hostname to intercept (e.g., `"api.stripe.com"`, `"hooks.slack.com"`) |
| `mockPath`   | string   | URL path to match (e.g., `"/v1/charges"`, `"/api/*"`)                        |

**Optional fields:**

| Field                     | Type              | Default | Description                                                                                                                                                                                     |
| ------------------------- | ----------------- | ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `description`             | string            | —       | Human-readable description (max 500 chars)                                                                                                                                                      |
| `mockMethod`              | enum              | `"*"`   | HTTP method: `"GET"`, `"POST"`, `"PUT"`, `"DELETE"`, `"PATCH"`, `"HEAD"`, `"OPTIONS"`, or `"*"` (any)                                                                                           |
| `mockOrigin`              | string            | —       | Service name that makes the request, `"*"` for any service, or omit for any service (default behavior)                                                                                          |
| `mockDelayMs`             | integer (≥ 0)     | —       | Artificial response delay in milliseconds                                                                                                                                                       |
| `mockResponseStatus`      | integer (100-599) | —       | HTTP response status code                                                                                                                                                                       |
| `mockResponseHeaders`     | object            | —       | Response headers: `{ "Content-Type": "application/json" }`                                                                                                                                      |
| `mockResponseBody`        | any JSON          | —       | Response body (object, array, string, number, boolean, or null)                                                                                                                                 |
| `mockRequestBodyContains` | string            | —       | Substring match against the serialized request body (case-insensitive). Must be non-empty. Mutually exclusive with `mockRequestBodyMatches`.                                                    |
| `mockRequestBodyMatches`  | string            | —       | Regex match against the serialized request body (case-sensitive; use `(?i)` flag for case-insensitive). Must be non-empty and a valid regex. Mutually exclusive with `mockRequestBodyContains`. |

**Full example — mocking Stripe:**

```json
{
  "type": "MOCK",
  "name": "mock-stripe-charges",
  "mockMethod": "POST",
  "mockOrigin": "payment-service",
  "mockTarget": "api.stripe.com",
  "mockPath": "/v1/charges",
  "mockDelayMs": 100,
  "mockResponseStatus": 200,
  "mockResponseHeaders": { "Content-Type": "application/json" },
  "mockResponseBody": {
    "id": "ch_test_123",
    "object": "charge",
    "amount": 2000,
    "currency": "usd",
    "status": "succeeded"
  }
}
```

**Example — mocking a failure:**

```json
{
  "type": "MOCK",
  "name": "mock-stripe-failure",
  "mockMethod": "POST",
  "mockTarget": "api.stripe.com",
  "mockPath": "/v1/charges",
  "mockResponseStatus": 402,
  "mockResponseBody": {
    "error": { "type": "card_error", "message": "Your card was declined." }
  }
}
```

**Example — body matching for LLM prompt routing:**

When multiple calls hit the same endpoint with different payloads (LLM APIs, GraphQL, RPC-style APIs), use body matching to return different responses based on request content. A mock with a body match has higher specificity than one without, so catch-all fallbacks still work.

```json
[
  {
    "type": "MOCK",
    "name": "mock-openai-classify",
    "mockMethod": "POST",
    "mockTarget": "api.openai.com",
    "mockPath": "/v1/chat/completions",
    "mockRequestBodyContains": "classify this ticket",
    "mockResponseStatus": 200,
    "mockResponseBody": {
      "id": "chatcmpl-mock-001",
      "choices": [
        {
          "index": 0,
          "message": { "role": "assistant", "content": "billing" },
          "finish_reason": "stop"
        }
      ]
    }
  },
  {
    "type": "MOCK",
    "name": "mock-openai-extract",
    "mockMethod": "POST",
    "mockTarget": "api.openai.com",
    "mockPath": "/v1/chat/completions",
    "mockRequestBodyContains": "extract entities",
    "mockResponseStatus": 200,
    "mockResponseBody": {
      "id": "chatcmpl-mock-002",
      "choices": [
        {
          "index": 0,
          "message": {
            "role": "assistant",
            "content": "{\"people\": [\"Alice\"]}"
          },
          "finish_reason": "stop"
        }
      ]
    }
  },
  {
    "type": "MOCK",
    "name": "mock-openai-fallback",
    "mockMethod": "POST",
    "mockTarget": "api.openai.com",
    "mockPath": "/v1/chat/completions",
    "mockResponseStatus": 200,
    "mockResponseBody": {
      "id": "chatcmpl-mock-default",
      "choices": [
        {
          "index": 0,
          "message": { "role": "assistant", "content": "I don't understand." },
          "finish_reason": "stop"
        }
      ]
    }
  }
]
```

**Alternative: top-level `mocks` array.** Mocks can also be defined in a top-level `mocks` array with slightly different field names:

```json
{
  "name": "my-definition",
  "items": [ ... ],
  "mocks": [
    {
      "name": "Stripe Create Charge",
      "method": "POST",
      "origin": "payment-service",
      "target": "api.stripe.com",
      "path": "/v1/charges",
      "responseStatus": 200,
      "responseHeaders": { "Content-Type": "application/json" },
      "responseBody": { "id": "ch_test", "status": "succeeded" }
    }
  ]
}
```

Field name mapping: `mockMethod` → `method`, `mockOrigin` → `origin`, `mockTarget` → `target`, `mockPath` → `path`, `mockDelayMs` → `delayMs`, `mockResponseStatus` → `responseStatus`, `mockResponseHeaders` → `responseHeaders`, `mockResponseBody` → `responseBody`, `mockRequestBodyContains` → `requestBodyContains`, `mockRequestBodyMatches` → `requestBodyMatches`.

---

### BROKER

A message broker instance with a transparent proxy sidecar that captures all published and delivered messages.

**Required fields:**

| Field    | Type       | Description                                                                                               |
| -------- | ---------- | --------------------------------------------------------------------------------------------------------- |
| `type`   | `"BROKER"` | Item type                                                                                                 |
| `name`   | string     | Unique name (1-63 chars, lowercase alphanumeric + hyphens). Used as DNS hostname for service connections. |
| `broker` | enum       | Broker engine: `"amqp"` or `"kafka"`                                                                      |

**Optional fields:**

| Field         | Type              | Default | Description                                                                                |
| ------------- | ----------------- | ------- | ------------------------------------------------------------------------------------------ |
| `description` | string            | —       | Human-readable description (max 500 chars)                                                 |
| `image`       | string            | —       | Custom Docker image (e.g. `"rabbitmq:3.13-management"`, `"apache/kafka:3.9"`)              |
| `port`        | integer (1-65535) | —       | Native broker port (default: 5672 for AMQP, 9092 for Kafka)                                |
| `healthCheck` | string            | —       | Health check endpoint or `"tcp"`                                                           |
| `env`         | array             | —       | Environment variables: `[{ "name": "KEY", "value": "VALUE" }, ...]`                        |
| `command`     | string[]          | —       | Override Docker image CMD                                                                  |
| `minCpu`      | number (≥ 0)      | —       | Minimum CPU cores                                                                          |
| `minMemory`   | number (≥ 0)      | —       | Minimum memory in MB                                                                       |
| `maxCpu`      | number (≥ 0)      | —       | Maximum CPU cores                                                                          |
| `maxMemory`   | number (≥ 0)      | —       | Maximum memory in MB                                                                       |
| `stage`       | integer (≥ 0)     | `0`     | Deployment stage. Items deploy in stage order — stage N+1 starts after stage N is healthy. |

**Broker engine details:**

| Engine  | Default image      | Native port | Default connection string         |
| ------- | ------------------ | ----------- | --------------------------------- |
| `amqp`  | rabbitmq:3         | 5672        | `amqp://guest:guest@{name}:5672`  |
| `kafka` | apache/kafka:4.3.1 | 9092        | `{name}:9092` (bootstrap servers) |

**Examples:**

Minimal AMQP:

```json
{
  "type": "BROKER",
  "name": "rabbitmq",
  "broker": "amqp"
}
```

Minimal Kafka:

```json
{
  "type": "BROKER",
  "name": "kafka",
  "broker": "kafka"
}
```

With custom image and credentials (AMQP):

```json
{
  "type": "BROKER",
  "name": "rabbitmq",
  "broker": "amqp",
  "image": "rabbitmq:3.13-management",
  "env": [
    { "name": "RABBITMQ_DEFAULT_USER", "value": "myuser" },
    { "name": "RABBITMQ_DEFAULT_PASS", "value": "mypass" }
  ]
}
```

**Important notes:**

- **Broker names are DNS hostnames.** Services connect to the broker using the broker item's `name` as the hostname and the broker's native port (5672 for AMQP, 9092 for Kafka). For example: `"amqp://guest:guest@rabbitmq:5672"` where `rabbitmq` is the BROKER item name, or `"kafka:9092"` for Kafka bootstrap servers.
- The broker-proxy sidecar is injected transparently — it captures all published and delivered messages without modifying wire traffic.
- Message logs include protocol-specific metadata and are available for assertions via `$.messageLogs`:
  - AMQP: `exchange`, `routingKey`
  - Kafka: `topic`, `partition`, `key`, `offset` (consume only)

**Connecting services to brokers:** Use the broker item's `name` as the hostname in your service's environment variables:

```json
{
  "type": "SERVICE",
  "name": "my-service",
  "port": 3000,
  "healthCheck": "/health",
  "env": [{ "name": "AMQP_URL", "value": "amqp://guest:guest@rabbitmq:5672" }]
}
```

```json
{
  "type": "SERVICE",
  "name": "my-service",
  "port": 3000,
  "healthCheck": "/health",
  "env": [{ "name": "KAFKA_BROKERS", "value": "kafka:9092" }]
}
```

---

## $ref (Item References)

Items can reference shared fragments using `$ref` with a relative path. Additional fields are shallow-merged as overrides:

```json
{
  "items": [
    {
      "$ref": "../shared/postgres.json",
      "initFilePath": "../init-files/users-seed.sql"
    }
  ]
}
```

**Multi-ref:** `$ref` can also be an array of paths. Fragments are resolved and merged left-to-right, with later files overriding earlier ones. Inline fields still win over all fragments:

```json
{
  "items": [
    {
      "$ref": [
        "../shared/base-service.json",
        "../shared/staging-overrides.json"
      ],
      "env": ["...$ref.env", { "name": "EXTRA", "value": "inline-wins" }]
    }
  ]
}
```

Rules:

- Path is relative to the file containing the `$ref`
- For multi-ref, fragments merge left-to-right; inline override fields win over all fragments (shallow merge, no deep merging for objects)
- Refs are recursive — a fragment can `$ref` another fragment, which can `$ref` another, and so on. Overrides at each level are applied outward (innermost base is loaded first, then each layer's overrides are shallow-merged on top). Circular references are detected and reported as errors.
- `$ref` is stripped before sending to the backend

**Array spreading:** To extend an array field from the fragment instead of replacing it, use `"...$ref.<path>"` as an element in the override array:

```json
{
  "$ref": "../shared/my-service.json",
  "env": ["...$ref.env", { "name": "EXTRA_VAR", "value": "123" }]
}
```

The `"...$ref.env"` marker is replaced with the fragment's `env` array. Position controls order — entries before the marker are prepended, entries after are appended. If the path doesn't resolve to an array, the marker expands to nothing.

The path supports dot notation for nested fields (e.g., `"...$ref.some.nested.array"`), though in practice it will almost always be the same field name.

## $ref (Action References)

Step actions can use `$ref` to load reusable action definitions from shared fragment files. This works for all action types — `httpRequest`, `dbQuery`, `ui`, and `wait`. The fragment file must be an object with an `action` field and optional `name`/`description` metadata:

```yaml
# shared/create-user.yaml
name: Create user
description: POST to create a new user
action:
  type: httpRequest
  method: POST
  url: api-gateway/api/users
  headers:
    Content-Type: application/json
  body:
    name: '{{userName}}'
```

Reference it on a step's `action` with `$ref`. Inline fields are shallow-merged as overrides:

```yaml
- name: Create a user
  action:
    $ref: ../shared/create-user.yaml
    body:
      name: custom-name
  assertions:
    - assertions:
        - path: $.response.status
          operator: eq
          value: 201
```

The fragment's `action` object is loaded and any inline sibling fields override it (same shallow-merge behavior as item `$ref`).

### UI sub-step `$ref`

UI actions also support `$ref` inside the `steps` array to splice in reusable sub-step sequences (e.g., a login flow). The fragment file has a `steps` array instead of `action`:

```yaml
# shared/login-flow.yaml
name: OAuth login flow
description: Signs in via Google OAuth mock
steps:
  - visit: /login
  - click: "[data-testid='login-btn']"
  - waitFor: "[data-testid='dashboard']"
```

Reference it inside a UI action's `steps` array:

```yaml
action:
  type: ui
  target: my-app
  steps:
    - $ref: ../shared/login-flow.yaml
    - visit: /settings
    - click: "[data-testid='save']"
```

The `$ref` entry is replaced by the contents of the fragment's `steps` array, spliced into position. Multiple `$ref` entries can appear in the same steps array and can be mixed with inline sub-steps.

### Rules

- Path is relative to the definition file containing the `$ref`
- Fragment files accept optional `name` and `description` metadata
- Action fragments must contain an `action` object; sub-step fragments must contain a `steps` array
- Refs are recursive — an action fragment's `action` can itself use `$ref` to load from another fragment, and sub-step fragments can contain `$ref` entries that reference other sub-step fragments. Circular references are detected and reported as errors.
- `$ref` is resolved before validation, so referenced content is validated normally

---

## Config

The optional top-level `config` object holds run-level settings that apply to the entire definition.

| Field            | Type    | Required | Default | Description                                                               |
| ---------------- | ------- | -------- | ------- | ------------------------------------------------------------------------- |
| `timeoutSeconds` | integer | No       | `300`   | Timeout for the entire run in seconds                                     |
| `browser`        | object  | No       | —       | Browser configuration for UI tests (ignored when there are no UI actions) |

### browser

| Field     | Type   | Required | Default           | Description                                                               |
| --------- | ------ | -------- | ----------------- | ------------------------------------------------------------------------- |
| `version` | string | No       | `"148.0.7778.56"` | Chrome version tag. Changing this requires regenerating visual baselines. |

Example:

```json
{
  "config": {
    "timeoutSeconds": 120,
    "browser": {
      "version": "148.0.7778.56"
    }
  }
}
```

---

## Tests

Tests are defined in the top-level `tests` array. Each test is independent and contains a flat array of sequential steps. To run actions in parallel, use the `parallel` action type.

**Definition-level variables:** The definition file itself can have a top-level `variables` field (alongside `name`, `items`, `tests`). These are shared across all tests in the definition. Test-level variables override definition-level variables with the same key.

### TestDefinition

| Field            | Type    | Required | Default | Description                                                                                                                                         |
| ---------------- | ------- | -------- | ------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `name`           | string  | Yes      | —       | Name of the test                                                                                                                                    |
| `description`    | string  | No       | —       | What the test verifies                                                                                                                              |
| `timeoutSeconds` | integer | No       | —       | Timeout for entire test in seconds                                                                                                                  |
| `stopOnFailure`  | boolean | No       | `true`  | Stop executing subsequent steps when any assertion fails                                                                                            |
| `variables`      | object  | No       | —       | Test-level variables as key-value pairs, available via `{{variableName}}`. Overrides definition-level variables with the same key. Supports `$ref`. |
| `steps`          | array   | Yes      | —       | Flat array of steps, executed sequentially                                                                                                          |

### TestStep

| Field           | Type    | Required | Default | Description                                                                       |
| --------------- | ------- | -------- | ------- | --------------------------------------------------------------------------------- |
| `name`          | string  | No       | —       | Step name                                                                         |
| `description`   | string  | No       | —       | Step description                                                                  |
| `action`        | object  | Yes      | —       | Action to execute (httpRequest, dbQuery, wait, ui, or parallel)                   |
| `extract`       | object  | No       | —       | Extract variables from the root context: `{ "varName": "$.response.body.field" }` |
| `assertions`    | array   | No       | —       | Assertion blocks to validate after action completes                               |
| `stopOnFailure` | boolean | No       | `true`  | Stop test when assertions in this step fail                                       |

### Step Actions

#### HTTP Request (`httpRequest`)

```json
{
  "action": {
    "type": "httpRequest",
    "method": "POST",
    "url": "api-gateway/api/users",
    "headers": {
      "Authorization": "Bearer {{token}}",
      "Content-Type": "application/json"
    },
    "body": { "name": "{{userName}}", "email": "{{email}}" }
  }
}
```

| Field         | Type            | Required | Description                                                                                                                 |
| ------------- | --------------- | -------- | --------------------------------------------------------------------------------------------------------------------------- |
| `type`        | `"httpRequest"` | Yes      | Action type                                                                                                                 |
| `method`      | enum            | Yes      | `"GET"`, `"POST"`, `"PUT"`, `"DELETE"`, `"PATCH"`, `"HEAD"`, `"OPTIONS"`                                                    |
| `url`         | string          | Yes      | `"service-name/path"` format — service name resolves to internal DNS                                                        |
| `headers`     | object          | No       | Request headers (values support `{{variables}}`)                                                                            |
| `body`        | any JSON        | No       | Request body (string values support `{{variables}}`)                                                                        |
| `formData`    | object          | No       | Multipart/form-data fields. Cannot be combined with `body`. See below.                                                      |
| `queryParams` | object          | No       | URL query parameters. String values sent as-is; array values send repeated keys. Values support `{{variables}}`. See below. |

**formData (multipart/form-data uploads):**

Use `formData` instead of `body` when the target API expects `multipart/form-data` (e.g., file uploads). The Content-Type header is set automatically — do not set it manually.

Field values are encoded by type:

- **String / number / boolean** → plain form field
- **Array of strings** → repeated `key[]` fields (e.g., `permissions[]`)
- **Object with `filename` + `content`** → file upload part (optional `contentType`, defaults to `application/octet-stream`)

```yaml
action:
  type: httpRequest
  method: POST
  url: my-service/v1/storage/buckets/{{bucketId}}/files
  headers:
    Authorization: 'Bearer {{token}}'
  formData:
    fileId: 'unique()'
    file:
      filename: report.txt
      content: 'Hello world'
      contentType: text/plain
    permissions:
      - 'read("any")'
      - 'write("user:{{userId}}")'
```

**queryParams (URL query parameters):**

Use `queryParams` to append URL query parameters with proper encoding. This is especially useful for APIs that use array-style params (e.g. `queries[]`).

```yaml
action:
  type: httpRequest
  method: GET
  url: api/v1/documents
  queryParams:
    queries[]:
      - '{"method":"limit","values":[10]}'
      - '{"method":"offset","values":[0]}'
    format: json
```

- **String / number / boolean** → single `key=value` pair
- **Array values** → repeated keys (e.g. `queries[]=...&queries[]=...`)
- Values support `{{variable}}` interpolation
- Params are URL-encoded automatically
- Merged with any existing query string in `url`

#### Database Query (`dbQuery`)

```json
{
  "action": {
    "type": "dbQuery",
    "database": "postgres-db",
    "query": "SELECT * FROM users WHERE email = '{{email}}'"
  }
}
```

| Field      | Type        | Required | Description                                                    |
| ---------- | ----------- | -------- | -------------------------------------------------------------- |
| `type`     | `"dbQuery"` | Yes      | Action type                                                    |
| `database` | string      | Yes      | Name of a DATABASE item in the definition                      |
| `query`    | string      | Yes      | SQL query or MongoDB command JSON (supports `{{variables}}`)   |
| `params`   | object      | No       | Bound query parameters (string values support `{{variables}}`) |

**SQL placeholder syntax:**

Write placeholders in the dialect of the target database; the value for each placeholder lives in the `params` map.

| Database | Placeholder | `params` key | Example                                                                  |
| -------- | ----------- | ------------ | ------------------------------------------------------------------------ |
| postgres | `$N`        | string `"N"` | `query: "WHERE id = $1"`, `params: { "1": "{{userId}}" }`                |
| postgres | `$name`     | `name`       | `query: "WHERE email = $email"`, `params: { email: "{{userEmail}}" }`    |
| postgres | `:name`     | `name`       | `query: "WHERE email = :email"`, `params: { email: "{{userEmail}}" }`    |
| mysql    | `?`         | string `"N"` | `query: "WHERE id = ? AND name = ?"`, `params: { "1": "5", "2": "Bob" }` |

For mysql each `?` consumes one positional value in source order — repeats like `WHERE a = ? OR b = ?` need both keys in `params` even if the value is the same.

**MongoDB query format:** For MongoDB databases, the `query` field must be a JSON string with the following structure:

```json
{
  "action": {
    "type": "dbQuery",
    "database": "mongo-db",
    "query": "{\"operation\":\"findOne\",\"collection\":\"orders\",\"filter\":{\"orderId\":\"ORD-001\"}}"
  }
}
```

Supported MongoDB operations: `find`, `findOne`, `insertOne`, `insertMany`, `updateOne`, `updateMany`, `deleteOne`, `deleteMany`.

Command fields: `operation` (required), `collection` (required), `filter` (for find/update/delete), `document` (for insertOne), `documents` (for insertMany), `update` (for updateOne/updateMany).

#### Wait (`wait`)

```json
{
  "action": {
    "type": "wait",
    "durationMs": 2000
  }
}
```

| Field        | Type     | Required | Description                      |
| ------------ | -------- | -------- | -------------------------------- |
| `type`       | `"wait"` | Yes      | Action type                      |
| `durationMs` | integer  | Yes      | Duration to wait in milliseconds |

#### Parallel (`parallel`)

Runs multiple actions concurrently within a single step. All actions execute in parallel and the step completes when all of them finish. If any action fails, the step fails.

```json
{
  "name": "Create user and order in parallel",
  "action": {
    "type": "parallel",
    "actions": [
      {
        "type": "httpRequest",
        "method": "POST",
        "url": "api-gateway/api/users",
        "body": { "name": "Alice" }
      },
      {
        "type": "httpRequest",
        "method": "POST",
        "url": "api-gateway/api/orders",
        "body": { "item": "WIDGET-1" }
      }
    ]
  }
}
```

| Field     | Type         | Required | Description                          |
| --------- | ------------ | -------- | ------------------------------------ |
| `type`    | `"parallel"` | Yes      | Action type                          |
| `actions` | array        | Yes      | Array of actions to run concurrently |

Each entry in `actions` is a regular action object (`httpRequest`, `dbQuery`, `wait`, or `ui`). Parallel actions cannot be nested (no `parallel` inside `parallel`).

#### UI Action (`ui`)

Drives a real Chromium browser through a sequence of sub-steps (visit, click, type, wait for an element, extract a value, screenshot, viewport). Use this to exercise frontends end-to-end. When a definition contains at least one `ui` action, Dokkimi attaches a headless Chromium sidecar to the test-agent pod automatically — API/DB-only runs stay lean.

```yaml
action:
  type: ui
  target: routing-test-ui
  steps:
    - visit: /
    - click: "[data-testid='tab-db']"
    - waitFor: "[data-testid='scenario-db']"
    - type:
        selector: "[data-testid='db-create-title']"
        text: '{{postTitle}}'
    - click: "[data-testid='db-create-submit']"
    - waitFor: "[data-testid='db-create-success']"
    - extract:
        newPostId:
          from: attribute
          selector: "[data-testid='db-create-success']"
          name: data-post-id
    - screenshot: post-created
```

| Field    | Type   | Required | Description                                                             |
| -------- | ------ | -------- | ----------------------------------------------------------------------- |
| `type`   | `"ui"` | Yes      | Action type                                                             |
| `target` | string | Yes      | Name of a SERVICE item the browser will load. Maps to its internal URL. |
| `steps`  | array  | Yes      | Ordered list of UI sub-steps (see below).                               |

Each sub-step has a single key naming its kind:

| Kind         | Shape                                                                 | Purpose                                                                                                                                                                                                                                                                                      |
| ------------ | --------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `visit`      | `visit: <path-or-url>`                                                | Navigate. Bare paths resolve against the target's base URL; absolute URLs are used verbatim.                                                                                                                                                                                                 |
| `click`      | `click: <css-selector>`                                               | Click the first matching element.                                                                                                                                                                                                                                                            |
| `type`       | `type: { selector, text }`                                            | Focus and type text into the element. `text` may reference `{{variables}}`.                                                                                                                                                                                                                  |
| `waitFor`    | `waitFor: <css-selector>` or `waitFor: { selector, text }`            | Wait until the element is visible (and optionally contains the given text).                                                                                                                                                                                                                  |
| `extract`    | `extract: { <varName>: { from, selector, name?, pattern?, group? } }` | Pull a value off the page and store it as a variable. See below.                                                                                                                                                                                                                             |
| `screenshot` | `screenshot: <name>`                                                  | Take a PNG of the current viewport, tagged with `name`.                                                                                                                                                                                                                                      |
| `scroll`     | `scroll: <css-selector>` or `scroll: { selector?, x?, y? }`           | Scroll. String form scrolls the matching element into view; object form scrolls to absolute pixel coords (`x`, `y` default to 0). chromedp auto-scrolls before clicks/waits, so explicit `scroll` is mainly for infinite-scroll triggers and lazy-load verification.                         |
| `select`     | `select: { selector, value }`                                         | Set the value of a native `<select>` and dispatch a `change` event so framework listeners react. For custom (non-`<select>`) dropdowns, use `click` + `waitFor` + `click` instead.                                                                                                           |
| `hover`      | `hover: <css-selector>`                                               | Dispatch `mouseover`/`mouseenter` on the matching element. Used for tooltips and hover-revealed menus.                                                                                                                                                                                       |
| `key`        | `key: <key-name>` or `key: { selector, key }`                         | Send a single keyboard key. String form sends to the focused element; object form focuses the selector first. Recognized names: `Enter`, `Tab`, `Escape`, `Backspace`, `Delete`, `ArrowUp`/`Down`/`Left`/`Right`, `Home`, `End`, `PageUp`, `PageDown`, `Space`. Single characters also work. |
| `upload`     | `upload: { selector, files: [path, ...] }`                            | Attach local files to an `<input type="file">`. Paths must exist **inside the test-agent container** — files are not bundled from the test definition itself; arrange delivery via a custom test-agent image or a mounted volume.                                                            |
| `drag`       | `drag: { from, to }`                                                  | Synthesize a mouse drag from the `from` element's center to the `to` element's center. Works for HTML5 native drag and most JS drag libraries (react-dnd, dnd-kit) that listen on real mouse events. Pure `dispatchEvent('drag')`-only libraries are out of scope.                           |
| `viewport`   | `viewport: { width, height }`                                         | Set the browser viewport dimensions (positive integers, pixels). Persists across subsequent UI actions until changed. The global default (1280×720) is configurable via `DOKKIMI_DEFAULT_VIEWPORT_WIDTH` / `DOKKIMI_DEFAULT_VIEWPORT_HEIGHT` env vars.                                       |

Selector and text fields support `{{variable}}` interpolation.

**Per-sub-step timeout:** every sub-step has a hard 30s ceiling by default. A `waitFor` whose target never appears fails the step quickly rather than hanging until the test-level timeout. Override per sub-step with a `timeoutMs` sibling key (positive integer, milliseconds):

```yaml
- waitFor: "[data-testid='slow-result']"
  timeoutMs: 60000 # give this one wait up to 60s
- click: "[data-testid='go']"
  timeoutMs: 2000 # this click should be near-instant
```

`timeoutMs` is allowed alongside any sub-step kind (`visit`, `click`, `type`, `waitFor`, `extract`, `screenshot`, `viewport`).

**Extract sources** (the `from` field):

| `from`           | Required fields    | Returns                                                                                                       |
| ---------------- | ------------------ | ------------------------------------------------------------------------------------------------------------- |
| `text`           | `selector`         | `textContent` of the matching element.                                                                        |
| `attribute`      | `selector`, `name` | The named HTML attribute on the matching element.                                                             |
| `value`          | `selector`         | The `.value` of an input / select / textarea.                                                                 |
| `url`            | (none)             | The browser's current URL. Optional `part: "full" \| "pathname" \| "search" \| "hash" \| "host"` to slice it. |
| `cookie`         | `name`             | A cookie value by name.                                                                                       |
| `localStorage`   | `key`              | `localStorage.getItem(key)`.                                                                                  |
| `sessionStorage` | `key`              | `sessionStorage.getItem(key)`.                                                                                |
| `count`          | `selector`         | The number of matching elements (rendered as a decimal string).                                               |
| `exists`         | `selector`         | `"true"` if at least one element matches, otherwise `"false"`.                                                |

**Regex post-processing.** Any extract source can be narrowed by adding `pattern` (a regex) and optional `group` (capture-group index, default `1`). The raw value is read first, then the regex is applied; the captured substring becomes the variable's value. Use this whenever the page exposes a value embedded in a larger string — an order id inside a sentence, a UUID inside a URL, a number inside a status badge.

```yaml
- extract:
    # Pull just the digits out of "Order #4912 created"
    orderId:
      from: text
      selector: "[data-testid='order-status']"
      pattern: 'Order #([0-9]+)'
    # Use group 0 to capture the entire match instead of a sub-group
    fullSlug:
      from: url
      part: pathname
      pattern: '/users/[^/]+'
      group: 0
```

If the regex doesn't match, the extract step fails with a clear error.

**Using extracted values:** anything pulled out via `extract` is added to the variable context and behaves like any other variable.

- In the same step's assertions, reference it as `$.variables.<varName>` in a self-block (for example `path: "$.variables.newPostId"`).
- In any later step (in this group or beyond), reference it as `{{newPostId}}` inside an action's URL, headers, body, query, params, etc.

**CORS gotcha — read this before writing UI tests against your own services.**

The UI runs in a real browser, which means cross-origin restrictions are real. If your page is loaded from `http://app/` and your JS does `fetch('http://api/...')`, the browser will preflight the request and need `Access-Control-Allow-*` headers in the response. **Dokkimi deliberately does not modify CORS behavior** — your tests should exercise the same browser policies your app sees in production. So:

- If your prod app uses a same-origin gateway (nginx/CDN/Next.js rewrites/API routes proxying `/api/*`), reproduce that inside the SERVICE that hosts the page. The browser then sees one origin and never preflights.
- If your prod app genuinely talks cross-origin and relies on a CORS allowlist (`https://app.example.com` → `https://api.example.com`), name your Dokkimi services so their hostnames match what your allowlist expects, and your prod CORS config will keep working unchanged.
- A naked `fetch('http://other-service/...')` from a UI test will fail the browser's preflight unless the other service responds with the right headers — and **adding wildcard CORS to "make tests pass" hides bugs that will fire in production**. Mirror prod, don't shortcut it.

A minimal same-origin proxy in nginx, suitable for an SPA fixture:

```nginx
location /api/ {
    proxy_pass http://api/;   # bare hostname → cluster service port; no Host override
}
```

Then have the SPA call `/api/...` (relative). The browser sees one origin; no preflight, no allowlist required.

---

### Variable Interpolation

`{{variableName}}` works in two contexts:

**In item fields** (build time): `{{VAR}}` resolves against a merged map of config.yaml `env` + definition-level `variables`. Unresolved references are errors. See the "Build-time `{{VAR}}` in items" section above for details.

**In test steps** (runtime): `{{variableName}}` resolves at runtime by the test agent. Variables come from three sources (in order of increasing precedence):

1. **Definition-level `variables`** — shared across all tests in the definition
2. **Test-level `variables`** — per-test overrides (overwrites definition-level values with the same key)
3. **`extract` on steps** — extracted from responses at runtime (overwrites all hardcoded values with the same name)

**`$ref` for variables:** Both definition-level and test-level `variables` support `$ref` to load values from shared files. The `$ref` can be a string (single file) or an array (multiple files merged left-to-right). Inline keys override `$ref` values:

```json
{
  "variables": {
    "$ref": "../shared/db-vars.json",
    "localOverride": "my-value"
  }
}
```

```json
{
  "variables": {
    "$ref": ["../shared/db-vars.json", "../shared/test-users.json"],
    "extraVar": "inline-wins"
  }
}
```

The referenced files must be plain `{ "key": "value" }` objects (no nested objects). Variable `$ref` files can themselves use `$ref` to load from another variables file (recursive resolution with circular reference detection).

**Where variables work:**

- Action URLs: `"url": "api-gateway/api/users/{{userId}}"`
- Action headers: `"headers": { "Authorization": "Bearer {{token}}" }`
- Action body string values: `"body": { "email": "{{email}}" }`
- Database queries: `"query": "SELECT * FROM users WHERE id = {{userId}}"`
- Assertion values: `"value": "{{email}}"`
- Match where clause values: `"value": "user-service/{{path}}"`

**Extract syntax:**

Each extract rule can be a **simple JSONPath string** or a **regex extract object**:

```json
{
  "extract": {
    "userId": "$.response.body.id",
    "authToken": "$.response.headers.x-auth-token",
    "firstName": "$.response.body.user.profile.name",
    "firstItem": "$.response.body.items[0].id",
    "correlationId": {
      "path": "$.response.body.message",
      "pattern": "correlation_id=([a-f0-9-]+)",
      "group": 1
    }
  }
}
```

**Simple form** (string): a JSONPath expression. The resolved value is stored directly.

**Regex form** (object):

| Field     | Type   | Required | Description                                                |
| --------- | ------ | -------- | ---------------------------------------------------------- |
| `path`    | string | Yes      | JSONPath to the source value                               |
| `pattern` | string | Yes      | Regex pattern (with capture groups)                        |
| `group`   | number | No       | Capture group index (default: `1`; use `0` for full match) |

The JSONPath is resolved first, the result is coerced to a string, then the regex is applied. An error is raised if the path doesn't exist, the pattern doesn't match, or the capture group is out of range.

**Transform form** (object): converts an object into an array for use with `forEach`:

| Field       | Type   | Required | Description                                           |
| ----------- | ------ | -------- | ----------------------------------------------------- |
| `path`      | string | \*       | JSONPath to the source object                         |
| `from`      | string | \*       | Variable reference (`{{varName}}`) as the source      |
| `transform` | string | Yes      | Conversion type: `"keys"`, `"values"`, or `"entries"` |

\* Either `path` or `from` is required (not both).

- `"keys"` — returns an array of the object's key names (sorted alphabetically)
- `"values"` — returns an array of values (in sorted key order)
- `"entries"` — returns an array of `{ "key": "...", "value": ... }` objects (in sorted key order)

```json
{
  "extract": {
    "settingKeys": {
      "path": "$.response.body.settings",
      "transform": "keys"
    },
    "fieldNames": {
      "from": "{{userTemplate}}",
      "transform": "keys"
    }
  }
}
```

Extract resolves paths against the unified root context, the same document structure used by assertions. The root context is: `{ request, response, responseTime, variables, traffic, consoleLogs, dbLogs, timeline }`. For step-level and assertion-block extract (including inside `match` blocks), the test-agent resolves extract paths against this root context.

For HTTP actions, use paths like `$.response.body.field`, `$.response.status`, `$.response.headers.name`.
For DB queries, use paths like `$.response.data[0].field`, `$.response.success`, `$.response.rowsAffected`.

Supported JSONPath syntax:

- `$.response.body.field` — field in the response body
- `$.response.body.nested.field` — nested object access
- `$.response.body.array[0]` — array index
- `$.response.body.array[0].field` — array element field access
- `$.response.headers.header-name` — response headers (case-insensitive)
- `$.response.status` — HTTP status code
- `$.response.data[0].column` — DB query result field

**Extract paths and assertion paths use the same unified root context.** Both resolve against the same document structure with a `$.` prefix. For example, `$.response.body.id` works in both extract and assertion paths. The unified root context includes `request`, `response`, `responseTime`, `variables`, and more — so both extract and assertions can access request-side data.

**Variable scope and precedence:**

- Definition-level variables are seeded first, then test-level variables override, then extracted variables override at runtime
- Variables persist across all steps within a single test run
- Extracted variables from step N are available in steps N+1, N+2, etc.
- Within a `parallel` action, variable extraction order is non-deterministic
- Referencing an undefined variable causes an immediate error

---

### Loops

Loop modifiers let you repeat tests, steps, or actions over data. Three types are available: `forEach` (iterate an array), `for` (numeric range), and `repeat` (fixed count with optional early exit).

#### forEach

Iterates over an array of items. Each iteration sets the loop variable to the current item.

| Field     | Type            | Required | Description                                                                                                               |
| --------- | --------------- | -------- | ------------------------------------------------------------------------------------------------------------------------- |
| `items`   | array or string | Yes      | Inline array, `{{variable}}` reference, or `$.path` into the response (assertion-block level only)                        |
| `as`      | string          | Yes      | Variable name for the current item. Access fields with `{{as.field}}`.                                                    |
| `name`    | string          | No       | Loop name. When set, exposes metadata as `{{name.index}}`, `{{name.items}}`, `{{name.completed}}`, `{{name.iterations}}`. |
| `delayMs` | integer         | No       | Milliseconds to wait between iterations                                                                                   |

```json
{
  "name": "Verify user {{user.name}}",
  "forEach": {
    "items": [
      { "name": "Alice", "email": "alice@test.com" },
      { "name": "Bob", "email": "bob@test.com" }
    ],
    "as": "user"
  },
  "action": {
    "type": "httpRequest",
    "method": "GET",
    "url": "api-gateway/api/users?email={{user.email}}"
  }
}
```

Items can also be a variable reference or a JSONPath:

```json
"forEach": { "items": "{{users}}", "as": "user" }
```

#### for

Iterates over a numeric range (inclusive on both ends).

| Field     | Type    | Required | Default | Description                                                                      |
| --------- | ------- | -------- | ------- | -------------------------------------------------------------------------------- |
| `from`    | integer | Yes      | —       | Start value (inclusive)                                                          |
| `to`      | integer | Yes      | —       | End value (inclusive)                                                            |
| `step`    | integer | No       | 1       | Increment per iteration. Must not be 0. Use negative step for descending ranges. |
| `as`      | string  | Yes      | —       | Variable name for the current value                                              |
| `name`    | string  | No       | —       | Loop name for metadata (see forEach)                                             |
| `delayMs` | integer | No       | —       | Milliseconds to wait between iterations                                          |

```json
{
  "name": "Seed user {{i}}",
  "for": { "from": 1, "to": 5, "as": "i" },
  "action": {
    "type": "httpRequest",
    "method": "POST",
    "url": "api-gateway/api/users",
    "body": { "name": "user-{{i}}" }
  }
}
```

For descending ranges, provide a negative `step` explicitly: `"for": { "from": 10, "to": 1, "step": -1, "as": "i" }`. Omitting `step` when `from > to` is a validation error.

#### repeat

Repeats a fixed number of times, optionally stopping early when `until` assertions all pass.

| Field     | Type    | Required | Description                                                          |
| --------- | ------- | -------- | -------------------------------------------------------------------- |
| `count`   | integer | Yes      | Maximum number of iterations                                         |
| `as`      | string  | Yes      | Variable name for the iteration index (0-based)                      |
| `name`    | string  | No       | Loop name for metadata (see forEach)                                 |
| `delayMs` | integer | No       | Milliseconds to wait between iterations                              |
| `until`   | array   | No       | Assertions checked after each iteration; all must pass to stop early |

The loop always executes at least once, regardless of `until`.

```json
{
  "name": "Poll until job completes (attempt {{attempt}})",
  "repeat": {
    "count": 10,
    "as": "attempt",
    "delayMs": 500,
    "until": [
      { "path": "$.response.body.status", "operator": "eq", "value": "done" }
    ]
  },
  "action": {
    "type": "httpRequest",
    "method": "GET",
    "url": "api-gateway/api/jobs/{{jobId}}"
  }
}
```

#### Loop meta-variables

All three loop types set variables via the `as` field. When the optional `name` field is set, additional metadata variables become available. Meta-variables require `name`; without it, only `{{as}}` is set.

| Variable              | Type    | Available in          | Description                                                                 |
| --------------------- | ------- | --------------------- | --------------------------------------------------------------------------- |
| `{{as}}`              | any     | forEach, for, repeat  | Current item (forEach), range value (for), or 0-based counter (repeat)      |
| `{{name.index}}`      | number  | forEach, for, repeat  | 0-based iteration counter                                                   |
| `{{name.items}}`      | array   | forEach only          | The full items array being iterated                                         |
| `{{name.completed}}`  | boolean | All (after loop ends) | Whether the loop completed normally (repeat+until: did the condition pass?) |
| `{{name.iterations}}` | number  | All (after loop ends) | How many iterations actually ran                                            |

`completed` and `iterations` are set after the loop finishes, so they are available in subsequent steps but not inside the loop body.

#### Loop levels

Loops can be applied at five levels:

**Test-level** — add `forEach`, `for`, or `repeat` to a test definition. All steps repeat per iteration:

```json
{
  "name": "Verify order {{order.id}}",
  "forEach": { "items": "{{orders}}", "as": "order" },
  "steps": [
    {
      "name": "Check API",
      "action": {
        "type": "httpRequest",
        "method": "GET",
        "url": "api/orders/{{order.id}}"
      }
    },
    {
      "name": "Check DB",
      "action": {
        "type": "dbQuery",
        "database": "postgres-db",
        "query": "SELECT * FROM orders WHERE id = '{{order.id}}'"
      }
    }
  ]
}
```

**Step-level** — add a loop modifier to a step. The action, extract, and assertions all repeat per iteration:

```json
{
  "name": "Create user {{user.name}}",
  "forEach": { "items": "{{users}}", "as": "user" },
  "action": { ... },
  "extract": { "lastId": "$.response.body.id" },
  "assertions": [ ... ]
}
```

**Action-level** — add a loop modifier inside the action object. Only the action repeats; extract and assertions run once on the last response:

```json
{
  "name": "Seed 5 users",
  "action": {
    "type": "httpRequest",
    "method": "POST",
    "url": "api-gateway/api/users",
    "body": { "name": "user-{{i}}" },
    "for": { "from": 1, "to": 5, "as": "i" }
  },
  "extract": { "lastUserId": "$.response.body.id" }
}
```

**Assertion-block level** — add `forEach` to an assertion block. The assertions run once per item (only `forEach` is supported at this level):

```json
{
  "forEach": { "items": "$.response.body", "as": "user" },
  "assertions": [
    {
      "path": "{{user.email}}",
      "operator": "matches",
      "value": "^.+@.+\\..+$"
    },
    { "path": "{{user.active}}", "operator": "eq", "value": true }
  ]
}
```

**UI sub-step group** — inside a UI action's `steps` array, add an object with a loop modifier and nested `steps`:

```json
{
  "forEach": { "items": ["bad@", "", "no-dot"], "as": "email" },
  "steps": [
    { "type": { "selector": "#email", "text": "{{email}}" } },
    { "click": "#submit" },
    { "waitFor": "[data-testid='error']" }
  ]
}
```

---

### Assertion Blocks

Each step can have an `assertions` array of blocks. Block type is determined by shape (not by an explicit type field). There are two block types:

#### 1. Self Block (no `match`)

Asserts on the step's own outcome:

- HTTP step → the response (`$.response.status`, `$.response.body`, `$.response.headers.*`, `$.responseTime`).
- DB query step → the query result (`$.response.success`, `$.response.data`, `$.response.rowsAffected`, `$.response.error`, `$.responseTime`).
- UI step → variables newly pulled out by the action's `extract` sub-steps, exposed as `$.variables.<varName>` (e.g. `$.variables.errorText`).
- Wait step → captured logs within the step's time window (`$.messageLogs`, `$.traffic`, `$.consoleLogs`, `$.dbLogs`).

```json
{
  "assertions": [
    { "path": "$.response.status", "operator": "eq", "value": 201 },
    { "path": "$.response.body.id", "operator": "exists" },
    {
      "path": "$.response.body.name",
      "operator": "eq",
      "value": "{{userName}}"
    },
    {
      "path": "$.response.headers.content-type",
      "operator": "contains",
      "value": "application/json"
    },
    { "path": "$.responseTime", "operator": "lt", "value": 500 }
  ]
}
```

#### 2. Match Block (has `match`)

Filters an array from the root context (traffic, console logs, DB logs, etc.) and asserts on the matched entries. This is a generic system — the same syntax works for all log types.

**Important:** `$.traffic`, `$.consoleLogs`, `$.dbLogs`, and `$.messageLogs` are scoped per test — they only include entries captured during the current test's steps. Traffic from one test is not visible in another test within the same definition. If you need to assert on traffic triggered by a previous step, keep the assertion in the same test.

**Match criteria fields:**

| Field   | Type              | Required | Description                                                                                                                                                                                                  |
| ------- | ----------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `path`  | string            | Yes      | JSONPath to the array to filter (e.g. `"$.traffic"`, `"$.consoleLogs"`, `"$.dbLogs"`, `"$.messageLogs"`)                                                                                                     |
| `where` | array             | No       | Array of filter entries — each entry tests a field on the iterator element (see below)                                                                                                                       |
| `count` | integer or object | No       | Assert on the number of matching entries. Integer shorthand (e.g. `1`) or `{ "operator": "eq", "value": 1 }`. Count operators: `"eq"`, `"gt"`, `"gte"`, `"lt"`, `"lte"`. Default: at least 1 match expected. |
| `as`    | string            | No       | Save the matched entries array as a named variable for use in later steps                                                                                                                                    |

**Where entries** use `$$` as the iterator variable — it refers to each element in the array being filtered:

```json
{
  "match": {
    "path": "$.traffic",
    "where": [
      { "path": "$$.origin", "operator": "eq", "value": "api-gateway" },
      { "path": "$$.request.method", "operator": "eq", "value": "POST" },
      {
        "path": "$$.request.url",
        "operator": "contains",
        "value": "user-service/api/users"
      }
    ],
    "count": 1
  },
  "assertions": [
    {
      "path": "$.match.request.body.email",
      "operator": "eq",
      "value": "{{email}}"
    },
    { "path": "$.match.response.status", "operator": "eq", "value": 201 },
    { "path": "$.match.response.body.id", "operator": "exists" }
  ]
}
```

Where entries support logical combinators — `or`, `and`, and `not` — for complex filtering:

```json
{
  "path": "$.traffic",
  "where": [
    {
      "or": [
        {
          "path": "$$.request.url",
          "operator": "contains",
          "value": "/api/users"
        },
        {
          "path": "$$.request.url",
          "operator": "contains",
          "value": "/api/orders"
        }
      ]
    }
  ]
}
```

**Assertion paths inside match blocks** use `$.match.*` to reference the matched entry:

| Path             | Description                                                        |
| ---------------- | ------------------------------------------------------------------ |
| `$.match.*`      | The single matched entry (when count=1), or the last matched entry |
| `$.lastMatch.*`  | Alias for the last matched entry                                   |
| `$.matches`      | Array of all matched entries                                       |
| `$.matches[0].*` | Specific matched entry by index                                    |

**Traffic assertion example:**

```json
{
  "match": {
    "path": "$.traffic",
    "where": [
      { "path": "$$.origin", "operator": "eq", "value": "api-gateway" },
      { "path": "$$.request.method", "operator": "eq", "value": "POST" },
      {
        "path": "$$.request.url",
        "operator": "contains",
        "value": "order-service/api/orders"
      }
    ],
    "count": 1
  },
  "assertions": [
    { "path": "$.match.response.status", "operator": "eq", "value": 201 }
  ]
}
```

**Console log assertion example:**

```json
{
  "match": {
    "path": "$.consoleLogs",
    "where": [
      { "path": "$$.service", "operator": "eq", "value": "user-service" },
      { "path": "$$.level", "operator": "eq", "value": "INFO" },
      { "path": "$$.message", "operator": "contains", "value": "User created" }
    ],
    "count": { "operator": "gte", "value": 1 }
  }
}
```

To assert zero errors from a service:

```json
{
  "match": {
    "path": "$.consoleLogs",
    "where": [
      { "path": "$$.service", "operator": "eq", "value": "order-service" },
      { "path": "$$.level", "operator": "eq", "value": "ERROR" }
    ],
    "count": 0
  }
}
```

Both block types can include `extract` to capture variables from matched results.

#### Source Fields (Transform Shorthands)

Instead of using `path` as the assertion source, you can use a transform shorthand that resolves a path and applies a transformation before comparing:

| Field     | Description                                                       |
| --------- | ----------------------------------------------------------------- |
| `count`   | Resolves the path and returns its length (array or string)        |
| `type`    | Resolves the path and returns the type as a string                |
| `keys`    | Resolves the path (must be an object) and returns its keys        |
| `values`  | Resolves the path (must be an object) and returns its values      |
| `entries` | Resolves the path (must be an object) and returns key-value pairs |

```json
{ "count": "$.response.body.items", "operator": "eq", "value": 3 }
```

```json
{ "type": "$.response.body.count", "operator": "eq", "value": "number" }
```

You can also use the object form `{ "from": "$.path", "transform": "count" }` in both `path` and `value` fields for more complex comparisons.

#### Value References

To compare two document paths against each other, use a value reference instead of a literal value:

```json
{
  "path": "$.response.body.total",
  "operator": "eq",
  "value": { "from": "$.response.body.expectedTotal" }
}
```

A value reference is an object with a `from` field containing a `$.`-prefixed path. The path is resolved against the root context before comparison.

---

### Assertion Paths

All assertion paths start with `$.` and resolve against the unified root context.

**For HTTP responses (self block):**

| Path                             | Description                        |
| -------------------------------- | ---------------------------------- |
| `$.response.status`              | HTTP status code (integer)         |
| `$.response.body`                | Entire response body               |
| `$.response.body.field`          | Top-level field in response body   |
| `$.response.body.nested.field`   | Nested field (dot notation)        |
| `$.response.body[0].field`       | Array element access               |
| `$.response.headers.header-name` | Response header (case-insensitive) |
| `$.request.method`               | HTTP method of the request         |
| `$.request.body`                 | Entire request body                |
| `$.request.body.field`           | Field in request body              |
| `$.request.headers.header-name`  | Request header (case-insensitive)  |
| `$.responseTime`                 | Response time in milliseconds      |

**For database query results (self block only):**

| Path                        | Description                                    |
| --------------------------- | ---------------------------------------------- |
| `$.response.success`        | Boolean — did the query succeed?               |
| `$.response.data`           | Array of result rows                           |
| `$.response.data[0].column` | Specific column from a result row              |
| `$.response.rowsAffected`   | Number of affected rows (integer)              |
| `$.response.error`          | Error message if query failed (string or null) |
| `$.responseTime`            | Query execution time in milliseconds           |

**Inside match blocks:**

| Path                           | Description                                          |
| ------------------------------ | ---------------------------------------------------- |
| `$.match.response.status`      | Response status of the matched entry                 |
| `$.match.request.body.field`   | Request body field of the matched entry              |
| `$.lastMatch.*`                | Alias — same as `$.match.*` (the last matched entry) |
| `$.matches`                    | Array of all matched entries                         |
| `$.matches[0].response.status` | Field from a specific matched entry by index         |

**Other root context fields:**

| Path                  | Description                                      |
| --------------------- | ------------------------------------------------ |
| `$.variables.varName` | Access a variable by name                        |
| `$.traffic`           | Array of all captured HTTP traffic entries       |
| `$.consoleLogs`       | Array of all console log entries                 |
| `$.dbLogs`            | Array of all database log entries                |
| `$.messageLogs`       | Array of all captured broker message log entries |
| `$.timeline`          | Ordered array of all events (traffic + logs)     |

**Message log entry fields (`$.messageLogs`):**

Each entry in `$.messageLogs` has the following fields:

| Field        | Type   | Description                                                           |
| ------------ | ------ | --------------------------------------------------------------------- |
| `timestamp`  | string | ISO timestamp of the message event                                    |
| `broker`     | string | Broker item name (e.g. `"rabbitmq"`)                                  |
| `brokerType` | string | Protocol type (e.g. `"amqp"`)                                         |
| `operation`  | string | `"publish"` / `"deliver"` (AMQP) or `"produce"` / `"consume"` (Kafka) |
| `body`       | any    | Message body (parsed JSON if valid, otherwise raw string)             |

Protocol-specific metadata fields are spread at the top level of each entry.

AMQP metadata:

| Field        | Type   | Description                                |
| ------------ | ------ | ------------------------------------------ |
| `exchange`   | string | AMQP exchange the message was published to |
| `routingKey` | string | AMQP routing key used for the message      |

Kafka metadata:

| Field       | Type    | Description                                          |
| ----------- | ------- | ---------------------------------------------------- |
| `topic`     | string  | Kafka topic                                          |
| `partition` | integer | Partition index                                      |
| `key`       | any     | Message key (string or parsed JSON, null if not set) |
| `offset`    | integer | Message offset (consume only)                        |

---

### Assertion Operators

| Operator                | Value required? | Value type     | Description                                                                                                             |
| ----------------------- | --------------- | -------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `eq`                    | Yes             | any            | Equality with coercion: numeric (`1` == `"1"`) and boolean (`true` == `"TRUE"`); case-sensitive for non-boolean strings |
| `ne`                    | Yes             | any            | Not equal (inverse of `eq`)                                                                                             |
| `gt`                    | Yes             | number         | Greater than                                                                                                            |
| `gte`                   | Yes             | number         | Greater than or equal                                                                                                   |
| `lt`                    | Yes             | number         | Less than                                                                                                               |
| `lte`                   | Yes             | number         | Less than or equal                                                                                                      |
| `contains`              | Yes             | any            | Dispatches by type: string → substring match (case-sensitive), array → element containment, object → key existence      |
| `notContains`           | Yes             | any            | Inverse of `contains` (case-sensitive)                                                                                  |
| `matches`               | Yes             | string (regex) | Regular expression match                                                                                                |
| `exists`                | No              | —              | Value exists (is defined and not null)                                                                                  |
| `notExists`             | No              | —              | Value does not exist                                                                                                    |
| `in`                    | Yes             | array          | Value is in the given array                                                                                             |
| `notIn`                 | Yes             | array          | Value is NOT in the given array                                                                                         |
| `isEmpty`               | No              | —              | Value is empty/null/undefined/empty array/empty object                                                                  |
| `notEmpty`              | No              | —              | Value is not empty                                                                                                      |
| `eqIgnoreCase`          | Yes             | any            | Case-insensitive equality for strings                                                                                   |
| `containsIgnoreCase`    | Yes             | any            | Case-insensitive substring containment                                                                                  |
| `notContainsIgnoreCase` | Yes             | any            | Inverse of `containsIgnoreCase`                                                                                         |

To check the type or length of a value, use the `type` or `count` source fields instead of an operator (see "Source Fields" above).

---

## Complete Example

A full definition with two services, a database, a mock, and tests:

```json
{
  "name": "ecommerce-checkout",
  "description": "Tests the checkout flow end-to-end",
  "items": [
    {
      "type": "SERVICE",
      "name": "api-gateway",
      "image": "api-gateway:latest",
      "port": 3000,
      "healthCheck": "/health",
      "env": [
        { "name": "ORDER_SERVICE_URL", "value": "http://order-service:3001" },
        {
          "name": "DATABASE_URL",
          "value": "postgresql://dokkimi:dokkimi@postgres-db:5432/dokkimi"
        }
      ]
    },
    {
      "type": "SERVICE",
      "name": "order-service",
      "image": "order-service:latest",
      "port": 3001,
      "healthCheck": "/health",
      "env": [
        {
          "name": "DATABASE_URL",
          "value": "postgresql://dokkimi:dokkimi@postgres-db:5432/dokkimi"
        },
        { "name": "STRIPE_API_KEY", "value": "sk_test_fake" }
      ]
    },
    {
      "type": "DATABASE",
      "name": "postgres-db",
      "database": "postgres",
      "initFilePath": "../init-files/schema.sql"
    },
    {
      "type": "MOCK",
      "name": "mock-stripe",
      "mockMethod": "POST",
      "mockOrigin": "order-service",
      "mockTarget": "api.stripe.com",
      "mockPath": "/v1/charges",
      "mockResponseStatus": 200,
      "mockResponseBody": { "id": "ch_test_123", "status": "succeeded" }
    }
  ],
  "tests": [
    {
      "name": "Create order and process payment",
      "timeoutSeconds": 60,
      "variables": {
        "userEmail": "test@example.com"
      },
      "steps": [
        {
          "name": "Create order",
          "action": {
            "type": "httpRequest",
            "method": "POST",
            "url": "api-gateway/api/orders",
            "body": {
              "email": "{{userEmail}}",
              "items": [{ "sku": "WIDGET-1", "qty": 2 }]
            }
          },
          "extract": {
            "orderId": "$.response.body.id"
          },
          "assertions": [
            {
              "assertions": [
                { "path": "$.response.status", "operator": "eq", "value": 201 },
                { "path": "$.response.body.id", "operator": "exists" },
                {
                  "path": "$.response.body.status",
                  "operator": "eq",
                  "value": "pending"
                }
              ]
            },
            {
              "match": {
                "path": "$.traffic",
                "where": [
                  {
                    "path": "$$.origin",
                    "operator": "eq",
                    "value": "api-gateway"
                  },
                  {
                    "path": "$$.request.method",
                    "operator": "eq",
                    "value": "POST"
                  },
                  {
                    "path": "$$.request.url",
                    "operator": "contains",
                    "value": "order-service/api/orders"
                  }
                ],
                "count": 1
              },
              "assertions": [
                {
                  "path": "$.match.response.status",
                  "operator": "eq",
                  "value": 201
                }
              ]
            },
            {
              "match": {
                "path": "$.consoleLogs",
                "where": [
                  {
                    "path": "$$.service",
                    "operator": "eq",
                    "value": "order-service"
                  },
                  { "path": "$$.level", "operator": "eq", "value": "INFO" },
                  {
                    "path": "$$.message",
                    "operator": "contains",
                    "value": "Order created"
                  }
                ],
                "count": { "operator": "gte", "value": 1 }
              }
            },
            {
              "match": {
                "path": "$.consoleLogs",
                "where": [
                  {
                    "path": "$$.service",
                    "operator": "eq",
                    "value": "order-service"
                  },
                  { "path": "$$.level", "operator": "eq", "value": "ERROR" }
                ],
                "count": 0
              }
            }
          ]
        },
        {
          "name": "Verify order in database",
          "action": {
            "type": "dbQuery",
            "database": "postgres-db",
            "query": "SELECT * FROM orders WHERE id = '{{orderId}}'"
          },
          "assertions": [
            {
              "assertions": [
                {
                  "path": "$.response.success",
                  "operator": "eq",
                  "value": true
                },
                {
                  "path": "$.response.data[0].email",
                  "operator": "eq",
                  "value": "{{userEmail}}"
                },
                {
                  "path": "$.response.data[0].status",
                  "operator": "eq",
                  "value": "completed"
                }
              ]
            }
          ]
        }
      ]
    }
  ]
}
```

---

## Naming Rules

Item names must be: lowercase, alphanumeric with hyphens, start/end with alphanumeric, 1-63 characters. They're used as Docker DNS names.

Pattern: `^[a-z0-9][a-z0-9-]*[a-z0-9]$` (or single character: `^[a-z0-9]$`)

Good: `my-service`, `postgres-db`, `api-gateway`
Bad: `MyService`, `my_service`, `-start-with-dash`

---

## CLI Reference

The `dokkimi` CLI manages the full lifecycle: validate definitions, run tests, inspect results, and debug failures.

### Commands

| Command                         | Description                                             |
| ------------------------------- | ------------------------------------------------------- |
| `dokkimi init`                  | Scaffold a `.dokkimi/` folder with example files        |
| `dokkimi validate [path]`       | Validate definition files without running               |
| `dokkimi run [target]`          | Run definition(s) and stream live results               |
| `dokkimi inspect [path]`        | Interactively inspect results from the last run         |
| `dokkimi dump [path] [-o file]` | Output raw JSON data dump for LLM-assisted debugging    |
| `dokkimi baselines`             | Review and approve pending visual baselines             |
| `dokkimi junit`                 | Generate a JUnit XML report from a test run             |
| `dokkimi doctor`                | Run environment pre-flight checks                       |
| `dokkimi stop`                  | Stop the current test run                               |
| `dokkimi status`                | Show service and instance status                        |
| `dokkimi clean`                 | Stop all instances and clean up resources               |
| `dokkimi reboot`                | Restart all Dokkimi services                            |
| `dokkimi shutdown`              | Stop all running Dokkimi services                       |
| `dokkimi config`                | View and edit Dokkimi settings (concurrency, telemetry) |
| `dokkimi mcp`                   | Start the MCP server (for AI tool integration)          |
| `dokkimi uninstall`             | Remove Dokkimi data, images, and services               |
| `dokkimi version`               | Show installed version                                  |

### `dokkimi run`

Resolves definitions, submits them to Control Tower, and streams live status with spinners and elapsed time. Exits with code 0 if all pass, 1 if any fail.

The target argument is flexible (similar to jest):

```bash
# Path-based targets
dokkimi run                          # .dokkimi/ in cwd (or nearest parent)
dokkimi run /path/to/project         # Finds /path/to/project/.dokkimi/
dokkimi run .dokkimi/                # Explicit .dokkimi/ directory
dokkimi run .dokkimi/auth-tests      # Only definitions in that subfolder
dokkimi run .dokkimi/auth.json       # A specific definition file

# Pattern-based targets (matches against file names/paths within .dokkimi/)
dokkimi run auth                     # Substring match — runs files with "auth" in the name
dokkimi run "auth/**"                # Glob pattern
dokkimi run "auth.*service"          # Regex pattern

# Options
dokkimi run --watch                  # Re-run on file changes
dokkimi run auth --watch             # Combine patterns with watch mode
```

**Watch mode** (`--watch` / `-w`):

- Watches `.dokkimi/**/*.{json,yml,yaml}` for changes (500ms debounce)
- Keyboard controls: `r` to re-run, `f` to re-run failed, `i` to inspect results, `b` to review baselines (when pending), `q` to quit
- The `i to inspect` hint only appears after the run completes
- The `b to review baselines` hint only appears when the run has pending visual baselines

**Post-run prompt** (TTY only, non-watch):
After a run completes, the CLI prompts `Press i to inspect results, b to review baselines, or any other key to exit...` (the `b` option only appears when pending baselines exist). In CI/non-TTY environments, the prompt is skipped and the CLI exits immediately.

### `dokkimi inspect`

Full-screen interactive TUI for drilling into test results and traffic logs. Uses the terminal's alternate screen buffer so it doesn't pollute scroll-back.

**Navigation:**

- Arrow keys + Enter to navigate menus
- ESC or `q` to go back
- Ctrl+C to exit

**Per-definition drill-down:**

- **Raw Definition** — opens the definition JSON in your editor
- **Test Logs** — opens test execution logs (timestamps, events, errors) in your editor
- **Items** — view item status and console logs per service/database/mock
- **Test Steps** — drill into each test and individual step

**Per-step detail view:**

- Raw Step Definition
- Test Logs (scoped to the step's group)
- Assertions (pass/fail with expected vs actual)
- Variables (before/after the step)
- HTTP Traffic (inter-service calls during the step)
- DB Queries (database operations during the step)
- Console Logs (per-service stdout/stderr during the step)

Selecting a log item opens it as a temp file in your `$EDITOR` (defaults to `code`).

### `dokkimi dump`

Outputs a complete JSON data dump of the last run — designed for piping to LLMs or scripts for automated debugging.

**LLM debugging workflow:** When a user asks you to debug a failed test run, use `dokkimi dump --failed -o failures.json` to get structured JSON of only the failing instances. Then read the output file to diagnose the issue. Do NOT use `dokkimi inspect` — that is an interactive TUI designed for humans, not LLMs.

```bash
dokkimi dump --failed -o failures.json # LLM debugging: only failed instances
dokkimi dump -o run-dump.json          # Write full dump to file (streams, low memory)
dokkimi dump                           # Output to stdout
dokkimi dump .dokkimi/auth.json -o out.json  # Dump specific definitions only
```

**Options:**

- `-o`, `--output <file>` — write to a file instead of stdout (streams instance-by-instance to avoid holding the full dump in memory)
- `--failed` — only include instances that failed (filters out passing definitions)
- `[path]` — filter to definitions matching a `.json` file or `.dokkimi/` folder

If a specified definition wasn't part of the last run, a warning is printed to stderr.

### `dokkimi baselines`

Interactive TUI for reviewing and approving pending visual baselines from the last run. When a test definition includes `screenshot` sub-steps with `match: true`, Dokkimi compares captures against baselines stored in `.dokkimi/<project>/baselines/`. New captures (no baseline yet) and failed diffs appear as pending.

**Three-level navigation:** tests → baselines → detail.

- Arrow keys + Enter to navigate
- `y` / `a` — approve a baseline (writes the file immediately)
- `s` — skip a baseline (marks as skipped, no file written)
- `o` / → / Enter — open images in your editor (detail view)
- `A` — approve all baselines at the current level
- ESC / `q` / ← to go back

Approved baselines are written to `.dokkimi/<project>/baselines/`. Also accessible via the `b` key after a run completes.

### `dokkimi config`

Interactive settings editor for Dokkimi. Opens a full-screen menu where you can view and change concurrency limits and telemetry preferences. All changes are written to `~/.dokkimi/config.json`.

Settings include concurrency controls and a telemetry on/off toggle.

After changing settings that affect running services, a menu offers to reboot Dokkimi services immediately or exit with a reminder to run `dokkimi reboot`.

**Output structure:**

```json
{
  "runId": "...",
  "status": "COMPLETED|FAILED",
  "createdAt": "...",
  "completedAt": "...",
  "instances": [
    {
      "name": "definition-name",
      "status": "...",
      "testStatus": "PASSED|FAILED|null",
      "errorMessage": "...|null",
      "definition": { ... },
      "items": [ ... ],
      "testExecutionLogs": [ ... ],
      "assertionResults": [ ... ],
      "httpLogs": [ ... ],
      "databaseLogs": [ ... ],
      "consoleLogs": [ ... ]
    }
  ]
}
```
