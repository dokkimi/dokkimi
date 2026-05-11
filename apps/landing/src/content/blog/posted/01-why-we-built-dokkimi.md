---
title: 'Why we built Dokkimi'
description: 'Unit tests mock away the interesting parts. Staging environments drift from reality. We built Dokkimi for integration, E2E, and visual regression testing — without changing your code.'
date: '2026-04-07'
slug: 'why-we-built-dokkimi'
---

## The testing gap

If you run microservices, you've probably felt this: your unit tests pass, your staging deploy looks fine, and then production breaks because service A sends a field that service B doesn't expect.

Unit tests are great for isolated logic. But the moment you mock the HTTP client, the database, or the message queue, you're no longer testing the thing that breaks in production — the integration between services.

## Staging doesn't fix this

The usual answer is "test it in staging." But staging environments have their own problems:

- **Shared state.** Two developers testing at the same time step on each other's data.
- **Drift.** Staging is never quite the same as production. Different config, stale data, missing services.
- **Slow feedback.** Deploying to staging takes minutes. Getting a clean environment takes longer.

You end up with a testing strategy that's fast but fake (unit tests) or real but slow and flaky (staging).

## What if you could have both?

That's the idea behind Dokkimi. For each test run, Dokkimi spins up an isolated Kubernetes namespace with your actual services, real databases, a traffic interceptor that captures every HTTP call between them, and optionally a real Chromium browser for E2E UI testing.

You write assertions against real traffic — "when I POST to the API gateway, verify that the order service called the payment service with the right amount." You drive a browser through your UI and screenshot it for visual regression. You query the database directly to verify writes. No mocks of your own code. No shared state. No drift.

```yaml
assertions:
  - match:
      origin: order-service
      method: POST
      url: payment-service/v1/charges
    assertions:
      - path: request.body.amount
        operator: eq
        value: 1998
```

## How it works in practice

1. You define your services, databases, mocks, and UI flows in YAML files under `.dokkimi/`.
2. `dokkimi run` deploys everything into a fresh namespace with sidecar interceptors (and a headless browser if your test includes UI actions).
3. Your test steps execute — HTTP requests, database queries, browser interactions, and screenshots — while the interceptor logs all inter-service traffic.
4. Assertions run against responses, captured traffic, database state, and screenshot diffs. Console log assertions are supported too.
5. Everything is torn down automatically.

The whole cycle takes seconds for small topologies. You get production-like confidence with unit-test-like speed.

## What Dokkimi is not

Dokkimi is not a replacement for unit tests. You should still test your business logic in isolation. Dokkimi fills the gap between unit tests and production — the integration layer where services talk to each other, databases get queried, external APIs get called, and users interact with the UI.

It's also not a load testing tool or a monitoring solution. It's specifically for functional correctness of multi-service workflows — from the API layer all the way to what the user sees in the browser.

## Try it

```bash
brew install dokkimi/tap/dokkimi
dokkimi init
dokkimi run
```

The `init` command scaffolds example definitions so you can see the structure before writing your own. Check out the [docs](/docs) for the full reference.
