# Formbricks Bug Hunt Report

**Project:** [Formbricks](https://github.com/formbricks/formbricks) (~12k stars)
**Version:** `ghcr.io/formbricks/formbricks:latest` (as of 2026-07-03)
**Architecture:** Next.js web app + PostgreSQL (pgvector) + Valkey (Redis)

---

## Confirmed Bugs

### Bug 1: Required Field Validation Bypass (CONFIRMED)

**Severity:** Medium
**File:** `apps/web/modules/api/lib/validation.ts` line 45
**Endpoint:** `POST /api/v1/client/[workspaceId]/responses` (unauthenticated)

**Root Cause:**
Server-side validation only checks survey elements that are _present_ in the response data. If a required field is omitted entirely from the `data` object, its validation (including the `required` check) is never executed.

```typescript
// validation.ts line 45
const elementsToValidate = allElements.filter((element) =>
  Object.keys(responseData).includes(element.id),
);
```

This means a client can submit `{ finished: true, data: {} }` for a survey with mandatory required questions, and the server accepts it as a complete response.

**Impact:**

- Survey data integrity is compromised — "finished" responses may contain zero answers
- Analytics and quotas count these as valid completed responses
- Any downstream logic (follow-ups, webhook triggers) fires on empty data
- The client-side SDK validates correctly, but the server-side gate is bypassable by any HTTP client

**Reproduction:**

1. Create a survey with required openText questions
2. `POST /api/v1/client/{workspaceId}/responses` with `finished: true` and an empty `data: {}`
3. Response: `200 OK` with a valid response ID — no validation error

**Dokkimi test:** `formbricks-required-field-bypass` — PASSED

- CONTROL: submits with both required fields → 200 (correct)
- BUG: submits `finished: true` with `data: {}` → 200 (proves bypass)
- BUG: submits `finished: true` with only 1 of 2 required fields → 200 (proves partial bypass)
- Verification: all 3 responses stored in DB as `finished: true`

---

### Bug 2: Closed Survey Accepts Response Updates (CONFIRMED)

**Severity:** Medium
**File:** `apps/web/app/api/v1/client/[workspaceId]/responses/[responseId]/lib/put-response-handler.ts` line 133
**Endpoint:** `PUT /api/v1/client/[workspaceId]/responses/[responseId]` (unauthenticated)

**Root Cause:**
The POST endpoint (response creation) correctly checks `survey.status !== "inProgress"` and returns 403 for closed surveys. But the PUT endpoint (response update) only checks `existingResponse.finished` — it never validates `survey.status`. This means a partial response created while the survey was open can be updated and finished after the survey is closed.

```typescript
// put-response-handler.ts, validateUpdateRequest() line 133
if (existingResponse.finished) {
  return {
    response: responses.badRequestResponse("Response is already finished", ...),
  };
}
// No survey.status check here — contrast with POST route line 141:
// if (survey.status !== "inProgress") { return 403; }
```

**Impact:**

- Survey owners close a survey expecting no more data, but existing partial responses can still be modified and finalized
- "Completed" or "paused" surveys continue accumulating finished responses
- Quota evaluation still runs, potentially consuming quota after a survey is closed
- Survey analytics show responses with timestamps after the survey closed

**Reproduction:**

1. Create a survey (status: `inProgress`), submit a partial response (`finished: false`)
2. Close the survey (set status to `completed`)
3. `POST` a new response → 403 Forbidden (correct)
4. `PUT` the existing partial response with `finished: true` → 200 OK (bug)

**Dokkimi test:** `formbricks-closed-survey-update` — PASSED

- Seeds an in-progress survey, creates a partial response
- Closes survey via SQL UPDATE to `completed`
- CONTROL: POST new response → 403 (correct rejection)
- BUG: PUT existing response with `finished: true` → 200 (proves bypass)
- Verification: response marked `finished: true` while `survey_status` is `completed`

---

### Bug 3: PUT Finish Bypasses Required Field Check (CONFIRMED)

**Severity:** Medium
**File:** `apps/web/modules/api/lib/validation.ts` line 45 (same root cause as Bug 1)
**Endpoint:** `PUT /api/v1/client/[workspaceId]/responses/[responseId]` (unauthenticated)

**Root Cause:**
Same `validateResponseData` filter as Bug 1, but exercised through a different attack vector. The PUT handler merges old response data with new data, then validates only elements present in the merged result. If a required field was never submitted in any step, the merge still lacks it and validation skips it — allowing the response to be marked `finished` with incomplete data.

**Impact:**

- Multi-step survey flows (save progress, resume later) can be completed with missing required answers
- Unlike Bug 1 (which requires a single malicious POST), this exploits the normal partial-save → finish workflow
- Harder to detect because the response genuinely has _some_ data — just not all required fields

**Reproduction:**

1. Create a survey with 2 required questions
2. `POST` a partial response (`finished: false`) with only question 1 answered
3. `PUT` the response with `finished: true` and `data: {}` (no question 2)
4. Response: `200 OK` — response is now finished with only 1 of 2 required fields

**Dokkimi test:** `formbricks-put-finish-bypass` — PASSED

- Seeds a survey with 2 required openText questions
- POSTs a partial response with only 1 field answered
- PUTs `finished: true` with empty data → 200 (proves bypass)
- Verification: response is `finished: true` in DB with only 1 of 2 required fields

---

## Investigated and Ruled Out

| Area                                  | Finding                                                                                                                                                                   |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Storage path traversal**            | S3-based storage (`@aws-sdk/client-s3`); S3 keys are literal strings with no `..` resolution — traversal is impossible                                                    |
| **Cross-workspace response update**   | Both POST (line 129) and PUT (line 256) check `survey.workspaceId !== workspaceId` — properly blocked                                                                     |
| **V2 API validation**                 | Uses the same `validateResponseData` — same Bug 1 root cause, not a separate bug                                                                                          |
| **Display endpoint status check**     | `createDisplay` properly checks survey status and workspace                                                                                                               |
| **Webhook SSRF**                      | Solid protection: private IP blocking, DNS resolution with timeout, IPv4-mapped IPv6 detection, DNS pinning via `createPinnedDispatcher()` closes TOCTOU rebinding window |
| **API key auth timing attacks**       | Hybrid SHA-256 lookupHash + bcrypt hashedKey with control hash for constant-time comparison when key doesn't exist                                                        |
| **Response creation race conditions** | Uses `prisma.$transaction` wrapping both `createResponse` and `evaluateResponseQuotas`                                                                                    |
| **Management API IDOR**               | Proper workspace permission checks via `getApiKeyWithPermissions()`                                                                                                       |
| **Invite email mismatch**             | `handleInviteAcceptance()` doesn't verify email, but signup is a server action (not REST), limiting attack surface                                                        |
| **Response quota race**               | Transaction-based quota evaluation prevents bypass                                                                                                                        |

---

## Test Definitions

All tests pass against `ghcr.io/formbricks/formbricks:latest`.

| Definition                       | Purpose                                                    | Steps | Result |
| -------------------------------- | ---------------------------------------------------------- | ----- | ------ |
| `smoke.yaml`                     | Boot Formbricks, seed data via SQL, verify client API      | 3     | PASSED |
| `bug-required-field-bypass.yaml` | Prove required field validation bypass (POST) with control | 5     | PASSED |
| `bug-closed-survey-update.yaml`  | Prove closed survey accepts updates with control           | 6     | PASSED |
| `bug-put-finish-bypass.yaml`     | Prove PUT finish bypasses required fields with control     | 4     | PASSED |
