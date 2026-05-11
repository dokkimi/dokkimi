# Contributing to Dokkimi

Thanks for your interest in contributing to Dokkimi! This guide covers how to set up the dev environment, run tests, and submit changes.

## Prerequisites

- Node.js 22+
- Yarn (the repo uses Yarn workspaces)
- Go 1.21+
- Docker Desktop with Kubernetes enabled
- kubectl

## Setup

```bash
git clone https://github.com/dokkimi/dokkimi.git
cd dokkimi
yarn install
```

Generate the Prisma client (required before building):

```bash
cd shared/prisma && npx prisma generate
```

## Development

### Dev mode

```bash
yarn dev:cli
```

This starts Control Tower and the CLI in watch mode. To make the `dokkimi` binary available in other terminals:

```bash
yarn link      # symlinks dokkimi onto your PATH
yarn unlink    # undo
```

### Building

```bash
yarn build             # Full build: shared → services → apps
yarn build:shared      # Shared libraries only
yarn build:services    # NestJS services only
```

Build order matters for shared packages: `config → platform → telemetry → definition-validator → definition-resolver → service-manager`

After changing shared types, rebuild the affected package:

```bash
cd shared/config && yarn build
```

### Monorepo structure

The repo has three top-level directories:

- **`shared/`** — internal TypeScript libraries consumed by apps and services. Build order matters: `config → platform → telemetry → definition-validator → definition-resolver → service-manager`. All packages are `private: true` and use `workspace:*` protocol — they are not published to npm.
- **`services/`** — Control Tower (NestJS) and Go sidecars (interceptor, test-agent, db-proxy variants).
- **`apps/`** — CLI, VSCode extension, and landing site.

To add a new shared package, create it under `shared/<name>`, add it to the `workspaces` array in the root `package.json`, and slot it into the `build:shared` script in dependency order.

### Go services

Go services (interceptor, test-agent, db-proxy) compile independently:

```bash
cd services/interceptor && go build ./...
cd services/test-agent && go build ./...
```

### Docker images

Go sidecars are packaged as Docker images (`ghcr.io/dokkimi/<name>`). Control Tower uses `dokkimi/control-tower` (local only).

To build images locally:

```bash
./scripts/rebuild-go-services.sh     # All Go sidecar images
./scripts/rebuild-node-services.sh   # Control Tower image
./scripts/rebuild-all.sh             # Everything
```

CI builds these images automatically on every push but only publishes them on version tags. When working on a fork, you'll need to build images locally to test sidecar changes.

### VSCode extension

The VSCode extension lives in `apps/vscode/`. To build and test it locally:

```bash
yarn workspace @dokkimi/definition-validator build   # dependency
yarn workspace dokkimi-vscode package                # produces a .vsix file
```

Then install the `.vsix` in VSCode via **Extensions → ⋯ → Install from VSIX**.

## Testing

### TypeScript

```bash
yarn workspace control-tower test                                    # All Control Tower tests
yarn workspace control-tower test -- --testPathPattern=runs          # Single file/pattern
yarn workspace @dokkimi/definition-validator test                    # Validator tests
```

### Go

```bash
cd services/interceptor && go test ./...
cd services/test-agent && go test -vet=off ./...
cd services/db-proxy/postgres && go test ./...    # also: mysql, mongo, redis
```

### Linting and formatting

```bash
yarn lint          # ESLint
yarn lint:fix      # ESLint with auto-fix
yarn format        # Prettier (write)
yarn format:check  # Prettier (check only)
```

## Pre-commit hooks

The repo uses [Husky](https://typicode.github.io/husky/) + [lint-staged](https://github.com/lint-staged/lint-staged) to run ESLint and Prettier on staged files before each commit. These are installed automatically by `yarn install`. If a commit is rejected, fix the reported issues and commit again.

## Submitting Changes

1. Fork the repo and create a branch from `main`.
2. Make your changes. Add tests if you're adding or changing behavior.
3. Run `yarn lint` and `yarn format:check` to make sure your code passes.
4. Run the relevant test suites (see above).
5. Open a pull request against `main`.

### RFCs for complex changes

For non-trivial features — new item types, changes to the definition format, new sidecar behavior, architectural changes — open an RFC before writing code. Create a markdown file in `docs/proposed/` describing the motivation, proposed design, and any trade-offs. Once the RFC is approved, move to implementation.

Bug fixes, small improvements, and documentation changes don't need an RFC.

### PR expectations

- Keep PRs focused — one feature or fix per PR.
- Write a clear description of what changed and why.
- Complex features should reference their approved RFC in `docs/proposed/`.
- If your change affects the definition format, update `shared/docs/dokkimi-instructions.md`.
- If your change affects architecture, update `docs/ARCHITECTURE.md`.

## Reporting Issues

Open an issue on [GitHub Issues](https://github.com/dokkimi/dokkimi/issues). Include:

- What you were trying to do
- What happened instead
- Output of `dokkimi doctor`
- Output of `dokkimi dump` if a test run failed

## Architecture

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for a full overview of how the system works.

## License

By contributing, you agree that your contributions will be licensed under the project's [Elastic License 2.0](LICENSE).
