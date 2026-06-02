---
title: 'Parallel test execution in Dokkimi'
description: 'How to run test steps concurrently and execute multiple test definitions in parallel to keep your feedback loop fast.'
date: '2026-04-21'
slug: 'parallel-test-execution'
---

## Two levels of parallelism

Dokkimi supports parallelism at two levels:

1. **Within a test** — run multiple actions concurrently using the `parallel` action type.
2. **Across tests** — run multiple test definitions concurrently, each in its own isolated environment.

Both are designed to keep your feedback loop short as your test suite grows.

## Parallel steps within a test

Test steps are a flat array that runs sequentially by default. To run actions concurrently, use the `parallel` action type, which takes a list of actions and executes them at the same time.

```yaml
tests:
  - name: Concurrent requests
    steps:
      # These three actions run in parallel
      - name: Create orders concurrently
        action:
          type: parallel
          actions:
            - type: httpRequest
              method: POST
              url: api-gateway/api/orders
              body: { item: 'widget', quantity: 1 }
            - type: httpRequest
              method: POST
              url: api-gateway/api/orders
              body: { item: 'gadget', quantity: 2 }
            - type: httpRequest
              method: POST
              url: api-gateway/api/orders
              body: { item: 'gizmo', quantity: 3 }

      # This step runs after all three above complete
      - name: List all orders
        action:
          type: httpRequest
          method: GET
          url: api-gateway/api/orders
        assertions:
          - assertions:
              - path: response.status
                operator: eq
                value: 200
              - path: response.body[2]
                operator: exists
```

The three POST requests execute simultaneously inside the `parallel` action. Once all three complete, the next step runs and verifies all three orders were created.

## When to use the parallel action

The `parallel` action type is useful for:

- **Testing concurrent access.** Does your service handle simultaneous writes correctly? Do transactions isolate properly?
- **Speeding up setup.** If you need to create several resources before the real test begins, create them in parallel.
- **Simulating realistic load patterns.** Real users don't wait for one request to finish before starting the next.

## When to keep steps sequential

Use sequential steps when order matters:

```yaml
steps:
  # Step 1: Create user
  - name: Create user
    action:
      type: httpRequest
      method: POST
      url: api-gateway/api/users
      body: { email: 'test@example.com' }
    extract:
      userId: $.body.id

  # Step 2: Use the created user's ID
  - name: Get user
    action:
      type: httpRequest
      method: GET
      url: api-gateway/api/users/{{userId}}
```

Step 2 depends on the `userId` extracted from step 1. Since steps run sequentially by default, this works without any extra configuration.

## Parallel test definitions

At a higher level, you can run multiple test definitions at the same time:

```bash
dokkimi run
```

When you run without a specific target, Dokkimi discovers all test definitions under `.dokkimi/` and runs them concurrently. Each definition gets its own isolated Docker network, so there's no interference between them.

This is the primary way to scale your test suite. Each test definition is self-contained — its own services, databases, and mocks — so they're naturally parallelizable.

## Structuring for parallelism

To get the most out of parallel execution:

- **One workflow per definition.** Don't put unrelated tests in the same definition file. Separate "checkout flow" from "user registration" into different definitions so they can run in parallel.
- **Share service definitions with `$ref`.** Your API gateway definition doesn't need to be duplicated across test files. Put shared items in a `shared/` folder and reference them.
- **Keep environments small.** Each environment runs real containers. If one definition deploys 15 services and another deploys 2, the small one will finish long before the large one. Break up large topologies where possible.

## Resource considerations

Each parallel test definition creates its own isolated Docker environment with its own set of containers. On a local machine, you're limited by CPU and memory. A few concurrent environments work fine on a modern laptop. For larger suites, cloud execution (coming soon) will provide elastic resources.

Run `dokkimi doctor` to see your available resources and how many concurrent environments it can comfortably support.
