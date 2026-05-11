---
title: 'Mocking OAuth flows in service-to-service tests'
description: 'How to test services that depend on OAuth providers like Auth0, Okta, or Google without hitting real auth servers — using network-level mocks and token validation overrides.'
date: '2026-04-27'
slug: 'mocking-oauth-flows'
---

## The app we're testing

Imagine a project management tool — something like a simplified Linear or Jira. The architecture looks like this:

- **api-gateway** — validates JWTs on every request, fetches user profiles from the identity provider, and routes requests to backend services
- **project-service** — manages projects and tasks (CRUD, assignment, status changes)
- **notification-service** — sends email and Slack notifications when tasks are assigned or completed
- **postgres-db** — stores projects, tasks, and team memberships

Users authenticate via Auth0. When someone logs in through the frontend, they get a JWT. Every subsequent API request includes that JWT in the `Authorization` header. The API gateway validates the token by fetching Auth0's public keys, then passes the user's identity downstream.

The data model is simple:

```sql
CREATE TABLE teams (
  id SERIAL PRIMARY KEY,
  name VARCHAR(100) NOT NULL
);

CREATE TABLE team_members (
  team_id INTEGER REFERENCES teams(id),
  user_id VARCHAR(100) NOT NULL, -- Auth0 sub claim
  role VARCHAR(20) DEFAULT 'member',
  PRIMARY KEY (team_id, user_id)
);

CREATE TABLE projects (
  id SERIAL PRIMARY KEY,
  team_id INTEGER REFERENCES teams(id),
  name VARCHAR(200) NOT NULL,
  created_by VARCHAR(100) NOT NULL
);

CREATE TABLE tasks (
  id SERIAL PRIMARY KEY,
  project_id INTEGER REFERENCES projects(id),
  title VARCHAR(300) NOT NULL,
  assignee VARCHAR(100),
  status VARCHAR(20) DEFAULT 'todo',
  created_at TIMESTAMP DEFAULT NOW()
);
```

The challenge: every endpoint requires a valid JWT, and the gateway talks to Auth0 on every request. How do you test this without a real Auth0 tenant?

## Why this is hard without mocking

OAuth adds two external dependencies to every request:

1. **JWKS fetch.** The gateway calls `https://your-tenant.auth0.com/.well-known/jwks.json` to get the public keys for token validation. If Auth0 is down, rate-limiting you, or returning different keys than expected, your gateway rejects every request.
2. **Userinfo fetch.** After validation, the gateway calls `https://your-tenant.auth0.com/userinfo` to get the user's profile (name, email, avatar). This data is passed to downstream services so they know who's making the request.

You could create a real Auth0 tenant for testing, but then your tests depend on Auth0's availability, you're paying for API calls, and you can't control what the userinfo endpoint returns. You also can't test error scenarios — what happens when Auth0 returns a 500, or when a token has the wrong audience claim?

Dokkimi solves this by intercepting the network calls to Auth0 and returning exactly what you need.

## Seeding the database

First, set up test data so there's something meaningful to test against:

```sql
-- .dokkimi/project-mgmt/init/seed.sql

INSERT INTO teams (id, name) VALUES
  (1, 'Platform Team');

INSERT INTO team_members (team_id, user_id, role) VALUES
  (1, 'auth0|user-alice', 'admin'),
  (1, 'auth0|user-bob', 'member');

INSERT INTO projects (id, team_id, name, created_by) VALUES
  (1, 1, 'API Redesign', 'auth0|user-alice');

INSERT INTO tasks (id, project_id, title, assignee, status) VALUES
  (1, 1, 'Design new endpoint schema', 'auth0|user-alice', 'in_progress'),
  (2, 1, 'Write migration scripts', 'auth0|user-bob', 'todo'),
  (3, 1, 'Update client SDK', NULL, 'todo');

SELECT setval('teams_id_seq', 10);
SELECT setval('projects_id_seq', 10);
SELECT setval('tasks_id_seq', 10);
```

Notice that `user_id` values match Auth0 `sub` claims (`auth0|user-alice`). This is the link between your identity provider and your application data — and it's exactly the kind of thing that breaks when test data is inconsistent.

## Setting up the mock identity provider

The gateway makes two types of calls to Auth0. You need to mock both.

The JWKS endpoint returns the public keys used to validate token signatures:

```yaml
# .dokkimi/shared/mock-auth0-jwks.yaml
type: MOCK
name: mock-auth0-jwks
mockTarget: your-tenant.auth0.com
mockPath: /.well-known/jwks.json
mockResponseStatus: 200
mockResponseHeaders:
  content-type: application/json
mockResponseBody:
  keys:
    - kty: RSA
      kid: test-key-1
      use: sig
      n: '<base64url-encoded RSA modulus from your test key pair>'
      e: AQAB
```

The `n` value is the base64url-encoded RSA modulus from a test key pair that you generate and commit to your repo. You'll get this value when you run the key generation commands below — extract it with `openssl rsa -in private.pem -pubout -outform DER | openssl asn1parse` or use a library like `node-jose` to convert your public key to JWK format. These aren't real credentials — they only work against your mock JWKS.

