# Hyperswitch Bug Hunting Report

## What is Hyperswitch?

[Hyperswitch](https://github.com/juspay/hyperswitch) is a 43k-star open-source payment switch built by Juspay. It provides a single API that routes payments to 150+ payment processors (Stripe, Adyen, Braintree, etc.), handling connector selection, retries, and status normalization. Written in Rust, it's used in production for real payment processing. The architecture includes a main API router, a scheduler pipeline (producer/consumer/drainer), and integrations with Postgres and Redis.

## What we did

Using Dokkimi, we deployed the full Hyperswitch stack (Postgres, Redis, payment router) and mocked Stripe's API at the DNS level — no changes to Hyperswitch source code. Mocks intercept outbound HTTPS to `api.stripe.com` and return controlled responses simulating success, failures, malformed data, and edge cases. Across 11 definition files and 50+ individual probes, we tested connector error handling, multi-tenant isolation, payment state machine enforcement, refund validation, concurrency safety, input sanitization, and PCI compliance.

## Test Environment

- **Hyperswitch v1.123.1** (official Docker image with config mounted via Dokkimi `mountFiles`)
- **PostgreSQL 15** with consolidated migrations (435 files, 4,298 lines of SQL)
- **Redis** with password auth
- **Dokkimi MOCK items** intercepting `api.stripe.com` (customers, payment_intents, and refunds with multiple response variants)
- 11 definition files in `.dokkimi/hyperswitch/definitions/`

---

## Finding 1: Concurrent refunds can exceed captured amount (TOCTOU race condition)

**Severity: High — direct financial loss**

The refund validation in `refunds_validator.rs` has a time-of-check-time-of-use (TOCTOU) race condition. When two refund requests arrive simultaneously, both read the same refund history from the database, both validate that the new refund fits within the captured amount, and both proceed — resulting in total refunds exceeding the original payment.

### Reproduction

```
1. Create a $100.00 payment (amount: 10000) and confirm it
2. Send two $60.00 refunds (amount: 6000) simultaneously using Dokkimi's parallel action
3. Both requests pass validation: each sees $0 existing refunds, calculates $60 ≤ $100 ✓
4. Both refunds are created
```

### Proof (database query)

```sql
SELECT COALESCE(SUM(refund_amount), 0)::text as total_refunded,
       COUNT(*)::text as refund_count
FROM refund
WHERE payment_id = '{{paymentId}}'
  AND refund_status NOT IN ('failure', 'transaction_failure')

-- Result: total_refunded = 12000, refund_count = 2
-- $120.00 refunded on a $100.00 payment
```

### Why this matters

- **Real money loss:** The merchant is out $20. Both refunds are sent to the connector and processed. This isn't a display bug — the connector (Stripe, Adyen, etc.) processes each refund independently.
- **No lock or atomic check:** The validation at `refunds_validator.rs:51-77` fetches all refunds, sums non-failed ones, and checks the total. But between the check and the refund creation, no database lock prevents another request from passing the same check.
- **Exploitable:** An attacker who knows the payment ID and API key can trivially send concurrent refund requests to extract more than the captured amount.
- **The mock doesn't matter:** The bug is entirely inside Hyperswitch's validation layer, before any connector is called. The same race exists with real Stripe, real Adyen, or any other connector.

### Root cause

`validate_refund_amount` (line 51) queries `db.find_refund_by_payment_id_merchant_id`, iterates to sum amounts, and validates. The caller then creates the refund record. There is no `SELECT ... FOR UPDATE`, no advisory lock, and no atomic compare-and-insert to prevent a concurrent request from passing the same validation against stale data.

### Definition file

`.dokkimi/hyperswitch/definitions/11-refund-race-condition.yaml`

---

## Finding 2: Stripe-compat API silently defaults mandate amount to 0

**Severity: Medium — silent data corruption on financial field**

When a payment is created through the Stripe compatibility API (`/vs/v1/payment_intents`) with `mandate_data` but no explicit amount, Hyperswitch silently defaults the mandate amount to `MinorUnit(0)` instead of returning a validation error. The merchant gets a $0.00 mandate created with no warning.

### Reproduction

```
POST /vs/v1/payment_intents (form-encoded)
  amount=6540&currency=usd&confirm=true&customer={{customerId}}
  &mandate_data[customer_acceptance][type]=online
  &mandate_data[mandate_type]=single_use
  (no mandate amount field)

Result: HTTP 200
  amount: 6540                                    ← payment amount correct
  mandate_data.mandate_type.single_use.amount: 0  ← mandate amount silently zeroed
```

### Why this matters

- **Silent corruption:** The API returns 200 with no warning. The merchant believes they created a valid mandate. The mandate amount is a critical financial field that governs future charges.
- **Stripe doesn't do this:** Stripe's API requires explicit amounts on mandates. A Hyperswitch merchant migrating from Stripe may omit the field expecting a validation error, not a silent zero.
- **Downstream impact:** A $0 mandate may block future recurring charges or allow unintended ones, depending on how the connector interprets it.

### Root cause

In `types.rs` (lines 752/761/771), `mandate.amount.unwrap_or_default()` converts `Option<i64>` `None` into `MinorUnit(0)`. The `unwrap_or_default` pattern is appropriate for optional display fields, but not for a financial amount that should be explicitly provided.

### Definition file

`.dokkimi/hyperswitch/definitions/10-mandate-amount-bug.yaml`

---

## Finding 3: Connector HTTP errors return misleading 200 OK

**Severity: Medium — can cause financial reconciliation issues**

When a payment connector returns an HTTP error (502 Bad Gateway, 500 Internal Server Error), Hyperswitch returns **HTTP 200** to the merchant with `status: "processing"`. The actual error is buried in `error_code` and `error_message` fields that many integrations won't check.

### Reproduction (HTML 502 from CDN outage)

```
Mock:   POST api.stripe.com/v1/payment_intents → 502 with HTML body "<html>502 Bad Gateway</html>"
Result: Hyperswitch returns HTTP 200
        status: "processing"
        error_code: "502"
        error_message: "<html><body><h1>502 Bad Gateway</h1></body></html>"
        connector_transaction_id: null
```

### Reproduction (Stripe 500 internal error)

```
Mock:   POST api.stripe.com/v1/payment_intents → 500 with JSON {"error": {"code": "internal_error", ...}}
Result: Hyperswitch returns HTTP 200
        status: "processing"
        error_code: "500"
        error_message: "{\"error\":{\"code\":\"internal_error\",...}}"
        connector_transaction_id: null
```

### Why this matters

- **Misleading HTTP status:** Any integration checking `response.status == 200` will believe the payment is in progress. The `Connector_http_status_code` header leaks the real status, but the HTTP status code itself says "OK."
- **Zombie payments:** The payment is left in `processing` forever. It will never complete because the connector never processed it. No retry is triggered.
- **CDN 502 is unambiguous:** A 502 from a CDN means the request never reached Stripe's servers — the payment definitely didn't go through. Treating it identically to an ambiguous 500 is incorrect.
- **Financial impact:** Merchants who rely on HTTP status codes for reconciliation will have phantom "processing" payments that never resolve, requiring manual investigation.

### Root cause

The Stripe connector's `get_error_response` catches the connector error, but the router's payment flow maps connector errors to `processing` status (the "uncertain state" pattern). This is defensible for truly ambiguous failures, but over-applied — a CDN 502 or a clean Stripe error JSON should result in `failed`, not `processing`.

### Affects refunds too

The same bug exists in the refund path. When the connector returns 502/500 during a refund, Hyperswitch returns HTTP 200 with `status: "pending"`:

```
Refund with connector 502 → HTTP 200, status: "pending", error_code: "502"
Refund with connector 500 → HTTP 200, status: "pending", error_code: "500"
```

This is arguably worse than the payment case: `status: "pending"` tells the merchant "the refund is in progress" — the customer expects their money back, but it will never arrive.

### Definition files

- `.dokkimi/hyperswitch/definitions/04-connector-mocks.yaml` — payment-side (steps "FINDING: HTML 502" and "FINDING: Stripe 500")
- `.dokkimi/hyperswitch/definitions/07-refund-probes.yaml` — refund-side (steps "FINDING: Refund with connector 502" and "FINDING: Refund with connector 500")

---

## Finding 4: Zero-amount payments accepted without validation

**Severity: Low**

Hyperswitch accepts `amount: 0` in payment creation and returns HTTP 200 with a created payment intent. Stripe itself rejects zero-amount payment intents. When this payment is eventually sent to a real connector, it will be rejected — Hyperswitch creates a payment record that can never succeed.

### Reproduction

```
POST /payments { amount: 0, currency: "USD" } → HTTP 200 (payment created)
POST /payments { amount: -100, currency: "USD" } → HTTP 400 (correctly rejected)
```

Negative amounts are correctly rejected. Zero is not.

### Mitigating factor

Some processors use `amount: 0` for card verification flows, so this may be intentional for connector compatibility. However, no warning is emitted and the payment will fail downstream.

### Definition file

`.dokkimi/hyperswitch/definitions/03-edge-cases.yaml` — step "FINDING: Zero amount is accepted"

---

## Positive Findings

### Amount integrity check works correctly

When the connector returns a different amount than requested (mock returns 9999 for a 5000 request), Hyperswitch catches it:

```json
{
  "error": {
    "code": "IE_00",
    "message": "Integrity Check Failed! as data mismatched for amount expected 5000 but found 9999",
    "connector_transaction_id": "pi_mock_mismatch_456"
  }
}
```

This is a strong security feature — a compromised or buggy connector can't silently change payment amounts.

### Multi-tenant isolation (05-multi-tenant.yaml)

All cross-tenant access attempts correctly rejected:

| Test                                   | Status |
| -------------------------------------- | ------ |
| Merchant B GET merchant A's payment    | 404 ✓  |
| Merchant B cancel merchant A's payment | 404 ✓  |
| Merchant B refund merchant A's payment | 404 ✓  |
| Merchant B GET merchant A's account    | 401 ✓  |
| Merchant B list merchant A's API keys  | 401 ✓  |

Payment IDs don't leak existence (404, not 403).

### State machine enforcement (06-state-machine.yaml)

All invalid state transitions correctly rejected with 400:

| Test                             | Status |
| -------------------------------- | ------ |
| Capture before confirm           | 400 ✓  |
| Refund before confirm            | 400 ✓  |
| Double-confirm succeeded payment | 400 ✓  |
| Cancel succeeded payment         | 400 ✓  |
| Capture auto-captured payment    | 400 ✓  |
| Confirm cancelled payment        | 400 ✓  |

### Refund validation (07-refund-probes.yaml)

| Test                                               | Status |
| -------------------------------------------------- | ------ |
| Over-refund (99999 on 5000 payment)                | 400 ✓  |
| Zero-amount refund                                 | 422 ✓  |
| Negative-amount refund                             | 422 ✓  |
| Over-refund after partial (4001 remaining of 4000) | 400 ✓  |
| Refund zombie "processing" payment                 | 400 ✓  |
| Refund nonexistent payment ID                      | 404 ✓  |

### Input validation (08-input-validation.yaml)

| Test                                      | Status                                       |
| ----------------------------------------- | -------------------------------------------- |
| SQL injection in merchant_id              | 400 ✓                                        |
| SQL injection in merchant_name            | 200 (stored as data, Prisma parameterized) ✓ |
| DB tables intact after injection attempts | ✓                                            |
| XSS in payment description                | 200 (API-only, no rendering) ✓               |
| 5,000 char merchant name                  | 200 (accepted)                               |
| String amount (type confusion)            | 400 ✓                                        |
| Empty merchant_id                         | 400 ✓                                        |
| Path traversal in merchant_id             | 400 ✓                                        |
| Invalid email format                      | 400 ✓                                        |

### Data leakage (09-data-leakage.yaml)

| Test                                | Status                    |
| ----------------------------------- | ------------------------- |
| Full card number NOT in DB          | 0 rows ✓                  |
| Connector API key masked in GET     | `sk************ey` ✓      |
| Admin endpoint rejects merchant key | 401 ✓                     |
| Payment amount update (unconfirmed) | 200 (expected behavior) ✓ |

### Edge cases (03-edge-cases.yaml)

| Test                               | Status           |
| ---------------------------------- | ---------------- |
| Negative amount (-100)             | 400 ✓            |
| Invalid currency ("FAKE")          | 400 ✓            |
| Duplicate merchant ID              | 409 ✓            |
| Wrong admin API key                | 401 ✓            |
| Malformed JSON from connector      | 500 ✓            |
| Missing `id` in connector response | 500 ✓            |
| Amount mismatch integrity check    | 500 (IE_00) ✓    |
| Successful mocked payment          | 200, succeeded ✓ |

---

## How to Reproduce

```bash
# Run all Hyperswitch tests
dokkimi run .dokkimi/hyperswitch/definitions/

# Or run individually
dokkimi run .dokkimi/hyperswitch/definitions/03-edge-cases.yaml
dokkimi run .dokkimi/hyperswitch/definitions/04-connector-mocks.yaml
dokkimi run .dokkimi/hyperswitch/definitions/05-multi-tenant.yaml
dokkimi run .dokkimi/hyperswitch/definitions/06-state-machine.yaml
dokkimi run .dokkimi/hyperswitch/definitions/07-refund-probes.yaml
dokkimi run .dokkimi/hyperswitch/definitions/08-input-validation.yaml
dokkimi run .dokkimi/hyperswitch/definitions/09-data-leakage.yaml
dokkimi run .dokkimi/hyperswitch/definitions/10-mandate-amount-bug.yaml
dokkimi run .dokkimi/hyperswitch/definitions/11-refund-race-condition.yaml

# Inspect traffic after a run
dokkimi dump
```

No build step required — tests use the official Hyperswitch Docker image with config files mounted via Dokkimi's `mountFiles`.

---

## Notes on Test Setup

These notes document non-obvious requirements discovered during test authoring that may be useful for anyone extending these tests.

- **Config via mountFiles:** Hyperswitch reads a 146KB TOML config at startup. Dokkimi's `mountFiles` mounts the config and entrypoint script into the official Docker image — no custom wrapper image needed.
- **Redis password injection:** Hyperswitch's `RedisSettings` has no password field. The password is injected into the TOML config's `host` field as `:password@hostname`, which gets embedded in the Redis URL.
- **Startup ordering:** The entrypoint script waits for Postgres and Redis TCP connectivity before launching the router. Mounted via `mountFiles` in the server fragment.
- **Form-encoded Stripe requests:** The Stripe connector sends `application/x-www-form-urlencoded` requests (not JSON), so `mockRequestBodyContains` matches against form-encoded strings like `description=pay_success`.
- **Customer creation prerequisite:** Hyperswitch calls `POST /v1/customers` before `POST /v1/payment_intents` — both endpoints need mocks.
- **Required `metadata` field:** The `PaymentIntentResponse` struct has a required (non-optional) `metadata` field. Mocks must include `metadata: {}` or deserialization fails with a generic 500.
- **Postgres NUMERIC columns:** The `amount` column uses Postgres NUMERIC type. DB query assertions require `amount::text` casting to compare values.
