# Lago Bug-Hunting Report

**Target:** [getlago/lago-api](https://github.com/getlago/lago-api) v1.48.1 (10k-star open-source billing platform)
**Tested with:** Dokkimi — deployed full Lago stack (Rails API + Postgres + Redis) with interceptor sidecars
**Date:** 2026-06-28

## What is Lago?

Lago is an open-source billing and metering engine. It manages customers, billable metrics, plans, subscriptions, usage events, and invoices for SaaS companies. The API is a Rails 8.0.5 application backed by PostgreSQL with a Redis queue for Sidekiq workers.

## What we did

Deployed Lago's API service with a custom wrapper image (RSA key generation, migration execution, org seeding) against Postgres 15 with pg_partman and Redis. Ran six Dokkimi test definitions (116 total test steps) covering the billing lifecycle, coupons, wallets, taxes, add-ons, invoices, subscription lifecycle, and webhook configuration. Cross-referenced all findings against [Lago's official documentation](https://docs.getlago.com) to separate real bugs from intentional design decisions.

## Summary

Lago lets you create things with values that make no sense for a billing system, and those values get stored and used.

1. **You can create a subscription plan that charges negative dollars.** Like a plan that costs -$1/month. Coupons and add-ons correctly reject negative amounts — plans just don't check.
2. **You can create a tax rate of -10%.** Instead of adding tax to an invoice, it would subtract from it. A -100% tax rate would zero out every invoice. Lago has a proper system for credits and refunds — negative tax rates shouldn't exist.
3. **Tax rates have no ceiling.** You can set a 99,999,999% tax rate. A $50 charge would generate $50 billion in taxes.
4. **You can point Lago's webhook system at internal servers.** An attacker can register `http://169.254.169.254` (AWS's internal metadata service) as a webhook URL. When Lago fires a webhook, it would hit that internal address from inside the network, potentially leaking cloud credentials. This was already reported on HackerOne but the fix isn't in the open-source code.
5. **When applying a coupon, you can override the discount to -50%.** A negative discount becomes a surcharge — the customer pays more, not less. Or override to 200% and the invoice goes negative. The coupon itself validates amounts, but the override at application time doesn't check at all.

The common thread: **validation gaps at the API boundary.** The data gets stored as-is and would flow into invoice calculations, tax computations, and webhook delivery without any downstream safety net.

## Findings

### F-01: Negative billing amounts accepted on plans

|              |                                                                                                                                                                                          |
| ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Endpoint** | `POST /api/v1/plans`                                                                                                                                                                     |
| **Severity** | High                                                                                                                                                                                     |
| **Input**    | `amount_cents: -100`                                                                                                                                                                     |
| **Response** | 200 — plan created with `amount_cents: -100`                                                                                                                                             |
| **Docs say** | Silent — no mention of negative amount validation. Charge properties use a regex (`^[0-9]+.?[0-9]*$`) that only matches non-negative numbers, but `amount_cents` has no such constraint. |

No validation prevents creating plans with negative amounts. The `Plan` model has zero numericality validation on `amount_cents` (only `monetize :amount_cents`), while `Coupon` has `numericality: {greater_than: 0}` and `AddOn` has `numericality: {greater_than: 0}`. Plans are the only entity missing this validation. No existing GitHub issue filed.

**Downstream impact verified:** Definition 06 creates a negative-amount plan, subscribes a customer, then queries the database directly — the subscription JOIN confirms `amount_cents < 0` persisted. This is not just an API-level quirk; the billing pipeline would use this value.

**Reproduce:** `dokkimi run .dokkimi/lago/definitions/01-basic-lifecycle.yaml` — Step 1.19; also definition 06 (DB assertion)

### F-02: Negative tax rates accepted

