---
title: 'Testing external API integrations end-to-end'
description: 'How to build a complete test suite for services that depend on third-party APIs — covering happy paths, error handling, rate limits, and webhook callbacks.'
date: '2026-04-27'
slug: 'testing-external-api-integrations'
---

## The app we're testing

Here's an e-commerce platform with a fairly standard checkout flow. A customer browses products, adds items to a cart, and pays. Behind the scenes, several services and external APIs are involved:

- **api-gateway** — routes requests, handles auth
- **order-service** — manages the order lifecycle (cart → pending → paid → shipped)
- **payment-service** — charges cards via Stripe
- **shipping-service** — creates shipping labels via EasyPost
- **notification-service** — sends order confirmations via SendGrid and SMS receipts via Twilio
- **postgres-db** — stores products, orders, and customers

The data model:

```sql
CREATE TABLE customers (
  id SERIAL PRIMARY KEY,
  email VARCHAR(200) NOT NULL,
  phone VARCHAR(20),
  name VARCHAR(100) NOT NULL
);

CREATE TABLE products (
  id SERIAL PRIMARY KEY,
  sku VARCHAR(50) UNIQUE NOT NULL,
  name VARCHAR(200) NOT NULL,
  price_cents INTEGER NOT NULL,
  stock INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE orders (
  id SERIAL PRIMARY KEY,
  customer_id INTEGER REFERENCES customers(id),
  status VARCHAR(20) DEFAULT 'pending',
  total_cents INTEGER NOT NULL,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE order_items (
  order_id INTEGER REFERENCES orders(id),
  product_id INTEGER REFERENCES products(id),
  quantity INTEGER NOT NULL,
  unit_price_cents INTEGER NOT NULL,
  PRIMARY KEY (order_id, product_id)
);
```

When a customer clicks "Pay," the chain looks like this: API gateway → order service (creates order) → payment service (charges Stripe) → order service (marks as paid) → shipping service (creates label via EasyPost) → notification service (emails via SendGrid + texts via Twilio). If any of those external APIs fail, the order needs to be handled gracefully — and that's exactly what's hard to test without Dokkimi.

## Seeding test data

Start with a seed file that gives you products, a customer, and a known starting state:

```sql
-- .dokkimi/ecommerce/init/seed.sql

INSERT INTO customers (id, email, phone, name) VALUES
  (1, 'buyer@example.com', '+15551234567', 'Jane Doe');

INSERT INTO products (id, sku, name, price_cents, stock) VALUES
  (1, 'WIDGET-001', 'Blue Widget', 999, 50),
  (2, 'WIDGET-002', 'Red Widget', 1499, 30),
  (3, 'GADGET-001', 'Turbo Gadget', 4999, 5);

SELECT setval('customers_id_seq', 10);
SELECT setval('products_id_seq', 10);
SELECT setval('orders_id_seq', 10);
```

This gives you a customer with a known email and phone (for notification assertions), products with known prices (for payment assertions), and limited stock on the Turbo Gadget (for testing out-of-stock scenarios later).

## Building the mock library

Each external API gets a shared mock file. These live in `.dokkimi/shared/` so every test can reference them:

```yaml
# .dokkimi/shared/mock-stripe-success.yaml
type: MOCK
name: mock-stripe
mockTarget: api.stripe.com
mockPath: /v1/charges
mockResponseStatus: 200
mockResponseHeaders:
  content-type: application/json
mockResponseBody:
  id: ch_test_123
  object: charge
  status: succeeded
  amount: 2498
  currency: usd
```

```yaml
# .dokkimi/shared/mock-easypost-success.yaml
type: MOCK
name: mock-easypost
mockTarget: api.easypost.com
mockPath: /v2/shipments
mockResponseStatus: 201
mockResponseHeaders:
  content-type: application/json
mockResponseBody:
  id: shp_test_789
  tracking_code: '9400111899223456789012'
  status: pre_transit
  postage_label:
    label_url: 'https://easypost.com/labels/test-label.pdf'
```

