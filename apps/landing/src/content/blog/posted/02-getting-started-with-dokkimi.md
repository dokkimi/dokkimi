---
title: 'Getting started with Dokkimi: your first test in 5 minutes'
description: 'A step-by-step walkthrough of installing Dokkimi and writing your first integration test.'
date: '2026-04-07'
slug: 'getting-started-with-dokkimi'
---

## Prerequisites

You need two things:

- **Node.js 20+**
- **Docker** — Docker Desktop is the easiest path.

## Install and verify

```bash
brew install dokkimi/tap/dokkimi
dokkimi doctor
```

`dokkimi doctor` checks that Docker is running and your system has enough resources. Fix anything it flags before continuing.

## Scaffold example definitions

```bash
mkdir my-project && cd my-project
dokkimi init
```

This creates a `.dokkimi/` folder with an example topology — a simple API gateway, a backend service, and a Postgres database.

```
.dokkimi/
  example/
    definitions/
      example-test.yaml
    shared/
      api-gateway.yaml
      backend-service.yaml
      postgres.yaml
```

## Anatomy of a test definition

Open `example-test.yaml`. A test definition has three sections:

**Items** — the services, databases, and mocks that make up your test environment:

```yaml
name: example-flow
items:
  - $ref: ../shared/api-gateway.yaml
  - $ref: ../shared/backend-service.yaml
  - $ref: ../shared/postgres.yaml
```

`$ref` lets you reuse service definitions across tests. You can also inline them.

**Variables** — values you can reference with `{{variableName}}` in actions and assertions:

```yaml
variables:
  testEmail: 'test@example.com'
```

**Tests** — the actual test cases, each with a sequence of steps:

```yaml
tests:
  - name: Create and fetch a user
    steps:
      - name: Create user
        action:
          type: httpRequest
          method: POST
          url: api-gateway/api/users
          body:
            email: '{{testEmail}}'
        assertions:
          - assertions:
              - path: $.response.status
                operator: eq
                value: 201
```

Steps are a flat array and run sequentially. If you need concurrent execution, use the `parallel` action type to run multiple actions at the same time.

## Run it

```bash
dokkimi run
```

Dokkimi will:

1. Create an isolated Docker environment.
2. Deploy your services with interceptor sidecars.
3. Seed any databases.
4. Attach a Chromium browser (if your test includes UI actions).
5. Wait for readiness checks to pass.
6. Execute your test steps — HTTP requests, database queries, and browser interactions.
7. Report results, diff screenshots against baselines, and tear everything down.

You'll see real-time output as each step executes and assertions pass or fail.

## Inspect traffic after a run

```bash
dokkimi inspect
```

This shows every HTTP call the interceptor captured during the last run — which service called which, what the request and response bodies were, and how long each call took. This is invaluable for debugging failures.

## Next steps

- Read the full [CLI reference](/docs) for all available commands.
- Look at the `$ref` pattern for sharing service definitions across test files.
- Try adding a `MOCK` item to intercept calls to an external API.
- Add a `ui` action to drive a browser through your frontend and take screenshots for visual regression testing.

Once you're comfortable with the basics, check out [how traffic interception works](/blog/how-traffic-interception-works) for a deeper look at what's happening under the hood.
