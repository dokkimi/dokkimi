# Design: Inline Assertion Validation in Test-Agent

## Problem

Today, assertion validation happens **after** all test steps have executed. The test-agent runs every action, posts a `/test-complete` notification to Control Tower (CT), and CT's Test Validation Service (TVS) retroactively evaluates assertions against accumulated traffic logs in the database.

This post-hoc model makes step-level flow control impossible. Features like `retryUntil` (repeat a step until an assertion passes) and loops require the test-agent to know assertion results _between_ steps — but right now it fires-and-forgets, and only CT has the verdict after the entire test finishes.

## Decision

Move assertion validation into the test-agent. The test-agent becomes both executor and validator: after each step's action completes, it receives traffic logs, evaluates that step's assertions inline, and only then proceeds to the next step.

CT continues to receive all raw logs (for dump/inspect/history) but no longer runs assertion validation.

## Architecture: Current vs. Proposed

### Current Flow

```
  test-agent                    interceptor/db-proxy              CT
  ──────────                    ────────────────────              ──
  execute step action ──────►   proxy request ──────────────────► POST /logs/http
                                                                  POST /logs/database
  ... (repeat all steps) ...

  POST /test-complete ──────────────────────────────────────────► TVS validates
                                                                  (query logs from DB)
                                                                  (evaluate all assertions)
                                                                  (store results)
```

### Proposed Flow

```
  test-agent                    interceptor/db-proxy              CT
  ──────────                    ────────────────────              ──
  execute step action ──────►   proxy request
                                  ├── POST /logs/http ──────────► store (unchanged)
                                  └── POST /logs/http ──────────► test-agent
  receive logs in memory
  wait for quiescence
  evaluate step assertions
  flush step data from memory
  report step result ───────────────────────────────────────────► store assertion result
  proceed to next step (or retry, loop, etc.)
```

## Design Details

### 1. Dual-Write: Interceptors and DB-Proxies

Interceptors and DB-proxies already POST logs to CT via `CONTROL_TOWER_URL`. They also already receive `TEST_AGENT_URL` as an env var (injected by `go-service-env.builder.ts` during container creation) — but the Go loggers don't use it yet.

**Change:** The Go loggers add a second POST to `TEST_AGENT_URL` alongside the existing CT POST. The two writes are independent and fire in separate goroutines — if the test-agent write fails, the CT write is unaffected. Only the test-agent write matters for validation timing; the CT write is fire-and-forget for storage.

**Affected files:**

- `services/interceptor/logger.go` — add second POST in `logRequest()` goroutine
- `services/db-proxy/shared/logger.go` — add second POST in `logQuery()` goroutine

**Payload format:** Identical to what CT receives today. No schema changes.

### 2. Console Log Collection via GELF

CT currently streams console logs from containers using Docker's native log API (`container.logs({ follow: true })` via dockerode, called from the namespace lifecycle module). These logs go into the database for the console-log block validator.

**Change:** Service containers are created with Docker's GELF log driver, configured to forward stdout/stderr to the test-agent over UDP. No Docker socket mount, no privilege escalation — the log driver is set at container creation time by CT's namespace-lifecycle module, and logs flow directly from the container runtime to the test-agent within the Docker network.

**Docker LogConfig (set at container creation):**

```json
{
  "Type": "gelf",
  "Config": {
    "gelf-address": "udp://test-agent:12201",
    "gelf-compression-type": "none"
  }
}
```

**What GELF provides automatically per log line:**

- `short_message` — the log line
- `_container_name` — which service produced it
- `_source` — `"stdout"` or `"stderr"`
- `timestamp` — Unix timestamp with millisecond precision

**Test-agent receiver:** Listens on UDP port 12201 using `github.com/Graylog2/go-gelf/v2/gelf`. The library handles chunking, decompression, and reassembly internally.

```go
reader, _ := gelf.NewReader("0.0.0.0:12201")
for {
    msg, _ := reader.ReadMessage()
    containerName := msg.Extra["_container_name"]
    source := msg.Extra["_source"]  // "stdout" or "stderr"
    logLine := msg.Short
}
```

**Why GELF over Docker socket:** Docker socket access is root-equivalent on the host — an unnecessary privilege escalation. GELF keeps everything within the namespace network with no elevated permissions. The container runtime handles forwarding; the test-agent is just a UDP listener.

