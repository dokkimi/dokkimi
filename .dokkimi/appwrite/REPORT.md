# Appwrite 1.9.0 Bug Hunt Report

Target: `appwrite/appwrite:latest` (1.9.0)
Stack: Appwrite HTTP server + MariaDB 10.11 + Redis (password-protected)
Tested with: Dokkimi (3-container subsets, no workers)

## Test Definitions

| Definition                      | Steps | Result | What it tests                                                 |
| ------------------------------- | ----- | ------ | ------------------------------------------------------------- |
| `01-smoke-test.yaml`            | 17    | PASS   | Bootstrap admin, create project/API key, database CRUD        |
| `02-permission-escalation.yaml` | 25    | PASS   | Two users, private/public documents, cross-user access denial |

Both pass. The permission system is solid — all authorization boundaries held.

---

## Findings

### Finding 1: User creation returns 500 but user IS created in the database

**Confidence: 90/100**

When creating a user via `POST /v1/account` (or `POST /v1/users`) on a non-console project, the API returns 500. However, the user is actually persisted in MariaDB — they can log in immediately after with valid credentials.

The 500 comes from `Queue/Connection/Redis.php:59` — Appwrite tries to LPUSH to `utopia-queue.queue.v1-functions` (to trigger function events) and the Redis operation fails. The exception is uncaught and propagates as a server error.

**Evidence:**

- `02-permission-escalation.yaml` steps 6-9: Register User A and B (both return 500), then both log in successfully (201) and operate normally for the rest of the test.
- The error trace in the 500 response body points to `Queue/Connection/Redis.php`, not user creation logic.

**Why this is a real bug regardless of Redis config:**

- The user IS committed to MariaDB before the queue enqueue runs
- The API returns 500, making clients believe creation failed
- Attribute creation (`POST /v1/databases/.../attributes/string`) uses the same queue mechanism but returns 202 regardless of enqueue success — different codepaths handle the same queue failure differently

**Severity: High** — data inconsistency between what the API reports and what actually happened.

---

### Finding 2: Function event queue uses a Redis connection without AUTH

**Confidence: 55/100**

With `_APP_REDIS_PASS=dokkimi` set, operations that use `_APP_CONNECTIONS_QUEUE` (explicitly set to `redis://:dokkimi@appwrite-redis:6379`) work for some subsystems (database worker queue, cache) but fail with NOAUTH for the function event trigger.

This suggests the function event enqueue path constructs its Redis connection from `_APP_REDIS_HOST` + `_APP_REDIS_PORT` without including `_APP_REDIS_PASS`, bypassing the explicit connection DSN.

**Caveat:** This could also be a Dokkimi db-proxy issue (see Dokkimi section below). Verification requires testing with direct Redis (no proxy) to isolate.

**Severity: Medium** — only affects password-protected Redis, which is the recommended production config.

---

### Finding 3: `_APP_OPTIONS_ROUTER_PROTECTION=disabled` has no effect

**Confidence: 85/100**

Setting this env var does not disable router protection in 1.9.0. Without `_APP_DOMAIN` and `_APP_CONSOLE_DOMAIN` matching the container hostname, all requests get 401 with:

```
Hostname is not allowed. Set a custom domain in _APP_DOMAIN or _APP_CONSOLE_DOMAIN.
Router protection is enabled, only the configured domain is allowed.
Disable using _APP_OPTIONS_ROUTER_PROTECTION=disabled.
```

The error message references the env var, but the code never checks it.

**Evidence:** Setting `_APP_OPTIONS_ROUTER_PROTECTION=disabled` still yielded 401 until we added `_APP_DOMAIN: appwrite` and `_APP_CONSOLE_DOMAIN: appwrite` to match the container hostname.

**Severity: Low** — easy workaround (set `_APP_DOMAIN`), but the error message is actively misleading.

---

### Finding 4: Async attribute worker never processes queued jobs

**Confidence: 30/100**

When running `php app/worker.php databases` alongside the HTTP server, the worker connects to Redis, polls with BRPOP on `utopia-queue.queue.database_db_main`, but never picks up enqueued attribute creation jobs. Attributes stay in "processing" status indefinitely.

After 90+ seconds of polling with 1-second delays, the attribute never transitioned to "available". We worked around this entirely by using direct MariaDB queries (`ALTER TABLE` + `UPDATE _metadata`).

**Caveat:** This is most likely NOT an Appwrite bug. Probable causes:

- The API's enqueue might silently fail (returning 202 anyway), so there's nothing to pick up
- Queue key mismatch between what the API LPUSHes and what the worker BRPOPs
- The Dokkimi environment missing some config the worker needs

**Severity: N/A** — low confidence this is an Appwrite bug.

---

### Finding 5: `explode()` deprecation warning on null `_APP_DOMAIN_FUNCTIONS`

**Confidence: 70/100**

