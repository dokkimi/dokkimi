# Lago Bug-Hunting Report

**Target:** [getlago/lago-api](https://github.com/getlago/lago-api) v1.48.1 (10k-star open-source billing platform)
**Tested with:** Dokkimi — deployed full Lago stack (Rails API + Postgres + Redis) with interceptor sidecars
**Date:** 2026-06-28 (initial), 2026-07-02 (expanded)

## What is Lago?

Lago is an open-source billing and metering engine. It manages customers, billable metrics, plans, subscriptions, usage events, and invoices for SaaS companies. The API is a Rails 8.0.5 application backed by PostgreSQL with a Redis queue for Sidekiq workers.

## What we did

Deployed Lago's API service with a custom wrapper image (RSA key generation, migration execution, org seeding) against Postgres 15 with pg_partman and Redis. Ran nine Dokkimi test definitions (161 total test steps) covering:

- **Round 1** (definitions 01–06): billing lifecycle, coupons, wallets, taxes, add-ons, invoices, subscription lifecycle, webhook configuration, and cross-service verification via DB assertions and mock webhook receiver.
- **Round 2** (definitions 07–09): targeted probes informed by source-code analysis of the Lago codebase — wallet state machine violations, invoice voided-state bypasses, and deeper validation gaps across plans, coupons, customers, billable metrics, and metadata.

Cross-referenced all findings against [Lago's official documentation](https://docs.getlago.com) and the Rails source code to separate real bugs from intentional design decisions.

## Summary

Lago lets you create things with values that make no sense for a billing system, and those values get stored and used. But it goes beyond input validation — **Lago also fails to enforce its own state machine rules**, allowing mutations on terminated wallets and voided invoices.

1. **You can create a subscription plan that charges negative dollars.** Like a plan that costs -$1/month. Coupons and add-ons correctly reject negative amounts — plans just don't check.
2. **You can create a tax rate of -10%.** Instead of adding tax to an invoice, it would subtract from it. A -100% tax rate would zero out every invoice. Lago has a proper system for credits and refunds — negative tax rates shouldn't exist.
3. **Tax rates have no ceiling.** You can set a 99,999,999% tax rate. A $50 charge would generate $50 billion in taxes.
4. **You can point Lago's webhook system at internal servers.** An attacker can register `http://169.254.169.254` (AWS's internal metadata service) as a webhook URL. When Lago fires a webhook, it would hit that internal address from inside the network, potentially leaking cloud credentials. This was already reported on HackerOne but the fix isn't in the open-source code.
5. **When applying a coupon, you can override the discount to -50%.** A negative discount becomes a surcharge — the customer pays more, not less. Or override to 200% and the invoice goes negative. The coupon itself validates amounts, but the override at application time doesn't check at all.
6. **You can mark a voided invoice as "paid".** After voiding an invoice (making it null and void), you can still set its `payment_status` to `succeeded`. This triggers downstream webhooks and payment processing jobs on an invoice that should be inert.
7. **You can update a terminated wallet.** After terminating a wallet, you can still change its name, priority, and expiration date via the API. The `WalletUpdateService` checks that the wallet exists but never checks whether it's terminated.
8. **Duplicate wallet top-ups have no idempotency protection.** Sending the same top-up request twice creates two separate transactions and doubles the charge. There's no idempotency key on manual wallet top-ups.
9. **Plans accept negative trial periods.** A `trial_period: -30` is stored as-is. The helper method `trial_period?` checks `.positive?` for display purposes, but the negative value persists in the database and could cause undefined behavior in billing calculations.
10. **Coupon percentage rates can be negative at creation.** The `Coupon` model only validates `presence: true` on `percentage_rate` — no numericality check. A -25% coupon is created successfully.

The common thread: **validation gaps at the API boundary and state machine violations.** The data gets stored as-is and would flow into invoice calculations, tax computations, and webhook delivery without any downstream safety net. State transitions (voided, terminated) don't fully lock down the affected resources.

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

**Reproduce:** `dokkimi run .dokkimi/oss-probes/lago/definitions/01-basic-lifecycle.yaml` — Step 1.19; also definition 06 (DB assertion)

### F-02: Negative tax rates accepted

|              |                                                                                                                    |
| ------------ | ------------------------------------------------------------------------------------------------------------------ |
| **Endpoint** | `POST /api/v1/taxes`                                                                                               |
| **Severity** | High                                                                                                               |
| **Input**    | `rate: "-10.0"`                                                                                                    |
| **Response** | 200 — tax created with `rate: -10`                                                                                 |
| **Docs say** | Silent — rate is defined as a string matching `^[0-9]+.?[0-9]*$` in the docs, but the API accepts negative values. |

A -10% tax rate would reduce invoice totals. A -100% rate would zero out every invoice. The OpenAPI schema regex `^[0-9]+.?[0-9]*$` intends to block negatives, but the Rails `Tax` model only validates presence — no numericality check. Lago has a dedicated credit notes system for tax adjustments and refunds, making negative tax rates unnecessary.

**Reproduce:** `dokkimi run .dokkimi/oss-probes/lago/definitions/05-taxes-addons-invoices.yaml` — Step "PROBE: Tax with negative rate"

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

**Reproduce:** `dokkimi run .dokkimi/oss-probes/lago/definitions/05-taxes-addons-invoices.yaml` — Steps "PROBE: Tax with rate > 100%" and "PROBE: Tax with absurdly large rate"; also definition 06 (DB + webhook verification)

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

**Reproduce:** `dokkimi run .dokkimi/oss-probes/lago/definitions/05-taxes-addons-invoices.yaml` — Step "PROBE: Webhook with internal/SSRF URL"

### F-05: Coupon percentage override bypasses validation

|              |                                                                                                                                                                       |
| ------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Endpoint** | `POST /api/v1/applied_coupons`                                                                                                                                        |
| **Severity** | Medium                                                                                                                                                                |
| **Input**    | `percentage_rate: "-50.0"` and `percentage_rate: "200.0"` as overrides at application time                                                                            |
| **Response** | Both return 200                                                                                                                                                       |
| **Docs say** | Silent — the coupon creation endpoint documents `percentage_rate` as matching `^[0-9]+.?[0-9]*$` (non-negative), but the application override has no such validation. |

When applying a coupon, the `percentage_rate` can be overridden. A -50% override would INCREASE the invoice (surcharge instead of discount). A 200% override would make the invoice total negative. The `AppliedCoupon` model has zero validation on `percentage_rate` — not even a presence check — while `amount_cents` on the same model has explicit `numericality: {greater_than_or_equal_to: 0}` validation.

**Reproduce:** `dokkimi run .dokkimi/oss-probes/lago/definitions/03-coupons-and-discounts.yaml` — Steps "PROBE: Apply coupon with negative amount override" and "PROBE: Apply coupon with 200% override"

### F-06: 150% coupon percentage accepted

|              |                                            |
| ------------ | ------------------------------------------ |
| **Endpoint** | `POST /api/v1/coupons`                     |
| **Severity** | Low                                        |
| **Input**    | `percentage_rate: "150.0"`                 |
| **Response** | 200 — coupon created                       |
| **Docs say** | Silent — no maximum percentage documented. |

A percentage coupon with 150% discount is created successfully. When applied, this could result in a negative invoice balance (customer receives credit). No cap on percentage rate at creation time.

**Reproduce:** `dokkimi run .dokkimi/oss-probes/lago/definitions/03-coupons-and-discounts.yaml` — Step "PROBE: Percentage coupon > 100%"

### F-07: No upper bound on plan/add-on/wallet amounts

|               |                                                                        |
| ------------- | ---------------------------------------------------------------------- |
| **Endpoints** | `POST /api/v1/plans`, `POST /api/v1/add_ons`, `POST /api/v1/wallets`   |
| **Severity**  | Low                                                                    |
| **Input**     | `amount_cents: 99999999999999` / `granted_credits: "99999999999999.0"` |
| **Response**  | All return 200                                                         |
| **Docs say**  | Silent — no maximum values documented.                                 |

Plans, add-ons, and wallets all accept amounts of ~$1 trillion without validation. While values fit in bigint columns, downstream arithmetic (taxes, proration, multi-currency conversion) may overflow.

**Reproduce:** `dokkimi run .dokkimi/oss-probes/lago/definitions/02-billing-edge-cases.yaml` — Step 4; `05-taxes-addons-invoices.yaml` — "PROBE: Add-on with huge amount"; `04-wallets-and-credits.yaml` — "PROBE: Wallet with enormous credit balance"

### F-08: Ghost customer auto-creation on subscription

|              |                                                                                                                                                                                                             |
| ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Endpoint** | `POST /api/v1/subscriptions`                                                                                                                                                                                |
| **Severity** | Low                                                                                                                                                                                                         |
| **Input**    | `external_customer_id: "customer-does-not-exist"`                                                                                                                                                           |
| **Response** | 200 — customer silently created with no name, no email, no currency                                                                                                                                         |
| **Docs say** | Silent — the subscription endpoint defines a 404 response code, suggesting validation occurs, but docs never mention auto-creation. Likely consistent with Lago's upsert-first philosophy but undocumented. |

When subscribing a nonexistent customer, Lago auto-creates a bare-bones customer record and assigns the subscription. A typo in a customer ID creates phantom customers that are billed. The auto-created customer has `name: null`, `email: null`, `currency: null` — an incomplete record.

**Reproduce:** `dokkimi run .dokkimi/oss-probes/lago/definitions/01-basic-lifecycle.yaml` — Step 1.13

### F-09: Negative/zero/far-future event timestamps accepted

|              |                                                           |
| ------------ | --------------------------------------------------------- |
| **Endpoint** | `POST /api/v1/events`                                     |
| **Severity** | Low                                                       |
| **Input**    | `timestamp: -1`, `timestamp: 0`, `timestamp: 32503680000` |
| **Response** | All return 200                                            |
| **Docs say** | Silent — no timestamp range validation documented.        |

Events with timestamp `-1` (Dec 31, 1969), `0` (Jan 1, 1970 epoch), and `32503680000` (Jan 1, 3000) are all accepted. These events would either never aggregate (timestamps before the subscription started) or sit dormant for centuries.

**Reproduce:** `dokkimi run .dokkimi/oss-probes/lago/definitions/02-billing-edge-cases.yaml` — Steps 20-22

### F-10: XSS payload stored in customer name

|              |                                                                                                       |
| ------------ | ----------------------------------------------------------------------------------------------------- |
| **Endpoint** | `POST /api/v1/customers`                                                                              |
| **Severity** | Low (API-only) / Medium (if rendered in dashboard/invoices)                                           |
| **Input**    | `name: "<script>alert(\"xss\")</script>"`                                                             |
| **Response** | 200 — stored and returned verbatim                                                                    |
| **Docs say** | Silent — no documentation on input sanitization, XSS prevention, or HTML encoding for any text field. |

Customer names are not sanitized. The `<script>` tag is stored in the database and returned in API responses. If rendered unescaped in the Lago dashboard or embedded in PDF invoices (via the Gotenberg service), this becomes a stored XSS vulnerability.

**Reproduce:** `dokkimi run .dokkimi/oss-probes/lago/definitions/02-billing-edge-cases.yaml` — Step 8

### F-11: Multiple active subscriptions to same plan allowed

|              |                                                                                                                                                                                                                                                                           |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Endpoint** | `POST /api/v1/subscriptions`                                                                                                                                                                                                                                              |
| **Severity** | Low                                                                                                                                                                                                                                                                       |
| **Input**    | Two subscriptions with different `external_id` but same `plan_code` and `external_customer_id`                                                                                                                                                                            |
| **Response** | Both return 200 — two active subscriptions                                                                                                                                                                                                                                |
| **Docs say** | Docs say customers can hold "several subscriptions" by "assigning them multiple plans" — but this describes multiple different plans, not duplicates of the same plan. The `external_id` is described as "an idempotency key, ensuring that each subscription is unique." |

A single customer can hold two simultaneous active subscriptions to the same plan. Depending on business rules, this may result in double-billing. No warning or deduplication.

**Reproduce:** `dokkimi run .dokkimi/oss-probes/lago/definitions/02-billing-edge-cases.yaml` — Steps 15-16

### F-12: Payment status changeable on voided invoices

|              |                                                                                      |
| ------------ | ------------------------------------------------------------------------------------ |
| **Endpoint** | `PUT /api/v1/invoices/{id}`                                                          |
| **Severity** | High                                                                                 |
| **Input**    | `payment_status: "succeeded"` and `payment_status: "failed"` on a voided invoice     |
| **Response** | Both return 200 — payment status updated                                             |
| **Docs say** | Silent — voided invoices should be immutable; the void action "cancels" the invoice. |

After voiding an invoice (which should make it inert), the `payment_status` can still be changed to `succeeded` or `failed` via the update endpoint. The `InvoicesUpdateService` blocks payment status changes on **draft** invoices (line 34: `if invoice.draft? && (old_payment_status != invoice.payment_status)`) but has no equivalent check for **voided** invoices. Only the `ready_for_payment_processing` field checks `!invoice.voided?` (line 38).

Setting `payment_status: succeeded` on a voided invoice triggers `SendWebhookJob.perform_after_commit("invoice.payment_status_updated", invoice)`, `Invoices::PrepaidCreditJob`, and `handle_payment_gated_activation` — all of which execute on an invoice that was supposed to be cancelled.

**Source:** `app/services/invoices/update_service.rb:32-38`

**Reproduce:** `dokkimi run .dokkimi/oss-probes/lago/definitions/08-invoice-voided-bugs.yaml` — Steps "PROBE: Set payment_status to succeeded on voided invoice" and "PROBE: Set payment_status to failed on voided invoice"

### F-13: Terminated wallets can be updated

|              |                                                                                  |
| ------------ | -------------------------------------------------------------------------------- |
| **Endpoint** | `PUT /api/v1/wallets/{id}`                                                       |
| **Severity** | High                                                                             |
| **Input**    | `name`, `priority`, `expiration_at` on a terminated wallet                       |
| **Response** | All return 200 — wallet updated                                                  |
| **Docs say** | Silent — terminated wallets should be frozen; termination is described as final. |

After terminating a wallet, the name, priority, and expiration date can all be changed via the update endpoint. The `WalletUpdateService#call` checks `unless wallet` (not found) on line 21 but never checks `wallet.terminated?`. The wallet is found in the database — it still exists, it's just in a `terminated` state — so the update proceeds.

This is a state machine violation: terminated is supposed to be a terminal state, but the wallet remains fully mutable (except for balance changes, which are correctly rejected with 422).

**Source:** `app/services/wallets/update_service.rb:20-21` — missing `wallet.terminated?` guard

**Reproduce:** `dokkimi run .dokkimi/oss-probes/lago/definitions/07-wallet-lifecycle-bugs.yaml` — Steps "PROBE: Update terminated wallet name", "PROBE: Update terminated wallet priority", "PROBE: Update terminated wallet expiration"

### F-14: Metadata writable on voided invoices

|              |                                                                            |
| ------------ | -------------------------------------------------------------------------- |
| **Endpoint** | `PUT /api/v1/invoices/{id}`                                                |
| **Severity** | Medium                                                                     |
| **Input**    | `metadata: [{key: "ghost-key", value: "ghost-value"}]` on a voided invoice |
| **Response** | 200 — metadata added                                                       |
| **Docs say** | Silent — voided invoices should be immutable.                              |

Metadata can be added to voided invoices. The `InvoicesUpdateService` has no state check at all on metadata updates — neither draft nor voided status is checked before writing metadata. This modifies an invoice that should be frozen.

**Reproduce:** `dokkimi run .dokkimi/oss-probes/lago/definitions/08-invoice-voided-bugs.yaml` — Step "PROBE: Add metadata to voided invoice"

### F-15: Duplicate wallet top-ups (no idempotency)

|              |                                                                 |
| ------------ | --------------------------------------------------------------- |
| **Endpoint** | `POST /api/v1/wallet_transactions`                              |
| **Severity** | Medium                                                          |
| **Input**    | Same `{wallet_id, paid_credits: "100.0"}` sent twice            |
| **Response** | Both return 200 — two separate wallet transactions created      |
| **Docs say** | Silent — no idempotency key documented for wallet transactions. |

Sending the exact same wallet top-up request twice creates two separate wallet transactions. There is no idempotency key on manual top-ups. In a production scenario, a network retry or double-click could charge the customer twice. The wallet balance reflects both transactions.

This contrasts with events (`POST /api/v1/events`), which do have a `transaction_id` for idempotency and correctly reject duplicates with 422 `value_already_exist`.

**Reproduce:** `dokkimi run .dokkimi/oss-probes/lago/definitions/07-wallet-lifecycle-bugs.yaml` — Steps "PROBE: First top-up (should succeed)" and "PROBE: Duplicate top-up (same payload, no idempotency key)"

### F-16: Negative trial period accepted on plans

|              |                                                                                                       |
| ------------ | ----------------------------------------------------------------------------------------------------- |
| **Endpoint** | `POST /api/v1/plans`                                                                                  |
| **Severity** | Medium                                                                                                |
| **Input**    | `trial_period: -30`, `trial_period: 0.5`, `trial_period: 999999999`                                   |
| **Response** | All return 200                                                                                        |
| **Docs say** | Silent — `trial_period` is documented as "number of days" but no range or type validation documented. |

The `Plan` model has zero validation on `trial_period` (a float column). Negative values (-30 days), fractional values (0.5 days), and absurdly large values (999,999,999 days = ~2.7 million years) are all accepted. The helper method `trial_period?` (line 87: `trial_period.present? && trial_period.positive?`) checks positivity for display purposes, but the stored value is used directly in billing period calculations.

**Source:** `app/models/plan.rb:168` — `trial_period :float` with no validates

**Reproduce:** `dokkimi run .dokkimi/oss-probes/lago/definitions/09-deeper-validation-gaps.yaml` — Steps "PROBE: Plan with negative trial_period", "PROBE: Plan with fractional trial_period", "PROBE: Plan with absurdly large trial_period"

### F-17: Negative coupon percentage rate accepted at creation

|              |                                                                                                |
| ------------ | ---------------------------------------------------------------------------------------------- |
| **Endpoint** | `POST /api/v1/coupons`                                                                         |
| **Severity** | Medium                                                                                         |
| **Input**    | `percentage_rate: "-25.0"` and `percentage_rate: "0.0"`                                        |
| **Response** | Both return 200                                                                                |
| **Docs say** | Silent — `percentage_rate` docs show regex `^[0-9]+.?[0-9]*$` (non-negative) but not enforced. |

The `Coupon` model validates `percentage_rate` with only `presence: true, if: :percentage?` (line 60) — no numericality validation. Meanwhile, `amount_cents` on the same model has `numericality: {greater_than: 0}` (line 55). A -25% percentage coupon would surcharge the customer instead of discounting. A 0% coupon would apply but do nothing.

This is distinct from F-05 (override at application time) — here the coupon itself is created with invalid rates.

**Source:** `app/models/coupon.rb:60` — missing numericality validation on `percentage_rate`

**Reproduce:** `dokkimi run .dokkimi/oss-probes/lago/definitions/09-deeper-validation-gaps.yaml` — Steps "PROBE: Coupon with negative percentage_rate at creation" and "PROBE: Coupon with zero percentage_rate at creation"

### F-18: No string length limits on customer fields

|              |                                                             |
| ------------ | ----------------------------------------------------------- |
| **Endpoint** | `POST /api/v1/customers`                                    |
| **Severity** | Low                                                         |
| **Input**    | `name` with 10,000 characters; `email` with 250+ characters |
| **Response** | Both return 200                                             |
| **Docs say** | Silent — no length limits documented on any customer field. |

The `Customer` model has no length validation on `name`, `email`, `external_id`, or any other string field. A 10,000-character name and a 250+ character email are both stored successfully. This could cause rendering issues in the dashboard/invoices, PDF generation failures (Gotenberg), and database bloat. Rails' default `string` type maps to `varchar(255)` in PostgreSQL, but `text` columns (which Lago uses for several fields) have no implicit limit.

**Reproduce:** `dokkimi run .dokkimi/oss-probes/lago/definitions/09-deeper-validation-gaps.yaml` — Steps "PROBE: Customer with 10K character name" and "PROBE: Customer with extremely long email"

### F-19: Billable metric rounding precision unbounded

|              |                                                           |
| ------------ | --------------------------------------------------------- |
| **Endpoint** | `POST /api/v1/billable_metrics`                           |
| **Severity** | Low                                                       |
| **Input**    | `rounding_precision: -5` and `rounding_precision: 999999` |
| **Response** | Both return 200                                           |
| **Docs say** | Silent — no bounds documented.                            |

The `BillableMetric` model has no bounds validation on `rounding_precision`. Negative values and absurdly large values are accepted. A negative rounding precision could cause `BigDecimal` rounding errors in aggregation calculations. A precision of 999,999 could cause performance issues or memory allocation problems during decimal arithmetic.

**Source:** `app/models/billable_metric.rb` — `rounding_precision` with no validates

**Reproduce:** `dokkimi run .dokkimi/oss-probes/lago/definitions/09-deeper-validation-gaps.yaml` — Steps "PROBE: Billable metric with negative rounding_precision" and "PROBE: Billable metric with huge rounding_precision"

### F-20: Invoice metadata value has no length limit

|              |                                                                  |
| ------------ | ---------------------------------------------------------------- |
| **Endpoint** | `PUT /api/v1/invoices/{id}`                                      |
| **Severity** | Low                                                              |
| **Input**    | Metadata value with 1,000+ characters                            |
| **Response** | 200 — stored                                                     |
| **Docs say** | Silent — no length limits documented on metadata keys or values. |

Invoice metadata values have no length validation. The `InvoiceMetadata` model's `value` column is a text field with no length constraint in the model layer. Arbitrarily large metadata values are stored and returned in API responses, webhook payloads, and potentially PDF invoices.

**Reproduce:** `dokkimi run .dokkimi/oss-probes/lago/definitions/09-deeper-validation-gaps.yaml` — Step "PROBE: Invoice metadata with very long value"

### F-21: Negative minimum commitment amount on plans

|              |                                                                  |
| ------------ | ---------------------------------------------------------------- |
| **Endpoint** | `POST /api/v1/plans`                                             |
| **Severity** | Medium                                                           |
| **Input**    | `minimum_commitment: {amount_cents: -1000}`                      |
| **Response** | 200 — plan created with negative minimum commitment              |
| **Docs say** | Silent — no validation documented on minimum commitment amounts. |

Plans accept a negative `minimum_commitment.amount_cents`. A minimum commitment is supposed to set a floor — the customer is charged at least this amount regardless of usage. A negative minimum commitment inverts the logic: it could result in credits being issued when usage is below the (negative) threshold.

**Reproduce:** `dokkimi run .dokkimi/oss-probes/lago/definitions/09-deeper-validation-gaps.yaml` — Step "PROBE: Plan with negative minimum_commitment amount"

### F-22: Sub-penny precision tax rates accepted

|              |                                                       |
| ------------ | ----------------------------------------------------- |
| **Endpoint** | `POST /api/v1/taxes`                                  |
| **Severity** | Low                                                   |
| **Input**    | `rate: "0.001"`                                       |
| **Response** | 200 — tax created                                     |
| **Docs say** | Silent — no precision limits documented on tax rates. |

Tax rates with sub-penny precision (0.001%) are accepted. While the `Tax` model stores `rate` as a `float`, extremely small or precise rates could cause rounding inconsistencies in invoice calculations, especially when multiplied across large amounts or many line items. Real-world tax rates are defined to at most 2-3 decimal places.

**Reproduce:** `dokkimi run .dokkimi/oss-probes/lago/definitions/09-deeper-validation-gaps.yaml` — Step "PROBE: Tax with sub-penny precision rate"

## Documented Behaviors (Not Bugs)

These behaviors initially looked suspicious but are confirmed as intentional by Lago's documentation:

| Behavior                                                   | What we observed                                                 | What the docs say                                                                                                      |
| ---------------------------------------------------------- | ---------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| **Customer POST is an upsert**                             | Same `external_id` with different `name` → 200, name overwritten | Docs explicitly state: "This endpoint performs an upsert operation."                                                   |
| **Events silently accepted for nonexistent subscriptions** | `external_subscription_id: "sub-does-not-exist"` → 200           | Docs: events are processed asynchronously; unknown subscriptions are "ingested but not post-processed."                |
| **Events accepted for nonexistent metric codes**           | `code: "totally_fake_metric"` → 200                              | Docs: "If the provided code does not correspond to any active billable metric, it will be ignored during the process." |

## Well-Handled Cases

These behaviors were correctly validated by Lago:

| Probe                                       | Expected        | Actual                          | Verdict |
| ------------------------------------------- | --------------- | ------------------------------- | ------- |
| Duplicate plan code                         | 409/422         | 422 `value_already_exist`       | Correct |
| Subscription to nonexistent plan            | 404             | 404 `plan_not_found`            | Correct |
| Duplicate usage event (same txn_id)         | 409/422         | 422 `value_already_exist`       | Correct |
| No auth header                              | 401             | 401                             | Correct |
| Wrong API key                               | 401             | 401                             | Correct |
| Invalid currency                            | 422             | 422 `value_is_invalid`          | Correct |
| Zero amount plan (free tier)                | 200             | 200                             | Correct |
| Empty plan name/code                        | 422             | 422 `value_is_mandatory`        | Correct |
| Invalid interval                            | 422             | 422 `value_is_invalid`          | Correct |
| SQL injection in external_id                | Not exploitable | 200, stored safely              | Correct |
| Delete plan with active subscription        | Soft delete     | 200 `pending_deletion: true`    | Correct |
| Negative coupon `amount_cents`              | 422             | 422 `value_is_out_of_range`     | Correct |
| Negative/zero add-on `amount_cents`         | 422             | 422 `value_is_out_of_range`     | Correct |
| Negative invoice `unit_amount_cents`        | 422             | 422 `value_is_out_of_range`     | Correct |
| Negative wallet credits                     | 422             | 422 `invalid_granted_credits`   | Correct |
| Negative/zero wallet `rate_amount`          | 422             | 422 `value_is_out_of_range`     | Correct |
| Wallet priority out of range (0, 51)        | 422             | 422 `value_is_invalid`          | Correct |
| Wallet with past expiration                 | 422             | 422 `invalid_date`              | Correct |
| Wallet for nonexistent customer             | 422             | 422 `customer_not_found`        | Correct |
| Wallet currency mismatch                    | 422             | 422 `currencies_does_not_match` | Correct |
| Apply coupon to nonexistent customer        | 404             | 404 `customer_not_found`        | Correct |
| Apply nonexistent coupon                    | 404             | 404 `coupon_not_found`          | Correct |
| Invoice for nonexistent customer            | 404             | 404 `customer_not_found`        | Correct |
| Invoice with nonexistent add-on             | 404             | 404 `add_on_not_found`          | Correct |
| Terminate already-terminated sub            | 404             | 404 `subscription_not_found`    | Correct |
| Terminate nonexistent subscription          | 404             | 404 `subscription_not_found`    | Correct |
| Webhook with invalid URL                    | 422             | 422 `url_is_invalid`            | Correct |
| Webhook with `javascript:` URL              | 422             | 422 `url_is_invalid`            | Correct |
| Top up terminated wallet (paid_credits)     | 422             | 422                             | Correct |
| Top up terminated wallet (granted_credits)  | 422             | 422                             | Correct |
| Void already-voided invoice                 | 405             | 405                             | Correct |
| Retry payment on voided invoice             | 405             | 405                             | Correct |
| Subscription plan_overrides currency change | 403             | 403 (premium feature)           | Correct |

## Validation Inconsistencies

Lago's validation is inconsistent across entity types for the same field concept.

| Validation              | Plans                | Coupons        | Add-ons      | Taxes          | Wallets      |
| ----------------------- | -------------------- | -------------- | ------------ | -------------- | ------------ |
| **Negative amounts**    | Accepted (bug)       | Rejected 422   | Rejected 422 | Accepted (bug) | Rejected 422 |
| **Zero amounts**        | Accepted (free tier) | Accepted       | Rejected 422 | Accepted       | Rejected 422 |
| **Upper bound**         | None                 | None           | None         | None           | None         |
| **Negative percentage** | N/A                  | Accepted (bug) | N/A          | N/A            | N/A          |

State machine enforcement is also inconsistent:

| Action after terminal state | Wallets (terminated) | Invoices (voided) | Subscriptions (terminated) |
| --------------------------- | -------------------- | ----------------- | -------------------------- |
| **Update metadata/fields**  | Accepted (bug)       | Accepted (bug)    | N/A (no update endpoint)   |
| **Change payment status**   | N/A                  | Accepted (bug)    | N/A                        |
| **Top up / credit**         | Rejected 422         | N/A               | N/A                        |
| **Delete / void again**     | N/A                  | Rejected 405      | Rejected 404               |
| **Retry payment**           | N/A                  | Rejected 405      | N/A                        |

## Dokkimi Definition Files

- `.dokkimi/oss-probes/lago/definitions/01-basic-lifecycle.yaml` — 21 steps: billing lifecycle + edge cases
- `.dokkimi/oss-probes/lago/definitions/02-billing-edge-cases.yaml` — 22 steps: extreme amounts, timestamps, XSS, plan lifecycle
- `.dokkimi/oss-probes/lago/definitions/03-coupons-and-discounts.yaml` — 19 steps: coupon creation, application, stacking, overrides
- `.dokkimi/oss-probes/lago/definitions/04-wallets-and-credits.yaml` — 13 steps: wallet creation, credits, priority bounds, expiration
- `.dokkimi/oss-probes/lago/definitions/05-taxes-addons-invoices.yaml` — 22 steps: taxes, add-ons, invoices, subscription lifecycle, webhooks
- `.dokkimi/oss-probes/lago/definitions/06-inter-service-traffic.yaml` — 19 steps: DB assertions proving invalid data persists, webhook delivery via mock with absurd tax computation verified end-to-end
- `.dokkimi/oss-probes/lago/definitions/07-wallet-lifecycle-bugs.yaml` — 14 steps: terminated wallet updates, terminated wallet top-ups, duplicate top-up idempotency
- `.dokkimi/oss-probes/lago/definitions/08-invoice-voided-bugs.yaml` — 14 steps: payment status on voided invoices, metadata on voided invoices, credit notes against voided invoices, double-void, retry payment
- `.dokkimi/oss-probes/lago/definitions/09-deeper-validation-gaps.yaml` — 17 steps: negative trial periods, negative coupon percentage rates, oversized customer fields, billable metric precision, metadata length, minimum commitment, currency override, sub-penny tax rates
