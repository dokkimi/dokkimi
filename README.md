# Dokkimi

**The only testing framework that does integration, E2E, and visual regression testing. All without a staging environment.**

Dokkimi spins up isolated Docker environments from simple YAML/JSON definitions. It deploys your services, databases, and mocks into dedicated networks, drives a real browser through your UI, intercepts all inter-service HTTP traffic, and runs automated test suites that assert on responses, traffic patterns, database state, and screenshots.

## Why Dokkimi?

Testing microservices is hard. Unit tests mock away the interesting parts. Integration tests are flaky and slow to set up. Staging environments drift from reality.

Dokkimi gives you **isolated test environments on demand**:

- **E2E UI testing** — drive a real browser alongside your services. Click, type, navigate, and assert on what the user sees.
- **Visual regression** — screenshot any step, diff against baselines. Catch visual regressions before they ship.
- **Traffic interception** — capture every HTTP call between services. Assert on exactly what was sent and received.
- **Mock external APIs** — intercept calls to external APIs such as Stripe, Auth0, Twilio, and more. Return controlled responses. No test accounts needed.
- **Body-aware mock routing** — return different mock responses from the same endpoint based on request body content. Test LLM prompt routing, GraphQL queries, and RPC-style APIs where every call hits one URL.
- **Database seeding & queries** — seed Postgres, MySQL, MongoDB, or Redis before tests with custom data. Query directly in assertions to verify content.
- **Isolated environments** — every test run gets its own network with dedicated services, databases, and browser. No shared state. No corrupted tests.
- **Variable extraction** — extract values from responses using JSONPath + regex capture groups, then use them in subsequent steps.
- **Parallel test execution** — run steps in parallel within a test, and run multiple test definitions concurrently.
- **Zero code changes** — your services run unmodified. Dokkimi wires up sidecars, routing, DNS, browser, and cleanup.

## Install

```bash
# Global install
npm install -g dokkimi

# Or with Homebrew
brew install dokkimi/tap/dokkimi

# Or as a project devDependency
yarn add -D dokkimi
```

## Prerequisites

- Node.js 22+
- Docker

Run `dokkimi doctor` after installing to verify your setup.

## Quick Start

```bash
# Scaffold a .dokkimi/ folder with example files
dokkimi init

# Validate your definitions
dokkimi validate

# Run tests
dokkimi run

# Inspect traffic from the last run
dokkimi inspect

# Review pending visual baselines
dokkimi baselines
```

## What a Definition Looks Like

A `.dokkimi/` folder contains YAML or JSON files that describe your test environment and assertions:

```yaml
name: author-publish-flow
items:
  - $ref: ../shared/web-app.yaml
  - $ref: ../shared/api-gateway.yaml
  - $ref: ../shared/post-service.yaml
  - $ref: ../shared/postgres-db.yaml
  - $ref: ../shared/mock-auth0-jwks.yaml

tests:
  - name: Publish a post through the UI
    steps:
      - name: Create and publish a post
        action:
          type: ui
          target: web-app
          steps:
            - visit: /posts/new
            - type:
                selector: '#title'
                text: 'My new post'
            - click: '[data-testid="publish-btn"]'
            - waitFor: '[data-testid="success-toast"]'
            - screenshot: post-published
        assertions:
          - match:
              origin: web-app
              method: POST
              url: api-gateway/v1/posts
            assertions:
              - path: response.status
                operator: eq
                value: 201

      - name: Verify post in database
        action:
          type: dbQuery
          database: postgres-db
          query: "SELECT title FROM posts WHERE title = 'My new post'"
        assertions:
          - assertions:
              - path: data[0].title
                operator: eq
                value: My new post
```

This single definition spins up a web app, API gateway, post service, Postgres database, and an Auth0 mock — then drives a browser through the publish flow, asserts on the inter-service HTTP call, and verifies the data was written to the database.

Services are defined as shared fragments and referenced with `$ref` — write once, reuse across all your test definitions.

```yaml
# .dokkimi/shared/api-gateway.yaml
type: SERVICE
name: api-gateway
image: ${{REGISTRY}}/api-gateway:${{IMAGE_TAG}}
port: 3000
healthCheck: /health
env:
  - name: DATABASE_URL
    value: postgresql://dokkimi:dokkimi@postgres-db:5432/dokkimi
  - name: USER_SERVICE_URL
    value: http://user-service:3000
```

Image tags and other values can be centralized in `.dokkimi/config.yaml` using `${{VAR}}` syntax — change once, apply everywhere.

## Commands

| Command                     | Description                                       |
| --------------------------- | ------------------------------------------------- |
| `dokkimi init`              | Scaffold a `.dokkimi/` folder with examples       |
| `dokkimi run [target]`      | Run definition(s) and stream results              |
| `dokkimi validate [target]` | Validate definitions without running              |
| `dokkimi inspect`           | Inspect traffic logs from the last run            |
| `dokkimi baselines`         | Review and approve pending visual baselines       |
| `dokkimi dump`              | Export last run as JSON for AI-assisted debugging |
| `dokkimi doctor`            | Check prerequisites and system health             |
| `dokkimi status`            | Show whether Dokkimi is running                   |
| `dokkimi clean`             | Stop all instances and clean up resources         |
| `dokkimi config`            | View and edit Dokkimi settings                    |
| `dokkimi reboot`            | Restart Dokkimi services                          |
| `dokkimi uninstall`         | Remove Dokkimi from your cluster                  |
| `dokkimi version`           | Show installed version                            |

The `[target]` argument is flexible — pass a directory, a specific file, a glob pattern, or a substring to match definition names.

## Built for AI-Assisted Development

Dokkimi definitions are designed for coding agents. Let Claude, Cursor, or Copilot write and debug your tests.

- **Auto-registers with your AI tools** — on first run, Dokkimi installs context into Claude Code, Cursor, and GitHub Copilot so your AI assistant understands the `.dokkimi/` definition format.
- **AI-readable definition format** — YAML/JSON definitions are structured data that LLMs can read, generate, and modify accurately. Ask your AI to "write a test definition for the checkout flow" and it just works.
- **`dokkimi dump`** — exports a complete JSON snapshot of your last run (traffic logs, test results, assertions, errors) formatted for LLM context. Paste it into your AI tool to debug failures without manually digging through logs.
- **1,000+ line reference spec** — the full definition reference (`dokkimi-instructions.md`) is automatically available to your AI agent, covering every field, type, and pattern.

## Development

See [CONTRIBUTING.md](CONTRIBUTING.md) for how to set up the dev environment and submit changes.

```bash
git clone https://github.com/dokkimi/dokkimi.git
cd dokkimi
yarn install
yarn dev:cli    # Start Control Tower + CLI in watch mode
```

Full architecture doc: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)

## Documentation

- [Website](https://dokkimi.com)
- [Docs](https://dokkimi.com/docs)
- [Tutorials](https://dokkimi.com/tutorials)
- [Community](https://github.com/dokkimi/dokkimi/discussions)

Full reference for writing `.dokkimi/` definition files: `~/.dokkimi/dokkimi-instructions.md` (installed automatically on first run).

## License

[Elastic License 2.0](LICENSE) — free to use, modify, and distribute. Cannot be offered as a managed service.
