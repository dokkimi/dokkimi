## Context

We're building [Dokkimi](https://dokkimi.com), a tool for testing microservices in isolated Docker environments. To stress-test our own tool, we deployed a full Lago stack (Rails API + Postgres + Redis) and ran automated probes against it. We picked Lago because it's one of the more complete open-source billing systems out there — this isn't a hit piece, it's a byproduct of us testing our own thing against real software.

We ran 161 test steps across 9 definition files against **v1.48.1**. Below is everything we found, grouped by category. Some of these may be intentional design decisions we're misreading — happy to be corrected.

## The big ones

These three stood out because they're **state machine violations**, not just missing input validation. They let you mutate resources that should be frozen.

### Voided invoices can be marked as "paid" (High)

`PUT /api/v1/invoices/{id}` with `payment_status: "succeeded"` returns 200 on a voided invoice. The update service blocks this on draft invoices (`InvoicesUpdateService` line 34) but not voided ones. This triggers `SendWebhookJob`, `PrepaidCreditJob`, and `handle_payment_gated_activation` — all on an invoice that was supposed to be cancelled. Metadata is also writable on voided invoices via the same endpoint.

### Terminated wallets can be updated (High)

`PUT /api/v1/wallets/{id}` returns 200 for name, priority, and expiration changes on a terminated wallet. `WalletUpdateService#call` checks `unless wallet` (not found) but never checks `wallet.terminated?`. Balance top-ups are correctly rejected with 422 — but field updates aren't.

### Duplicate wallet top-ups — no idempotency (Medium)

`POST /api/v1/wallet_transactions` with the same payload twice creates two separate transactions. No idempotency key. A network retry or double-click doubles the charge. This contrasts with events, which have `transaction_id` for idempotency.

## Validation gaps

These are missing numericality/bounds checks. The pattern is that some entity types validate a field and others don't — e.g., `Coupon` and `AddOn` reject negative `amount_cents`, but `Plan` doesn't.

| Severity   | Finding                                      | Endpoint                          | Input                                    | Response              |
| ---------- | -------------------------------------------- | --------------------------------- | ---------------------------------------- | --------------------- |
| **High**   | Negative plan amounts                        | `POST /plans`                     | `amount_cents: -100`                     | 200                   |
| **High**   | Negative tax rates                           | `POST /taxes`                     | `rate: "-10.0"`                          | 200                   |
| **Medium** | No upper bound on tax rates                  | `POST /taxes`                     | `rate: "99999999.0"`                     | 200                   |
| **Medium** | Coupon override bypasses validation          | `POST /applied_coupons`           | `percentage_rate: "-50.0"`               | 200                   |
| **Medium** | Negative trial period on plans               | `POST /plans`                     | `trial_period: -30`                      | 200                   |
| **Medium** | Negative coupon percentage at creation       | `POST /coupons`                   | `percentage_rate: "-25.0"`               | 200                   |
| **Medium** | Negative minimum commitment                  | `POST /plans`                     | `minimum_commitment.amount_cents: -1000` | 200                   |
| **Low**    | 150% coupon percentage                       | `POST /coupons`                   | `percentage_rate: "150.0"`               | 200                   |
| **Low**    | No upper bound on amounts                    | `POST /plans, /add_ons, /wallets` | `amount_cents: 99999999999999`           | 200                   |
| **Low**    | No string length limits (customers)          | `POST /customers`                 | 10K-char name, 250-char email            | 200                   |
| **Low**    | Billable metric rounding_precision unbounded | `POST /billable_metrics`          | `rounding_precision: -5`                 | 200                   |
| **Low**    | Invoice metadata no length limit             | `PUT /invoices/{id}`              | 1000+ char metadata value                | 200                   |
| **Low**    | Sub-penny tax rates                          | `POST /taxes`                     | `rate: "0.001"`                          | 200                   |
| **Low**    | XSS payload in customer name                 | `POST /customers`                 | `<script>` tag in name                   | 200, stored verbatim  |
| **Low**    | Ghost customer auto-creation                 | `POST /subscriptions`             | Nonexistent customer ID                  | 200, customer created |
| **Low**    | Negative/far-future event timestamps         | `POST /events`                    | `timestamp: -1`                          | 200                   |
| **Low**    | Duplicate subscriptions to same plan         | `POST /subscriptions`             | Same plan_code, different external_id    | 200                   |

## What Lago gets right

We also tested 33 cases that Lago handles correctly — auth failures, duplicate plan codes, negative wallet credits, currency mismatches, nonexistent resources, SQL injection, terminated subscription re-termination, and more. The validation that exists is solid. The issue is coverage, not quality.

## Reproduce

All findings are reproducible with `curl` against a stock Lago deployment. We also have the full test definitions available — they deploy the Lago stack, run the probes, and verify each response automatically. Happy to share if useful.

## Suggested priority

1. **State machine guards** — voided invoice + terminated wallet mutations are the most dangerous because they bypass lifecycle guarantees that downstream code relies on.
2. **Negative amount/rate validation on Plan and Tax** — these flow into real invoice calculations.
3. **Wallet transaction idempotency** — double-charges in production.
4. Everything else is lower urgency but still worth a pass.

Happy to provide more detail on any specific finding. Great project — this is meant to help.
