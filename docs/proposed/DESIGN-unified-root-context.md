# Design: Unified Root Context (`$`)

## Problem

The test-agent has three separate path systems for accessing test data:

| Context          | Current syntax                      | Document shape                                     |
| ---------------- | ----------------------------------- | -------------------------------------------------- |
| Extract (HTTP)   | `$.body.X`, `$.headers.X`           | `{ statusCode, headers, body }`                    |
| Extract (DB)     | `$.data[0].X`, `$.success`          | `{ success, data, rowsAffected, error, duration }` |
| Assertion (HTTP) | `response.body.X`, `request.body.X` | `{ request, response, responseTime }`              |
| Assertion (DB)   | `data[0].X`, `success`              | `{ success, data, rowsAffected, error, duration }` |
| Assertion (UI)   | `$.extracted.varName`               | `{ target, baseURL, extracted: {...} }`            |

Users must know which action type produced the result _and_ whether they're in extract or assertion context to write the correct path. The docs explicitly warn: "don't use `response.body` in extract paths or `$.body` in assertion paths."

This happened because the system grew feature by feature without a unifying model. Two assembly functions (`AssembleStepDocument` and `AssembleExtractDocument`) build different document shapes from the same underlying data. The `$` prefix is purely syntactic — the assertion engine strips it.

Meanwhile, the test-agent has access to far more data than either document exposes: intercepted traffic, console logs, database logs, and the full variable context. None of this is queryable through extract or assertion paths.

## Proposal

Replace the multiple document shapes with a single root context `$` that represents the full observable state at assertion/extract time. One document, one path system, used everywhere.

```
$ = {
    request:     { method, url, headers, body },
    response:    { status, headers, body },
    responseTime: 142,

    variables:   { ... },

    traffic:     [ { timestamp, from, to, request, response }, ... ],
    consoleLogs: [ { timestamp, service, level, message }, ... ],
    dbLogs:      [ { timestamp, database, query, duration, result }, ... ],
    timeline:    [ { type, timestamp, ... }, ... ]
}
```

### Scoping

- `request`, `response`, `responseTime` — **step-scoped**. They describe the current action's direct result.
- `variables` — **test-scoped**. Accumulated across all steps in the test, cleared at the test boundary.
- `traffic`, `consoleLogs`, `dbLogs`, `timeline` — **step-scoped**. The log buffer (`StepLogBuffer`) is flushed after each step's validation completes (`ValidateStepWithRetry` calls `Flush()`), and match blocks further filter by the step's execution time window. So these already contain only the current step's observable effects — this is existing behavior, not a new restriction. Steps are sequential, so cross-step ordering is implied by step ordering.

### Evaluation order

Within a step, extract rules are evaluated **before** assertions. `$.variables` in the assertion document reflects all extracts from the current step (and all prior steps in the test). This was always the implementation order, but with `$.variables` queryable in assertions it becomes a public contract:

```json
"extract": { "userId": "$.response.body.id" },
"assertions": [
    { "path": "$.variables.userId", "operator": "exists" }
]
```

This works because extract runs first, populates `$.variables.userId`, and then assertions evaluate against the root context (which includes the updated `$.variables`).

### What changes for the user

**Extract — one syntax for all action types:**

```json
// Before (HTTP)
"extract": { "userId": "$.body.user.id" }

// Before (DB)
"extract": { "userId": "$.data[0].id" }

// After (both — always through $.response)
"extract": { "userId": "$.response.body.user.id" }
"extract": { "userId": "$.response.data[0].id" }
```

Extract can now pull from anything in `$`:

```json
"extract": {
    "firstServiceCalled": "$.traffic[0].to",
    "authHeader": "$.request.headers.Authorization",
    "dbQueryCount": "$.dbLogs.length"
}
```