```yaml
# .dokkimi/shared/mock-sendgrid-success.yaml
type: MOCK
name: mock-sendgrid
mockTarget: api.sendgrid.com
mockPath: /v3/mail/send
mockResponseStatus: 202
mockResponseHeaders:
  content-type: application/json
mockResponseBody: {}
```

```yaml
# .dokkimi/shared/mock-twilio-success.yaml
type: MOCK
name: mock-twilio
mockTarget: api.twilio.com
mockPath: /2010-04-01/Accounts/*/Messages.json
mockResponseStatus: 201
mockResponseHeaders:
  content-type: application/json
mockResponseBody:
  sid: SM_test_456
  status: queued
```

The Twilio mock uses a wildcard (`*`) in the path to match any Account SID.

## Testing the happy path

With mocks and seed data in place, write a test that exercises the full checkout:

```yaml
name: checkout-happy-path
items:
  - $ref: ../shared/api-gateway.yaml
  - $ref: ../shared/order-service.yaml
  - $ref: ../shared/payment-service.yaml
  - $ref: ../shared/shipping-service.yaml
  - $ref: ../shared/notification-service.yaml
  - $ref: ../shared/postgres-db.yaml
  - $ref: ../shared/mock-stripe-success.yaml
  - $ref: ../shared/mock-easypost-success.yaml
  - $ref: ../shared/mock-sendgrid-success.yaml
  - $ref: ../shared/mock-twilio-success.yaml

tests:
  - name: Full checkout flow
    steps:
      # Create an order
      - action:
          type: httpRequest
          method: POST
          url: api-gateway/v1/orders
          body:
            customerId: 1
            items:
              - sku: WIDGET-001
                quantity: 1
              - sku: WIDGET-002
                quantity: 1
        assertions:
          - assertions:
              - path: response.status
                operator: eq
                value: 201
              - path: response.body.order.totalCents
                operator: eq
                value: 2498
        extract:
          orderId: response.body.order.id

      # Pay for the order
      - action:
          type: httpRequest
          method: POST
          url: api-gateway/v1/orders/{{orderId}}/pay
          body:
            paymentMethod: pm_test_visa
        assertions:
          # Stripe was charged the correct amount
          - match:
              origin: payment-service
              method: POST
              url: api.stripe.com/v1/charges
            assertions:
              - path: request.body.amount
                operator: eq
                value: 2498
              - path: request.body.currency
                operator: eq
                value: usd

          # A shipping label was created
          - match:
              origin: shipping-service
              method: POST
              url: api.easypost.com/v2/shipments
            assertions:
              - path: response.body.tracking_code
                operator: exists

          # Confirmation email was sent to the customer
          - match:
              origin: notification-service
              method: POST
              url: api.sendgrid.com/v3/mail/send
            assertions:
              - path: request.body.personalizations[0].to[0].email
                operator: eq
                value: buyer@example.com

          # SMS receipt was sent
          - match:
              origin: notification-service
              method: POST
              url: api.twilio.com
            assertions:
              - path: request.body.To
                operator: eq
                value: '+15551234567'
              - path: request.body.Body
                operator: contains
                value: '9400111899223456789012'

      # Verify the order was persisted correctly
      - action:
          type: dbQuery
          database: postgres-db
          query: 'SELECT status, total_cents FROM orders WHERE id = {{orderId}}'
        assertions:
          - assertions:
              - path: data[0].status
                operator: eq
                value: paid
              - path: data[0].total_cents
                operator: eq
                value: 2498

      # Verify stock was decremented
      - action:
          type: dbQuery
          database: postgres-db
          query: "SELECT stock FROM products WHERE sku = 'WIDGET-001'"
        assertions:
          - assertions:
              - path: data[0].stock
                operator: eq
                value: 49
```

