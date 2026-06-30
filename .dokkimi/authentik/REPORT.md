# Authentik 2026.5.3 Bug Hunt Report

Target: `ghcr.io/goauthentik/server:2026.5.3`
Stack: Authentik HTTP server + worker + PostgreSQL 16
Tested with: Dokkimi (3-container stack with WORKER item type)

## Test Definitions

| Definition                      | Steps | Result | What it tests                                                          | Dokkimi capabilities used                    |
| ------------------------------- | ----- | ------ | ---------------------------------------------------------------------- | -------------------------------------------- |
| `01-smoke-test.yaml`            | 11    | PASS   | Bootstrap API, user CRUD, token management, group membership           | httpRequest                                  |
| `02-permission-escalation.yaml` | 14    | PASS   | Non-admin user blocked from admin endpoints, cross-user token reuse    | httpRequest                                  |
| `03-oauth2-flows.yaml`          | 18    | PASS   | OAuth2 provider setup, client_credentials grant, introspection, revoke | httpRequest, raw body strings                |
| `04-token-management.yaml`      | ~15   | PASS   | Token lifecycle, expiry, multiple tokens per user                      | httpRequest                                  |
| `05-input-validation.yaml`      | ~15   | PASS   | SQL injection, XSS, oversized payloads in usernames and fields         | httpRequest                                  |
| `06-race-conditions.yaml`       | 17    | PASS   | Concurrent duplicate user creation, simultaneous group membership      | **parallel**, traffic match assertions       |
| `07-permission-cache.yaml`      | 16    | PASS   | PATCH is_superuser silent ignore **(F1)**, group superuser revocation  | httpRequest                                  |
| `08-cascade-verification.yaml`  | 15    | PASS   | User deletion cascades to tokens, group membership cleanup             | **parallel**, httpRequest                    |
| `09-console-log-audit.yaml`     | 11    | PASS   | Passwords/tokens never leak to console logs or traffic response bodies | **$.consoleLogs** match, **$.traffic** match |
| `10-api-consistency.yaml`       | 24    | PASS   | Partial PATCH preserves fields, password never in API, deactivation    | **$.traffic** match, httpRequest             |

10 definitions total. All pass. 156 total test steps across authentication, authorization, OAuth2, race conditions, permission management, cascade behavior, console log auditing, and API consistency.

---

## Confirmed Findings

### Finding 1: PATCH `is_superuser` silently ignored — API returns 200 but field is not applied

**Confidence: 95/100**

Sending `PATCH /api/v3/core/users/{id}/` with `{"is_superuser": true}` returns HTTP 200 (success), but the response body shows `"is_superuser": false`. The API accepts the field, returns a success status code, and silently drops the change.

**Evidence:** `07-permission-cache.yaml` test 1 —

1. Create a new user (POST returns 201, `is_superuser: false`)
2. PATCH the user with `{"is_superuser": true}` → **returns 200**
3. GET the user → **`is_superuser` is still `false`**

The PATCH response itself contains `"is_superuser": false` in the body, contradicting the 200 status code. The API accepted the request and reported success without applying the change.

**Why this matters:**

- **Silent data loss** — an admin who PATCHes `is_superuser: true` would believe the change succeeded based on the 200 response. No error, no warning.
- **Misleading API contract** — the field appears in the API schema as writable (it's accepted in the request body without a 400/422), but it's actually read-only.
- **Security-adjacent** — while this prevents accidental privilege escalation, the correct behavior would be either: (a) apply the change, or (b) return 400/422 with a message like "is_superuser cannot be set via PATCH". Silently dropping security-sensitive fields is the worst option.

**Severity: Medium** — the API gives false confirmation of a privilege change. An admin automation relying on this endpoint to provision superusers would silently fail.

**How Dokkimi caught it:** By asserting on the response body _after_ the PATCH (not just the status code), the test verified the actual state change rather than trusting the 200. Traditional tests that only check `status == 200` would miss this entirely.

---

## Negative Findings (Authentik Passed)

These areas were tested and Authentik handled them correctly:

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

- **Partial PATCH preserves unrelated fields** — PATCHing only `name` leaves `username`, `email`, and `is_active` unchanged. PATCHing only `email` preserves the previously-updated `name`. No field clobbering.
- **Password never leaks in API** — after setting a password, neither `GET /users/{id}/` nor `GET /users/?search=` returns the password or its hash in the response body.
- **Deactivation is immediate** — PATCHing `is_active: false` immediately rejects the user's existing API token (403). No grace period.
- **Deletion is immediate** — `DELETE /users/{id}/` returns 204 and a subsequent GET returns 404. No soft-delete lag.

### Authorization & Isolation (Tests 01-05)

- **Non-admin users blocked** — a regular user's token cannot access admin endpoints (403).
- **Cross-user token isolation** — a token created for user A cannot act as user B.
- **SQL injection** — injection payloads in usernames are stored as literal strings, not executed.
- **XSS payloads** — script tags in user fields are stored and returned verbatim.
- **OAuth2 flows** — client_credentials grant works correctly. Invalid credentials are rejected. Token introspection reflects revocation state.

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