**Why GELF over other log drivers:**

- **syslog** — can't distinguish stdout from stderr (dealbreaker for console log assertions)
- **fluentd** — no good Go receiver library; binary msgpack protocol; blocks container on startup without `fluentd-async=true`
- **splunk** — requires faking a Splunk HEC endpoint with auth tokens and health check

**Why UDP:** No startup ordering issues — if the test-agent isn't listening yet, packets are silently dropped (the service container never blocks). The tradeoff is UDP can drop packets under load, but console log assertions check for the presence of specific log patterns, not byte-level completeness.

**Impact on `docker logs` and CT:** Switching the log driver from the default `json-file` to GELF means `docker logs <container>` and CT's dockerode `container.logs()` streaming no longer work for these containers — there's no local log file to read. This is a conscious tradeoff: `dokkimi dump` and `dokkimi inspect` are the supported debugging paths for console log output, and both continue to work since test-agent forwards logs to CT. Running `docker logs` directly was never a documented workflow.

To preserve console logs in CT for dump/inspect, the test-agent forwards received console logs to CT via `POST /logs/console` (fire-and-forget, same pattern as interceptors posting HTTP logs). The forwarded payload matches CT's existing `RawConsoleLogDto` schema — test-agent re-formats the GELF message fields (`_container_name`, `_source`, `short_message`, `timestamp`) into the DTO that CT's console log processor already expects. CT's dockerode console log streaming is removed and replaced by this forwarding path.

### 3. Test-Agent Log Ingestion Endpoints

New HTTP endpoints on the test-agent (port 8080, alongside existing `/execute` and `/health`):

| Endpoint              | Source       | Purpose                     |
| --------------------- | ------------ | --------------------------- |
| `POST /logs/http`     | Interceptors | Receive HTTP traffic logs   |
| `POST /logs/database` | DB-proxies   | Receive database query logs |

Console logs are received via GELF (see section 2), not via HTTP POST.

### 4. In-Memory Log Storage

Test-agent holds logs in memory, scoped to the current step:

```go
type StepLogBuffer struct {
    httpLogs     []HttpLogMessage
    dbLogs       []DatabaseLogMessage
    consoleLogs  []ConsoleLogMessage
    mu           sync.Mutex
}
```

When a step completes validation, the buffer is flushed. Memory usage is bounded to one step's worth of data at any time.

### 5. ConfigMap Changes

The test-agent receives its configuration via a ConfigMap file (read at startup by `FileConfigReader`). Today the ConfigMap includes step actions but strips assertion blocks — they're removed during ConfigMap generation because only CT's TVS needed them.

**Change:** Stop stripping assertion blocks from the test-agent's ConfigMap. The resolved definition already contains the full step definitions (actions + assertions + extracts); the ConfigMap generation just needs to stop filtering them out.

### 6. Per-Step Validation Flow

After executing a step's action:

1. **Quiescence detection** — Poll the in-memory log buffer. Consider settled when no new logs arrive for the quiescence period. These parameters should be configurable constants (not hardcoded):
   - Poll interval: 100ms (default)
   - Quiescence period: 500ms (default)
   - Max wait: 10s (default)

   These match CT's current `QuiescenceDetectionService` values but can be tuned independently.

2. **Document assembly** — Build the assertion document from buffered logs. This is a non-trivial port of CT's `DocumentAssemblerService` (~200 lines):
   - HTTP: `{ request: { method, url, header, body }, response: { status, header, body }, responseTime }`
   - DB: `{ success, data[], rowsAffected, error, duration }`
   - Console: filter by service name, level, message

3. **Variable extraction** — Evaluate `extract` rules against the assembled document, including both step-level and block-level extract rules. Test-agent already has a `VariableContext` with JSONPath + regex support — this is the same mechanism, now also fed by assertion block extracts. Porting `resolveExtractRule()` (regex capture group support) is included here.

