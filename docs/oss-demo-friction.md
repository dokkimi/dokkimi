# Dokkimi Fixes from OSS Demos

Issues discovered while testing two open-source projects (Hyperswitch and Lago) end-to-end with Dokkimi. Most are small — estimated effort noted per item.

## Bugs

### 1. `stopOnFailure: false` does not prevent step cascade

When a step with `stopOnFailure: false` fails, all subsequent steps are still skipped with "Step was not executed — a previous step failed before reaching this step." The flag has no effect.

**Workaround:** Split into separate tests so failures don't cascade.

**Discovered in:** Lago definition 06 — webhook assertions failed but DB assertions should have continued.

---

## Missing Features

### 2. `mountFiles` on SERVICE items

Both Hyperswitch and Lago required wrapper Dockerfiles solely to COPY config files, keys, and scripts into the container. This was the single biggest source of friction across both projects.

- Hyperswitch: 146KB TOML config file
- Lago: RSA private key, patched rake file, custom entrypoint

**Already spec'd:** [docs/mount-files-proposal.md](mount-files-proposal.md) — ~60-80 lines across 5 files, following the existing DATABASE `initFilePath` pattern.

### 3. `entrypoint` / `command` override on SERVICE

Lago needed a custom entrypoint that waits for Postgres/Redis, runs migrations, seeds the org, starts Sidekiq in the background, then starts the Rails server. Without an override, we baked all of this into a wrapper Dockerfile.

```yaml
type: SERVICE
name: lago-api
image: getlago/api:v1.48.1
port: 3000
entrypoint: /app/scripts/entrypoint.sh
```

Combined with `mountFiles`, this would eliminate wrapper Dockerfiles entirely for both projects.

### 4. `image` override on DATABASE items

Lago uses `getlago/postgres-partman:15.0-alpine` (Postgres with the pg_partman extension). DATABASE only accepts a `version` field that maps to `postgres:<version>`, so we had to manually tag the image before every run:

```bash
docker tag getlago/postgres-partman:15.0-alpine postgres:15-partman
```

An `image` field on DATABASE (like SERVICE already has) would fix this:

```yaml
type: DATABASE
name: lago-postgres
databaseType: postgres
image: getlago/postgres-partman:15.0-alpine
```

### 5. Built-in Docker image build

We ran `docker build -t dokkimi/lago-api:local .` manually outside Dokkimi before every run. A `build` field on SERVICE would let `dokkimi run` build it automatically:

```yaml
type: SERVICE
name: lago-api
build: ../docker/Dockerfile
port: 3000
```

Lower priority than `mountFiles` + `entrypoint` since those two together eliminate most wrapper images.

---

## Design Friction

### 6. Traffic assertions require a dummy wait step

To assert on accumulated inter-service traffic, we used a `type: wait` action with `durationMs: 1` just to get access to `$.traffic`:

```yaml
- name: Verify webhook delivered
  action:
    type: wait
    durationMs: 1
  assertions:
    - match:
        path: $.traffic
        where:
          - path: $$.origin
            operator: eq
            value: lago-api
```

A dedicated step type or the ability to add match blocks without a dummy action would be cleaner.

### 7. Traffic is scoped per test

`$.traffic` only includes traffic captured during the current test's steps. When we split definition 06 into separate tests, test 3 couldn't see traffic from test 2. This forced us to merge assertions back into a single test.

This might be intentional (test isolation), but it was surprising. Consider either documenting this clearly or offering a `$.allTraffic` that spans the full definition run.

### 8. YAML not mentioned in docs

The reference says definition files are "JSON files in a `.dokkimi/` folder" and all examples use JSON, but YAML works fine. All six Lago definitions are YAML. The docs should mention YAML as supported.

---

## Impact Summary

| Fix                    | Effort  | Impact                                           |
| ---------------------- | ------- | ------------------------------------------------ |
| `stopOnFailure` bug    | Small   | Unblocks non-linear test flows                   |
| `mountFiles`           | Medium  | Eliminates wrapper Dockerfiles                   |
| `entrypoint`/`command` | Small   | Eliminates wrapper Dockerfiles (with mountFiles) |
| DATABASE `image`       | Small   | Eliminates manual `docker tag` workaround        |
| Docker build           | Medium  | Quality of life, lower priority                  |
| Traffic assertion UX   | Small   | Cleaner definitions                              |
| Traffic scope docs     | Trivial | Prevent user confusion                           |
| YAML in docs           | Trivial | Accuracy                                         |

Fixes 1-4 would have saved ~2 hours of friction across both projects and eliminated the entire `.dokkimi/lago/docker/` directory.
