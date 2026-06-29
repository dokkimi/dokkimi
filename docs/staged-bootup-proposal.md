# Staged Bootup Order for Items

## Problem

All items in a definition boot in parallel. Services that expect their dependencies (databases, other services) to be already running will crash if those dependencies aren't up yet. Users must work around this by writing custom entrypoint scripts with wait loops — polling dependencies manually before starting the actual application.

Example from the Lago demo: `lago-api` requires Postgres and Redis to be available at startup (no reconnection logic). The workaround was a mounted `entrypoint.sh` that busy-waits on `pg_isready` and TCP probes before starting Rails:

```bash
until pg_isready -h lago-postgres -p 5432 -q; do sleep 2; done
until bash -c "echo > /dev/tcp/lago-redis/6379" 2>/dev/null; do sleep 2; done
bundle exec rails server -b 0.0.0.0 -p 3000
```

This is boilerplate that Dokkimi should handle.

## Solution

Each item can have an optional `stage` property (non-negative integer, defaults to 0). Items deploy in stage order — stage N+1 containers don't start until all stage N items are healthy.

```yaml
items:
  - $ref: ../shared/postgres.yaml
    stage: 0
  - $ref: ../shared/redis.yaml
    stage: 0
  - $ref: ../shared/lago-api.yaml
    stage: 1
```

Stage 0 (Postgres + Redis) boots and becomes healthy. Only then does stage 1 (lago-api) deploy. Lago-API can assume its dependencies exist at startup — no wait loops needed.

### Backwards compatibility

Items without a `stage` property default to stage 0 — all items boot in parallel. No changes required for existing definitions.

## Architecture

### Current flow (no stages)

1. CLI resolves definitions, POSTs to CT
2. CT deploys all containers (fire-and-forget), marks instance RUNNING
3. Sidecars health-check their containers, report to CT and test-agent
4. Test-agent waits for ALL items healthy via `allReadyChan`, then runs tests

### New flow (with stages)

1. CLI resolves definitions (including stage properties), POSTs to CT
2. CT groups items by `stage` prop, deploys **stage 0 containers only** + test-agent + global interceptor
3. Sidecars for stage 0 items health-check and report to CT and test-agent
4. Test-agent waits for **stage 0 items** to be healthy
5. Test-agent calls CT: `POST /instances/:id/run-stage` with `{ stage: 1 }`
6. CT deploys stage 1 containers
7. Sidecars for stage 1 items health-check and report to CT and test-agent
8. Test-agent waits for **stage 1 items** to be healthy
9. If more stages: repeat from step 5. If final stage: test-agent starts tests immediately

### Key properties

- **CT stays request-driven.** It never polls or watches health data. It deploys on startup (stage 0) and deploys on ping (subsequent stages).
- **Test-agent stays the health authority.** It already tracks health and gates execution. The only change: gate per stage instead of all-at-once, and call CT between stages.
- **One new endpoint.** `POST /instances/:id/run-stage` is the only new coordination between TA and CT.
- **Timeout unchanged.** A single run-level timeout covers all stages.
- **Items stay flat.** The `stage` property is just a field on each item — no nested arrays, no structural changes to the definition format.

## Implementation

### 1. Definition format

