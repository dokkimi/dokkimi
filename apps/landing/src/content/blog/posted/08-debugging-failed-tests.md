---
title: 'Debugging failed Dokkimi tests'
description: 'How to use dokkimi inspect and dokkimi dump to diagnose assertion failures, missing traffic, database query issues, and service startup failures.'
date: '2026-06-16'
slug: 'debugging-failed-tests'
---

## A test failed. Now what?

A Dokkimi test failure means one of three things:

1. **An assertion didn't match.** Your service returned an unexpected status code, body, or header.
2. **Expected traffic wasn't captured.** The interceptor didn't see a request that your assertion was looking for.
3. **A service didn't start.** A container failed readiness checks and the test timed out.

Each has a different debugging approach. Let's walk through them.

## Start with the test output

When a test fails, Dokkimi prints which assertions passed and which failed, including the expected vs. actual values:

```
FAIL  Place order and verify payment
  ✓ POST /orders → 201
  ✗ httpCall order-service → payment-service/v1/charges
    assertion: request.body.$.amount eq 1998
    actual: 2499
```

This tells you exactly what went wrong. The order service called the payment service, but with amount `2499` instead of `1998`. That's a bug in your pricing logic, not a test infrastructure issue.

## Drill into the details with `dokkimi inspect`

For more context, run `dokkimi inspect`. This opens an interactive TUI that lets you drill into the last run step by step:

```bash
dokkimi inspect
```

You start by picking a definition from the run, then selecting a test suite and individual step. From there you can view:

- **Assertions** — pass/fail with expected vs. actual values
- **HTTP traffic** — every request the interceptor captured for that step, with full request/response bodies
- **Database queries** — every query your services executed, captured by the DB proxy sidecar
- **Console logs** — stdout/stderr per service, with auto-detected log levels
- **Timeline** — a visual call tree showing the sequence of HTTP and DB calls
- **Variables** — before/after state for any extracted variables

So for our pricing bug, you'd select the "Place order and verify payment" suite, pick the step that fires the order, and open the HTTP traffic view. You'd see that the order service sent `{ amount: 2499 }` to the payment service — and now you know the issue is in the order service's pricing calculation, not in the inter-service call.

## Missing traffic

Sometimes the assertion fails because the expected HTTP call never happened:

```
FAIL  Place order and verify payment
  ✗ httpCall order-service → payment-service/v1/charges
    no matching traffic found
```

This means the order service never called the payment service. Drill into the step's HTTP traffic in `dokkimi inspect` to see what it did instead. Common causes:

- **The service errored before making the call.** Check the console logs for exceptions.
- **The URL doesn't match.** Maybe the service calls `/v1/charge` (singular) but your assertion matches `/v1/charges` (plural).
- **The origin doesn't match.** If `api-gateway` proxies the request to `payment-service`, the captured origin will be `api-gateway`, not `order-service`.

## Console log assertions

If you're asserting on console logs, the inspect TUI surfaces captured stdout/stderr per service under the "Console Logs" section for each step. Log levels are auto-detected, so you can quickly scan for errors or verify that your service logged (or didn't log) specific messages.

## Service startup failures

If a service never becomes ready, the test will time out:

```
TIMEOUT  orders-db failed readiness check after 60s
```

This usually means:

- **The container image is wrong.** Check that the image tag exists and is pullable from your cluster.
- **The port is wrong.** The readiness check hits the configured port. If your service listens on 8080 but you configured port 3000, it'll never pass.
- **A dependency isn't ready.** If your service crashes on startup because the database isn't available yet, check that database seed scripts complete before the service starts.

## Database query inspection

Dokkimi's database proxy sidecars capture every query your services execute during a test run. In the inspect TUI, select a step that involves a database and open the "DB Queries" section to see the captured queries:

```
order-service → orders-db
  INSERT INTO orders (item, quantity, total) VALUES ('widget', 2, 2499)

order-service → orders-db
  SELECT price FROM products WHERE name = 'widget'
```

When an assertion fails with the wrong value, the query log often reveals where the bad data came from — a missing WHERE clause, a stale cache hit, or a calculation done in SQL that doesn't match your expectation.

## Common patterns

| Symptom                  | Likely cause                               | First step                                          |
| ------------------------ | ------------------------------------------ | --------------------------------------------------- |
| Wrong value in assertion | Bug in service logic                       | `dokkimi inspect` → HTTP traffic for the step       |
| No matching traffic      | Service didn't make the call               | `dokkimi inspect` → console logs for exceptions     |
| Wrong query result       | Bug in SQL or missing migration            | `dokkimi inspect` → DB queries for the step         |
| Timeout on startup       | Bad image, wrong port, or dependency issue | `dokkimi inspect` → console logs for startup errors |

If you're still stuck after inspecting traffic, logs, and queries, run `dokkimi dump -o last-run.json` to export the entire run — test definition, captured traffic, console logs, query logs, assertion results, and timing data — as a single structured JSON file you can hand to a colleague or an AI assistant for a second pair of eyes. You can also use `dokkimi dump --failed` to limit the export to only the instances that failed.