The userinfo endpoint returns the profile for the authenticated user:

```yaml
# .dokkimi/shared/mock-auth0-userinfo-alice.yaml
type: MOCK
name: mock-auth0-userinfo
mockTarget: your-tenant.auth0.com
mockPath: /userinfo
mockResponseStatus: 200
mockResponseHeaders:
  content-type: application/json
mockResponseBody:
  sub: 'auth0|user-alice'
  email: alice@example.com
  email_verified: true
  name: Alice Chen
  picture: 'https://example.com/avatars/alice.png'
```

Your service code doesn't change at all. The gateway makes the same HTTPS call to `your-tenant.auth0.com` that it would in production — but DNS within the Dokkimi namespace resolves that domain to the mock handler.

## Generating test tokens

Your test steps need to send JWTs that the gateway will accept. The token must be signed with the private key corresponding to the public key in your JWKS mock.

Generate a key pair once and commit it to your repo:

```bash
openssl genrsa -out .dokkimi/test-keys/private.pem 2048
openssl rsa -in .dokkimi/test-keys/private.pem -pubout -out .dokkimi/test-keys/public.pem
```

Then generate a test token with any JWT library. Here's a quick Node script:

```javascript
const jwt = require('jsonwebtoken');
const fs = require('fs');

const privateKey = fs.readFileSync('.dokkimi/test-keys/private.pem');

const token = jwt.sign(
  {
    sub: 'auth0|user-alice',
    email: 'alice@example.com',
    iss: 'https://your-tenant.auth0.com/',
    aud: 'https://api.yourapp.com',
  },
  privateKey,
  { algorithm: 'RS256', expiresIn: '24h', keyid: 'test-key-1' },
);

console.log(token);
```

Set the `kid` to match one of the keys in your JWKS mock (`test-key-1`). Set the claims (`iss`, `aud`, `sub`) to match what your gateway expects. Copy the output token into your test definition.

## Testing the authenticated happy path

Now you can write a test that exercises the full flow — authenticated request through the gateway, hitting the project service, querying the database:

```yaml
name: list-tasks-authenticated
items:
  - $ref: ../shared/api-gateway.yaml
  - $ref: ../shared/project-service.yaml
  - $ref: ../shared/postgres-db.yaml
  - $ref: ../shared/mock-auth0-jwks.yaml
  - $ref: ../shared/mock-auth0-userinfo-alice.yaml

variables:
  aliceToken: 'eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCIsImtpZCI6InRlc3Qta2V5LTEifQ...'

tests:
  - name: List tasks for authenticated user
    steps:
      # List tasks for the project — requires authentication
      - action:
          type: httpRequest
          method: GET
          url: api-gateway/v1/projects/1/tasks
          headers:
            Authorization: 'Bearer {{aliceToken}}'
        assertions:
          # Got the right tasks back
          - assertions:
              - path: response.status
                operator: eq
                value: 200
              - path: response.body.tasks.length
                operator: eq
                value: 3
              - path: response.body.tasks[0].title
                operator: eq
                value: 'Design new endpoint schema'

          # The gateway validated the token against Auth0
          - match:
              origin: api-gateway
              method: GET
              url: your-tenant.auth0.com/.well-known/jwks.json
            assertions:
              - path: response.status
                operator: eq
                value: 200

          # The gateway fetched the user profile
          - match:
              origin: api-gateway
              method: GET
              url: your-tenant.auth0.com/userinfo
            assertions:
              - path: response.body.sub
                operator: eq
                value: 'auth0|user-alice'
```

This test verifies the entire auth chain: the gateway fetched the JWKS to validate the token, called userinfo to get the profile, and the project service returned the right tasks for Alice's team. Because the database was seeded with known data, every assertion is deterministic.

## Testing authorization rules

Authentication tells you _who_ the user is. Authorization tells you _what they can do_. If your app has role-based access control, you need tests for it.

Say only admins can delete tasks. Alice is an admin, Bob is a member:

```yaml
name: only-admins-can-delete
items:
  - $ref: ../shared/api-gateway.yaml
  - $ref: ../shared/project-service.yaml
  - $ref: ../shared/postgres-db.yaml
  - $ref: ../shared/mock-auth0-jwks.yaml

variables:
  bobToken: 'eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJhdXRoMHx1c2VyLWJvYiJ9...'

tests:
  - name: Member cannot delete tasks
    steps:
      # Bob tries to delete a task — should be denied
      - action:
          type: httpRequest
          method: DELETE
          url: api-gateway/v1/tasks/3
          headers:
            Authorization: 'Bearer {{bobToken}}'
        assertions:
          - assertions:
              - path: response.status
                operator: eq
                value: 403

      # Verify the task still exists
      - action:
          type: dbQuery
          database: postgres-db
          query: 'SELECT id FROM tasks WHERE id = 3'
        assertions:
          - assertions:
              - path: data.length
                operator: eq
                value: 1
```

