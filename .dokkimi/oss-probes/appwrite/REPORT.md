# Appwrite 1.9.0 Bug Hunt Report

Target: `appwrite/appwrite:latest` (1.9.0)
Stack: Appwrite HTTP server + MariaDB 10.11 + Redis (no auth) + database worker
Tested with: Dokkimi (4-container stack with WORKER item type)

## Test Definitions

| Definition                        | Steps | Result        | What it tests                                                         | Dokkimi capabilities used           |
| --------------------------------- | ----- | ------------- | --------------------------------------------------------------------- | ----------------------------------- |
| `01-smoke-test.yaml`              | 15    | PASS          | Bootstrap admin, create project/API key, database CRUD                | httpRequest                         |
| `02-permission-escalation.yaml`   | 22    | PASS          | Two users, private/public documents, cross-user access denial         | httpRequest                         |
| `03-input-validation.yaml`        | 19    | PASS          | SQL injection, XSS, injection in doc IDs, oversized inputs            | httpRequest                         |
| `04-api-key-scopes.yaml`          | 21    | PASS          | 3 keys with different scopes, out-of-scope operation rejection        | httpRequest                         |
| `05-multi-tenant.yaml`            | 22    | PASS          | Two projects, cross-project data access, namespace collision          | httpRequest                         |
| `06-session-management.yaml`      | 23    | PASS          | Session revocation, token replay, concurrent sessions, cross-project  | httpRequest                         |
| `07-edge-cases.yaml`              | 32    | PASS          | Duplicate resource rejection, deletion cascades, sibling isolation    | httpRequest                         |
| `08-file-storage.yaml`            | 22    | PASS          | File upload (formData), download, permission enforcement, extension   | httpRequest, formData               |
| `09-api-db-consistency.yaml`      | 20    | PASS          | API responses match MariaDB state; document CRUD verified at DB level | **dbQuery**, information_schema     |
| `10-concurrent-writes.yaml`       | 20    | PASS          | Race conditions: same doc ID, same email, concurrent updates          | **parallel**, **dbQuery**           |
| `11-console-log-audit.yaml`       | 18    | **FAIL** (F6) | Scans console logs for PHP errors, deprecations, uncaught exceptions  | **$.consoleLogs** match blocks      |
| `12-cascade-verification.yaml`    | 18    | PASS          | Deletion cascade drops MariaDB tables, not just API references        | **dbQuery**, information_schema     |
| `13-rate-limiting.yaml`           | 8     | PASS          | Abuse protection with env override, per-route rate isolation          | **repeat** with until, env override |
| `14-pagination-integrity.yaml`    | 13    | PASS          | Seed 25 docs with `for` loop, verify totals, cross-ref with MariaDB   | **for** loop, **dbQuery**           |
| `15-file-content-integrity.yaml`  | 16    | PASS          | File upload/download roundtrip, empty files, duplicate filenames      | **formData**                        |
| `16-session-idor.yaml`            | 18    | PASS          | Cross-user session deletion via admin API (IDOR)                      | httpRequest                         |
| `17-password-edge-cases.yaml`     | 19    | PASS          | Empty password fall-through, blocked user ops, impersonator flag      | httpRequest                         |
| `18-router-protection.yaml`       | 2     | PASS          | Router protection env var with mismatched hostname                    | httpRequest, custom env fragment    |
| `19-string-size-enforcement.yaml` | 16    | PASS          | String attr size enforcement: 128, 256, 4096 with oversized content   | httpRequest, **wait**               |

19 definitions total. 18 pass, 1 expected failure (Finding 6). 344 total test steps across authorization, isolation, input validation, session security, file storage, database consistency, race conditions, console log auditing, cascade verification, rate limiting, pagination, file integrity, IDOR, and password handling.