One test covers the entire flow: order creation, payment processing, shipping label generation, email confirmation, SMS receipt, database persistence, and inventory management. Every assertion is deterministic because the seed data has known prices, stock levels, and customer contact info.

## Testing error handling

Error scenarios are where mocks really pay off. Create mock variants for each failure case:

```yaml
# .dokkimi/shared/mock-stripe-card-declined.yaml
type: MOCK
name: mock-stripe
mockTarget: api.stripe.com
mockPath: /v1/charges
mockResponseStatus: 402
mockResponseHeaders:
  content-type: application/json
mockResponseBody:
  error:
    type: card_error
    code: card_declined
    message: Your card was declined.
    decline_code: generic_decline
```

Now test that a declined card is handled correctly across the entire system:

```yaml
name: checkout-card-declined
items:
  - $ref: ../shared/api-gateway.yaml
  - $ref: ../shared/order-service.yaml
  - $ref: ../shared/payment-service.yaml
  - $ref: ../shared/notification-service.yaml
  - $ref: ../shared/postgres-db.yaml
  - $ref: ../shared/mock-stripe-card-declined.yaml
  - $ref: ../shared/mock-twilio-success.yaml
  - $ref: ../shared/mock-sendgrid-success.yaml

tests:
  - name: Card declined handling
    steps:
      - action:
          type: httpRequest
          method: POST
          url: api-gateway/v1/orders
          body:
            customerId: 1
            items:
              - sku: WIDGET-001
                quantity: 1
        extract:
          orderId: response.body.order.id

      - action:
          type: httpRequest
          method: POST
          url: api-gateway/v1/orders/{{orderId}}/pay
          body:
            paymentMethod: pm_test_visa
        assertions:
          # Payment was rejected
          - assertions:
              - path: response.status
                operator: eq
                value: 402
              - path: response.body.error
                operator: contains
                value: declined

          # No shipping label was created
          - match:
              origin: shipping-service
              url: api.easypost.com
            count:
              operator: eq
              value: 0

          # No confirmation email was sent
          - match:
              origin: notification-service
              url: api.sendgrid.com
            count:
              operator: eq
              value: 0

      # Order status should be payment_failed, not paid
      - action:
          type: dbQuery
          database: postgres-db
          query: 'SELECT status FROM orders WHERE id = {{orderId}}'
        assertions:
          - assertions:
              - path: data[0].status
                operator: eq
                value: payment_failed

      # Stock should NOT have been decremented
      - action:
          type: dbQuery
          database: postgres-db
          query: "SELECT stock FROM products WHERE sku = 'WIDGET-001'"
        assertions:
          - assertions:
              - path: data[0].stock
                operator: eq
                value: 50
```

This test verifies four critical behaviors: the error response is correct, no shipping label was created, no confirmation was sent, and the order was marked as failed. It also checks that stock wasn't decremented — a subtle bug where the inventory update happens before the payment check.

## Testing webhook callbacks

Stripe uses webhooks to notify your services asynchronously. After a charge succeeds, Stripe sends a `charge.succeeded` event to your webhook endpoint. Many payment flows rely on this rather than the synchronous charge response.

You can simulate webhooks by sending the HTTP request yourself. First, seed an order in the `payment_pending` state:

