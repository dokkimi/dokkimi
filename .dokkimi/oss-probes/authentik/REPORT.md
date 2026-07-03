# Authentik 2026.5.3 Bug Hunt Report

Target: `ghcr.io/goauthentik/server:2026.5.3`
Stack: Authentik HTTP server + worker + PostgreSQL 16
Tested with: Dokkimi (3-container stack with WORKER item type)
Date: 2026-06-28 (initial), 2026-07-02 (expanded)

## Test Definitions

| Definition                             | Steps | Result | What it tests                                                          | Dokkimi capabilities used                    |
| -------------------------------------- | ----- | ------ | ---------------------------------------------------------------------- | -------------------------------------------- |
| `01-smoke-test.yaml`                   | 11    | PASS   | Bootstrap API, user CRUD, token management, group membership           | httpRequest                                  |
| `02-permission-escalation.yaml`        | 14    | PASS   | Non-admin user blocked from admin endpoints, cross-user token reuse    | httpRequest                                  |
| `03-oauth2-flows.yaml`                 | 18    | PASS   | OAuth2 provider setup, client_credentials grant, introspection, revoke | httpRequest, raw body strings                |
| `04-token-management.yaml`             | ~15   | PASS   | Token lifecycle, expiry, multiple tokens per user                      | httpRequest                                  |
| `05-input-validation.yaml`             | ~15   | PASS   | SQL injection, XSS, oversized payloads in usernames and fields         | httpRequest                                  |
| `06-race-conditions.yaml`              | 17    | PASS   | Concurrent duplicate user creation, simultaneous group membership      | **parallel**, traffic match assertions       |
| `07-permission-cache.yaml`             | 16    | PASS   | PATCH is_superuser silent ignore **(F1)**, group superuser revocation  | httpRequest                                  |
| `08-cascade-verification.yaml`         | 15    | PASS   | User deletion cascades to tokens, group membership cleanup             | **parallel**, httpRequest                    |
| `09-console-log-audit.yaml`            | 11    | PASS   | Passwords/tokens never leak to console logs or traffic response bodies | **$.consoleLogs** match, **$.traffic** match |
| `10-api-consistency.yaml`              | 24    | PASS   | Partial PATCH preserves fields, password never in API, deactivation    | **$.traffic** match, httpRequest             |
| `11-api-error-handling.yaml`           | 14    | PASS   | Unhandled exceptions, token key validation, service account usernames  | httpRequest                                  |
| `12-privilege-escalation-groups.yaml`  | 19    | PASS   | Superuser group add, user type changes, is_superuser manipulation      | httpRequest                                  |
| `13-deactivation-token-lifecycle.yaml` | 21    | PASS   | Deactivated user tokens, token rebinding, intent changes, passwords    | httpRequest                                  |

13 definitions total. All pass. 210 total test steps across authentication, authorization, OAuth2, race conditions, permission management, cascade behavior, console log auditing, API consistency, error handling, privilege escalation, and token lifecycle.

---

## Confirmed Findings

### Finding 1: PATCH `is_superuser` silently ignored — API returns 200 but field is not applied

**Confidence: 95/100**

Sending `PATCH /api/v3/core/users/{id}/` with `{"is_superuser": true}` returns HTTP 200 (success), but the response body shows `"is_superuser": false`. The API accepts the field, returns a success status code, and silently drops the change.

**Root cause:** `is_superuser` is a `SerializerMethodField` (read-only computed property) in `UserSerializer`, but since DRF silently ignores unknown/read-only fields in PATCH requests, it returns 200 instead of 400.

**Evidence:** `07-permission-cache.yaml` test 1 — Create user → PATCH with `is_superuser: true` → 200 → GET → `is_superuser` still `false`.

**Severity: Medium** — the API gives false confirmation of a privilege change. An admin automation relying on this endpoint would silently fail.

---

### Finding 2: Events `top_per_user` endpoint crashes on non-numeric `top_n` (500)

