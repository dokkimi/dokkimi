---
title: 'Testing microservices with real databases'
description: 'How to seed Postgres, MySQL, MongoDB, or Redis in Dokkimi tests — with fresh, isolated instances instead of shared staging databases.'
date: '2026-04-16'
slug: 'testing-with-real-databases'
---

## Why real databases matter

Most teams rely on long-lived staging environments to test against real databases. The problem is that staging databases accumulate stale data and become shared bottlenecks. When a test fails, you can't tell whether it's a real bug or just stale data from a previous run or bloat. You end up losing trust in your tests.

What you actually want is a fresh, isolated database instance for every test run, seeded with exactly the data you need, and torn down when you're done. Every test is focused with a relevant, customizable, and debuggable dataset.

## Database items in Dokkimi

Dokkimi can deploy real database instances as part of your test namespace. Define them like any other item:

```yaml
items:
  - type: DATABASE
    name: orders-db
    database: postgres
    version: '16'
    initFilePath: ./seeds/orders-seed.sql
```

Dokkimi spins up a Postgres 16 container in the test namespace, runs your init script, and configures DNS so that `orders-db` resolves to it. Your service connects with the same hostname it uses in production — you just point the connection config at `orders-db`.

## Init scripts

Init scripts run before any test steps execute. They set up the schema and any baseline data your tests depend on.

For SQL databases, use `.sql` files:

```sql
-- seeds/orders-seed.sql
CREATE TABLE IF NOT EXISTS orders (
  id SERIAL PRIMARY KEY,
  customer_email TEXT NOT NULL,
  total_cents INTEGER NOT NULL,
  status TEXT DEFAULT 'pending',
  created_at TIMESTAMPTZ DEFAULT NOW()
);

INSERT INTO orders (customer_email, total_cents, status)
VALUES ('existing@example.com', 4999, 'completed');
```

For MongoDB, use `.js` files:

```javascript
// seeds/mongo-seed.js
db.users.insertMany([
  { email: 'alice@example.com', role: 'admin' },
  { email: 'bob@example.com', role: 'member' },
]);
```

## Isolation guarantees

Each test run gets its own database instance in its own namespace. There's no shared state between runs, no need to clean up after yourself, and no risk of parallel tests colliding. When the test run finishes, the entire namespace — including all database containers — is destroyed.

This means your init scripts can be simple. You don't need teardown logic or transaction rollbacks. Just set up the state you need and let Dokkimi handle cleanup.

## Supported engines

Dokkimi supports:

- **Postgres** — versions 13+
- **MySQL** — versions 8+
- **MongoDB** — versions 5+
- **Redis** — versions 6+

Each engine runs as a standard container image. You can pin specific versions to match your production setup.

## Combining databases with traffic assertions

The real power comes from combining database seeding with Dokkimi's traffic interception. For example, test that your service reads from the database correctly and calls downstream services with the right data:

```yaml
tests:
  - name: Fetch existing order
    steps:
      - name: GET /orders/1
        action:
          type: httpRequest
          method: GET
          url: api-gateway/api/orders/1
        assertions:
          - assertions:
              - path: response.status
                operator: eq
                value: 200
              - path: response.body.customer_email
                operator: eq
                value: 'existing@example.com'
```

The order with ID 1 exists because your seed script inserted it. The assertion verifies that your service reads it correctly and returns the right data through the API. No mocking your own database layer.

## Tips

- **Keep init scripts minimal.** Only insert the data your test actually needs. Large init scripts slow down test startup and make failures harder to debug.
- **Use variables for test data.** Define emails, IDs, and other test values as variables so assertions can reference them without hardcoding.
- **Pin database versions.** Match your production version exactly. A test that passes on Postgres 16 might fail on Postgres 14 due to syntax differences.
