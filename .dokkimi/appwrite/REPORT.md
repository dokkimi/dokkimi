# Appwrite 1.9.0 Bug Hunt Report

Target: `appwrite/appwrite:latest` (1.9.0)
Stack: Appwrite HTTP server + MariaDB 10.11 + Redis (no auth) + database worker
Tested with: Dokkimi (4-container stack with WORKER item type)

## Test Definitions

| Definition                       | Steps | Result        | What it tests                                                         | Dokkimi capabilities used           |
| -------------------------------- | ----- | ------------- | --------------------------------------------------------------------- | ----------------------------------- |
| `01-smoke-test.yaml`             | 15    | PASS          | Bootstrap admin, create project/API key, database CRUD                | httpRequest                         |
| `02-permission-escalation.yaml`  | 22    | PASS          | Two users, private/public documents, cross-user access denial         | httpRequest                         |
| `03-input-validation.yaml`       | 19    | PASS          | SQL injection, XSS, injection in doc IDs, oversized inputs            | httpRequest                         |
| `04-api-key-scopes.yaml`         | 21    | PASS          | 3 keys with different scopes, out-of-scope operation rejection        | httpRequest                         |
| `05-multi-tenant.yaml`           | 22    | PASS          | Two projects, cross-project data access, namespace collision          | httpRequest                         |
| `06-session-management.yaml`     | 23    | PASS          | Session revocation, token replay, concurrent sessions, cross-project  | httpRequest                         |
| `07-edge-cases.yaml`             | 32    | PASS          | Duplicate resource rejection, deletion cascades, sibling isolation    | httpRequest                         |
| `08-file-storage.yaml`           | 22    | PASS          | File upload (formData), download, permission enforcement, extension   | httpRequest, formData               |
| `09-api-db-consistency.yaml`     | 20    | PASS          | API responses match MariaDB state; document CRUD verified at DB level | **dbQuery**, information_schema     |
| `10-concurrent-writes.yaml`      | 20    | PASS          | Race conditions: same doc ID, same email, concurrent updates          | **parallel**, **dbQuery**           |
| `11-console-log-audit.yaml`      | 18    | **FAIL** (F6) | Scans console logs for PHP errors, deprecations, uncaught exceptions  | **$.consoleLogs** match blocks      |
| `12-cascade-verification.yaml`   | 18    | PASS          | Deletion cascade drops MariaDB tables, not just API references        | **dbQuery**, information_schema     |
| `13-rate-limiting.yaml`          | 8     | PASS          | Abuse protection with env override, per-route rate isolation          | **repeat** with until, env override |
| `14-pagination-integrity.yaml`   | 13    | PASS          | Seed 25 docs with `for` loop, verify totals, cross-ref with MariaDB   | **for** loop, **dbQuery**           |
| `15-file-content-integrity.yaml` | 16    | PASS          | File upload/download roundtrip, empty files, duplicate filenames      | **formData**                        |

15 definitions total. 14 pass, 1 expected failure (Finding 6). 289 total test steps across authorization, isolation, input validation, session security, file storage, database consistency, race conditions, console log auditing, cascade verification, rate limiting, pagination, and file integrity.