4. **Assertion evaluation** — Port the assertion engine from TypeScript to Go:
   - `compareValues()` — all operators: `eq`, `ne`, `gt`, `gte`, `lt`, `lte`, `contains`, `notContains`, `matches`, `exists`, `notExists`, `in`, `notIn`, `type`, `length`, `isEmpty`, `notEmpty`, `arrayContains`, `arrayNotContains`, `eqIgnoreCase`
   - `evaluateDocPath()` — dotted path resolution with array index support and case-insensitive header fallback
   - `validateCount()` — count assertions on matched log sets

5. **Block validation** — Port of CT's `AssertionValidatorService` (~250 lines) orchestrating three block types with the same semantics:
   - **Self block** (no `match`, no `service`) — validate against the step's own request/response
   - **HTTP call block** (has `match`) — filter buffered HTTP logs by origin/method/url, apply `assertionScope` (all/first/last/any)
   - **Console log block** (has `service`) — filter buffered console logs by service + level + message pattern, validate count

6. **Report result** — POST step assertion results to CT for storage (dump/inspect).

7. **Flush** — Clear the step log buffer.

### 7. Reporting Results to CT

After each step's validation, test-agent POSTs results to CT via the existing log-processing module (with `@SkipThrottle()`, same as other sidecar ingestion endpoints):

```
POST /logs/test-validation
{
    instanceId: string
    stepIndex: number
    passed: boolean
    assertions: [{
        path: string
        operator: string
        passed: boolean
        expected: any
        actual: any
        error?: string
        blockIndex: number
        resultKind: "field" | "count" | "extract"
    }]
}
```

CT stores these in the existing `assertionResult` table — same schema, different writer. The dump file and inspect commands work unchanged.

### 8. Test Completion

The `/test-complete` notification still happens, but it now includes per-step pass/fail status (already computed inline). CT no longer needs to run TVS — it just records the final status.

**Migration path:** During implementation, CT can keep TVS as a no-op fallback (skip validation if results already exist for all steps). Once inline validation is stable, TVS is removed entirely.

### 9. GELF Receiver in Test-Agent

Test-agent starts a GELF UDP listener on port 12201 at startup. Incoming messages are parsed into `ConsoleLogMessage` structs and appended to the current step's log buffer.

```go
reader, _ := gelf.NewReader("0.0.0.0:12201")
for {
    msg, _ := reader.ReadMessage()
    buf.mu.Lock()
    buf.consoleLogs = append(buf.consoleLogs, ConsoleLogMessage{
        Service:   msg.Extra["_container_name"].(string),
        Source:    msg.Extra["_source"].(string),  // "stdout" or "stderr"
        Message:   msg.Short,
        Timestamp: msg.TimeUnix,
    })
    buf.mu.Unlock()
}
```

Log level (INFO/WARN/ERROR/DEBUG) is parsed from the log line prefix, same as CT's console log processor does today. The GELF `level` field (syslog severity) only distinguishes stdout (6) from stderr (3) — application-level log levels come from the message content.

## Error Handling

**Test-agent crashes mid-validation:** The run is marked FAILED. CT does not fall back to TVS — a crash is an infrastructure failure, not a test result. The `/test-complete` notification never arrives, so CT's existing timeout mechanism (namespace health monitoring) detects the failure and cleans up.

**Sidecar fails to POST to test-agent:** The test-agent's quiescence detection will still settle (it doesn't know about missing logs). This is the same failure mode as today — if an interceptor fails to POST to CT, TVS validates against incomplete data. The CT copy of logs provides a debugging fallback via `dokkimi dump`.

**Assertion engine bug (Go vs. TS divergence):** Mitigated by testing strategy (see below) and shadow mode during migration. In shadow mode, CT's TVS still runs on `/test-complete` as it does today — it validates assertions against its own DB logs and compares results against the inline results already stored by the test-agent. If any step's pass/fail verdict diverges between the two engines, the divergence is logged to CT's console with the step index, operator, and both results. The inline result is authoritative (it's what the test-agent acted on); shadow mode is purely diagnostic. Shadow mode is disabled once the shared test corpus and integration runs show no divergence.

## Testing Strategy

The Go assertion engine must produce identical results to the TypeScript one. Strategy:

1. **Shared test corpus** — Extract all test cases from `assertion-engine.spec.ts` (currently 96 tests) into a JSON fixture file. Both the TS tests and Go tests read from the same fixture. Any new test case is added once and verified in both languages.