**Confidence: 95/100**

`GET /api/v3/events/events/top_per_user/?top_n=abc` returns HTTP 500. The code at `events/api/events.py:244` does `top_n = int(request.query_params.get("top_n", "15"))` without a try/except, so any non-numeric value causes an unhandled `ValueError` → server error.

**Evidence:** `11-api-error-handling.yaml` step 2 — `top_n=abc` → **500**.

**Severity: Low** — authenticated-only endpoint, but any authenticated user can trigger a server crash.

---

### Finding 3: Events `top_per_user` crashes on negative `top_n` (500)

**Confidence: 95/100**

`GET /api/v3/events/events/top_per_user/?top_n=-5` returns HTTP 500. While `int("-5")` parses fine, Django's QuerySet does not support negative slicing — `queryset[:-5]` raises `AssertionError("Negative indexing is not supported.")`.

**Evidence:** `11-api-error-handling.yaml` step 3 — `top_n=-5` → **500**.

**Severity: Low** — same as F2: authenticated user can trigger server crash.

---

### Finding 4: Token `set_key` accepts single-character keys

**Confidence: 95/100**

`POST /api/v3/core/tokens/{identifier}/set_key/` with `{"key": "a"}` returns 204 (success). The endpoint at `tokens.py` checks `if not key: return 400` but has no minimum length validation. A single-character token key is trivially guessable (36 possibilities for alphanumeric).

The empty string is correctly rejected with 400.

**Evidence:** `11-api-error-handling.yaml` step 6 — `key: "a"` → **204** (accepted). Step 7 — `key: ""` → **400** (correctly rejected).

**Severity: Medium** — an admin setting a short key creates a token that is practically brute-forceable. API tokens are the primary authentication mechanism for automated access.

---

### Finding 5: Service account creation accepts special characters in username

**Confidence: 95/100**

`POST /api/v3/core/users/service_account/` accepts names containing spaces, HTML tags, and path traversal sequences. The endpoint uses `username = body.validated_data["name"]` and creates the user with `User.objects.create(username=username, ...)`. Since Django's `create()` doesn't call `full_clean()`, the `UnicodeUsernameValidator` on the User model is bypassed.

| Input                         | Response |
| ----------------------------- | -------- |
| `"service with spaces"`       | 200      |
| `"<script>alert(1)</script>"` | 200      |
| `"../../../etc/passwd"`       | 200      |

**Evidence:** `11-api-error-handling.yaml` steps 8-10 — all three return **200** with the verbatim username stored.

**Severity: Medium** — XSS in usernames could be rendered in admin UIs. Path-traversal strings in usernames could confuse LDAP or file-based integrations.

---

### Finding 6: Token with past expiry date accepted

**Confidence: 90/100**

`POST /api/v3/core/tokens/` with `intent: "app_password"` and `expires: "2020-01-01T00:00:00Z"` returns 201 (created). The `TokenSerializer.validate` method checks that `expires` doesn't exceed the maximum lifetime but does not check if `expires` is in the past.

The token is immediately expired at creation time. While the `ExpiringManager` default queryset filters out expired tokens, `TokenViewSet` explicitly uses `Token.objects.including_expired()`, so the token remains visible in the API.

**Evidence:** `11-api-error-handling.yaml` step 12 — `expires: "2020-01-01T00:00:00Z"` → **201**.

**Severity: Low** — no direct security impact, but creates misleading state. An automation that creates tokens with calculated expiry times could silently create dead tokens.

---

### Finding 7: User type changeable to `internal_service_account` via PATCH

**Confidence: 95/100**

`PATCH /api/v3/core/users/{id}/` with `{"type": "internal_service_account"}` returns 200. The `validate_type` method in `UserSerializer` blocks:

- Changing FROM `internal_service_account` to another type
- Creating a NEW user as `internal_service_account`