Note: `$.traffic` extraction is **positional only** (index-based). There is no JSONPath filter syntax (`$.traffic[?(@.to=='service-b')]`). For filtered access, match blocks are the declarative mechanism — and match blocks already support `extract` (documented, though unused in the internal test suite). To extract a value from a specific traffic entry (e.g., the response body of the call from service-a to service-b), use a match block with extract:

```json
{
  "match": { "from": "service-a", "to": "service-b" },
  "extract": { "serviceResponse": "$.response.body" }
}
```

`$.traffic` in extract/assertion paths provides raw positional access to the same data — useful for count (`$.traffic.length`), ordering (`$.traffic[0].to`), and first/last access, but not for content-based filtering.

**Assertions — one syntax for all action types:**

```json
// Before (HTTP)
{ "path": "response.body.user.name", "operator": "eq", "value": "Alice" }

// Before (DB)
{ "path": "data[0].name", "operator": "eq", "value": "Alice" }

// After (both — always $.response.*)
{ "path": "$.response.body.user.name", "operator": "eq", "value": "Alice" }
{ "path": "$.response.data[0].name", "operator": "eq", "value": "Alice" }
```

**New assertions that weren't possible before:**

```json
// Assert exactly 2 inter-service calls happened
{ "path": "$.traffic.length", "operator": "eq", "value": 2 }

// Assert no database writes occurred
{ "path": "$.dbLogs.length", "operator": "eq", "value": 0 }

// Assert a variable exists
{ "path": "$.variables.userId", "operator": "exists" }

// Assert ordering: DB query happened before the HTTP call
{ "path": "$.timeline[0].type", "operator": "eq", "value": "dbQuery" }
{ "path": "$.timeline[1].type", "operator": "eq", "value": "httpTraffic" }
```

**UI assertions — `$.extracted` becomes `$.variables`:**

```json
// Before
{ "path": "$.extracted.userName", "operator": "eq", "value": "Alice" }

// After
{ "path": "$.variables.userName", "operator": "eq", "value": "Alice" }
```

**Match blocks** — syntax stays the same. Match is a filter on `$.traffic`; the user's mental model just gets clearer:

```json
{
  "match": { "from": "service-a", "to": "service-b", "path": "/users" },
  "assertions": [
    { "path": "$.response.body.name", "operator": "eq", "value": "Alice" }
  ]
}
```

### DB response shape under `$`

Today, DB assertions use bare paths (`success`, `data[0].X`) because the DB document is flat. Under the unified `$`, DB results move under `$.response` to be consistent with HTTP:

```
// HTTP step
$.response = { status, headers, body }
$.responseTime = 142

// DB step
$.response = { success, data, rowsAffected, error }
$.responseTime = 8
```

Both are `$.response.*`. The shapes differ because the data genuinely differs, but the user always knows: "my action's result is at `$.response`." Query duration lives at `$.responseTime` for both — it's the same concept (how long the action took), just measured differently. For HTTP steps, it's the round-trip time (request sent to response received). For DB steps, it's the query execution time as reported by the db-proxy (includes proxy overhead but not test-agent-to-proxy round-trip).

### Timeline

`$.timeline` is a chronologically sorted merge of `$.traffic`, `$.consoleLogs`, and `$.dbLogs`. Each entry has a `type` field (`"httpTraffic"`, `"consoleLog"`, `"dbQuery"`) plus the fields from its source.

All sidecars use `time.Now().Format(time.RFC3339Nano)` for timestamps. Docker containers share the host kernel's clock, so timestamps are comparable across sidecars. Events separated by less than ~1ms may not have deterministic ordering (a sidecar may log an event slightly after it occurs), but for the typical use cases — an INSERT before a response, an error after a DB failure — the gap is milliseconds and the ordering is reliable.

The timeline enables cross-cutting assertions that are impossible today:

- "The INSERT happened before service-a responded" — check relative positions in `$.timeline`
- "The service logged an error _after_ the DB query failed" — temporal ordering across log types
- "Exactly 5 observable events happened during this step" — `$.timeline.length`

