---
title: 'Dokkimi vs. Docker Compose for integration testing'
description: 'Docker Compose and Dokkimi solve different layers of the integration testing problem. Here is where each one fits and where they overlap.'
date: '2026-05-07'
slug: 'dokkimi-vs-docker-compose-testing'
---

Docker Compose is probably the most common way to run integration tests for microservices, and for good reason — it's simple, well-documented, and nearly every developer already knows how it works. You write a `docker-compose.test.yml`, run `docker compose up`, your services can reach each other by container name, and you bolt on whatever test runner you want. For a lot of teams, that setup covers the basics and stays out of the way.

The two tools operate at different layers of the same problem and, for many teams, complement each other rather than compete. This post is about understanding where Docker Compose stops being enough, and what a Docker-native testing tool like Dokkimi gives you in those areas.

## What Docker Compose handles well

Docker Compose is good at one thing and it does that thing cleanly: getting multiple containers running on the same network so they can talk to each other. If your integration tests boil down to "start these services, send some HTTP requests, check the responses," Docker Compose is a perfectly reasonable choice. The learning curve is minimal, the tooling is mature, and it stays out of the way.

Where this setup works especially well is during early development, when the service boundaries are still shifting and you mainly want to validate that things start, connect, and respond. At that stage, the overhead of a more structured testing framework isn't worth it — you just need to run your services and poke at them.

## Where Docker Compose leaves gaps

The limitations tend to show up gradually, usually once your architecture gets complex enough that the interesting bugs live _between_ services rather than inside any single one.

### You can only see the edges

Docker Compose starts your services and gets out of the way, which means your tests can only observe what you directly send in and what comes back out. If your API gateway calls an order service, which calls a payment service, which writes to a database — Docker Compose has no visibility into any of those intermediate calls. You're testing a black box.

This matters because integration bugs rarely live at the entry point. They live in the internal call chain: a service passed the wrong currency code to another service, a retry happened when it shouldn't have, a downstream call was made with stale data. With Docker Compose, you only find these bugs if they happen to affect the final response you're checking. If the bug is silent — say, a duplicate charge that doesn't change the HTTP status code — your test passes and you find out in production.

Dokkimi's interceptor sidecar captures every HTTP call between services automatically. You can assert on things like "the order service called the payment service with `amount_cents: 1998` and `currency: usd`" directly, without your services needing to log or expose that information. In practice, that looks like this:

```json
{
  "match": {
    "origin": "order-service",
    "method": "POST",
    "url": "payment-service/api/charges"
  },
  "assertions": [
    { "path": "request.body.amount_cents", "operator": "eq", "value": 1998 },
    { "path": "request.body.currency", "operator": "eq", "value": "usd" },
    { "path": "response.status", "operator": "eq", "value": 201 }
  ]
}
```

The assertion operates on the actual network traffic, not on what your test script can infer from the outside.

### Test orchestration is your problem

With Docker Compose, the test runner is whatever you attach to it — a shell script, a pytest suite, a Jest file that fires off HTTP calls. That means you're responsible for waiting until services are healthy before sending requests, sequencing multi-step test scenarios, parsing responses, and tearing things down cleanly when something fails halfway through. Each of those is solvable on its own, but together they add up to a meaningful amount of test infrastructure that you need to write and maintain, and that infrastructure tends to grow more brittle as the test suite gets more complex. You've probably seen the pattern: a `wait-for-it.sh` script that polls a health endpoint in a loop, a `docker compose down -v` in a `trap` handler that doesn't always fire, and a growing pile of retry logic that exists only because there's no built-in way to know when the system is actually ready.

Dokkimi handles orchestration natively. You declare test steps, and the framework manages readiness checks, step sequencing, assertion evaluation, and cleanup. The test definition describes _what_ should happen and _what_ to verify, not _how_ to poll for readiness or recover from a partial failure.

### State leaks between runs

Docker Compose volumes persist between runs unless you explicitly remove them, which means database state from one test run can leak into the next. Most teams handle this with teardown scripts or by nuking volumes before each run and re-seeding, but either approach is fragile — if a test fails mid-run and the teardown doesn't execute, the next run inherits corrupted state and fails for reasons that have nothing to do with the code being tested. This is the kind of flakiness that erodes trust in a test suite: the test that passed yesterday now fails, nobody changed the code, and someone spends an hour before realizing it was leftover data from a previous run.

Dokkimi creates a fresh isolated Docker environment for every run. Each database starts empty, gets seeded with whatever init data the test defines, runs the test, and the entire environment is destroyed afterward. There's no cleanup step because there's nothing to clean up — the isolation boundary is the environment itself.

### Parallel runs fight each other

Running two Docker Compose test suites at the same time is possible but painful — you run into port conflicts, shared Docker network collisions, and container name clashes that require careful configuration to avoid. Most teams end up running tests sequentially, which is fine until your test suite takes 30 minutes and you want it to take 5.

In Dokkimi, every test run gets its own isolated Docker network with its own internal DNS. There's no shared state between environments, no port mapping to manage, and no coordination required. You can run as many test definitions in parallel as your machine has resources for.

## What Dokkimi costs you

Dokkimi is not a drop-in replacement for Docker Compose, and it's worth being honest about what it asks for in return.

**Docker is required.** You need Docker running locally — Docker Desktop is the easiest path. This is the same prerequisite as Docker Compose, so there's no additional infrastructure to set up.

**The learning curve is steeper.** Docker Compose is something most developers can pick up in an afternoon. Dokkimi's definition format — services, databases, mocks, test steps, assertions — is more expressive but also more to learn. The tradeoff is that the framework handles more for you once you've learned it, but the initial ramp isn't trivial.

**Resource overhead is higher.** Dokkimi's sidecar interceptors add containers beyond what your services alone would need. A single Dokkimi environment runs fine on any modern laptop, but if you're running 10 test environments in parallel, you'll need more CPU and memory than the equivalent Docker Compose setup would require.

## Using them together

These tools test at different levels of fidelity, and there's nothing wrong with using both. Docker Compose for quick local smoke tests during development — "did I break the startup sequence, does the basic flow still work" — and Dokkimi for deeper integration tests that verify the communication patterns between services, test error handling with mocked third-party APIs, and run in CI with full isolation.

Some teams start with Docker Compose, and as their services stabilize and the integration points become critical, they add Dokkimi tests for the scenarios that Docker Compose can't meaningfully cover. If your tests are primarily smoke tests, Docker Compose may be all you need. Dokkimi earns its complexity when you need to assert on inter-service communication, when you want full visibility into your service interactions, or when you've outgrown sequential test runs and need isolated parallel environments.