But it does NOT block changing an existing user TO `internal_service_account`. Once set, the `validate` method then blocks ALL subsequent modifications to that user (`"Can't modify internal service account users"`), effectively locking the user record.

The `service_account` and `external` type changes also succeed (200), which may have licensing implications since authentik charges differently for internal vs external users.

**Evidence:** `12-privilege-escalation-groups.yaml` steps 11, 13, 14 — type changes to `service_account` (200), `external` (200), and `internal_service_account` (200) all succeed. Step 15 — subsequent PATCH on the now-`internal_service_account` user returns **400**.

**Severity: Medium** — an admin (or compromised admin token) can permanently lock a user account from API modification by setting its type to `internal_service_account`. This is a denial-of-service vector against specific user accounts. The type change also affects licensing calculations.

---

### Finding 8: Token can be created for deactivated user

**Confidence: 95/100**

`POST /api/v3/core/tokens/` with `user: {deactivated_user_pk}` returns 201 even when the target user has `is_active: false`. The `TokenSerializer.validate` method doesn't check if the user is active.

The existing token for the deactivated user is correctly rejected (403), but a new token can be created that would become active if the user is reactivated.

**Evidence:** `13-deactivation-token-lifecycle.yaml` step 7 — deactivated user's existing token → **403** (correct). Step 8 — creating a new token for the same deactivated user → **201** (bug).

**Severity: Low** — tokens for deactivated users return 403 when used, so no immediate privilege escalation. But it creates unnecessary state and could indicate an incomplete deactivation workflow.

---

## Well-Handled Cases (New Definitions)

These areas were tested in definitions 11-13 and Authentik handled them correctly:

### Error Handling & Input Validation (Test 11)

- **Empty token key** → correctly rejected (400)
- **Large `top_n` values** → handled gracefully (200 with results)

### Token Security (Test 13)

- **Token user rebinding** — PATCH to change a token's user returns 400. Token-user binding is immutable after creation.
- **Token intent changes** — PATCH to change a token's intent (e.g., `api` → `verification` or `recovery`) returns 400. Intent is locked after creation.
- **Invalid intent on creation** — creating tokens with `verification` or `recovery` intent via the API returns 400. Only `api` and `app_password` are allowed.
- **Deactivated user token rejection** — an existing API token for a deactivated user immediately returns 403. No stale token window.
- **Empty password** — setting password to empty string returns 400.
- **Single-space password** — setting password to `" "` returns 400.

---

## Negative Findings (Original Definitions — Authentik Passed)

These areas were tested and Authentik's security held:

### Race Conditions (Test 06)

- **Concurrent duplicate user creation** — two simultaneous POST requests with the same username produce exactly one user. One request succeeds (201), the other is rejected. No duplicates.
- **Concurrent group membership** — adding a user to two groups simultaneously succeeds for both. No 500 errors.

### Permission & Privilege Management (Test 07)

- **Group-based superuser revocation** — adding a user to a superuser group correctly grants admin access. Removing them immediately revokes it — no stale cache. The `is_superuser` flag on the `/me/` endpoint reflects group membership changes in real time.

### Cascade Behavior (Test 08)

- **User deletion invalidates all tokens** — deleting a user causes both their API tokens to return 403 immediately. No stale token window.
- **Token cleanup** — deleted user's tokens return 404 when queried by identifier. No orphaned records accessible via the API.
- **Group membership cleanup** — a group that contained a deleted user correctly shows 0 members after deletion.

### Console Log Security (Test 09)

- **Passwords never in logs** — after setting a user's password and triggering various auth operations, the password string never appears in Authentik's console output.
- **Token keys never in logs** — API token keys are not logged to the console during authentication or token operations.
- **Passwords never in traffic** — no API response body (across all captured traffic) contains the plaintext password.

### API Consistency (Test 10)

