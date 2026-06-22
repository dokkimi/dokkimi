---
title: 'The bug that returns 200 OK'
description: 'Your HTTP assertions pass, but your service is silently logging errors. Console log assertions catch what status codes miss.'
date: '2026-05-05'
slug: 'console-log-assertions'
---

## The silent failure

You've written a solid test. You POST a payment, assert a 200 response, and verify that the downstream call to Stripe carries the right amount. Everything passes. Ship it.

Two weeks later, you're paging through production logs and notice that the payment service has been logging `Error: failed to update audit trail` on every single charge. The service caught the exception, logged it, and returned 200 anyway. Your test never knew.

HTTP assertions verify what your services _say_ to each other. But they can't tell you what your services are _thinking_. A service can return a perfect response while silently swallowing exceptions, skipping audit writes, or falling back to default behavior that happens to look correct from the outside.

## Asserting on what gets logged

Dokkimi captures stdout and stderr from every service container during a test run. You can assert on that output the same way you assert on HTTP traffic — by adding a match block to your step's assertions:

```yaml
- match:
    path: '$.consoleLogs'
    where:
      - path: '$$.service'
        operator: eq
        value: payment-service
      - path: '$$.level'
        operator: eq
        value: ERROR
    count:
      operator: eq
      value: 0
```

That's it. If payment-service logs any ERROR-level message during this step, the test fails. The silent audit trail bug from our example would have been caught immediately.

This works because Dokkimi auto-detects log levels from common output formats. JSON structured logs (`{"level": "error", ...}`), log4j-style prefixes (`[ERROR] ...`), and common patterns (`Error:`, `WARN:`) are all recognized automatically. If your logs don't match any known pattern, they're captured as INFO by default.

## Scoped to the step, not the run

One thing that makes log assertions practical is that they're time-scoped. If your test has five steps, a log assertion in step 3 only checks logs emitted during that step. You won't get false positives from noisy startup messages or teardown cleanup in other steps.

## The assertion you should add first

If you take one thing from this post, it's this: add a zero-error assertion to your most important test steps. It takes one line, it catches real bugs, and it requires zero knowledge of what your service actually logs.

You can get more specific when you need to. For example, verifying that a payment step produces exactly one audit log entry:

```yaml
- match:
    path: '$.consoleLogs'
    where:
      - path: '$$.service'
        operator: eq
        value: payment-service
      - path: '$$.level'
        operator: eq
        value: INFO
      - path: '$$.message'
        operator: contains
        value: 'Payment processed'
    count:
      operator: eq
      value: 1

- match:
    path: '$.consoleLogs'
    where:
      - path: '$$.service'
        operator: eq
        value: payment-service
      - path: '$$.level'
        operator: eq
        value: ERROR
    count:
      operator: eq
      value: 0
```

The `message` where clause supports `contains` (substring match), `eq` (exact match), and `matches` (regex). Prefer `contains` over `eq` when you can — log messages tend to include timestamps, request IDs, and other dynamic content that makes exact matching fragile.

## Three layers deep

Console log assertions are most powerful when combined with HTTP assertions. Here's a payment step with full coverage:

```yaml
- name: Process payment
  action:
    type: httpRequest
    method: POST
    url: api-gateway/api/payments
    body:
      orderId: '{{orderId}}'
      amount: 1998
  assertions:
    - assertions:
        - path: $.response.status
          operator: eq
          value: 200

    - match:
        path: '$.traffic'
        where:
          - path: '$$.origin'
            operator: eq
            value: payment-service
          - path: '$$.request.method'
            operator: eq
            value: POST
          - path: '$$.request.url'
            operator: eq
            value: mock-stripe/v1/charges
      assertions:
        - path: $.match.request.body.amount
          operator: eq
          value: 1998

    - match:
        path: '$.consoleLogs'
        where:
          - path: '$$.service'
            operator: eq
            value: payment-service
          - path: '$$.level'
            operator: eq
            value: INFO
          - path: '$$.message'
            operator: contains
            value: 'Payment processed'
        count:
          operator: eq
          value: 1

    - match:
        path: '$.consoleLogs'
        where:
          - path: '$$.service'
            operator: eq
            value: payment-service
          - path: '$$.level'
            operator: eq
            value: ERROR
        count:
          operator: eq
          value: 0
```

The first block checks that the API returned success. The second verifies that the downstream call to Stripe carried the correct amount. The third and fourth confirm the service logged what it should have and nothing it shouldn't have.

Any one of those layers can pass while the others fail. A 200 response doesn't mean the Stripe call was correct. A correct Stripe call doesn't mean the service didn't log an error along the way. Testing all three is the difference between "it worked" and "it worked correctly."