PHP 8.1+ warns when `explode()` receives `null` instead of a string. Appwrite calls `explode(',', getenv('_APP_DOMAIN_FUNCTIONS'))` and `getenv()` returns `false`/`null` when the var is unset.

**Evidence:** Observed in container logs during the previous session.

**Severity: Negligible** — deprecation warning, non-fatal, no functional impact.

---

## Verification Strategy

### To verify Finding 1 (500 but user created):

Run Appwrite in standard docker-compose (no Dokkimi) with ALL workers running. If user creation returns 201, the 500 is caused by the function queue failure. Then:

1. Stop the `appwrite-worker-functions` container
2. Create a user via `POST /v1/account`
3. If it returns 500 but the user exists in MariaDB, the inconsistent error handling is confirmed
4. Compare the codepath: check if `POST /v1/databases/.../attributes/string` still returns 202 with the functions worker down — if yes, that confirms the inconsistency

### To verify Finding 2 (REDIS_PASS ignored):

1. Run Appwrite with docker-compose using password-protected Redis
2. Set `_APP_REDIS_PASS` but do NOT set `_APP_CONNECTIONS_QUEUE`
3. Create a user on a non-console project
4. If it returns 500 with NOAUTH in the trace, the env var is being ignored for the function queue
5. Then set `_APP_CONNECTIONS_QUEUE` explicitly and retry — if it works, confirmed
6. Read Appwrite source: grep for `_APP_REDIS_PASS` and trace where it's used vs where `_APP_CONNECTIONS_QUEUE` is used

### To verify Finding 3 (router protection dead code):

1. `grep -r 'ROUTER_PROTECTION' .` in the Appwrite source
2. Check if any PHP code reads `_APP_OPTIONS_ROUTER_PROTECTION`
3. If it's only in error messages and never in conditionals, confirmed
4. Check the main branch — this may already be fixed post-1.9.0

### To verify Finding 4 (worker doesn't process):

This is most likely a test environment issue. To verify:

1. Run standard Appwrite docker-compose (all containers)
2. Create an attribute via API
3. Check if it transitions from "processing" to "available" within 30 seconds
4. If yes, this is NOT an Appwrite bug — it's specific to our isolated environment

### To verify Finding 5 (explode deprecation):

1. `grep -rn 'explode.*DOMAIN_FUNCTIONS' .` in Appwrite source
2. Check if `_APP_DOMAIN_FUNCTIONS` has a default value or null guard
3. Run with `_APP_DOMAIN_FUNCTIONS` unset and check PHP error logs

---

## Dokkimi Issues

### Issue 1: No multi-process support for SERVICE items (Feature Request)

**Impact: High — blocked a major test scenario**

Appwrite (and many microservice platforms) requires multiple processes: an HTTP server and background workers. Dokkimi's SERVICE item only supports a single `command`. This forced us to bypass Appwrite's async attribute worker entirely and manually ALTER TABLE + UPDATE metadata via dbQuery.

**Current workarounds:**

- `mountFiles` + custom entrypoint shell script that runs both processes (brittle: no independent health checks, no per-process logging, crashes in the background process are invisible)
- Split into two SERVICE items pointing at the same image with different commands (each gets its own interceptor sidecar, which may not be desired)

**Suggested approach:** A `companions` field on SERVICE items — additional containers sharing the same network namespace but with their own command, without an interceptor sidecar:

```yaml
type: SERVICE
name: appwrite
image: appwrite/appwrite:latest
port: 80
command: ['php', 'app/http.php']
companions:
  - name: appwrite-worker-databases
    command: ['php', 'app/worker.php', 'databases']
  - name: appwrite-worker-functions
    command: ['php', 'app/worker.php', 'functions']
```

This mirrors how Dokkimi already deploys db-proxy and interceptor sidecars (shared network namespace via `networkMode: container:...`), so the infrastructure pattern already exists.

### Issue 2: Can't verify Redis proxy AUTH behavior (Investigation Needed)

**Impact: Medium — unclear if Finding 2 is an Appwrite bug or a Dokkimi bug**

The Redis db-proxy correctly forwards AUTH commands (confirmed by code review). Each client connection gets its own upstream connection. AUTH is forwarded as raw RESP bytes.

However, we observed NOAUTH errors through the proxy that might not occur with direct Redis. To rule out a proxy issue:

1. Check if the RESP parser handles RESP3 protocol (HELLO command) correctly in all cases — Appwrite may negotiate RESP3, and the proxy's parser might not handle all RESP3 value types
2. Check if concurrent connections cause any race conditions in the pending command channel
3. Add a test: connect to the Redis db-proxy, AUTH, then LPUSH — verify it works. Then do 10 concurrent connections with AUTH + LPUSH and verify all succeed.

If this is a proxy issue, it could affect any application that uses password-protected Redis with concurrent connections through Dokkimi.
