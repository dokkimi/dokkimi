# Feature: WORKER Item Type

## Problem

Many backend systems run background processes alongside their HTTP servers: queue consumers, event processors, cron-like daemons. These are long-running processes that don't serve HTTP — they poll a queue (Redis, Kafka, SQS) and process jobs.

Examples:

- **Appwrite** runs `php app/worker.php databases` to process async attribute creation jobs from Redis
- **Sidekiq** workers in Rails apps consume background jobs
- **Celery** workers in Django apps
- **BullMQ** consumers in Node apps

Dokkimi's SERVICE type requires `port` and `healthCheck`, both of which are meaningless for a worker. During Appwrite testing, we couldn't run the database worker, which meant attribute creation jobs sat in Redis forever. We had to bypass the entire async system with raw SQL queries to MariaDB — brittle and not representative of real behavior.

## Proposed API

New `WORKER` item type:

```yaml
type: WORKER
name: appwrite-worker-db
image: appwrite/appwrite:latest
command: ['php', 'app/worker.php', 'databases']
env:
  - name: _APP_REDIS_HOST
    value: appwrite-redis
```

Same fields as SERVICE, minus `port`, `healthCheck`, and `uiPath`.

| Field          | Type     | Default | Description                             |
| -------------- | -------- | ------- | --------------------------------------- |
| `image`        | string   | —       | Docker image URI                        |
| `command`      | string[] | —       | Override Docker CMD                     |
| `entrypoint`   | string[] | —       | Override Docker ENTRYPOINT              |
| `env`          | array    | —       | Environment variables                   |
| `mountFiles`   | array    | —       | Files to mount (read-only)              |
| `stage`        | integer  | 0       | Deployment stage                        |
| `minCpu`       | number   | —       | Minimum CPU cores                       |
| `minMemory`    | number   | —       | Minimum memory in MB                    |
| `maxCpu`       | number   | —       | Maximum CPU cores                       |
| `maxMemory`    | number   | —       | Maximum memory in MB                    |
| `localDevPath` | string   | —       | Host path for live-reload mounts        |
| `mountPath`    | string   | —       | Container mount target for localDevPath |

## Design Decisions

**Interceptor:** WORKER items get a per-service interceptor + dnsmasq, identical to SERVICE. Workers make outbound calls (to Redis, databases, other services) and that traffic should be captured. The interceptor just won't probe the worker for health since there's no port.

**Health:** "Container is running." Workers either start and run, or crash immediately on bad config. There's no meaningful health endpoint to probe. WORKER items are marked READY immediately on container creation (same pattern as MOCK items). If the container crashes, the crash monitor detects it and fails the run.

**Reuse `createServiceGroup`:** The existing method already handles `item.port` being null and `healthCheckEndpoint` being empty. No new deployment class needed. The only change: use `item.type.toLowerCase()` for the Docker label `role` instead of the hardcoded string `'service'`.

## Implementation

~150 lines across 9 files, following the existing SERVICE pattern:

1. **shared/definition-validator/constants.ts** — add `'WORKER'` to `VALID_ITEM_TYPES` and add `WORKER` key set to `VALID_ITEM_KEYS` (SERVICE fields minus port/healthCheck/uiPath)
2. **shared/definition-validator/validate-items.ts** — add `validateWorkerItem()` (SERVICE validation minus port/healthCheck) and `case 'WORKER'` in the `validateItem()` switch
3. **services/control-tower/src/namespace-lifecycle/deployment-context.types.ts** — add `'WORKER'` to the `DefinitionItem.type` union (currently `'SERVICE' | 'DATABASE' | 'BROKER' | 'MOCK'` — intentionally excludes test-only types like HTTP_REQUEST/DB_QUERY; WORKER is deployed infrastructure so it belongs here)
4. **services/control-tower/src/namespace-lifecycle/docker/docker-service-group.service.ts** — change Docker label `'io.dokkimi.role': 'service'` to `'io.dokkimi.role': item.type.toLowerCase()`. Safe: DATABASE items use `createDatabaseGroup`, not `createServiceGroup`, so only SERVICE and WORKER flow through here.
5. **services/control-tower/src/namespace-lifecycle/docker/docker-deployer.service.ts** — add WORKER deployment phase (reuses `createServiceGroup`), mark READY after creation, add `c.role === 'worker'` to crash monitor filter (line 402-403), add `'WORKER'` to `directDnsNames` filter (line 88-90)
6. **apps/vscode/src/schema/dokkimi.schema.json** — add `WorkerItem` definition and add to `AnyItem` oneOf
7. **apps/vscode/src/snippets/dokkimi.json** — add `dok-worker` snippet
8. **shared/docs/dokkimi-instructions.md** — document WORKER type in the items reference section
9. **apps/landing/src/pages/docs/** — add WORKER documentation page or section

No changes needed: configmap builder (WORKER skipped from urlMap by existing `type === 'SERVICE'` check, and workers aren't databases or brokers), definition resolver (type-agnostic), Prisma schema (InstanceItem has no type column).

## Verification

1. `yarn workspace @dokkimi/definition-validator test`
2. `yarn workspace control-tower test -- --testPathPattern=service-group` — existing + new tests
3. Validate a definition with a WORKER item via `dokkimi validate`
4. Run Appwrite smoke test with a WORKER item for the database worker — attribute should transition from "processing" to "available" without the dbQuery hack
