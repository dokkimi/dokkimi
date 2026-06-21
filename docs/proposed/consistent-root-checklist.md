# Consistent Root Document — Implementation Checklist

Companion to `consistent-root-document.md` (design) and `consistent-root-implementation.md` (code specs). Each task is a self-contained unit of work. Tasks within a phase can be done in any order unless noted.

---

## Phase 1: Go Types (`services/test-agent/types.go`)

- [ ] Rewrite `MatchCriteria` struct → `Path`, `Where []WhereEntry`, `Count interface{}`, `As`
- [ ] Add `WhereEntry` struct — `Path`, `Operator`, `Value`, `Or`, `And`, `Not`
- [ ] Update `Assertion` struct — `Path` → `interface{}`; add `Count`, `Type`, `Keys`, `Values`, `Entries` source fields
- [ ] Add `PathWithTransform` struct (`From`, `Transform`)
- [ ] Add `ValueRef` struct (`From`, `Transform`)
- [ ] Remove `AssertionBlock` fields: `Count`, `AssertionScope`, `Service`, `ConsoleAssertions`
- [ ] Add `AssertionBlock` fields: `For`, `Repeat` (loops at block level)
- [ ] Make `AssertionBlock.Assertions` optional (pointer or empty-ok)
- [ ] Add nested body fields to `ForEachLoop`: `Match`, `Assertions`, `Extract`, `ForEach`, `For`, `Repeat`, `Action`, `Steps`
- [ ] Add same nested body fields to `ForLoop` and `RepeatLoop`
- [ ] Remove `ConsoleLogAssertion` struct

## Phase 2: Path Resolution (`services/test-agent/assertion_engine.go`)

- [ ] `EvaluateDocPath`: delete `.length` special case (lines 62–70)
- [ ] `EvaluateDocPath`: update array index regex to accept negative indices (`-?\d+`)
- [ ] `EvaluateDocPath`: add negative index resolution (`idx = len(arr) + idx` when `idx < 0`)
- [ ] `EvaluateDocPath`: add `scopedCtx ...interface{}` variadic parameter
- [ ] `EvaluateDocPath`: reject bare `$$` (without trailing `.field`) — return `(nil, false)`
- [ ] `EvaluateDocPath`: add `$$.` prefix handling — resolve against `scopedCtx[0]`
- [ ] Verify all existing callers of `EvaluateDocPath` still compile (no `scopedCtx` passed)

## Phase 3: Operator Changes (`services/test-agent/assertion_engine.go`)

- [ ] `CompareValues`: delete `"type"` operator case
- [ ] `CompareValues`: delete `"length"` operator case
- [ ] `CompareValues`: delete `"arrayContains"` operator case
- [ ] `CompareValues`: delete `"arrayNotContains"` operator case
- [ ] Add `containsDispatch` function — dispatch on actual type (string→substring, array→element, object→key)
- [ ] Handle `nil` actual in `containsDispatch` — type error, not silent false
- [ ] `CompareValues`: update `"contains"` and `"notContains"` cases to call `containsDispatch`
- [ ] Add `goTypeLabel` helper — returns `"string"`, `"number"`, `"boolean"`, `"array"`, `"object"`, `"null"`
- [ ] Add `sortedMapKeys` helper for `map[string]interface{}`
- [ ] Add `sortedExtractKeys` helper for `map[string]ExtractRule`

## Phase 4: Assertion Resolution Pipeline (`services/test-agent/assertion_engine.go`)

- [ ] Add `resolveSource` function — type-switch on `Path` (string vs object), check shorthands
- [ ] `resolveSource`: require `$.` prefix (not just `$`) on `path.from`
- [ ] Add `applyAssertionTransform` function — handle `length`, `type`, `keys`, `values`, `entries`
- [ ] Transform error handling: type mismatch → clear error, not silent nil
- [ ] Add `resolveValue` function — detect ValueRef via `$.` prefix on `from` key (not just `$`)
- [ ] `resolveValue`: support optional `transform` on ValueRef
- [ ] Rewrite `ValidateAssertion` — full pipeline: resolveSource → EvaluateDocPath → transform → resolveValue → CompareValues
- [ ] `ValidateAssertion`: add `scopedCtx ...interface{}` parameter, pass through to `EvaluateDocPath`

