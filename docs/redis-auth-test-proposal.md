# Investigation: Redis db-proxy AUTH Handling

## Problem

During Appwrite testing, we observed NOAUTH errors when Appwrite tried to LPUSH to `utopia-queue.queue.v1-functions` through Dokkimi's Redis db-proxy.

**Root cause: Dokkimi bug.** Dokkimi always starts Redis with `--requirepass dokkimi` even when the user's definition doesn't set a password. The default password (`dokkimi`) is applied unconditionally via `config.database.defaultPassword`. Appwrite connects to Redis without AUTH (normal for many apps), and gets NOAUTH because Dokkimi forced a password it never asked for.

**Fix:** Add a `noAuth: true` flag to DATABASE items. When set, credentials are skipped entirely — no default user/password is applied, and the database starts without authentication. This keeps the default behavior consistent across all DB types (default to `dokkimi:dokkimi`) while giving users an explicit opt-out.

Additionally, there were no tests proving the proxy handles AUTH correctly. Added those too.

## What We Know

Code review of the Redis db-proxy confirms:

- **Transparent relay** — the proxy does NOT authenticate on its own upstream connection. It opens a raw TCP socket and forwards bytes.
- **AUTH is forwarded** — when a client sends `AUTH <password>`, the proxy forwards the raw RESP bytes to upstream Redis and relays the response back.
- **Each connection is independent** — each client connection to the proxy gets its own upstream connection. No shared AUTH state.
- **RESP3 supported** — the RESP parser handles all RESP2 and RESP3 types, including HELLO negotiation.
- **No AUTH tests exist** — the existing test suite covers RESP parsing but not end-to-end AUTH behavior.

## How the Proxy Works (Detail)

The proxy is NOT a dumb TCP tunnel — it's RESP-aware:

- Reads each RESP command via `readRESP(reader)` and forwards `val.rawBytes` to upstream
- Classifies AUTH, HELLO, CLIENT as "internal" commands — forwarded but not logged in query logger
- Creates `pendingCommand` entries per command to maintain correct response ordering
- Drains RESP3 push messages (`>`) and attributes (`|`) that arrive asynchronously between command responses
- Supports inline commands (plain text like `PING\r\n`, per protocol.go:184-188)
- The health checker in main.go:49-55 connects directly to upstream Redis (bypasses proxy) using go-redis with credentials — this is a separate path

## Proposed Test

New file: `services/db-proxy/redis/auth_test.go`

Write a pure Go test (no Docker, no real Redis) that:

1. Starts a mock Redis server (TCP listener) implementing just enough RESP to test AUTH:
   - Tracks per-connection auth state
   - Returns `-NOAUTH Authentication required.` for commands before AUTH
   - Returns `+OK` for valid AUTH, `-ERR invalid password` for wrong password
   - Returns `+OK`/`:1` for PING/LPUSH after successful AUTH
2. Starts the proxy pointing at the mock server
3. Tests:
   - **Happy path**: connect → AUTH correct password → PING → succeeds
   - **Wrong password**: connect → AUTH wrong password → error returned
   - **No AUTH**: connect → PING → `-NOAUTH` relayed to client
   - **Concurrent connections**: 10 goroutines each AUTH independently → all succeed
   - **RESP3 HELLO**: connect → HELLO 3 AUTH username password → works
   - **AUTH error propagation**: verify `-ERR` responses from upstream reach client byte-for-byte unchanged
   - **Inline AUTH**: AUTH sent as inline command (plain text, not RESP array) → works

## Expected Outcome

If all tests pass: the proxy correctly relays AUTH. The NOAUTH error during Appwrite testing is Appwrite's fault — some codepath constructs a Redis connection without sending AUTH. Close the issue.

If any test fails: fix the proxy, then retest the Appwrite definitions.

## Implementation

### Auth test (done)

`services/db-proxy/redis/auth_test.go` — ~300 lines, 7 tests, all passing.

### `noAuth` flag (to implement)

New boolean field on DATABASE items: `noAuth: true`. When set, credentials are skipped entirely — no default user/password, no `--requirepass`, no AUTH.

**Definition API:**

```yaml
- type: DATABASE
  name: appwrite-redis
  database: redis
  noAuth: true
```

**Files to change (~40 lines across 5 files):**

1. **shared/definition-validator/constants.ts** — add `'noAuth'` to `VALID_DATABASE_KEYS`
2. **shared/definition-validator/validate-items.ts** — validate `noAuth` is boolean; error if `noAuth: true` is combined with `password`, `user`, or `name` (contradictory)
3. **services/control-tower/src/namespace-lifecycle/deployment-context.types.ts** — add `noAuth?: boolean` to `DefinitionItem`
4. **services/control-tower/src/namespace-lifecycle/builders/database-config.service.ts** — when `noAuth`, pass empty credentials (the conditional logic for each DB type already handles empty password/user correctly)
5. **services/control-tower/src/namespace-lifecycle/docker/docker-database-group.service.ts** — when `noAuth`, pass empty credentials to `buildDbProxyEnvVars`
6. **services/control-tower/src/namespace-lifecycle/builders/configmap-builder.service.ts** — when `noAuth`, skip default credentials in interceptor configmap and db-credentials configmap
7. **apps/vscode/src/schema/dokkimi.schema.json** — add `noAuth` to `DatabaseItem` schema
8. **shared/docs/dokkimi-instructions.md** — document `noAuth`

All 575 CT tests still pass. All 7 Go AUTH tests pass.