```yaml
name: stripe-webhook-charge-succeeded
items:
  - $ref: ../shared/api-gateway.yaml
  - $ref: ../shared/order-service.yaml
  - $ref: ../shared/payment-service.yaml
  - $ref: ../shared/shipping-service.yaml
  - $ref: ../shared/notification-service.yaml
  - $ref: ../shared/postgres-db.yaml
  - $ref: ../shared/mock-easypost-success.yaml
  - $ref: ../shared/mock-sendgrid-success.yaml
  - $ref: ../shared/mock-twilio-success.yaml

tests:
  - name: Stripe webhook triggers fulfillment
    steps:
      # Seed an order that's waiting for payment confirmation
      - action:
          type: dbQuery
          database: postgres-db
          query: >
            INSERT INTO orders (id, customer_id, status, total_cents)
            VALUES (100, 1, 'payment_pending', 2498)

      - action:
          type: dbQuery
          database: postgres-db
          query: >
            INSERT INTO order_items (order_id, product_id, quantity, unit_price_cents)
            VALUES (100, 1, 1, 999), (100, 2, 1, 1499)

      # Simulate the Stripe webhook
      - action:
          type: httpRequest
          method: POST
          url: payment-service/webhooks/stripe
          headers:
            stripe-signature: 'whsec_test_signature'
            content-type: application/json
          body:
            id: evt_test_001
            type: charge.succeeded
            data:
              object:
                id: ch_test_123
                amount: 2498
                status: succeeded
                metadata:
                  order_id: '100'
        assertions:
          - assertions:
              - path: response.status
                operator: eq
                value: 200

          # Order was marked as paid
          - match:
              origin: payment-service
              method: PATCH
              url: order-service/v1/orders/100
            assertions:
              - path: request.body.status
                operator: eq
                value: paid

          # Shipping was initiated
          - match:
              origin: shipping-service
              method: POST
              url: api.easypost.com/v2/shipments
            assertions:
              - path: response.status
                operator: eq
                value: 201

          # Customer was notified
          - match:
              origin: notification-service
              method: POST
              url: api.sendgrid.com/v3/mail/send
            assertions:
              - path: request.body.personalizations[0].to[0].email
                operator: eq
                value: buyer@example.com

      # Verify final state in the database
      - action:
          type: dbQuery
          database: postgres-db
          query: 'SELECT status FROM orders WHERE id = 100'
        assertions:
          - assertions:
              - path: data[0].status
                operator: eq
                value: paid
```

You're testing the entire asynchronous flow: Stripe fires a webhook, your payment service processes it, updates the order, triggers shipping, and sends notifications. Every step is verified through both HTTP assertions and a final database check.

## Testing rate limits and slow responses

Third-party APIs sometimes respond slowly or rate-limit you. Does your service handle that gracefully?

```yaml
# .dokkimi/shared/mock-stripe-rate-limited.yaml
type: MOCK
name: mock-stripe
mockTarget: api.stripe.com
mockPath: /v1/charges
mockResponseStatus: 429
mockResponseHeaders:
  content-type: application/json
  retry-after: '2'
mockResponseBody:
  error:
    type: rate_limit_error
    message: Too many requests.
```

```yaml
# .dokkimi/shared/mock-stripe-slow.yaml
type: MOCK
name: mock-stripe
mockTarget: api.stripe.com
mockPath: /v1/charges
mockResponseStatus: 200
mockDelayMs: 5000
mockResponseBody:
  id: ch_test_123
  status: succeeded
  amount: 2498
```

If your payment service has a 3-second timeout, the slow mock triggers it. You can assert that the service retries, returns a timeout error to the client, or queues the charge for later — whatever your retry policy dictates.

The rate limit mock lets you verify that your service respects the `Retry-After` header. Does it wait and retry, or does it fail immediately and return an error to the user?

## Testing out of stock

Here's a scenario that doesn't involve external APIs at all but benefits from the same seeded database approach. The Turbo Gadget has only 5 in stock:

```yaml
name: out-of-stock-rejection
items:
  - $ref: ../shared/api-gateway.yaml
  - $ref: ../shared/order-service.yaml
  - $ref: ../shared/postgres-db.yaml

tests:
  - name: Out of stock rejection
    steps:
      - action:
          type: httpRequest
          method: POST
          url: api-gateway/v1/orders
          body:
            customerId: 1
            items:
              - sku: GADGET-001
                quantity: 10
        assertions:
          - assertions:
              - path: response.status
                operator: eq
                value: 409
              - path: response.body.error
                operator: contains
                value: 'insufficient stock'

      # Stock should be unchanged
      - action:
          type: dbQuery
          database: postgres-db
          query: "SELECT stock FROM products WHERE sku = 'GADGET-001'"
        assertions:
          - assertions:
              - path: data[0].stock
                operator: eq
                value: 5
```