The Bob token has `sub: auth0|user-bob`, which maps to a `member` role in the `team_members` table. The gateway validates the token, the project service looks up the role, and returns a 403. The database step confirms the task wasn't actually deleted — it's not enough to check the status code, because a bug might return 403 while still executing the delete.

## Testing token expiration and invalid tokens

Error handling is just as important as the happy path. Create separate tests for each failure scenario:

```yaml
name: expired-token-rejected
variables:
  expiredToken: 'eyJhbGciOiJSUzI1NiJ9.eyJleHAiOjE2MDAwMDAwMDB9...'

tests:
  - name: Expired token is rejected
    steps:
      - action:
          type: httpRequest
          method: GET
          url: api-gateway/v1/projects/1/tasks
          headers:
            Authorization: 'Bearer {{expiredToken}}'
        assertions:
          - assertions:
              - path: response.status
                operator: eq
                value: 401
              - path: response.body.error
                operator: contains
                value: expired
```

```yaml
name: missing-token-rejected
tests:
  - name: Missing token is rejected
    steps:
      - action:
          type: httpRequest
          method: GET
          url: api-gateway/v1/projects/1/tasks
        assertions:
          - assertions:
              - path: response.status
                operator: eq
                value: 401
```

You can also test what happens when Auth0 itself is down. If you don't define the JWKS mock, the gateway's call to Auth0 will fail. Does your gateway return a 503? Does it cache the last known keys and keep working? That's a critical behavior to verify, and it's almost impossible to test against a real identity provider.

## Service-to-service token exchange

In more complex architectures, services authenticate to each other using client credentials. The notification service might need its own token to call the project service's internal API.

Mock the token endpoint to handle client credentials grants:

```yaml
- type: MOCK
  name: mock-auth0-token
  mockTarget: your-tenant.auth0.com
  mockPath: /oauth/token
  mockResponseStatus: 200
  mockResponseHeaders:
    content-type: application/json
  mockResponseBody:
    access_token: 'eyJhbGciOiJSUzI1NiJ9...'
    token_type: bearer
    expires_in: 3600
```

Then write a test that triggers the full chain — a task gets assigned, which triggers a notification, which requires the notification service to authenticate to the project service to fetch task details:

```yaml
name: task-assignment-notification
items:
  - $ref: ../shared/api-gateway.yaml
  - $ref: ../shared/project-service.yaml
  - $ref: ../shared/notification-service.yaml
  - $ref: ../shared/postgres-db.yaml
  - $ref: ../shared/mock-auth0-jwks.yaml
  - $ref: ../shared/mock-auth0-userinfo-alice.yaml
  - $ref: ../shared/mock-auth0-token.yaml
  - $ref: ../shared/mock-sendgrid-success.yaml

variables:
  aliceToken: 'eyJhbGciOiJSUzI1NiIsImtpZCI6InRlc3Qta2V5LTEifQ...'

tests:
  - name: Assigning a task triggers notification
    steps:
      # Alice assigns a task to Bob
      - action:
          type: httpRequest
          method: PATCH
          url: api-gateway/v1/tasks/3
          headers:
            Authorization: 'Bearer {{aliceToken}}'
          body:
            assignee: 'auth0|user-bob'
        assertions:
          - assertions:
              - path: response.status
                operator: eq
                value: 200

          # Notification service fetched a service token
          - match:
              origin: notification-service
              method: POST
              url: your-tenant.auth0.com/oauth/token
            assertions:
              - path: request.body.grant_type
                operator: eq
                value: client_credentials

          # Notification email was sent to Bob
          - match:
              origin: notification-service
              method: POST
              url: api.sendgrid.com/v3/mail/send
            assertions:
              - path: request.body.personalizations[0].to[0].email
                operator: eq
                value: bob@example.com

      # Verify the task assignment was persisted
      - action:
          type: dbQuery
          database: postgres-db
          query: 'SELECT assignee FROM tasks WHERE id = 3'
        assertions:
          - assertions:
              - path: data[0].assignee
                operator: eq
                value: 'auth0|user-bob'
```

## Tips for OAuth testing

- **Generate your test key pair once and commit it.** These aren't real credentials — they only work against your mock JWKS. Put them in `.dokkimi/test-keys/`.
- **Use `$ref` for auth mocks.** You'll need the same JWKS and userinfo mocks across almost every test. Shared files keep things DRY.
- **Match `sub` claims to your seed data.** The user IDs in your tokens, your userinfo mocks, and your database seeds must all agree. Mismatches here are a common source of confusing test failures.
- **Don't skip validation in tests.** It's tempting to configure your gateway to bypass JWT checks in test mode, but that defeats the purpose. The whole point is to verify that the auth chain works correctly with real-shaped tokens and responses.
- **Test multiple users.** Create tokens and userinfo mocks for at least two users with different roles. Authorization bugs almost always require two actors to reproduce.
