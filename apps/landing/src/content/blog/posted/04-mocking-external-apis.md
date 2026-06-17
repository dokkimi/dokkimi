---
title: 'Mock Stripe, Twilio, and any external API without changing your code'
description: "How Dokkimi's network-level mocks let you intercept outbound API calls and return controlled responses — no SDK wrappers or environment variables needed."
date: '2026-04-14'
slug: 'mocking-external-apis'
---

## The problem with traditional mocking

When your service calls Stripe to charge a card, you don't want to actually charge anyone during tests. The standard approach is to add a layer of indirection — an SDK wrapper, a feature flag, or an environment variable that swaps the real Stripe client for a fake one.

This works, but it has costs:

- **Code changes.** You're modifying production code to support testing.
- **Divergence risk.** Your mock client might not behave exactly like the real one. Different error formats, missing headers, subtle timing differences.
- **Maintenance burden.** Every new external API needs its own mock implementation.

## Network-level mocking

Dokkimi takes a different approach. Instead of mocking at the application layer, it mocks at the network layer. Your service makes a real HTTP call to `api.stripe.com`, but DNS within the test namespace resolves that domain to Dokkimi's mock handler.

```yaml
items:
  - type: MOCK
    name: mock-stripe
    mockTarget: api.stripe.com
    mockPath: /v1/charges
    mockResponseStatus: 200
    mockResponseBody:
      id: ch_test_123
      status: succeeded
      amount: 1998
    mockResponseHeaders:
      content-type: application/json
```

Your service code doesn't change at all. It constructs the same HTTP request it would in production, sends it to the same hostname, and gets back a response that looks exactly like what Stripe would return.

## Asserting on outbound calls

Because the mock is part of Dokkimi's interception layer, every call to the mock is captured. You can assert on exactly what your service sent:

```yaml
assertions:
  - match:
      origin: payment-service
      method: POST
      url: api.stripe.com/v1/charges
    assertions:
      - path: $.request.body.amount
        operator: eq
        value: 1998
      - path: $.request.body.currency
        operator: eq
        value: 'usd'
```

This lets you verify that your service is calling external APIs correctly — right endpoint, right body, right headers — without needing access to the external service's logs.

## Multiple mocks in one test

You can define as many mocks as your test needs:

```yaml
items:
  - type: MOCK
    name: mock-stripe
    mockTarget: api.stripe.com
    mockPath: /v1/charges
    mockResponseStatus: 200
    mockResponseBody:
      id: ch_test_123

  - type: MOCK
    name: mock-twilio
    mockTarget: api.twilio.com
    mockPath: /2010-04-01/Accounts/*/Messages.json
    mockResponseStatus: 201
    mockResponseBody:
      sid: SM_test_456
```

Each mock operates independently. Your checkout flow can call Stripe for payment and Twilio for SMS confirmation, and both calls are intercepted, mocked, and available for assertions.

## Error scenarios

Mocks are especially useful for testing error handling. What happens when Stripe returns a 402? When Twilio times out? Define a separate test with a mock that returns the error response:

```yaml
- type: MOCK
  name: mock-stripe-decline
  mockTarget: api.stripe.com
  mockPath: /v1/charges
  mockResponseStatus: 402
  mockResponseBody:
    error:
      type: card_error
      message: 'Your card was declined.'
```

Then assert that your service handles it correctly — returns the right error to the client, doesn't create a half-finished order, logs the failure appropriately.

## Body matching — same endpoint, different responses

Some APIs funnel all requests through a single endpoint. LLM APIs send every prompt to `POST /v1/chat/completions`. GraphQL APIs send every query to `POST /graphql`. Without body matching, you'd get one mock response for all calls to that endpoint.

Dokkimi lets you match on request body content so the same endpoint returns different responses depending on the payload:

```yaml
# Classify prompt → returns "billing"
- type: MOCK
  name: mock-llm-classify
  mockTarget: api.openai.com
  mockPath: /v1/chat/completions
  mockRequestBodyContains: 'classify this ticket'
  mockResponseStatus: 200
  mockResponseBody:
    choices:
      - message:
          content: billing

# Extract prompt → returns entities
- type: MOCK
  name: mock-llm-extract
  mockTarget: api.openai.com
  mockPath: /v1/chat/completions
  mockRequestBodyContains: 'extract entities'
  mockResponseStatus: 200
  mockResponseBody:
    choices:
      - message:
          content: '{"people": ["Alice"], "places": ["NYC"]}'

# Fallback — no body match, catches everything else
- type: MOCK
  name: mock-llm-fallback
  mockTarget: api.openai.com
  mockPath: /v1/chat/completions
  mockResponseStatus: 200
  mockResponseBody:
    choices:
      - message:
          content: "I don't understand."
```

Mocks with a body match automatically outrank mocks without one (higher specificity score), so the fallback only fires when no body-matching mock matches. Use `mockRequestBodyContains` for simple substring matching (case-insensitive) or `mockRequestBodyMatches` for regex patterns.

## When not to use mocks

Mocks are for functional testing — verifying that your code handles success and failure paths correctly. They're not a substitute for:

- **Contract testing.** Mocks won't tell you if the real API changed its response format. Pair Dokkimi mocks with contract tests or periodic integration runs against sandbox APIs.
- **End-to-end smoke tests.** For critical paths, you may still want a test that hits the real Stripe sandbox. Dokkimi can do this too — just don't define a mock for that domain.

The sweet spot is using mocks for the majority of your tests (fast, deterministic, free) and reserving real API calls for a small set of smoke tests.
