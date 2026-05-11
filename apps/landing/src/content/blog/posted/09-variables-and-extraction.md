---
title: 'Variables and data extraction in Dokkimi tests'
description: 'How to use variables for test data and extract values from responses to chain multi-step workflows.'
date: '2026-04-30'
slug: 'variables-and-extraction'
---

## Hardcoded values don't scale

Your first Dokkimi test probably hardcodes everything — email addresses, expected IDs, request bodies. That works for a single test, but it gets brittle fast. Change one value and you're updating it in five places.

Dokkimi has two mechanisms for keeping test data manageable: **variables** for values you know upfront, and **extraction** for values you learn at runtime.

## Variables

Define variables at the top of your test definition:

```yaml
variables:
  testEmail: 'integration-test@example.com'
  userName: 'Test User'
```

Reference them anywhere in actions or assertions with `{{variableName}}`:

```yaml
steps:
  - name: Create user
    action:
      type: httpRequest
      method: POST
      url: api-gateway/api/users
      body:
        email: '{{testEmail}}'
        name: '{{userName}}'
    assertions:
      - assertions:
          - path: response.body.email
            operator: eq
            value: '{{testEmail}}'
```

Variables are replaced at execution time. They work in action bodies, headers, URLs, and assertion values.

## Extraction

Variables cover values you know ahead of time. But what about values your services generate — IDs, tokens, timestamps? You can't predict those, but you need them for subsequent steps.

Extraction pulls values from responses and makes them available as variables:

```yaml
steps:
  - name: Create user
    action:
      type: httpRequest
      method: POST
      url: api-gateway/api/users
      body:
        email: '{{testEmail}}'
    extract:
      userId: $.body.id
      authToken: $.headers.x-auth-token

  - name: Fetch user
    action:
      type: httpRequest
      method: GET
      url: api-gateway/api/users/{{userId}}
      headers:
        Authorization: 'Bearer {{authToken}}'
```

The first step creates a user and extracts the `id` from the response body and the auth token from the response headers. The second step uses both values. Extraction uses JSONPath syntax (`$.body.id`, `$.headers.x-auth-token`) to navigate the response.

## Extraction in assertions

You can also extract values within assertion blocks. This is useful when you need a value from intercepted traffic (not just the direct response):

```yaml
assertions:
  - match:
      origin: api-gateway
      method: POST
      url: order-service/api/orders
    extract:
      internalOrderId: $.body.orderId
    assertions:
      - path: response.status
        operator: eq
        value: 201
```

The `internalOrderId` is now available in later steps, even though it came from an inter-service call you didn't initiate directly.

## Scoping rules

- **Variables** defined at the definition root are available to all tests and steps. Variables defined at the test level are scoped to that test and override root-level variables of the same name.
- **Extracted values** are available to all subsequent steps (but not to earlier steps or actions within a `parallel` block — extraction requires sequential ordering).
- If an extracted value shadows a variable, the extracted value wins.

## Practical patterns

**Chain a create-read-update-delete flow:**

```yaml
variables:
  testEmail: "crud-test@example.com"

tests:
  - name: Full CRUD cycle
    steps:
      - name: Create
        action: { type: httpRequest, method: POST, url: api-gateway/api/users, body: { email: "{{testEmail}}" } }
        extract: { userId: $.body.id }

      - name: Read
        action: { type: httpRequest, method: GET, url: api-gateway/api/users/{{userId}} }
        assertions:
          - assertions:
              - { path: response.body.email, operator: eq, value: "{{testEmail}}" }

      - name: Delete
        action: { type: httpRequest, method: DELETE, url: api-gateway/api/users/{{userId}} }
        assertions:
          - assertions:
              - { path: response.status, operator: eq, value: 204 }
```

Each step depends on the previous one's output. Sequential ordering ensures `userId` is available when it's needed.

## Tips

- **Name variables descriptively.** `testEmail` is better than `email` — it's clear this is test data, not production data.
- **Don't over-extract.** Only extract values you actually use in later steps. Extracting everything "just in case" makes tests harder to read.
- **Use variables for assertions too.** If you assert that a response contains `testEmail`, changing the email in one place updates both the request and the assertion.