|              |                                                                                                                    |
| ------------ | ------------------------------------------------------------------------------------------------------------------ |
| **Endpoint** | `POST /api/v1/taxes`                                                                                               |
| **Severity** | High                                                                                                               |
| **Input**    | `rate: "-10.0"`                                                                                                    |
| **Response** | 200 — tax created with `rate: -10`                                                                                 |
| **Docs say** | Silent — rate is defined as a string matching `^[0-9]+.?[0-9]*$` in the docs, but the API accepts negative values. |

A -10% tax rate would reduce invoice totals. A -100% rate would zero out every invoice. The OpenAPI schema regex `^[0-9]+.?[0-9]*$` intends to block negatives, but the Rails `Tax` model only validates presence — no numericality check. Lago has a dedicated credit notes system for tax adjustments and refunds, making negative tax rates unnecessary.

**Reproduce:** `dokkimi run .dokkimi/lago/definitions/05-taxes-addons-invoices.yaml` — Step "PROBE: Tax with negative rate"

### F-03: No upper bound on tax rates

|              |                                          |
| ------------ | ---------------------------------------- |
| **Endpoint** | `POST /api/v1/taxes`                     |
| **Severity** | Medium                                   |
| **Input**    | `rate: "99999999.0"` and `rate: "250.0"` |
| **Response** | Both return 200                          |
| **Docs say** | Silent — no maximum rate documented.     |