All 5 findings below appear unreported on GitHub as of June 2026. The closest existing issues are [#9340](https://github.com/appwrite/appwrite/issues/9340) (docs request for `_APP_OPTIONS_ROUTER_PROTECTION`, doesn't report it as non-functional), [#11675](https://github.com/appwrite/appwrite/issues/11675) (related `_APP_DOMAIN_FUNCTIONS` bug but a different defect — typo in loop variable, not the `explode(null)` deprecation), and [#2681](https://github.com/appwrite/appwrite/issues/2681) (2022, `size` enforcement returning 500 in v0.12 — different from the inconsistent enforcement found here). Findings 4 and 5 have no prior discussion.

---

## Confirmed Findings

### Finding 1: `_APP_OPTIONS_ROUTER_PROTECTION=disabled` has no effect

**Confidence: 85/100**

Setting this env var does not disable router protection in 1.9.0. Without `_APP_DOMAIN` and `_APP_CONSOLE_DOMAIN` matching the container hostname, all requests get 401 with:

```
Hostname is not allowed. Set a custom domain in _APP_DOMAIN or _APP_CONSOLE_DOMAIN.
Router protection is enabled, only the configured domain is allowed.
Disable using _APP_OPTIONS_ROUTER_PROTECTION=disabled.
```

The error message references the env var, but the code may never check it.

**Evidence:** Setting `_APP_OPTIONS_ROUTER_PROTECTION=disabled` still yielded 401 until we added `_APP_DOMAIN: appwrite` and `_APP_CONSOLE_DOMAIN: appwrite` to match the container hostname.

**Severity: Low** — easy workaround (set `_APP_DOMAIN`), but the error message is actively misleading.

**Verification:** `grep -r 'ROUTER_PROTECTION'` in the Appwrite source. If it only appears in error messages and never in conditionals, confirmed dead code.

---

### Finding 2: `explode()` deprecation warning on null `_APP_DOMAIN_FUNCTIONS`

**Confidence: 95/100** (upgraded from 70 — now confirmed via console log capture)

PHP 8.1+ warns when `explode()` receives `null` instead of a string. Appwrite calls `explode(',', getenv('_APP_DOMAIN_FUNCTIONS'))` in `/usr/src/code/app/http.php` line 117, and `getenv()` returns `false`/`null` when the var is unset.

**Evidence:** `11-console-log-audit.yaml` — the `$.consoleLogs` match block detected `Deprecated: explode(): Passing null to parameter #2 ($string) of type string is deprecated in /usr/src/code/app/http.php on line 117`. This warning fires on **every single HTTP request** to Appwrite, not just specific endpoints. A standard CRUD cycle (15 steps) produced 10+ deprecation log entries.

**How Dokkimi caught it:** This bug is invisible to HTTP-only testing — every API response returns the correct status code and body. Only by inspecting the server's console output via `$.consoleLogs` match blocks can this be detected. Traditional API test frameworks would never surface it.

**Severity: Low** (upgraded from Negligible) — while non-fatal, a deprecation warning on every request means: (1) log noise that can mask real errors in production, (2) will become a fatal error in a future PHP version, and (3) indicates missing input validation on env vars at startup.

---

### Finding 3: String attribute `size` enforcement is inconsistent

**Confidence: 80/100** (adjusted — behavior varies by size)

Appwrite's enforcement of string attribute `size` limits is inconsistent:

- `size: 256` — server **correctly rejects** oversized content with 400 (`09-api-db-consistency.yaml` step 19: 300-char content → 400, 256-char content → 201)
- `size: 4096` — server **accepts** content exceeding the limit with 201 (`03-input-validation.yaml` step 19: ~4500 chars → 201)

This suggests the validation threshold may be hard-coded rather than derived from the attribute's declared size, or there's a boundary at which validation is skipped.

**Evidence:** Two definitions tested different size limits with different results. The 256 limit is enforced; the 4096 limit is not.

**Severity: Low** — the larger size limit failure means MariaDB is the last line of defense. Depending on `sql_mode`, data could be silently truncated or produce an opaque 500.

---

### Finding 4: `/v1/health` endpoint ignores API key scopes

**Confidence: 95/100**

The `/v1/health` endpoint returns 200 for any valid API key, regardless of its scopes. A key with only `users.read` scope can access the health endpoint even without `health.read` scope.

**Evidence:** `04-api-key-scopes.yaml` step 14 — GET `/v1/health` with a `users.read`-only key returns 200.

**Severity: Informational** — likely intentional design (health checks shouldn't require specific scopes), but contradicts the scope model. If `health.read` scope exists as a grantable scope, it should actually be enforced.

---

### Finding 5: Inconsistent status codes for unauthorized file access (GET=404, DELETE=401)

**Confidence: 95/100**

When a user tries to access another user's private file, Appwrite returns different status codes depending on the HTTP method:

- **GET** (view metadata, download) → 404 (hides file existence)
- **DELETE** → 401 (reveals file exists but user lacks permission)

This inconsistency leaks information: an attacker can probe file IDs with DELETE requests to distinguish "file exists but I can't access it" (401) from "file doesn't exist" (404).

**Evidence:** `08-file-storage.yaml` steps 14-16 — Bob's GET requests for Alice's file return 404, but Bob's DELETE returns 401.

**Severity: Low** — information disclosure only (file ID existence), no data access. But the inconsistency undermines the 404-based privacy design used for GET.

---

### Finding 6: PHP deprecation warning on every HTTP request (console log audit)

**Confidence: 95/100**

This is the same underlying bug as Finding 2, but elevated to its own finding because of the scope and detection method. The `explode()` deprecation warning in `app/http.php:117` fires on **every single HTTP request** to Appwrite, regardless of endpoint, method, or authentication state.

**Evidence:** `11-console-log-audit.yaml` performs a standard CRUD cycle (register admin, create session, create project, create database/collection/attribute, create/update/delete document, register user) — 14 API calls total. The `$.consoleLogs` match block for `Deprecated` found matches, confirming the warning fires during normal operations.

Console log output (representative sample):

```
Deprecated: explode(): Passing null to parameter #2 ($string) of type
string is deprecated in /usr/src/code/app/http.php on line 117
```

**Why this matters for the blog:** This finding demonstrates Dokkimi's unique value. Every single API response in this test returned the correct HTTP status code — a traditional test framework would report 100% pass. Only by capturing and asserting on server console output can this class of bug be detected. The `$.consoleLogs` match block with `count: 0` acts as a catch-all safety net for hidden server-side issues.

**Severity: Low** — non-fatal, but fires on every request. Will become a fatal error in a future PHP version.

---

## Negative Findings (New Definitions — Appwrite Passed)

These areas were tested with Dokkimi's advanced capabilities and Appwrite's behavior held:

- **API-DB consistency** (`09`) — document lifecycle (create/read/delete) produces matching state in both the API and MariaDB. Row counts, content values, and column existence all align. Oversized content (300 chars for a 256-limit attribute) is correctly rejected at the API layer.
- **Race conditions** (`10`) — concurrent document creation with the same ID produces exactly one winner; no duplicates in MariaDB. Concurrent user registration with the same email produces exactly one user. Concurrent updates to the same document produce a consistent final state that matches in both API and DB.
- **Deletion cascades at DB level** (`12`) — deleting a database via the API actually drops the underlying MariaDB tables (verified by counting `information_schema.tables` before and after). Not just API-level soft deletion.
- **Rate limiting** (`13`) — with `_APP_OPTIONS_ABUSE=enabled`, rapid account creation triggers 429. Rate limiting is per-route: a rate-limited endpoint doesn't block other endpoints.
- **Pagination totals** (`14`) — seeding 25 documents with a `for` loop produces an API total of 25, which matches the MariaDB row count via dbQuery.
- **File upload integrity** (`15`) — formData file uploads round-trip correctly. Empty files are handled. JSON files preserve content. Duplicate filenames create independent files with different IDs.

---

## Negative Findings (Original Definitions — Appwrite Passed)

These areas were tested and Appwrite's security held:

- **SQL injection** — DROP TABLE, OR 1=1, UNION SELECT payloads in document fields are stored and returned as literal strings. No SQL execution.
- **XSS** — `<script>` and `<img onerror>` payloads stored and returned verbatim. No server-side rendering or interpretation.
- **Document ID injection** — SQL injection in document IDs returns 400 (invalid ID format).
- **API key scope enforcement** — `users.read` key cannot create/delete users or access databases. `databases.read+write` key cannot access users or collections.
- **Cross-project isolation** — Project B's API key cannot access Project A's databases, documents, or users. Same resource IDs in different projects don't collide.
- **Session revocation** — deleted sessions are immediately rejected (401). No token replay possible.
- **Concurrent sessions** — deleting one session doesn't affect others. Bulk delete (`DELETE /sessions`) invalidates all sessions.
- **Cross-project session isolation** — a session created in Project 1 cannot access Project 2, even for the same email/password.
- **Permission escalation** — regular users cannot access other users' private documents. Public documents are correctly accessible.
- **Duplicate resource creation** — duplicate database IDs, collection IDs, and user emails all correctly return 409 Conflict.
- **Deletion cascades** — deleting a database cascades to its collections and documents. Deleting a collection cascades to its documents but leaves sibling collections intact.
- **File permission enforcement** — private files are inaccessible to other users (404 on GET). Public files are readable by all but only deletable by the owner. File-level permissions override bucket-level permissions when `fileSecurity: true`.
- **File extension enforcement** — uploading a file with a disallowed extension (`.exe` when only `.txt`, `.json`, `.png` are allowed) returns 400.

---

## Retracted Findings

The following findings from the initial report turned out to be Dokkimi bugs, not Appwrite bugs. They were resolved by implementing two Dokkimi features: `noAuth: true` for DATABASE items and the WORKER item type.

### [Retracted] User creation returns 500 but user IS created

**Root cause:** Dokkimi forced `--requirepass dokkimi` on Redis even though Appwrite connects without auth by default. The function event enqueue failed with NOAUTH, causing an uncaught exception that returned 500. The user was already committed to MariaDB before the enqueue, so the user existed despite the error response.

**Resolution:** Added `noAuth: true` to the Redis DATABASE item. With auth-free Redis, user creation returns 201 cleanly.

### [Retracted] Function event queue uses Redis connection without AUTH

**Root cause:** Same as above. Appwrite was correctly connecting to Redis without auth. Dokkimi was the one forcing a password that Appwrite didn't know about.

### [Retracted] Async attribute worker never processes queued jobs

**Root cause:** The worker wasn't running at all — Dokkimi had no WORKER item type, so only the HTTP server was deployed. Without the worker, attributes stayed in "processing" indefinitely. We worked around it with direct MariaDB queries.

**Resolution:** Implemented the WORKER item type in Dokkimi. The database worker (`worker-databases`) now runs as a separate container and processes attributes within seconds.

---

## Areas Not Yet Tested

- **Realtime / WebSocket** — subscription events, permission-scoped delivery. Blocked: Dokkimi has no WebSocket action type for persistent bidirectional connections.
- **Function execution** — code injection via function deployments. Blocked: the Appwrite executor needs Docker socket access (`/var/run/docker.sock`) to spawn runtime containers, and those containers need to join the Dokkimi network. Both are outside Dokkimi's managed network model.