**Ordering caveat:** positional timeline assertions (`$.timeline[0].type == "dbQuery"`) are reliable when events are separated by more than ~1ms. For tightly-coupled events (e.g., an HTTP call that triggers a DB query within microseconds), the ordering may not be deterministic. Use `$.timeline` for count and type-presence assertions on tightly-coupled events; reserve positional ordering assertions for events with clear temporal separation (e.g., a DB write before a later HTTP response).

### Relationship to loops

The unified root context and loops are independent features that reinforce each other. Loops can ship before or after the root context migration — they need the variable context upgrade (Phase 3) but not the path unification (Phases 1-2). If loops ship first, their examples use old-style paths and get updated when the root context lands. If the root context ships first, loops use `$.*` paths from day one.

That said, the variable context upgrade (Phase 3) is shared infrastructure. Both features need `map[string]interface{}` and dotted path resolution. Implementing Phase 3 first unblocks both.

What loops specifically need:

- **Structured variables** — `map[string]interface{}` instead of `map[string]string`, so `forEach` can iterate arrays and `{{user.email}}` can resolve dotted paths.
- **Consistent paths** (nice to have) — loop iteration variables live in `$.variables` alongside extracted values. One path system means the user doesn't learn separate syntax for loop variables vs extracted variables vs assertion paths.

### Structured variables

Today, the variable context is `map[string]string`. Every extracted value is stringified via `valueToString()`: numbers become `"42"`, booleans become `"true"`, objects become JSON strings. This works by accident — JSON parsing on the receiving end turns `"42"` back into a number — but it blocks any feature that needs to treat variables as structured data (loops iterating arrays, dotted path access, type-correct assertions).

The variable context upgrades to `map[string]interface{}`.

#### What types are stored

Variables can hold any JSON-compatible type:

