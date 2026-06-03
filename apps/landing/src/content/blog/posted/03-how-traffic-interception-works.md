---
title: "How Dokkimi's traffic interception works"
description: 'A technical look at how Dokkimi captures inter-service HTTP traffic using sidecar proxies without modifying your application code.'
date: '2026-04-07'
slug: 'how-traffic-interception-works'
---

## The core idea

Dokkimi's main trick is that it can tell you exactly what service A sent to service B — the full request and response, with headers and bodies — without you adding any logging, tracing, or SDK to your services.

This is what makes assertions like "verify the order service sent the correct amount to the payment service" possible. Your services run unmodified. Dokkimi handles the observation layer.

## Sidecar proxies

When Dokkimi deploys your services into a Docker environment, it pairs each service container with an interceptor sidecar container. This sidecar acts as a transparent proxy — all inbound and outbound HTTP traffic flows through it.

```
┌─────────────────────────────┐
│  Container group             │
│  ┌───────────┐ ┌──────────┐ │
│  │  Your     │ │Interceptor│ │
│  │  Service  │◄┤  Sidecar  │◄── inbound traffic
│  │           │ │           │──► outbound traffic
│  └───────────┘ └──────────┘ │
└─────────────────────────────┘
```

The sidecar achieves this by manipulating the container's networking — it configures iptables rules so that traffic destined for your service (or originating from it) passes through the interceptor first. This is the same pattern service meshes like Istio use, but stripped down to just the capture functionality.

## What gets captured

For every HTTP request and response that flows through the interceptor, Dokkimi records:

- **Origin and destination** — which service sent the request and which received it
- **Method and URL**
- **Request headers and body**
- **Response status code, headers, and body**
- **Timing** — when the request was sent and how long the response took

This data is stored temporarily and made available to the assertion engine during the test run.

## DNS-based routing

Dokkimi configures DNS within the Docker network so that service names resolve to the interceptor sidecar rather than directly to the service. When your API gateway makes a request to `http://order-service/api/orders`, it resolves to the order service's interceptor, which logs the request, forwards it to the actual service, logs the response, and returns it.

This means your services don't need to know about Dokkimi at all. They use the same service names they'd use in production.

## Mocks and external APIs

The same interception mechanism powers Dokkimi's mock system. When you define a mock:

```yaml
- type: MOCK
  name: mock-stripe
  mockTarget: api.stripe.com
  mockPath: /v1/charges
  mockResponseStatus: 200
  mockResponseBody:
    id: ch_test_123
```

Dokkimi configures DNS so that `api.stripe.com` resolves to a mock handler within the Docker network. Your service makes a normal HTTPS call to Stripe, but instead of hitting the real API, it hits Dokkimi's mock — which returns your configured response and logs the interaction for assertions.

No environment variables to change. No conditional logic in your code. The mock is transparent at the network level.

## The assertion engine

After all steps in a test complete, the assertion engine queries the captured traffic. When you write:

```yaml
- match:
    origin: order-service
    method: POST
    url: payment-service/v1/charges
  assertions:
    - path: request.body.amount
      operator: eq
      value: 1998
```

The engine finds all captured HTTP calls matching the `origin`, `method`, and `url` pattern, then evaluates each assertion against the matched traffic. If no calls match, or if any assertion fails, the test fails with a clear message showing what was expected vs. what was captured.

## Console log capture

Beyond HTTP traffic, the interceptor also captures stdout/stderr from your service containers. This enables assertions on log output:

```yaml
- service: order-service
  consoleAssertions:
    - level: ERROR
      count:
        operator: eq
        value: 0
```

Log levels are auto-detected from common patterns (JSON structured logs, log4j-style prefixes, etc.), so you don't need to configure anything.

## Tradeoffs

This approach has real benefits — zero code changes, production-like networking, and full visibility into inter-service communication. But there are tradeoffs to be aware of:

- **HTTP/HTTPS only.** gRPC and other non-HTTP protocols aren't supported yet.
- **Small latency overhead.** The sidecar proxy adds a few milliseconds per request. Negligible for functional testing, but not suitable for benchmarking.
- **Requires Docker.** You need Docker running locally.

For most teams testing microservice integrations, these tradeoffs are well worth the visibility you get in return.