SERVICE, DATABASE, and BROKER items accept an optional `stage` field (MOCKs don't create containers and do not accept `stage`):

```json
{
  "type": "SERVICE",
  "name": "my-api",
  "image": "my-api:latest",
  "port": 3000,
  "stage": 1
}
```

The `stage` field can also be set in shared fragments. It's validated as a non-negative integer by the validator.

### 2. CT: Deployer split

`DockerDeployerService.deploy()` is currently monolithic — it creates the network, pulls images, starts test-agent, and deploys all items in one method. This needs to be split:

- **One-time setup** (stays in `deploy()`): create network, pull all images across all stages upfront (want them cached before any stage starts), deploy global interceptor + test-agent, resolve test-agent IP. Compute stage groups from item `stage` props using `groupItemsByStage()` and store in `DeploymentSession` (in-memory) for subsequent stage deployments.
- **Per-stage deployment** (extract to `deployStageItems(session, stageIndex)`): apply the existing db→broker→service phase ordering within the given item subset. Databases first, then brokers, then services — same ordering as today, just scoped to one stage's items. Called by `deploy()` for stage 0 and by the `run-stage` handler for subsequent stages.
- **RUNNING transition**: `deploy()` sets RUNNING immediately for single-stage definitions (stage 0 is the only and final stage). For multi-stage definitions, the `run-stage` handler sets RUNNING when deploying the final stage.

### 3. CT: `POST /instances/:id/run-stage`

New endpoint in the runs module (`InstanceStageController`).

```typescript
POST /instances/:instanceId/run-stage
Body: { stage: 1 }

// Response (stage deployed)
{ deployed: true }

// Response (already deployed — idempotent)
{ deployed: true }

// Response (out of bounds)
400
```

Validation is lightweight and stateless — no new DB field needed:

- **Bounds check**: is `stage` a valid index into the computed stage groups?
- **Already-deployed check**: are the items in this stage already in `STARTING` or beyond? If so, return idempotent success. This guards against duplicate calls (network retry) without CT needing to track a stage counter — the item statuses CT already stores are sufficient.

### 4. Test-agent: Staged health tracker

`ExpectedItemStages [][]string` — computed from item stage props at config-write time by `DockerDeployConfigService`.

Health tracker keeps a single `HealthTracker` with a `Reset(newExpectedIds)` method that swaps in a new expected set and creates a fresh `allReadyChan`. No routing logic needed — there's always exactly one active tracker. Health updates for items from previous stages are harmlessly dropped (not in expected set).

```go
for stageIdx, stageItems := range stages {
    healthTracker.Reset(stageItems)
    <-healthTracker.allReadyChan  // or timeout
    if stageIdx < len(stages)-1 {
        if err := callCT_RunStage(instanceId, stageIdx+1); err != nil {
            // Treat as stage failure — tear down
            notifyCompletion(STAGE_DEPLOY_FAILED)
            return
        }
    }
}
// All stages healthy — run tests
```

**Race window note**: There's a brief window between `callCT_RunStage` returning and `Reset(nextStageItems)` executing where a sidecar from the new stage could report healthy and get dropped (tracker still has the old expected set). This is harmless — container startup + health checks take seconds while the loop iteration takes microseconds, and sidecars report health continuously on an interval (adaptive polling at 1.5s/500ms) so the next update lands after `Reset()`.

### 5. Resolver

The resolver is stage-unaware. Items stay as a flat array throughout resolution. The `stage` property passes through like any other field.

### 6. Validation

- `stage` must be a non-negative integer
- `stage` is optional (defaults to 0)
- Stage numbers are sort keys, not indices — `0, 2, 5` is three stages deployed in that order with no error. `groupItemsByStage()` sorts by stage number and maps to a dense array of groups.
- MOCK items do not accept `stage` — they don't create containers and are excluded from stage grouping

## What doesn't change

- `${{VAR}}` and `{{VAR}}` interpolation — items are flat, no structural change
- `$ref` resolution — works on flat items as before
- Test execution — test-agent runs tests the same way after all stages are healthy
- Crash monitoring — CT monitors all deployed containers regardless of stage
- Teardown — all containers (across all stages) tear down together at run end
- Run timeout — single timeout covers the entire run including all stages

## Files touched

| File                                                                                    | Change                                                                                                                        |
| --------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `shared/definition-validator/validate-items.ts`                                         | Validate `stage` as non-negative integer                                                                                      |
| `shared/definition-validator/constants.ts`                                              | Add `stage` to `VALID_ITEM_KEYS` for SERVICE, DATABASE, BROKER (not MOCK)                                                     |
| `services/control-tower/src/runs/dto/submit-instance.dto.ts`                            | Add optional `stage` field to `DefinitionItemDto`                                                                             |
| `services/control-tower/src/namespace-lifecycle/deployment-context.types.ts`            | Add `stage` to `DefinitionItem` interface                                                                                     |
| `services/control-tower/src/namespace-lifecycle/docker/docker-deployer.service.ts`      | Add `groupItemsByStage()`, split deploy into one-time setup + `deployStageItems()`, store stage groups in `DeploymentSession` |
| `services/control-tower/src/namespace-lifecycle/docker/docker-deploy-config.service.ts` | Compute `expectedItemStages` from item `stage` props                                                                          |
| `services/control-tower/src/runs/instance-stage.controller.ts`                          | New `POST /instances/:id/run-stage` endpoint                                                                                  |
| `services/control-tower/src/namespace-lifecycle/namespace-lifecycle.service.ts`         | `deployStage()` method                                                                                                        |
| `services/test-agent/main.go`                                                           | Stage-aware health gating loop, CT ping between stages, failure handling                                                      |
| `services/test-agent/health_tracker.go`                                                 | Add `Reset(newExpectedIds)` method                                                                                            |
| `services/test-agent/types.go`                                                          | `ExpectedItemStages [][]string`                                                                                               |
| `apps/vscode/src/schema/dokkimi.schema.json`                                            | Add `stage` property to SERVICE, DATABASE, BROKER schemas (not MOCK)                                                          |
| `shared/docs/dokkimi-instructions.md`                                                   | Document `stage` property                                                                                                     |
| `apps/landing/src/pages/docs/project-structure.astro`                                   | Document `stage` property in item reference                                                                                   |
| `docs/staged-bootup-proposal.md`                                                        | This document                                                                                                                 |

## Decisions

1. **Status transitions**: Instance stays `STARTING` across all stages. `deploy()` sets `RUNNING` for single-stage definitions. `run-stage` handler sets `RUNNING` when deploying the final stage.
2. **Per-stage timeouts**: Global `timeoutSeconds` covers the entire run including all stages. Per-stage timeouts add config complexity — can be added later if users request it.
3. **Stage failure**: Tear down everything. Partial teardown creates orphaned resources that are hard to reason about.
4. **Image pulling**: All images across all stages are pulled upfront before any stage deploys. This ensures stage N+1 deploys quickly after the health-gate ping.