Because the seed file set the Turbo Gadget's stock to 5, you can test the boundary condition deterministically. No test flakiness from shared databases, no wondering what the stock level was when the test started.

## Organizing your test suite

As your test suite grows, organize by concern:

```
.dokkimi/
  shared/
    api-gateway.yaml
    order-service.yaml
    payment-service.yaml
    shipping-service.yaml
    notification-service.yaml
    postgres-db.yaml
    mock-stripe-success.yaml
    mock-stripe-card-declined.yaml
    mock-stripe-rate-limited.yaml
    mock-stripe-slow.yaml
    mock-easypost-success.yaml
    mock-sendgrid-success.yaml
    mock-twilio-success.yaml
  ecommerce/
    init/
      seed.sql
    definitions/
      checkout-happy-path.yaml
      checkout-card-declined.yaml
      checkout-rate-limited.yaml
      checkout-out-of-stock.yaml
      webhook-charge-succeeded.yaml
      webhook-charge-failed.yaml
```

The `shared/` directory has one file per service and one mock per external-API-scenario. The test definitions in `ecommerce/definitions/` reference them via `$ref` and focus on the test steps and assertions. When you add a new external API integration, you add a few mock files and a few test definitions — the services are already defined.

## Body matching for single-endpoint APIs

Some APIs route all traffic through a single endpoint — LLM APIs, GraphQL, and RPC-style services. You can use `mockRequestBodyContains` to return different responses based on the request payload:

```yaml
# Different GraphQL queries, different responses
- type: MOCK
  name: mock-graphql-users
  mockTarget: api.example.com
  mockPath: /graphql
  mockRequestBodyContains: getUsers
  mockResponseStatus: 200
  mockResponseBody:
    data:
      users:
        - id: '1'
          name: Alice

- type: MOCK
  name: mock-graphql-orders
  mockTarget: api.example.com
  mockPath: /graphql
  mockRequestBodyContains: getOrders
  mockResponseStatus: 200
  mockResponseBody:
    data:
      orders:
        - id: ord-1
          total: 99.99
```

For more precise matching, use `mockRequestBodyMatches` with a regex pattern:

```yaml
- type: MOCK
  name: mock-tool-call-search
  mockTarget: api.openai.com
  mockPath: /v1/chat/completions
  mockRequestBodyMatches: '"name":\s*"search_database"'
  mockResponseStatus: 200
  mockResponseBody:
    choices:
      - message:
          tool_calls:
            - function:
                name: search_database
                arguments: '{"results": 3}'
```

The two fields are mutually exclusive — use one or the other. `mockRequestBodyContains` is case-insensitive; `mockRequestBodyMatches` follows standard regex case sensitivity (add `(?i)` for case-insensitive). A mock without body matching serves as a fallback when no body-matching mock matches.

## Tips

- **Match real API responses exactly.** Copy a real response from Stripe's or Twilio's API docs and use that as your mock body. The closer your mocks are to reality, the more bugs they'll catch.
- **Test every error code your code handles.** If your payment service has a `switch` on Stripe error types (`card_error`, `rate_limit_error`, `api_error`), each case needs a test.
- **Use database steps to verify side effects.** Don't just check HTTP responses — confirm that stock was decremented, orders were updated, and nothing was half-written.
- **Test the absence of calls.** Verifying that a shipping label was _not_ created when payment failed is as important as verifying it _was_ created when payment succeeded.
- **Use `extract` to chain steps.** Capture the order ID from the create response and use it in subsequent steps. This keeps your tests realistic — real clients don't hard-code IDs.
- **Seed edge cases into your data.** Products with zero stock, customers with missing phone numbers, orders at price boundaries. The more your seed data reflects production variety, the more useful your tests become.