2. **Operator-level Go tests** — Each operator gets dedicated Go test coverage, including edge cases: nil/undefined values, type coercion boundaries, empty arrays/objects, regex edge cases.

3. **Integration test** — Run a Dokkimi test suite with TVS in shadow mode. Compare inline results from test-agent against TVS results from CT. Flag any divergence.

## What Changes Where

| Component                    | Change                                                                                                                                                                                                                                                                                                                                                                                                                      |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **test-agent** (Go)          | Add `/logs/http`, `/logs/database` endpoints. Add GELF UDP listener (port 12201, exposed in container config) for console logs. Forward console logs to CT via `POST /logs/console`. Add in-memory log buffer. Port assertion engine, document assembler, block validators, and extract resolver from TS. Add quiescence detection. Add step result reporting to CT. New dependency: `github.com/Graylog2/go-gelf/v2/gelf`. |
| **interceptor** (Go)         | Add second POST to `TEST_AGENT_URL` in logger goroutine (env var already injected).                                                                                                                                                                                                                                                                                                                                         |
| **db-proxy** (Go)            | Add second POST to `TEST_AGENT_URL` in logger goroutine (env var already injected).                                                                                                                                                                                                                                                                                                                                         |
| **CT namespace-lifecycle**   | Set GELF log driver on service containers (pointing at test-agent:12201). Expose UDP port 12201 on test-agent container. Remove dockerode console log streaming (replaced by test-agent forwarding). Stop stripping assertion blocks from test-agent ConfigMap.                                                                                                                                                             |
| **CT log-processing**        | Add `POST /logs/test-validation` endpoint (with `@SkipThrottle()`) to receive step results from test-agent.                                                                                                                                                                                                                                                                                                                 |
| **CT test-validation (TVS)** | Eventually removed. Intermediate state: skip validation when inline results exist. Shadow mode for divergence detection during migration.                                                                                                                                                                                                                                                                                   |
| **definition-resolver**      | No change — already outputs full step definitions.                                                                                                                                                                                                                                                                                                                                                                          |

## What Doesn't Change

- **CT log ingestion** — interceptors/db-proxies still POST HTTP/DB logs to CT. Console logs now come from test-agent instead of dockerode, but arrive at the same `POST /logs/console` endpoint. Dump/inspect/history work unchanged.
- **Definition format** — no YAML/JSON schema changes for existing features.
- **CLI** — no changes to run/dump/inspect commands.
- **Assertion operators and semantics** — identical behavior, just evaluated in Go instead of TypeScript.

## Unlocked Features

With inline validation, the test-agent knows assertion results before moving to the next step. This enables:

- **`retryUntil`** — repeat a step until assertions pass (with timeout/max retries)
- **Loops** — repeat a block of steps N times or until a condition
- **Conditional steps** — skip/run steps based on prior assertion results
- **Early termination** — fail fast on critical assertion failures without running remaining steps (today `stopOnFailure` only works post-hoc)

## Implementation Order

1. **Assertion engine in Go** — port `compareValues()`, `evaluateDocPath()`, `validateCount()`, `resolveExtractRule()` with full test coverage using shared test corpus from TS
2. **Document assembler in Go** — port `DocumentAssemblerService`: build assertion documents from raw log structs
3. **Block validators in Go** — port `AssertionValidatorService` + self/httpCall/consoleLog block validators with `assertionScope` filtering
4. **Log ingestion endpoints** — add `/logs/http` and `/logs/database` to test-agent with in-memory step buffer
5. **Dual-write in sidecars** — interceptor and db-proxy add second POST to `TEST_AGENT_URL`
6. **ConfigMap changes** — stop stripping assertion blocks from test-agent config
7. **Per-step validation loop** — integrate into `executeStepAt()`: action → quiescence → validate → report → flush
8. **Console log collection** — GELF UDP listener in test-agent + GELF log driver config in namespace-lifecycle
9. **Result reporting** — POST step results to CT via `/logs/test-validation`, CT stores them
10. **Shadow mode** — TVS validates in parallel, compare results, flag divergence
11. **TVS removal** — remove CT-side validation once inline is stable and shadow mode shows no divergence
12. **`retryUntil`** — first flow-control feature using inline results