## Phase 5: Match Engine (`services/test-agent/block_validators.go`)

- [ ] Delete `ValidateSelfBlock` function
- [ ] Delete `ValidateConsoleLogBlock` function
- [ ] Add `MatchResult` struct (`Matches`, `Match`, `LastMatch`)
- [ ] Add `ExecuteMatch` function — resolve source array, filter by `where`, build result
- [ ] Add `evaluateWhereEntry` function — AND-list evaluation over `[]WhereEntry`
- [ ] Add `evaluateSingleWhereEntry` function — handle `not`, `or`, `and`, simple assertion
- [ ] `evaluateSingleWhereEntry`: construct `Assertion` from `WhereEntry`, call `ValidateAssertion` with scoped element
- [ ] Add `savedMatchEntry` struct (`value`, `present` bool)
- [ ] Add `MatchStack` struct with `Push`/`Pop` — track key presence separately from nil values
- [ ] `MatchStack.Pop`: restore nil correctly (don't delete key when outer match had 0 results)
- [ ] Add `desugarMatchCount` function — bare int → `CountAssertion{eq, n}`; object form → `CountAssertion`
- [ ] Add `formatWhereDescription` function — serialize where criteria for error messages (recursive for `or`/`and`/`not`)

## Phase 6: Step Validation (`services/test-agent/step_validator.go`)

- [ ] Remove three-way dispatch (console-log / match / self-block) — replace with single `validateBlock`
- [ ] `validateBlock`: match → push stack → as → desugar count → loop → assertions → extract
- [ ] Empty-matches handling: targeted errors for `$.match`/`$.lastMatch` assertions, but don't skip other assertions
- [ ] Track `emptyMatchHandled` set to avoid double-evaluating assertions that got targeted errors
- [ ] `as` handling: save `matchResult.Matches` to `varCtx`, update `rootCtx["variables"]`
- [ ] Extract in match blocks: paths resolve against root context (e.g., `$.match.response.*`)
- [ ] Add `executeExtract` helper — resolve dynamic key names via `varCtx.Resolve`, use `sortedExtractKeys`

## Phase 7: Loop Execution (`services/test-agent/loop_executor.go`, `step_runner.go`)

- [ ] Delete `getStepLoop` function
- [ ] Delete `getActionLoop` function
- [ ] Add `getBlockLoop` helper — returns first non-nil from `ForEach`/`For`/`Repeat`
- [ ] Add `executeBlockLoop` method on `StepValidator` — build iteration plan, run loop body per iteration
- [ ] Add `extractLoopBody` function — convert nested loop fields into an `AssertionBlock`
- [ ] `executeBlockLoop`: recursion via `validateBlock` on extracted body (supports nested loops)
- [ ] `step_runner.go`: update `executeStepAt` — loop body is nested inside the loop struct, not sibling keys
- [ ] Step-level loop body: extract action from loop struct, execute action per iteration
- [ ] Step-level loop body: validate assertions/extract from loop body, not step siblings
- [ ] Verify loop executor injects `index` property (zero-based iteration index) on the `as` variable per iteration

## Phase 8: Document Assembly (`services/test-agent/document_assembler.go`)

- [ ] Tag timeline entries with `trafficIndex` (float64) and `direction` (`"request"` / `"response"`)
- [ ] Add `annotateTimelineIndices` function — set `requestTimelineIndex` on each traffic entry
- [ ] Set `responseTimelineIndex` on each traffic entry (nil when no response received)
- [ ] Add `findTimelineIndex` helper
- [ ] Call `annotateTimelineIndices` in `AssembleRootContext` after `mergeTimeline`

## Phase 9: Variable Resolution (`services/test-agent/variable_context.go`)

- [ ] `ResolveAssertionBlocks`: remove match URL/origin resolution (fields no longer exist)
- [ ] `ResolveAssertionBlocks`: remove console assertion resolution (struct removed)
- [ ] Add `resolveAssertion` method — resolve source path (string form), shorthand paths, value
- [ ] Add `resolveMatchCriteria` method — resolve `where` entry values
- [ ] Add `resolveWhereEntry` method — resolve value in assertions, recurse into `or`/`and`/`not`
- [ ] `resolveWhereEntry`: do NOT resolve `$$`-prefixed paths (resolved at match time, not variable time)
- [ ] `ResolveAssertionBlocks`: resolve nested loop bodies recursively
- [ ] `Extract`: add key interpolation via `vc.Resolve(variable)` for dynamic extract keys

---

## Phase 10: TypeScript Types (`shared/config/assertions.ts`)

- [ ] Rewrite `AssertionBlock` — remove `count`, `assertionScope`, `service`, `consoleAssertions`; add `for`, `repeat`; make `assertions` optional
- [ ] Add `MatchCriteria` interface — `path`, `where?`, `count?`, `as?`
- [ ] Add `WhereEntry` union type — `WhereAssertion | WhereOr | WhereAnd | WhereNot`
- [ ] Add `WhereAssertion`, `WhereOr`, `WhereAnd`, `WhereNot` interfaces
- [ ] Update `Assertion` — `path` → `string | PathWithTransform`; add `count`, `type`, `keys`, `values`, `entries` source fields
- [ ] Add `PathWithTransform` interface (`from`, `transform`)
- [ ] Add `ValueRef` interface (`from`, `transform?`)
- [ ] Update `AssertionOperator` — remove `'type'`, `'length'`, `'arrayContains'`, `'arrayNotContains'`
- [ ] Add nested body fields to `ForEachLoop`, `ForLoop`, `RepeatLoop`
- [ ] Delete `ConsoleLogAssertion` interface

## Phase 11: TypeScript Validator — Constants (`shared/definition-validator/constants.ts`)

- [ ] Remove from `VALID_ASSERTION_OPERATORS`: `'type'`, `'length'`, `'arrayContains'`, `'arrayNotContains'`
- [ ] Delete: `VALID_ASSERTION_SCOPES`, `VALID_CONSOLE_LOG_LEVELS`, `VALID_MESSAGE_OPERATORS`, `VALID_MESSAGE_FILTER_KEYS`, `VALID_CONSOLE_LOG_ASSERTION_KEYS`
- [ ] Replace `VALID_MATCH_CRITERIA_KEYS` → `['path', 'where', 'count', 'as']`
- [ ] Replace `VALID_ASSERTION_KEYS` → `['path', 'count', 'type', 'keys', 'values', 'entries', 'operator', 'value', 'disabled']`
- [ ] Replace `VALID_ASSERTION_BLOCK_KEYS` → `['assertions', 'match', 'extract', 'forEach', 'for', 'repeat']`
- [ ] Add `VALID_WHERE_ENTRY_KEYS` → `['path', 'operator', 'value', 'or', 'and', 'not']`
- [ ] Add `VALID_TRANSFORMS` → `['length', 'type', 'keys', 'values', 'entries']`
- [ ] Add `VALID_SOURCE_FIELDS` → `['path', 'count', 'type', 'keys', 'values', 'entries']`
- [ ] Update `VALID_FOR_EACH_KEYS` to include body fields: `match`, `assertions`, `extract`, `forEach`, `for`, `repeat`, `action`, `steps`
- [ ] Same for `VALID_FOR_KEYS` and `VALID_REPEAT_KEYS`

## Phase 12: TypeScript Validator — Assertions (`shared/definition-validator/validate-assertions.ts`)

- [ ] Rewrite `validateAssertionBlock` — remove `count`/`assertionScope`/`service`/`consoleAssertions` validation
- [ ] Add `validateMatchCriteria` — require `path` (string, `$.` prefix), validate optional `where`/`count`/`as`
- [ ] `validateMatchCriteria`: `where` present → must be non-empty array; `where` omitted → match all
- [ ] `validateMatchCriteria`: `count` → accept number (non-negative int) or `{operator, value}` object
- [ ] `validateMatchCriteria`: `as` → non-empty alphanumeric string
- [ ] Add `validateWhereEntry` (recursive) — exactly one of: assertion (`path`), `or`, `and`, `not`
- [ ] `validateWhereEntry`: assertion paths must start with `$$.`
- [ ] `validateWhereEntry`: `or`/`and` → non-empty array, recurse
- [ ] `validateWhereEntry`: `not` → plain object, recurse
- [ ] Rewrite `validateAssertion` — exactly one source field; validate string vs `PathWithTransform` for `path`
- [ ] `validateAssertion`: add `validatePathWithTransform` — require `from` (`$.` prefix), require valid `transform`
- [ ] `validateAssertion`: value — detect ValueRef via `$.` prefix on `from` key; validate `transform` if present
- [ ] `validatePathFormat`: reject `$$` prefix outside `where` context
- [ ] Delete `validateConsoleLogAssertion` function
- [ ] Remove forEach+match mutual exclusion check (lines 331–339)

## Phase 13: TypeScript Validator — Loops (`shared/definition-validator/validate-loops.ts`)

- [ ] Update `validateLoopModifiers` — accept `level` option (`'test'` | `'step'` | `'assertion-block'`)
- [ ] Add `validateLoopBody` function (recursive) — validate body fields based on level
- [ ] Test level: require `steps`, reject `action`/`match`/`assertions`/`extract`
- [ ] Step level: allow `action`; allow `match`/`assertions`/`extract`; reject `steps`
- [ ] Assertion-block level: allow `match`/`assertions`/`extract`; reject `action`/`steps`
- [ ] Nested loops: recurse with level tier drop (test→step→assertion-block)
- [ ] Validate `repeat.until` entries as standard assertions (supports transform shorthands, ValueRef)
- [ ] Reject step-level sibling `assertions`/`extract` when a loop is present (body owns them)
- [ ] Remove inline loop modifier validation from step/action/assertion-block levels

---

## Phase 14: Definition File Migration (33 files)

### traffic-tester definitions (16 files)

- [ ] `assertion-scopes-and-counts.json` — match blocks, `assertionScope`, `count`
- [ ] `advanced-assertions.json` — match blocks, assertion paths
- [ ] `console-log-assertions.json` — `consoleAssertions`, `service`
- [ ] `inter-service-traffic.json` — match blocks
- [ ] `traffic-hopping.json` — match blocks
- [ ] `variable-chaining.json` — match blocks, extract paths
- [ ] `variable-ref.json` — match blocks
- [ ] `http-methods-and-errors.json` — match blocks
- [ ] `custom-responses-and-logging.json` — match blocks
- [ ] `mock-body-matching.json` — match blocks
- [ ] `mock-external-apis.json` — match blocks
- [ ] `multi-ref-items.json` — match blocks
- [ ] `parallel-steps-and-variables.json` — match blocks
- [ ] `global-variables.json` — match blocks
- [ ] `regex-extract.json` — match blocks, extract paths
- [ ] `database/*.json` (4 files) — match blocks if present

### loop-tests definitions (6 files)

- [ ] `step-level-loops.json` — inline loop → nested body
- [ ] `action-level-loops.json` — inline loop → nested body
- [ ] `assertion-and-transform.json` — inline loop → nested body, match blocks
- [ ] `test-level-loops.json` — inline loop → nested `steps` body
- [ ] `combined-loops.json` — inline loops → nested bodies
- [ ] `ui-substep-loops.json` — inline loops → nested bodies

### demo-oauth-flow definitions (7 files)

- [ ] `authenticated-flow.json` — match blocks, assertion paths
- [ ] `oauth-userinfo-failure.json` — match blocks
- [ ] `public-endpoints.json` — match blocks
- [ ] `oauth-redirect-flow.json` — match blocks
- [ ] `single-post-endpoints.json` — match blocks
- [ ] `profile-posts-visibility.json` — match blocks
- [ ] `oauth-failure-cases.json` — match blocks

### control-tower definitions (1 file)

- [ ] `healthcheck-ct.json` — match blocks if present

### Migration rules (apply to all files)

For each file:
- [ ] `match: { origin, method, url }` → `match: { path: "$.traffic", where: [...] }` with `$$`-prefixed paths
- [ ] `$.response.*` in match-block assertions → `$.match.response.*`
- [ ] `$.request.*` in match-block assertions → `$.match.request.*`
- [ ] `$.responseTime` in match-block assertions → `$.match.responseTime`
- [ ] `count` blocks → `count` on match or `count` assertion shorthand
- [ ] `assertionScope` → remove (use `$.match`, `$.lastMatch`, or forEach over `$.matches`)
- [ ] Extract rules inside match blocks: `$.response.*` → `$.match.response.*`
- [ ] `consoleAssertions` → `match: { path: "$.consoleLogs", where: [...] }` + assertions
- [ ] `service` field → `$$.origin` in match `where`
- [ ] `{ "operator": "length", ... }` → `{ "count": "$.path", ... }`
- [ ] `{ "operator": "type", ... }` → `{ "type": "$.path", "operator": "eq", ... }`
- [ ] `arrayContains` → `contains`; `arrayNotContains` → `notContains`
- [ ] `$.x.y.length` in paths → `{ "count": "$.x.y", ... }` or `{ "path": { "from": "$.x.y", "transform": "length" }, ... }`
- [ ] Inline `forEach`/`for`/`repeat` (sibling keys) → nested loop with body content inside

---

## Phase 15: Tests — Go (`services/test-agent/`)

### `assertion_engine_test.go`

- [ ] Remove tests for `.length` path resolution
- [ ] Add tests for negative indexing: `$.arr[-1]`, `$.arr[-2]`, out-of-bounds
- [ ] Add tests for `$$` resolution with scoped context
- [ ] Add tests for `$$` without scoped context (returns nil, false)
- [ ] Add tests for bare `$$` (no trailing field) — returns nil, false
- [ ] Remove tests for `type`, `length`, `arrayContains`, `arrayNotContains` operators
- [ ] Add tests for unified `contains`: string substring, array element, object key, null → error, number → error
- [ ] Add tests for `notContains`: same dispatch matrix
- [ ] Add tests for `resolveSource`: string path, object form, each shorthand, missing source, multiple sources
- [ ] Add tests for `applyAssertionTransform`: each transform with correct input, each transform with wrong input type
- [ ] Add tests for `resolveValue`: literal, ValueRef with `$.` prefix, ValueRef with transform, literal object with `from` key not starting with `$.` (e.g., `{ "from": "$50" }`)
- [ ] Add tests for full `ValidateAssertion` pipeline: source → transform → value → compare

### `block_validators_test.go`

- [ ] Remove tests for `ValidateSelfBlock`
- [ ] Remove tests for `ValidateConsoleLogBlock`
- [ ] Add tests for `ExecuteMatch`: basic where filtering, empty where (match all), no matches, multiple matches
- [ ] Add tests for where `or`/`and`/`not` combinators — including nesting
- [ ] Add tests for `MatchStack`: push/pop, nested push/pop, pop restores nil correctly (outer match had 0 results)
- [ ] Add tests for `desugarMatchCount`: bare int, object form, nil
- [ ] Add tests for `formatWhereDescription`: simple, nested or/and/not
- [ ] Add tests for `as` — matches saved to variables, accessible in subsequent blocks

### `step_validator_test.go`

- [ ] Add tests for unified `validateBlock` flow: match → loop → assertions → extract sequence
- [ ] Add tests for match + forEach composition (match populates `$.matches`, forEach iterates)
- [ ] Add tests for `as`-named results persisting across blocks while `$.match` is block-scoped

### `loop_executor_test.go`

- [ ] Update tests for nested loop body structure (not inline modifiers)
- [ ] Add tests for match inside loop body
- [ ] Add tests for nested loops (forEach inside forEach)
- [ ] Add tests for extract with dynamic keys (`userId_{{entry.index}}`)
- [ ] Add tests for `repeat.until` with transform shorthands and ValueRef

### `variable_context_test.go`

- [ ] Add tests for `resolveWhereEntry`: resolves `{{var}}` in values, does NOT resolve `$$` paths
- [ ] Add tests for `resolveWhereEntry`: recurses into `or`/`and`/`not`
- [ ] Add tests for extract key interpolation with `Resolve`

### `document_assembler_test.go`

- [ ] Add tests for `requestTimelineIndex`/`responseTimelineIndex` on traffic entries
- [ ] Add tests for `responseTimelineIndex` = nil when no response

## Phase 16: Tests — TypeScript (`shared/definition-validator/`)

### `validate-assertions.spec.ts`

- [ ] Remove tests for `count`, `assertionScope`, `service`, `consoleAssertions` on assertion blocks
- [ ] Remove tests for `type`, `length`, `arrayContains`, `arrayNotContains` operators
- [ ] Add tests for new `MatchCriteria` validation: `path` required, `where` non-empty, `count` (int and object), `as`
- [ ] Add tests for `validateWhereEntry`: assertion form (`$$.` required), `or`, `and`, `not`, mixing rejected
- [ ] Add tests for assertion source fields: exactly one required, each shorthand validates as string path
- [ ] Add tests for `PathWithTransform` validation: require `from` (`$.`), require valid `transform`
- [ ] Add tests for `ValueRef` detection: `$.`-prefixed `from` → ValueRef, `$50` → literal
- [ ] Add tests for `$$` rejected outside `where` context

### `validate-loops.spec.ts`

- [ ] Update tests for nested loop body validation
- [ ] Add tests for level-specific body validation (test→steps, step→action allowed, assertion-block→no action/steps)
- [ ] Add tests for recursive nested loops
- [ ] Remove tests for forEach+match mutual exclusion (now composable)
- [ ] Add tests for `repeat.until` validation (accepts transform shorthands, ValueRef)
- [ ] Add tests for step-level loop + sibling assertions/extract rejected

---

## Phase 17: Documentation

### Primary reference

- [ ] `shared/docs/dokkimi-instructions.md` — Full update:
  - [ ] Assertion block section: new match structure, `$.match`/`$.matches`/`$.lastMatch`
  - [ ] Assertion paths table: remove per-log `$` meaning, add `$$`
  - [ ] Match block examples: `where`-based filtering, `or`/`and`/`not`
  - [ ] Operator table: remove `type`/`length`/`arrayContains`/`arrayNotContains`, update `contains`
  - [ ] Remove `count` block, `assertionScope`, `consoleAssertions`, `service` docs
  - [ ] Add source resolution and transform docs (`count`, `type`, `keys`, `values`, `entries` shorthands)
  - [ ] Add object form for `path` and `value` with `from`/`transform`
  - [ ] Add negative indexing docs
  - [ ] Add `as` on match docs
  - [ ] Add root-context ValueRef in `where` values
  - [ ] Update loop docs for nested structure

### Design docs (add "superseded" note)

- [ ] `docs/implemented/DESIGN-unified-root-context.md` — add "superseded by consistent-root-document.md" header
- [ ] `docs/implemented/DESIGN-loops.md` — add "superseded by consistent-root-document.md" header
- [ ] `docs/implemented/DESIGN-inline-validation.md` — add "superseded by consistent-root-document.md" header

### npm/CLI

- [ ] `scripts/npm-readme.md` — update match block example

### Astro doc pages

- [ ] `apps/landing/src/pages/docs/assertions.astro` — assertion syntax, operators, match blocks, transforms, `$$`/`where`
- [ ] `apps/landing/src/pages/docs/loops.astro` — nested loop structure
- [ ] `apps/landing/src/pages/docs/tests-and-steps.astro` — step-level assertion blocks, match blocks

### Astro blog posts

- [ ] `apps/landing/src/content/blog/posted/03-how-traffic-interception-works.md` — update `consoleAssertions`, per-log `$` paths
- [ ] `apps/landing/src/content/blog/posted/10-console-log-assertions.md` — full rewrite: `match: { path: "$.consoleLogs", where: [...] }` pattern

### Astro tutorials

- [ ] `apps/landing/src/content/tutorials/posted/04-testing-llm-integrations.md` — update `assertionScope`, `arrayContains`, `consoleAssertions`

### VSCode extension

- [ ] `apps/vscode` — update autocomplete for new match structure, `$$`, removed fields
- [ ] `apps/vscode` — update snippets for new match/where/loop patterns
- [ ] `apps/vscode` — update validation rules (mirrors TS validator changes)

---

## Phase 18: Verify & Ship

- [ ] Run Go tests: `cd services/test-agent && go test -vet=off ./...`
- [ ] Run TS validator tests: `yarn workspace @dokkimi/definition-validator test`
- [ ] Build shared packages: `yarn build:shared`
- [ ] Validate all definition files: `dokkimi validate` on each `.dokkimi/` project
- [ ] Run integration tests: `dokkimi run` on traffic-tester, loop-tests, demo-oauth-flow
- [ ] Verify build artifacts regenerated: `.publish-staging/` and `apps/cli/dist/` copies of `dokkimi-instructions.md`
- [ ] Rebuild Go sidecar images: `./scripts/rebuild-go-services.sh`
- [ ] Smoke test end-to-end: run a test suite that exercises match, loops, transforms, `as`, console log filtering
