---
title: 'The $ref pattern: reusable service definitions'
description: 'How to use $ref to share service, database, and mock definitions across test files and keep your .dokkimi/ folder DRY.'
date: '2026-04-23'
slug: 'ref-pattern-reusable-definitions'
---

## The duplication problem

As your test suite grows, you'll notice the same service definitions appearing in multiple test files. Your API gateway definition is identical whether you're testing the checkout flow or user registration. Copying it into every file creates a maintenance headache — change a port or environment variable and you have to update it everywhere.

## $ref to the rescue

Dokkimi supports JSON Reference-style `$ref` pointers in your item lists. Instead of inlining a service definition, point to a shared file:

```yaml
name: checkout-flow
items:
  - $ref: ../shared/api-gateway.yaml
  - $ref: ../shared/order-service.yaml
  - $ref: ../shared/postgres-db.yaml
  - type: MOCK
    name: mock-stripe
    mockTarget: api.stripe.com
    mockPath: /v1/charges
    mockResponseStatus: 200
    mockResponseBody:
      id: ch_test_123
```

The `$ref` path is relative to the file containing it. At resolution time, Dokkimi loads the referenced file and shallow-merges it with any sibling fields on the same object — so fields you write alongside the `$ref` act as overrides on top of the fragment. More on that in the "Overriding shared definitions" section below.

## Organizing shared definitions

A typical `.dokkimi/` folder with shared definitions looks like this:

```
.dokkimi/
  shared/
    api-gateway.yaml
    order-service.yaml
    user-service.yaml
    payment-service.yaml
    postgres-db.yaml
    redis-cache.yaml
  checkout-flow/
    definitions/
      checkout-test.yaml
      checkout-error-test.yaml
  user-registration/
    definitions/
      registration-test.yaml
```

Each test definition in `checkout-flow/` and `user-registration/` references the same shared services. When you update the API gateway's image tag or add an environment variable, you change it once in `shared/api-gateway.yaml` and every test picks it up.

## What goes in a shared file

A shared service definition is a single YAML item:

```yaml
# shared/api-gateway.yaml
type: SERVICE
name: api-gateway
image: my-registry/api-gateway:latest
port: 3000
healthCheck: /health
env:
  - name: DATABASE_URL
    value: postgresql://dokkimi:dokkimi@orders-db:5432/orders
  - name: REDIS_URL
    value: redis://:dokkimi@redis-cache:6379
```

A shared fragment is any file that does **not** have both a top-level `name` and `items` — that's the shape Dokkimi uses to distinguish a runnable definition from a fragment. In practice this means each shared file holds exactly one item, and if you need multiple items that always appear together (a service and its database, for example), you list each `$ref` separately in the test file's `items` array:

```yaml
items:
  - $ref: ../shared/order-service.yaml
  - $ref: ../shared/postgres-db.yaml
```

`$ref` also supports an array form (`$ref: [a.yaml, b.yaml]`) but that's a different feature — it overlays multiple fragments onto a single item, merging them left-to-right. Useful for base + environment-overrides patterns on one service, not for bundling separate items.

## Overriding shared definitions

Sometimes a test needs a slightly different version of a shared service — a different environment variable, an extra flag, or a specific image tag. Rather than duplicating the entire definition, inline the item in that specific test file:

```yaml
items:
  - $ref: ../shared/api-gateway.yaml
  - $ref: ../shared/order-service.yaml
    env:
      - ...$ref.env
      - name: FEATURE_FLAG_NEW_PRICING
        value: 'true' # only for this test
  - $ref: ../shared/postgres-db.yaml
```

The order service still uses the shared fragment, but we override its `env` to append one extra variable. The `...$ref.env` marker expands to the fragment's original `env` array, so we keep the base variables and add our test-specific one at the end. Without that marker, the inline `env` would replace the fragment's `env` entirely — shallow merge means arrays are not merged automatically.

## Validation

Run `dokkimi validate` to check that all `$ref` paths resolve correctly and that the resulting definitions are valid:

```bash
dokkimi validate
```

This catches broken references, missing files, and schema errors without deploying anything to your cluster.

## Recursive refs

Fragments can themselves use `$ref` to build on other fragments. This lets you create layered definitions — a base service with common settings, a variant that overrides a few fields, and a test-specific layer on top:

```yaml
# shared/base-service.yaml
type: SERVICE
name: api-gateway
port: 3000
healthCheck: /health
env:
  - name: NODE_ENV
    value: production
```

```yaml
# shared/api-gateway.yaml
$ref: ./base-service.yaml
image: my-registry/api-gateway:latest
env:
  - ...$ref.env
  - name: DATABASE_URL
    value: postgresql://dokkimi:dokkimi@postgres-db:5432/dokkimi
```

```yaml
# definitions/checkout-test.yaml
name: checkout-flow
items:
  - $ref: ../shared/api-gateway.yaml
    env:
      - ...$ref.env
      - name: FEATURE_FLAG_NEW_PRICING
        value: 'true'
```

At resolution time, Dokkimi walks the chain: `base-service.yaml` is loaded first, then `api-gateway.yaml` overrides on top of it, then the inline overrides in the test file win last. Each level is a shallow merge, same as single-level `$ref`.

This also works for action refs (an action fragment's `action` can itself use `$ref`) and UI sub-step refs (a sub-step fragment can contain `$ref` entries pointing to other sub-step fragments).

Circular references — where A refs B and B refs A — are detected and reported as validation errors.

## Tips

- **Name shared files after the service, not the test.** `api-gateway.yaml`, not `checkout-api-gateway.yaml`. The point of sharing is that it's the same service everywhere.
- **Version your images.** Use specific tags (`my-registry/api-gateway:v1.2.3`) rather than `:latest` in shared definitions so tests are reproducible. Even better, pull the tag from a `config.yaml` env var with `${{IMAGE_TAG}}` so every shared file updates in one place.
- **Keep overrides small.** If a shared fragment needs heavy customization in most tests, that's a sign it isn't really shared — split it into variants (`api-gateway-staging.yaml`, `api-gateway-debug.yaml`) instead of piling overrides on every reference.
- **Don't go too deep.** Recursive refs are powerful but two or three levels is usually the sweet spot. Deeply nested chains become hard to reason about — if you find yourself stacking five layers, consider flattening.