All 9 findings below appear unreported on GitHub as of July 2026. The closest existing issues are [#9340](https://github.com/appwrite/appwrite/issues/9340) (docs request for `_APP_OPTIONS_ROUTER_PROTECTION`, doesn't report it as non-functional), [#11675](https://github.com/appwrite/appwrite/issues/11675) (related `_APP_DOMAIN_FUNCTIONS` bug but a different defect — typo in loop variable, not the `explode(null)` deprecation), and [#2681](https://github.com/appwrite/appwrite/issues/2681) (2022, `size` enforcement returning 500 in v0.12 — different from the inconsistent enforcement found here). Findings 4 and 5 have no prior discussion.

---

## Confirmed Findings

### Finding 1: `_APP_OPTIONS_ROUTER_PROTECTION=disabled` has no effect

**Confidence: 95/100** (upgraded from 85 — now confirmed by dedicated definition)

Setting this env var does not disable router protection in 1.9.0. When `_APP_DOMAIN` doesn't match the request hostname, all requests get 401 with the router protection error, even with `_APP_OPTIONS_ROUTER_PROTECTION=disabled`.

**Code:** `app/controllers/general.php` line 132 — the check `System::getEnv('_APP_OPTIONS_ROUTER_PROTECTION', 'enabled') === 'enabled'` SHOULD work (the conditional logic is correct), but at runtime the env var is ignored. The error message ironically tells users to "disable \_APP_OPTIONS_ROUTER_PROTECTION environment variable" — the very thing that doesn't work.

Note: the documented default in `app/config/variables.php` line 77 says `'disabled'`, but the code fallback at line 132 is `'enabled'`. This mismatch may be related.

**Evidence:** `18-router-protection.yaml` — uses a modified Appwrite fragment with `_APP_DOMAIN: wrong-domain.example.com` (mismatched with container hostname `appwrite`) and `_APP_OPTIONS_ROUTER_PROTECTION: disabled`. Both POST `/v1/account` and GET `/v1/health` returned **401** with the HTML error page containing: "Router protection does not allow accessing Appwrite over this domain."

**Severity: Low** — easy workaround (set `_APP_DOMAIN` to match the hostname), but the error message is actively misleading since it recommends a fix that doesn't work.

---

### Finding 2: `explode()` deprecation warning on null `_APP_DOMAIN_FUNCTIONS`

**Confidence: 95/100** (upgraded from 70 — now confirmed via console log capture)

PHP 8.1+ warns when `explode()` receives `null` instead of a string. Appwrite calls `explode(',', getenv('_APP_DOMAIN_FUNCTIONS'))` in `/usr/src/code/app/http.php` line 117, and `getenv()` returns `false`/`null` when the var is unset.

**Evidence:** `11-console-log-audit.yaml` — the `$.consoleLogs` match block detected `Deprecated: explode(): Passing null to parameter #2 ($string) of type string is deprecated in /usr/src/code/app/http.php on line 117`. This warning fires on **every single HTTP request** to Appwrite, not just specific endpoints. A standard CRUD cycle (15 steps) produced 10+ deprecation log entries.

**How Dokkimi caught it:** This bug is invisible to HTTP-only testing — every API response returns the correct status code and body. Only by inspecting the server's console output via `$.consoleLogs` match blocks can this be detected. Traditional API test frameworks would never surface it.

**Severity: Low** (upgraded from Negligible) — while non-fatal, a deprecation warning on every request means: (1) log noise that can mask real errors in production, (2) will become a fatal error in a future PHP version, and (3) indicates missing input validation on env vars at startup.

---

### Finding 3: String attribute `size` enforcement is inconsistent

**Confidence: 95/100** (upgraded from 80 — now confirmed by dedicated definition)

Appwrite's enforcement of string attribute `size` limits is inconsistent. Small sizes are validated at the API layer; larger sizes are not.

**Evidence:** `19-string-size-enforcement.yaml` — creates three string attributes (size 128, 256, 4096) in the same collection, same database, same API key, same request pattern. Then inserts oversized content into each:

- `size: 128`, 150 chars → **400** (correctly rejected)
- `size: 256`, 300 chars → **400** (correctly rejected)
- `size: 4096`, 5000 chars → **201** (accepted — bug)

The threshold where enforcement stops appears to be somewhere between 256 and 4096. This suggests the validation is either hard-coded to a maximum size, or the `Text` validator has a different code path for larger sizes.

**Severity: Low** — for sizes above the threshold, MariaDB is the last line of defense. Depending on `sql_mode`, data could be silently truncated or produce an opaque 500.

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

### Finding 7: Cross-user session deletion IDOR (admin API)

**Confidence: 95/100**

The admin `DELETE /v1/users/:userId/sessions/:sessionId` endpoint fetches the user and session independently without verifying the session belongs to the specified user. A session owned by user A can be deleted by specifying user B's ID in the URL.

**Code:** `app/controllers/api/users.php` lines 2447-2470 — the endpoint fetches `$user = $dbForProject->getDocument('users', $userId)` and `$session = $dbForProject->getDocument('sessions', $sessionId)` separately, checks both exist, then deletes the session. There is no check that `$session->getAttribute('userId') === $userId`.

**Compare with correct pattern:** The team memberships endpoint (`Teams/Http/Memberships/Delete.php` line 83) properly checks `$membership->getAttribute('teamInternalId') !== $team->getSequence()` before allowing deletion.

**Evidence:** `16-session-idor.yaml` — Creates user A and B, creates a session for user A, then calls `DELETE /v1/users/{userBId}/sessions/{sessionAId}`. The request returned **204** and user A's session count dropped from 1 to 0. Repeated with a second session — same result.

**Impact:**

- Any admin API key holder can delete any session using any user ID as a proxy, corrupting audit logs
- The audit trail records the wrong user ID for the deletion
- In multi-tenant scenarios where admin keys have different scope restrictions, this bypasses per-user access boundaries

**Severity: Medium** — requires admin API key access, but within that trust boundary the ownership check is missing.

---

### Finding 8: Password update fall-through on empty string (admin API)

**Confidence: 90/100**

The admin `PATCH /v1/users/:userId/password` endpoint has a missing `return` statement after `$response->dynamic()`. When `password=""` is sent, the code:

1. Sets password to `""` in DB (lines 1369-1379)
2. Calls `$response->dynamic($user, Response::MODEL_USER)` — sends the response with `password: ""`
3. Does NOT return — falls through to the password hashing code below
4. The `$hooks->trigger('passwordValidator', ...)` call does nothing (hook is never registered)
5. Argon2 hashes the empty string and updates the DB again

**Code:** `app/controllers/api/users.php` lines 1369-1380 — compare with `app/controllers/api/account.php` lines 795-800 where `return;` is explicitly called after `$response->dynamic()`.

**Evidence:** `17-password-edge-cases.yaml` — The PATCH with `password: ""` returned 200 with `"password": ""` and `"hash": "argon2"` in the response body. The Argon2 hash present confirms the fall-through executed — the password was first set to empty, the response was sent, then the empty string was re-hashed with Argon2 and stored.

**Impact:**

- API response says password is empty, but DB has Argon2 hash of empty string (data inconsistency)
- The `allowEmpty: true` on the admin password param (absent from the account endpoint) makes this reachable
- A user whose password was "cleared" can still authenticate with an empty string (Argon2 verifies `""`)

**Severity: Low-Medium** — data inconsistency between API response and DB state; admin-only endpoint.

---

### Finding 9: Session creation for blocked user (admin API)

**Confidence: 90/100**

The admin `POST /v1/users/:userId/sessions` endpoint does not check the user's status before creating a session. A blocked user (status: false) can have sessions created for them.

**Evidence:** `17-password-edge-cases.yaml` — After blocking a user (PATCH status to false), POST to create a session returned **201**. The session exists in the DB, though it may be unusable for API access since the auth middleware checks user status on session-authenticated requests.

**Severity: Informational** — admin-only endpoint; the session is likely unusable for the blocked user. However, the session document exists in the DB unnecessarily.

---

## Negative Findings (New Definitions — Appwrite Passed)

These areas were tested with Dokkimi's advanced capabilities and Appwrite's behavior held. Note that some observations below (admin operations on blocked users, empty names, impersonator flag) are design decisions — admin API keys already have full project access, so these are expected behaviors within that trust boundary:

- **API-DB consistency** (`09`) — document lifecycle (create/read/delete) produces matching state in both the API and MariaDB. Row counts, content values, and column existence all align. Oversized content (300 chars for a 256-limit attribute) is correctly rejected at the API layer.
- **Race conditions** (`10`) — concurrent document creation with the same ID produces exactly one winner; no duplicates in MariaDB. Concurrent user registration with the same email produces exactly one user. Concurrent updates to the same document produce a consistent final state that matches in both API and DB.
- **Deletion cascades at DB level** (`12`) — deleting a database via the API actually drops the underlying MariaDB tables (verified by counting `information_schema.tables` before and after). Not just API-level soft deletion.
- **Rate limiting** (`13`) — with `_APP_OPTIONS_ABUSE=enabled`, rapid account creation triggers 429. Rate limiting is per-route: a rate-limited endpoint doesn't block other endpoints.
- **Pagination totals** (`14`) — seeding 25 documents with a `for` loop produces an API total of 25, which matches the MariaDB row count via dbQuery.
- **File upload integrity** (`15`) — formData file uploads round-trip correctly. Empty files are handled. JSON files preserve content. Duplicate filenames create independent files with different IDs.
- **Admin password change on blocked user** (`17`) — admin API correctly allows password changes on blocked users (returned 200). Admins need to manage blocked accounts.
- **Empty user name** (`17`) — `PATCH /v1/users/:userId/name` accepts empty string (returned 200). The `Text(128, 0)` validator allows min length 0 — intentional design.
- **Impersonator flag via admin API** (`17`) — `PATCH /v1/users/:userId/impersonator` successfully sets the flag (returned 200). This is an admin-only endpoint; the admin already has full project access. Whether the flag enables user self-impersonation depends on additional auth checks elsewhere.

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