- **string** — `"Alice"`
- **number** — `42`, `3.14` (stored as `float64`, matching Go's JSON unmarshalling)
- **boolean** — `true`, `false`
- **null** — `nil`
- **array** — `[{"name": "Alice"}, {"name": "Bob"}]`
- **object** — `{"email": "alice@example.com", "role": "admin"}`

#### Extract stores typed values

Today, `ResolveExtractRule()` in `assertion_engine.go` stringifies the extracted value:

```go
// Current — always returns string
b, _ := json.Marshal(rawValue)
strValue = string(b)
```

After the upgrade, extract preserves the raw value:

```json
"extract": { "users": "$.response.body.users" }
```

If `$.response.body.users` is an array, `{{users}}` holds the actual array, not `"[{\"name\":\"Alice\"}]"`. This is what makes `forEach: "{{users}}"` work — the loop receives an iterable, not a string.

#### `{{}}` interpolation and type context

`{{var}}` appears in two contexts that need different behavior:

**String context** — URLs, headers, SQL queries, string values. The variable is stringified into the surrounding text:

```json
"url": "service-a/users/{{userId}}"
"query": "SELECT * FROM users WHERE id = {{userId}}"
```

- string → inserted as-is
- number → `"42"` (decimal representation)
- boolean → `"true"` / `"false"`
- null → `""` (empty string)
- object/array → JSON-encoded string

**JSON value context** — when `{{var}}` appears as an entire value in a JSON body (not embedded in a larger string), the typed value is preserved:

```json
"body": {
    "userId": "{{userId}}",
    "filters": "{{filterObj}}",
    "tags": "{{tagArray}}"
}
```

If `userId` is the number `42`, the body gets `"userId": 42` (not `"userId": "42"`). If `filterObj` is an object, it's embedded directly. If `tagArray` is an array, it's embedded as an array.

The rule: if the template string contains **exactly one `{{...}}` reference and nothing else**, emit the typed value. Otherwise, stringify all references and concatenate. Specifically:

- `"{{var}}"` — entire value, preserves type
- `"{{var}} "` — trailing space, stringifies (not entire value)
- `"{{a}}{{b}}"` — two references, stringifies both and concatenates
- `["{{var}}"]` — each array element is evaluated independently; `"{{var}}"` is the entire element value, so type is preserved
- `"{{users[0].name}}"` — entire value, preserves type (dotted path resolution happens inside the braces)

This matches user intuition — `"{{userId}}"` as a JSON value should preserve the number, but `"/users/{{userId}}"` in a URL should produce a string.

#### Dotted path resolution

The current regex `\{\{(\w+)\}\}` only matches single identifiers like `{{userId}}`. It cannot resolve `{{user.email}}` or `{{users[0].name}}`.

The regex upgrades to match dotted and bracketed paths:

```
\{\{([\w]+(?:\.[\w]+|\[\d+\])*)\}\}
```

This matches:

- `{{userId}}` — simple variable lookup
- `{{user.email}}` — object property access
- `{{users[0].name}}` — array index + property
- `{{user.address.city}}` — nested property chain

Unsupported (and not needed): negative array indices, quoted bracket notation (`["key"]`), wildcard or filter expressions.

Resolution walks the variable context:

1. Split the path on `.` and `[N]` segments
2. Look up the first segment in the variable map
3. Traverse remaining segments into the value (object property access, array indexing)
4. If any segment fails to resolve, error with "variable path not found"

This is the same traversal that `EvaluateDocPath` already does for `$` paths — share the implementation rather than duplicating it.

#### Memory

Variables reset at the test boundary (the `varCtx.Reset()` fix already applied). Within a test, variables accumulate across steps — an extracted array from step 1 persists into step 5. This is the same lifecycle as string variables today; the only difference is that objects/arrays are larger than strings.

In practice, the data comes from HTTP response bodies and DB query results that are already in memory (in the log buffer). Storing a reference to `$.response.body.users` in the variable context doesn't duplicate the data — it's the same slice. The variable context just holds a pointer.

If a test extracts very large payloads into variables, memory grows — but this is bounded by the test's own data. Tests that would extract a 100MB response body into a variable are pathological regardless of the variable type system.

### Relationship to `{{}}` interpolation

`$` paths and `{{}}` interpolation are two different access patterns:

- **`$` paths** — used in `extract` and `assertions` to query the root context document at assertion time. Read-only, supports the full document.
- **`{{var}}`** — resolves variable values from `$.variables`. Used in two contexts:
  - **Actions** (URLs, headers, bodies, queries) — interpolates values into outgoing requests at action execution time.
  - **Assertion/extract fields** (`path`, `value`, `items`) — resolves before evaluation. This is how loop variables reach assertion paths: `{ "path": "{{user.email}}", ... }` resolves the dotted path inside the variable context, producing the value directly. This already works today for simple variables (e.g., `"value": "{{expectedName}}"`); the dotted path upgrade extends it to structured data.

`$` and `{{}}` can appear in the same field. A `path` like `"$.response.body.users[{{index}}].name"` uses `{{}}` to resolve the index from a variable, then `$` path evaluation traverses the document. `{{}}` resolves first.

---

## Implementation

### What changes

#### Phase 1: Unified root context assembly

**Replace two assembly functions with one.**

File: `services/test-agent/document_assembler.go`

Today there are two functions that build different documents from the same data:

- `AssembleStepDocument()` → `{ request, response, responseTime }` (HTTP) or `{ success, data, ... }` (DB)
- `AssembleExtractDocument()` → `{ statusCode, headers, body }` (HTTP) or `{ success, data, ... }` (DB)

Replace both with:

```go
func AssembleRootContext(
    step TestStep,
    stepExec StepExecution,
    httpLogs []HttpLogMessage,
    dbLogs []DatabaseLogMessage,
    consoleLogs []ConsoleLogMessage,
    varCtx *VariableContext,
    stepResp map[string]interface{},  // non-nil for UI steps
) map[string]interface{}
```

This function builds:

```go
{
    "request":      <from the step's action or matched log>,
    "response":     <from the step's response log>,
    "responseTime": <computed from request/response timestamps>,
    "variables":    varCtx.Snapshot(),
    "traffic":      assembleTrafficList(httpLogs, stepExec),
    "consoleLogs":  assembleConsoleList(consoleLogs),
    "dbLogs":       assembleDbLogList(dbLogs),
    "timeline":     assembleTimeline(httpLogs, dbLogs, consoleLogs, stepExec),
}
```

For HTTP steps, `$.response` = `{ status, headers, body }`. Note: the underlying log stores `statusCode`; `AssembleRootContext` remaps it to `status` for consistency with the user-facing path `$.response.status`.
For DB steps, `$.response` = `{ success, data, rowsAffected, error }`. Query duration moves to `$.responseTime`.
For UI steps, extracted values go into `varCtx` (already happens), and `$.variables` surfaces them — no more `$.extracted`.
For `wait` steps, `$.response` = `{}`.

The traffic/consoleLogs/dbLogs lists are assembled from the log buffer snapshot, filtered to the step's time window (same logic that `ValidateHttpCallBlock` already uses). Each entry is a map with user-friendly field names.

**Internal data stays as-is.** The log buffers, variable context, and sidecar log ingestion don't change. `AssembleRootContext` is a _view_ — it builds one shallow map of references to data that already exists in memory.

#### Phase 2: Wire up the single document

**File: `services/test-agent/step_validator.go`**

`validateStep()` currently creates two separate documents:

```go
stepDoc = AssembleStepDocument(resolvedStep, httpLogs, dbLogs, stepExec)
extractDoc = AssembleExtractDocument(resolvedStep, httpLogs, dbLogs, stepExec)
```

Replace with one call:

```go
rootCtx = AssembleRootContext(resolvedStep, stepExec, httpLogs, dbLogs, consoleLogs, sv.varCtx, stepResp)
```

Then pass `rootCtx` to both extract resolution and assertion validation. Every path evaluates against the same document.

**File: `services/test-agent/block_validators.go`**

- `ValidateSelfBlock()` — receives `rootCtx` instead of `stepDoc`. No logic change; `ValidateAssertion` already calls `EvaluateDocPath` which handles `$.` prefix.
- `ValidateHttpCallBlock()` — for matched traffic, currently builds a per-log document via `AssembleHttpDocument()`. Under the unified model, each matched log gets its own mini root context with `$.request` and `$.response` from that log entry. The `match` filtering logic stays the same. **Important**: match block assertion paths change from `response.body.X` to `$.response.body.X` — this is a separate code path from self-block assertions, so both must accept `$.`-prefixed paths. The per-log mini document must be shaped with `request`/`response` at the top level so `$.response.body.X` resolves correctly. The `statusCode` → `status` remap must also apply here — the per-log document uses the same `$.response.status` field name as the step-level root context.
- `ValidateConsoleLogBlock()` — currently doesn't use document paths at all (only message filtering). No change needed initially, but the `$.consoleLogs` path in the root context subsumes this capability.

**File: `services/test-agent/assertion_engine.go`**

- `EvaluateDocPath()` — already strips the `$.` prefix. With the unified root, `$.response.body.X` resolves naturally: strip `$.`, split on `.`, traverse `response` → `body` → `X`. No logic change needed.
- `ResolveExtractRule()` — already calls `EvaluateDocPath`. When the document changes from `{ statusCode, headers, body }` to the full root context, extract paths like `$.response.body.X` just work.
- `ValidateAssertion()` — no change. It calls `EvaluateDocPath` and `CompareValues`, both of which are document-shape-agnostic.

**File: `services/test-agent/variable_context.go`**

- `Extract()` method — currently calls `EvaluateJsonPath()` on the extract document. This can switch to using `EvaluateDocPath()` on the root context instead. Or, since `step_validator.go` already handles extract via `ResolveExtractRule()`, the `VariableContext.Extract()` method may become unused and can be removed.
- `EvaluateJsonPath()` — still used by `Resolve()` for variable interpolation in action payloads. Stays as-is; it operates on a different phase (action execution, not assertion).
- `Snapshot()` — called by `AssembleRootContext` to populate `$.variables`. Returns `map[string]string` today; will return `map[string]interface{}` after the variable context upgrade (see Phase 3).

**File: `services/test-agent/ui_executor.go`**

- `Execute()` currently returns `{ target, baseURL, extracted: {...} }`. UI-extracted values are already written to `varCtx` during execution (the returned document is redundant). With the unified root, `Execute()` no longer needs to return the extracted map — `$.variables` in the root context already contains them.
- The special-case in `step_validator.go` that uses `stepResp` for UI steps can be simplified: UI steps assemble the same root context as everything else, with `$.variables` containing the UI-extracted values.

#### Phase 3: Variable context upgrade

Implements the structured variables design described above (see "Structured variables" section).

**File: `services/test-agent/variable_context.go`**

- `variables map[string]string` → `map[string]interface{}`
- `Set(name, value string)` → `Set(name string, value interface{})`
- `Resolve()` regex `\{\{(\w+)\}\}` → `\{\{([\w]+(?:\.[\w]+|\[\d+\])*)\}\}` for dotted/bracketed paths
- `resolveValue()` — add type-context-aware interpolation: entire-value `{{var}}` preserves type, embedded `{{var}}` stringifies
- `Snapshot()` returns `map[string]interface{}`

**File: `services/test-agent/assertion_engine.go`**

- `ResolveExtractRule()` — stop stringifying extracted values. Return `interface{}` instead of `string`. This is a signature change that propagates to `step_validator.go` where `varCtx.Set()` is called with the result.

**File: `services/test-agent/test_executor.go`**

- `TestConfig.Variables` and `TestDefinition.Variables` are currently `map[string]string`. These stay as `map[string]string` in the config (user-declared variables are always strings). `Set()` accepts `interface{}`, so string values pass through unchanged.

**Risk: type change breaking existing `eq` assertions.**

Today, extracting `$.response.body.count` where the JSON value is `42` stores the string `"42"`. After Phase 3, it stores `float64(42)`. `CompareValues` with `eq` uses `reflect.DeepEqual` — no type coercion. So:

- `{ "value": 42 }` (number literal in definition JSON) — **works after upgrade** (float64 == float64)
- `{ "value": "42" }` (string literal in definition JSON) — **breaks after upgrade** (string != float64, was string == string before)
- `{ "value": "{{count}}" }` in an assertion — was string `"42"`, now float64 `42` (if entire-value rule applies). Comparison depends on what the other side is.

Numeric operators (`gt`, `gte`, `lt`, `lte`) are unaffected — they use `toFloat` which coerces strings to numbers.

Mitigation: audit all assertions that use `eq` with a string-quoted number against an extracted variable. In practice, most definitions already use unquoted numeric literals (`"value": 42`, not `"value": "42"`) because the JSON is parsed by Go's unmarshaller. The risk is limited to assertions where `"value"` is a `{{var}}` reference that was previously a string and is now typed. Run the full definition suite after Phase 3 to catch any breakage.

#### Phase 4: Migrate definition files and docs

This is a breaking change for all definition files. Dokkimi has no external users yet — the CLI has not been distributed and the landing site is not public. All ~100 definition files are internal. No migration period or dual-path support is needed.

**Definition files (~100 files under `.dokkimi/`):**

Every extract path and assertion path changes. The migration is mechanical:

| Old pattern         | New pattern               | Context                                                                                    |
| ------------------- | ------------------------- | ------------------------------------------------------------------------------------------ |
| `$.body.X`          | `$.response.body.X`       | Extract (HTTP)                                                                             |
| `$.headers.X`       | `$.response.headers.X`    | Extract (HTTP)                                                                             |
| `$.statusCode`      | `$.response.status`       | Extract (HTTP) — field rename: `statusCode` → `status` (remapped in `AssembleRootContext`) |
| `$.data[0].X`       | `$.response.data[0].X`    | Extract (DB)                                                                               |
| `$.success`         | `$.response.success`      | Extract (DB)                                                                               |
| `response.body.X`   | `$.response.body.X`       | Self-block assertion (HTTP)                                                                |
| `response.status`   | `$.response.status`       | Self-block assertion (HTTP)                                                                |
| `response.header.X` | `$.response.headers.X`    | Self-block assertion (HTTP)                                                                |
| `request.body.X`    | `$.request.body.X`        | Self-block assertion (HTTP)                                                                |
| `request.method`    | `$.request.method`        | Self-block assertion (HTTP)                                                                |
| `responseTime`      | `$.responseTime`          | Self-block assertion (HTTP)                                                                |
| `response.body.X`   | `$.response.body.X`       | Match-block assertion (HTTP) — separate code path in `ValidateHttpCallBlock`               |
| `response.status`   | `$.response.status`       | Match-block assertion (HTTP)                                                               |
| `request.body.X`    | `$.request.body.X`        | Match-block assertion (HTTP)                                                               |
| `data[0].X`         | `$.response.data[0].X`    | Self-block assertion (DB)                                                                  |
| `success`           | `$.response.success`      | Self-block assertion (DB)                                                                  |
| `rowsAffected`      | `$.response.rowsAffected` | Self-block assertion (DB)                                                                  |
| `error`             | `$.response.error`        | Self-block assertion (DB)                                                                  |
| `duration`          | `$.responseTime`          | DB assertion — moves from response to top-level, paralleling HTTP                          |
| `$.extracted.X`     | `$.variables.X`           | UI assertion                                                                               |

A script or find-and-replace pass can handle most of this. Edge cases to check manually:

- Match-block assertions are a separate code path (`ValidateHttpCallBlock` in `block_validators.go`) — must verify the per-log mini document is shaped correctly for `$.`-prefixed paths
- Regex extract rules where the path is inside an object (`{ path: "$.body.X", pattern: "..." }`)
- UI assertion files that use `$.extracted.*`
- The `statusCode` → `status` rename requires a remap in `AssembleRootContext`, not just a path change in definitions

**Documentation — `shared/docs/dokkimi-instructions.md` (source of truth):**

Sections to rewrite:

- "Extract syntax" section — replace `$.body.X` examples with `$.response.body.X`, document new capabilities (`$.traffic`, `$.variables`, etc.)
- "Extract paths vs assertion paths" section — remove entirely. One path system.
- "Assertion path reference" table — update all paths to `$.` prefix, add new paths for traffic/logs/variables/timeline
- `$.extracted.varName` references — replace with `$.variables.varName`
- "Extract operates on the action's response only" — remove this restriction

**Landing site content:**

Blog posts (10 files with old path patterns):

- `02-getting-started-with-dokkimi.md`
- `05-testing-with-real-databases.md`
- `06-parallel-test-execution.md`
- `09-variables-and-extraction.md`
- `10-console-log-assertions.md`
- `11-dokkimi-vs-docker-compose-testing.md`

Tutorials (4 files):

- `01-mocking-oauth-flows.md`
- `02-testing-nextjs-apps.md`
- `03-testing-external-api-integrations.md`
- `04-testing-llm-integrations.md`

Docs pages (3 files):

- `pages/docs/variables.astro`
- `pages/docs/refs.astro`
- `pages/docs/assertions.astro`

**Definition validator — `shared/definition-validator/validate-assertions.ts`:**

The validator currently doesn't check path formats — it validates structure (is it a string? does the object have `path`/`pattern`/`group`?) but not content. Add path format validation as part of this phase:

- Error if an extract path doesn't start with `$.`
- Error if an assertion path doesn't start with `$.`
- Suggest corrections for common old-syntax patterns (`response.body.X` → `$.response.body.X`, `$.body.X` → `$.response.body.X`, `data[0].X` → `$.response.data[0].X`)

This catches stale definitions immediately at validation time rather than failing silently at runtime. The `dokkimi validate` command and VSCode extension both run the validator, so users get feedback before they even try to run.

**Go test files:**

- `services/test-agent/assertion_engine_test.go` — test cases use the old document shapes; update to use the unified root context shape
- `services/test-agent/document_assembler_test.go` — tests for the old assembly functions; replace with tests for `AssembleRootContext`
- `services/test-agent/step_validator_test.go` (if exists) — update document expectations

**TypeScript test files:**

- `shared/definition-validator/*.spec.ts` — update for the new path validation rules

### What doesn't change

- **Log buffer internals** (`step_log_buffer.go`) — the three typed slices stay. `AssembleRootContext` reads from them via `Snapshot()`.
- **Sidecar log ingestion** — interceptors, db-proxies, and console log capture send the same payloads to the same endpoints.
- **Control Tower log processing** — receives and stores logs the same way.
- **Variable interpolation in actions** — `{{var}}` in URLs, headers, bodies, queries works the same. `Resolve()` still does string replacement at action execution time.
- **Match block filtering** — match criteria (`from`, `method`, `url`) and time windowing stay. The match block is still a filter on traffic; it just operates on entries that are also visible as `$.traffic`.
- **CLI `dokkimi dump` output** — the dump command returns raw stored data from the control tower, not the test-agent's assertion documents. No change needed.

### Implementation order

1. **Phase 1** — `AssembleRootContext` function. Write it alongside the old assembly functions. Add tests.
2. **Phases 2 + 4 (atomic)** — Wire the new function into `step_validator.go` and `block_validators.go`, remove old assembly functions, and migrate all definition files and docs in the same change. These are tightly coupled: Phase 2 breaks every test path, Phase 4 fixes them. Shipping Phase 2 alone means a broken test suite with no way to run definitions. Treat them as one deliverable.
3. **Phase 3** — Variable context upgrade. Independent of the path migration — it can ship before or after. Required for loops.

The core logic change is Phases 1 + 2: ~4 Go files in test-agent. The definition migration (Phase 4) is mechanical find-and-replace. The variable upgrade (Phase 3) is the only part with design subtlety (type-context interpolation).

---

## Summary

| Dimension                   | Before                                                         | After                                                                                          |
| --------------------------- | -------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| Path contexts               | 5 (extract HTTP, extract DB, assertion HTTP, assertion DB, UI) | 1 (`$.*`)                                                                                      |
| Document assembly functions | 2 (`AssembleStepDocument`, `AssembleExtractDocument`)          | 1 (`AssembleRootContext`)                                                                      |
| Queryable data              | Response only (extract) / request+response (assertion)         | Full state: request, response, traffic, logs, variables, timeline                              |
| Traffic assertions          | Match-and-count only                                           | Match-and-count + ordering + total count + absence                                             |
| Cross-log assertions        | Not possible                                                   | Timeline ordering, count, absence                                                              |
| UI variable access          | `$.extracted.X` (special namespace)                            | `$.variables.X` (same as everything else)                                                      |
| Go files changed            | —                                                              | 4 (`document_assembler.go`, `step_validator.go`, `block_validators.go`, `variable_context.go`) |
| Definition files to migrate | —                                                              | ~100                                                                                           |
| Doc files to update         | —                                                              | ~17 (instructions, landing blog, tutorials, doc pages)                                         |