Tax rates of 250% and 99,999,999% are accepted. While rates above 100% do exist in some jurisdictions (e.g., India's 150% cess on tobacco), a 99,999,999% rate is clearly unreasonable — a $50 invoice would generate ~$50 billion in taxes. Missing a sanity-check upper bound.

**Downstream impact verified:** Definition 06 creates a 99,999,999% tax, assigns it to a customer, creates a $100 one-off invoice, and verifies the result end-to-end: the database shows `taxes_amount_cents: 9,999,999,900` (~$100 million in taxes on a $100 fee), and the webhook delivered to our mock receiver carries the same computed amount. This is not theoretical — the billing pipeline actually computes and externalizes the absurd value.

**Reproduce:** `dokkimi run .dokkimi/lago/definitions/05-taxes-addons-invoices.yaml` — Steps "PROBE: Tax with rate > 100%" and "PROBE: Tax with absurdly large rate"; also definition 06 (DB + webhook verification)

### F-04: SSRF via webhook endpoint URL

|              |                                                           |
| ------------ | --------------------------------------------------------- |
| **Endpoint** | `POST /api/v1/webhook_endpoints`                          |
| **Severity** | Medium                                                    |
| **Input**    | `webhook_url: "http://169.254.169.254/latest/meta-data/"` |
| **Response** | 200 — webhook endpoint created                            |
| **Docs say** | Silent — no URL allowlist or SSRF protection documented.  |

The AWS instance metadata endpoint (`169.254.169.254`) is accepted as a webhook URL. Lago's `UrlValidator` only checks that the host is present and the scheme is HTTP/HTTPS — no IP or hostname filtering. The `SendHttpService` passes the URL directly to `Net::HTTP` with no SSRF protection, and no SSRF-filtering gems (`ssrf_filter`, `private_address_check`) are in the Gemfile. Invalid URLs (`not-a-url`) and `javascript:` URLs are correctly rejected — but internal network addresses pass validation.

This was previously reported via HackerOne (#2301565, closed January 2024). The fix does not appear in the open-source codebase — likely infrastructure-level (AWS IMDSv2, egress filtering). Self-hosted Lago deployments remain vulnerable.

**Note:** Definition 06 runs Sidekiq and confirms webhook delivery works end-to-end (via a mock receiver), but we used a non-SSRF URL for that test. The SSRF URL (`169.254.169.254`) was stored successfully in definition 05; the delivery path in source code has no filtering.

**Reproduce:** `dokkimi run .dokkimi/lago/definitions/05-taxes-addons-invoices.yaml` — Step "PROBE: Webhook with internal/SSRF URL"

### F-05: Coupon percentage override bypasses validation

|              |                                                                                                                                                                       |
| ------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Endpoint** | `POST /api/v1/applied_coupons`                                                                                                                                        |
| **Severity** | Medium                                                                                                                                                                |
| **Input**    | `percentage_rate: "-50.0"` and `percentage_rate: "200.0"` as overrides at application time                                                                            |
| **Response** | Both return 200                                                                                                                                                       |
| **Docs say** | Silent — the coupon creation endpoint documents `percentage_rate` as matching `^[0-9]+.?[0-9]*$` (non-negative), but the application override has no such validation. |

When applying a coupon, the `percentage_rate` can be overridden. A -50% override would INCREASE the invoice (surcharge instead of discount). A 200% override would make the invoice total negative. The `AppliedCoupon` model has zero validation on `percentage_rate` — not even a presence check — while `amount_cents` on the same model has explicit `numericality: {greater_than_or_equal_to: 0}` validation.

**Reproduce:** `dokkimi run .dokkimi/lago/definitions/03-coupons-and-discounts.yaml` — Steps "PROBE: Apply coupon with negative amount override" and "PROBE: Apply coupon with 200% override"

### F-06: 150% coupon percentage accepted

|              |                                            |
| ------------ | ------------------------------------------ |
| **Endpoint** | `POST /api/v1/coupons`                     |
| **Severity** | Low                                        |
| **Input**    | `percentage_rate: "150.0"`                 |
| **Response** | 200 — coupon created                       |
| **Docs say** | Silent — no maximum percentage documented. |

A percentage coupon with 150% discount is created successfully. When applied, this could result in a negative invoice balance (customer receives credit). No cap on percentage rate at creation time.

**Reproduce:** `dokkimi run .dokkimi/lago/definitions/03-coupons-and-discounts.yaml` — Step "PROBE: Percentage coupon > 100%"

### F-07: No upper bound on plan/add-on/wallet amounts

|               |                                                                        |
| ------------- | ---------------------------------------------------------------------- |
| **Endpoints** | `POST /api/v1/plans`, `POST /api/v1/add_ons`, `POST /api/v1/wallets`   |
| **Severity**  | Low                                                                    |
| **Input**     | `amount_cents: 99999999999999` / `granted_credits: "99999999999999.0"` |
| **Response**  | All return 200                                                         |
| **Docs say**  | Silent — no maximum values documented.                                 |

Plans, add-ons, and wallets all accept amounts of ~$1 trillion without validation. While values fit in bigint columns, downstream arithmetic (taxes, proration, multi-currency conversion) may overflow.

**Reproduce:** `dokkimi run .dokkimi/lago/definitions/02-billing-edge-cases.yaml` — Step 4; `05-taxes-addons-invoices.yaml` — "PROBE: Add-on with huge amount"; `04-wallets-and-credits.yaml` — "PROBE: Wallet with enormous credit balance"

### F-08: Ghost customer auto-creation on subscription

|              |                                                                                                                                                                                                             |
| ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Endpoint** | `POST /api/v1/subscriptions`                                                                                                                                                                                |
| **Severity** | Low                                                                                                                                                                                                         |
| **Input**    | `external_customer_id: "customer-does-not-exist"`                                                                                                                                                           |
| **Response** | 200 — customer silently created with no name, no email, no currency                                                                                                                                         |
| **Docs say** | Silent — the subscription endpoint defines a 404 response code, suggesting validation occurs, but docs never mention auto-creation. Likely consistent with Lago's upsert-first philosophy but undocumented. |

When subscribing a nonexistent customer, Lago auto-creates a bare-bones customer record and assigns the subscription. A typo in a customer ID creates phantom customers that are billed. The auto-created customer has `name: null`, `email: null`, `currency: null` — an incomplete record.

**Reproduce:** `dokkimi run .dokkimi/lago/definitions/01-basic-lifecycle.yaml` — Step 1.13

### F-09: Negative/zero/far-future event timestamps accepted

|              |                                                           |
| ------------ | --------------------------------------------------------- |
| **Endpoint** | `POST /api/v1/events`                                     |
| **Severity** | Low                                                       |
| **Input**    | `timestamp: -1`, `timestamp: 0`, `timestamp: 32503680000` |
| **Response** | All return 200                                            |
| **Docs say** | Silent — no timestamp range validation documented.        |

Events with timestamp `-1` (Dec 31, 1969), `0` (Jan 1, 1970 epoch), and `32503680000` (Jan 1, 3000) are all accepted. These events would either never aggregate (timestamps before the subscription started) or sit dormant for centuries.

**Reproduce:** `dokkimi run .dokkimi/lago/definitions/02-billing-edge-cases.yaml` — Steps 20-22

### F-10: XSS payload stored in customer name

|              |                                                                                                       |
| ------------ | ----------------------------------------------------------------------------------------------------- |
| **Endpoint** | `POST /api/v1/customers`                                                                              |
| **Severity** | Low (API-only) / Medium (if rendered in dashboard/invoices)                                           |
| **Input**    | `name: "<script>alert(\"xss\")</script>"`                                                             |
| **Response** | 200 — stored and returned verbatim                                                                    |
| **Docs say** | Silent — no documentation on input sanitization, XSS prevention, or HTML encoding for any text field. |

Customer names are not sanitized. The `<script>` tag is stored in the database and returned in API responses. If rendered unescaped in the Lago dashboard or embedded in PDF invoices (via the Gotenberg service), this becomes a stored XSS vulnerability.

**Reproduce:** `dokkimi run .dokkimi/lago/definitions/02-billing-edge-cases.yaml` — Step 8

### F-11: Multiple active subscriptions to same plan allowed

|              |                                                                                                                                                                                                                                                                           |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Endpoint** | `POST /api/v1/subscriptions`                                                                                                                                                                                                                                              |
| **Severity** | Low                                                                                                                                                                                                                                                                       |
| **Input**    | Two subscriptions with different `external_id` but same `plan_code` and `external_customer_id`                                                                                                                                                                            |
| **Response** | Both return 200 — two active subscriptions                                                                                                                                                                                                                                |
| **Docs say** | Docs say customers can hold "several subscriptions" by "assigning them multiple plans" — but this describes multiple different plans, not duplicates of the same plan. The `external_id` is described as "an idempotency key, ensuring that each subscription is unique." |

A single customer can hold two simultaneous active subscriptions to the same plan. Depending on business rules, this may result in double-billing. No warning or deduplication.

**Reproduce:** `dokkimi run .dokkimi/lago/definitions/02-billing-edge-cases.yaml` — Steps 15-16

## Documented Behaviors (Not Bugs)

These behaviors initially looked suspicious but are confirmed as intentional by Lago's documentation:

| Behavior                                                   | What we observed                                                 | What the docs say                                                                                                      |
| ---------------------------------------------------------- | ---------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| **Customer POST is an upsert**                             | Same `external_id` with different `name` → 200, name overwritten | Docs explicitly state: "This endpoint performs an upsert operation."                                                   |
| **Events silently accepted for nonexistent subscriptions** | `external_subscription_id: "sub-does-not-exist"` → 200           | Docs: events are processed asynchronously; unknown subscriptions are "ingested but not post-processed."                |
| **Events accepted for nonexistent metric codes**           | `code: "totally_fake_metric"` → 200                              | Docs: "If the provided code does not correspond to any active billable metric, it will be ignored during the process." |

## Well-Handled Cases

These behaviors were correctly validated by Lago:

| Probe                                | Expected        | Actual                          | Verdict |
| ------------------------------------ | --------------- | ------------------------------- | ------- |
| Duplicate plan code                  | 409/422         | 422 `value_already_exist`       | Correct |
| Subscription to nonexistent plan     | 404             | 404 `plan_not_found`            | Correct |
| Duplicate usage event (same txn_id)  | 409/422         | 422 `value_already_exist`       | Correct |
| No auth header                       | 401             | 401                             | Correct |
| Wrong API key                        | 401             | 401                             | Correct |
| Invalid currency                     | 422             | 422 `value_is_invalid`          | Correct |
| Zero amount plan (free tier)         | 200             | 200                             | Correct |
| Empty plan name/code                 | 422             | 422 `value_is_mandatory`        | Correct |
| Invalid interval                     | 422             | 422 `value_is_invalid`          | Correct |
| SQL injection in external_id         | Not exploitable | 200, stored safely              | Correct |
| Delete plan with active subscription | Soft delete     | 200 `pending_deletion: true`    | Correct |
| Negative coupon `amount_cents`       | 422             | 422 `value_is_out_of_range`     | Correct |
| Negative/zero add-on `amount_cents`  | 422             | 422 `value_is_out_of_range`     | Correct |
| Negative invoice `unit_amount_cents` | 422             | 422 `value_is_out_of_range`     | Correct |
| Negative wallet credits              | 422             | 422 `invalid_granted_credits`   | Correct |
| Negative/zero wallet `rate_amount`   | 422             | 422 `value_is_out_of_range`     | Correct |
| Wallet priority out of range (0, 51) | 422             | 422 `value_is_invalid`          | Correct |
| Wallet with past expiration          | 422             | 422 `invalid_date`              | Correct |
| Wallet for nonexistent customer      | 422             | 422 `customer_not_found`        | Correct |
| Wallet currency mismatch             | 422             | 422 `currencies_does_not_match` | Correct |
| Apply coupon to nonexistent customer | 404             | 404 `customer_not_found`        | Correct |
| Apply nonexistent coupon             | 404             | 404 `coupon_not_found`          | Correct |
| Invoice for nonexistent customer     | 404             | 404 `customer_not_found`        | Correct |
| Invoice with nonexistent add-on      | 404             | 404 `add_on_not_found`          | Correct |
| Terminate already-terminated sub     | 404             | 404 `subscription_not_found`    | Correct |
| Terminate nonexistent subscription   | 404             | 404 `subscription_not_found`    | Correct |
| Webhook with invalid URL             | 422             | 422 `url_is_invalid`            | Correct |
| Webhook with `javascript:` URL       | 422             | 422 `url_is_invalid`            | Correct |

## Validation Inconsistencies

One pattern worth noting: Lago's validation is inconsistent across entity types for the same field concept.

| Validation           | Plans                | Coupons      | Add-ons      | Taxes          |
| -------------------- | -------------------- | ------------ | ------------ | -------------- |
| **Negative amounts** | Accepted (bug)       | Rejected 422 | Rejected 422 | Accepted (bug) |
| **Zero amounts**     | Accepted (free tier) | Accepted     | Rejected 422 | Accepted       |
| **Upper bound**      | None                 | None         | None         | None           |

## Dokkimi Definition Files

- `.dokkimi/lago/definitions/01-basic-lifecycle.yaml` — 21 steps: billing lifecycle + edge cases
- `.dokkimi/lago/definitions/02-billing-edge-cases.yaml` — 22 steps: extreme amounts, timestamps, XSS, plan lifecycle
- `.dokkimi/lago/definitions/03-coupons-and-discounts.yaml` — 19 steps: coupon creation, application, stacking, overrides
- `.dokkimi/lago/definitions/04-wallets-and-credits.yaml` — 13 steps: wallet creation, credits, priority bounds, expiration
- `.dokkimi/lago/definitions/05-taxes-addons-invoices.yaml` — 22 steps: taxes, add-ons, invoices, subscription lifecycle, webhooks
- `.dokkimi/lago/definitions/06-inter-service-traffic.yaml` — 19 steps: DB assertions proving invalid data persists, webhook delivery via mock with absurd tax computation verified end-to-end
