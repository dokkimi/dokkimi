# Code Cleanup Candidates

Audit of files that are too large or too tangled, with specific extraction recommendations.

---

## Tier 1 — Split first

### `services/test-agent/database_query_executor.go` (1098 lines)

God object handling 4 database types with duplicated connect → execute → normalize → log flows.

**Extract into:**

| New file | Contents |
|----------|----------|
| `postgres_executor.go` | `PostgresPool`, `executePostgresQuery`, row scanning |
| `mysql_executor.go` | `MysqlPool`, `executeMysqlQuery`, row scanning |
| `redis_executor.go` | `executeRedisCommand`, `parseRedisCommand`, `normalizeRedisResult` |
| `mongo_executor.go` | `executeMongoCommand`, BSON parsing/encoding utilities |
| `database_query_executor.go` | Thin dispatcher: resolves DB type → delegates to the correct executor |

Each executor would implement a common interface:

```go
type DatabaseExecutor interface {
    Execute(ctx context.Context, query string, params []interface{}) (map[string]interface{}, error)
    Close() error
}
```

---

### `services/test-agent/assertion_engine.go` (743 lines)

Three distinct concerns in one file: path traversal, operator evaluation, and value transforms.

**Extract into:**

| New file | Contents |
|----------|----------|
| `doc_path.go` | `EvaluateDocPath`, array index resolution, case-insensitive key fallback |
| `assertion_operators.go` | `applyOperator` and all comparison implementations (eq, contains, matches, in, etc.) |
| `assertion_transforms.go` | `resolveSource`, `applyTransform` (length, type, keys, values, entries) |
| `assertion_engine.go` | `ValidateAssertion` pipeline: resolve source → apply transform → resolve value → apply operator |

---

### `shared/definition-resolver/resolve.ts` (755 lines)

Four separable phases executed in sequence.

**Extract into:**

| New file | Contents |
|----------|----------|
| `config-loader.ts` | `loadConfig`, `mergeConfigDefaults`, config file discovery |
| `glob-resolver.ts` | `resolveTargets`, glob/pattern matching, file enumeration |
| `env-substitution.ts` | `${{VAR}}` interpolation, env variable resolution |
| `resolve.ts` | Orchestrator: load config → resolve targets → substitute → return |

---

### `apps/cli/src/commands/run.ts` (749 lines)

CLI entry point that also handles orchestration, polling, and output formatting.

**Extract into:**

| New file | Contents |
|----------|----------|
| `run-poller.ts` | `pollUntilComplete`, status checking, timeout handling |
| `run-formatter.ts` | Console output formatting, progress display, summary tables |
| `run.ts` | CLI argument parsing, validation, and delegation to poller/formatter |

---

## Tier 2 — Cleaner with extraction

### `shared/definition-validator/validate-ui-action.ts` (669 lines)

Single file dispatching to 10+ UI sub-step type validators (visit, click, type, waitFor, extract, screenshot, scroll, select, hover, key, upload, drag, viewport).

**Extract into:**

| New file | Contents |
|----------|----------|
| `validate-ui-substeps.ts` | Per-substep validation functions (one per type) |
| `validate-ui-action.ts` | Top-level dispatch + shared helpers |

Alternatively, one file per sub-step group if the per-type validators grow further.

---

### `apps/cli/src/commands/baselines.ts` (606 lines)

Multiple operations (upload, diff, download, merge, approve) co-located but sharing no state.

**Extract into:**

| New file | Contents |
|----------|----------|
| `baselines/upload.ts` | Upload and artifact management |
| `baselines/diff.ts` | Visual diff comparison |
| `baselines/approve.ts` | Approval and merge logic |
| `baselines.ts` | CLI entry point delegating to sub-commands |

---

### `services/test-agent/document_assembler.go` (569 lines)

Assembles the unified root document from multiple data sources.

**Extract into:**

| New file | Contents |
|----------|----------|
| `document_assembler_traffic.go` | `assembleTrafficEntries`, timeline index calculation |
| `document_assembler_console.go` | `assembleConsoleLogs`, level detection |
| `document_assembler_db.go` | `assembleDatabaseLogs` |
| `document_assembler.go` | `AssembleDocument` orchestrator + response/variables sections |

---

### `services/control-tower/src/runs/runs.service.ts` (543 lines)

Run lifecycle management mixed with cleanup, deployment, and credential handling.

**Extract into:**

| New file | Contents |
|----------|----------|
| `run-cleanup.service.ts` | Cleanup orchestration, recovery, orphan detection |
| `run-deployment.service.ts` | Namespace creation, container deployment, image pulling |
| `runs.service.ts` | CRUD operations, status management, coordination |

---

### `shared/service-manager/index.ts` (517 lines)

Monolithic daemon manager intertwining state persistence, process lifecycle, and health checking.

**Extract into:**

| New file | Contents |
|----------|----------|
| `daemon-state.ts` | PID file read/write, file locking, state serialization |
| `process-lifecycle.ts` | Spawn, kill, waitForReady, signal handling |
| `health-checker.ts` | HTTP health polling, timeout logic, retry |
| `index.ts` | Public API composing the three modules |

---

## Tier 3 — Large but cohesive (monitor, don't split yet)

| File | Lines | Why it's OK for now |
|------|-------|---------------------|
| `services/db-proxy/mongo/protocol.go` | 954 | Specialized wire protocol decoder — inherently complex, rarely touched. Could extract BSON utilities if it grows further. |
| `services/test-agent/ui_executor.go` | 689 | Many sub-step types sharing context (browser session, varCtx). Splitting would add plumbing without reducing complexity. |
| `services/test-agent/ui_types.go` | 567 | Struct definitions — large surface area but low cognitive load. |
| `services/test-agent/ui_browser.go` | 537 | Chromedp wrapper — single responsibility, cohesive. |
| `services/test-agent/main.go` | 463 | Entry point + routing. Could extract an `Orchestrator` but not urgent. |
| `apps/cli/src/commands/clean.ts` | 442 | Multiple cleanup targets but all follow the same pattern. |
| `apps/cli/src/commands/doctor.ts` | 430 | Multiple diagnostic checks but simple linear flow. |
| `services/test-agent/step_validator.go` | 423 | Per-step-type dispatch — could split but each branch is small. |
| `shared/definition-validator/validate-assertions.ts` | 415 | Focused on assertion schema validation, recently refactored. |

---

## Recurring patterns to address

1. **Multi-type dispatch in one file** — `database_query_executor.go` and `validate-ui-action.ts` both handle N variants inline. Extract each variant behind a common interface/function signature.

2. **CLI commands doing formatting** — `run.ts`, `baselines.ts`, `doctor.ts` all mix business logic with console output. Extract formatters so the core logic is testable without TTY concerns.

3. **State + lifecycle + health in one module** — `service-manager/index.ts` and `runs.service.ts` both conflate "what is the current state" with "how do I change it" and "how do I verify it." Separate read-model from write-operations from health-probes.