- **Partial PATCH preserves unrelated fields** — PATCHing only `name` leaves `username`, `email`, and `is_active` unchanged.
- **Password never leaks in API** — after setting a password, neither `GET /users/{id}/` nor `GET /users/?search=` returns the password or its hash.
- **Deactivation is immediate** — PATCHing `is_active: false` immediately rejects the user's existing API token (403). No grace period.
- **Deletion is immediate** — `DELETE /users/{id}/` returns 204 and a subsequent GET returns 404. No soft-delete lag.

### Authorization & Isolation (Tests 01-05)

- **Non-admin users blocked** — a regular user's token cannot access admin endpoints (403).
- **Cross-user token isolation** — a token created for user A cannot act as user B.
- **SQL injection** — injection payloads in usernames are stored as literal strings, not executed.
- **XSS payloads** — script tags in user fields are stored and returned verbatim.
- **OAuth2 flows** — client_credentials grant works correctly. Invalid credentials are rejected. Token introspection reflects revocation state.

---

## Findings by Category

### Unhandled Exceptions (2)

| Finding               | Endpoint                           | Input       | Response |
| --------------------- | ---------------------------------- | ----------- | -------- |
| F2: Non-numeric top_n | `GET /events/events/top_per_user/` | `top_n=abc` | 500      |
| F3: Negative top_n    | `GET /events/events/top_per_user/` | `top_n=-5`  | 500      |

### Missing Input Validation (4)

| Finding                              | Endpoint                       | Input                        | Response |
| ------------------------------------ | ------------------------------ | ---------------------------- | -------- |
| F4: Short token key                  | `POST /tokens/{id}/set_key/`   | `key: "a"`                   | 204      |
| F5: Special chars in service account | `POST /users/service_account/` | spaces, HTML, path traversal | 200      |
| F6: Past expiry date                 | `POST /tokens/`                | `expires: "2020-01-01..."`   | 201      |
| F8: Token for inactive user          | `POST /tokens/`                | `user: {deactivated_pk}`     | 201      |

### State/Type Integrity (2)

| Finding                                     | Endpoint             | Input                              | Response         |
| ------------------------------------------- | -------------------- | ---------------------------------- | ---------------- |
| F1: is_superuser silently ignored           | `PATCH /users/{id}/` | `is_superuser: true`               | 200 (no change)  |
| F7: Type change to internal_service_account | `PATCH /users/{id}/` | `type: "internal_service_account"` | 200 (locks user) |

---

## Infrastructure Notes

### `dbQuery` action not functional with Authentik's DB proxy

Direct database queries from the test agent (`dbQuery` action type) consistently timed out with "action log not yet received from sidecar". The DB proxy sidecar successfully intercepts and logs Authentik's own queries (12K+ captured), but does not process queries sent directly from the test agent. Tests 08 and 10 were restructured to use API-only verification.

### Resource constraints

Running multiple Authentik test definitions simultaneously (all 10 at once) causes 503 failures — each definition spins up a full Authentik stack (server + worker + PostgreSQL). Tests must be run individually or in small batches.

---

## Areas Not Yet Tested

- **LDAP/RADIUS protocols** — Authentik supports LDAP and RADIUS outposts, but testing these requires specialized protocol clients beyond HTTP.
- **SAML flows** — SAML assertions require browser-based redirect flows that Dokkimi's `httpRequest` action can follow but assertion signing adds complexity.
- **WebSocket/SSE** — Authentik's admin interface uses WebSocket for real-time updates. Dokkimi has no WebSocket action type.
- **Multi-tenant outpost isolation** — testing whether one tenant's outpost can access another tenant's data requires a more complex multi-outpost deployment.
- **Certificate rotation** — testing whether rotating a signing certificate invalidates existing OAuth2 tokens.
- **Group-endpoint privilege escalation with non-superuser admin** — the code analysis shows `GroupViewSet.add_user()` doesn't check `enable_group_superuser` when adding a user to a superuser group. Our tests used the bootstrap admin (full superuser), so this bypass path was not conclusively demonstrated. A proper test requires an admin with `add_user_to_group` but not `enable_group_superuser` permission.
