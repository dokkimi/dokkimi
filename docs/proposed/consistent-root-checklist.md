# Consistent Root Document — Implementation Checklist

Companion to `consistent-root-document.md` (design) and `consistent-root-implementation.md` (code specs). Each task is a self-contained unit of work. Tasks within a phase can be done in any order unless noted.

---

## Phase 1: Go Types (`services/test-agent/types.go`)

- [x] Rewrite `MatchCriteria` struct → `Path`, `Where []WhereEntry`, `Count interface{}`, `As`
- [x] Add `WhereEntry` struct — `Path`, `Operator`, `Value`, `Or`, `And`, `Not`
- [x] Update `Assertion` struct — `Path` → `interface{}`; add `Count`, `Type`, `Keys`, `Values`, `Entries` source fields
- [x] Add `PathWithTransform` struct (`From`, `Transform`)
- [x] Add `ValueRef` struct (`From`, `Transform`)
- [x] Remove `AssertionBlock` fields: `Count`, `AssertionScope`, `Service`, `ConsoleAssertions`
- [x] Add `AssertionBlock` fields: `For`, `Repeat` (loops at block level)
- [x] Make `AssertionBlock.Assertions` optional (pointer or empty-ok)
- [x] Add nested body fields to `ForEachLoop`: `Match`, `Assertions`, `Extract`, `ForEach`, `For`, `Repeat`, `Action`, `Steps`
- [x] Add same nested body fields to `ForLoop` and `RepeatLoop`
- [x] Remove `ConsoleLogAssertion` struct

## Phase 2: Path Resolution (`services/test-agent/assertion_engine.go`)

- [x] `EvaluateDocPath`: delete `.length` special case (lines 62–70)
- [x] `EvaluateDocPath`: update array index regex to accept negative indices (`-?\d+`)
- [x] `EvaluateDocPath`: add negative index resolution (`idx = len(arr) + idx` when `idx < 0`)
- [x] `EvaluateDocPath`: add `scopedCtx ...interface{}` variadic parameter
- [x] `EvaluateDocPath`: reject bare `$$` (without trailing `.field`) — return `(nil, false)`
- [x] `EvaluateDocPath`: add `$$.` prefix handling — resolve against `scopedCtx[0]`
- [x] Verify all existing callers of `EvaluateDocPath` still compile (no `scopedCtx` passed)

## Phase 3: Operator Changes (`services/test-agent/assertion_engine.go`)

- [x] `CompareValues`: delete `"type"` operator case
- [x] `CompareValues`: delete `"length"` operator case
- [x] `CompareValues`: delete `"arrayContains"` operator case
- [x] `CompareValues`: delete `"arrayNotContains"` operator case
- [x] Add `containsDispatch` function — dispatch on actual type (string→substring, array→element, object→key)
- [x] Handle `nil` actual in `containsDispatch` — type error, not silent false
- [x] `CompareValues`: update `"contains"` and `"notContains"` cases to call `containsDispatch`
- [x] Add `goTypeLabel` helper — returns `"string"`, `"number"`, `"boolean"`, `"array"`, `"object"`, `"null"`
- [x] Add `sortedMapKeys` helper for `map[string]interface{}`
- [x] Add `sortedExtractKeys` helper for `map[string]ExtractRule`

## Phase 4: Assertion Resolution Pipeline (`services/test-agent/assertion_engine.go`)

- [x] Add `resolveSource` function — type-switch on `Path` (string vs object), check shorthands
- [x] `resolveSource`: require `$.` prefix (not just `$`) on `path.from`
- [x] Add `applyAssertionTransform` function — handle `length`, `type`, `keys`, `values`, `entries`
- [x] Transform error handling: type mismatch → clear error, not silent nil
- [x] Add `resolveValue` function — detect ValueRef via `$.` prefix on `from` key (not just `$`)
- [x] `resolveValue`: support optional `transform` on ValueRef
- [x] Rewrite `ValidateAssertion` — full pipeline: resolveSource → EvaluateDocPath → transform → resolveValue → CompareValues
- [x] `ValidateAssertion`: add `scopedCtx ...interface{}` parameter, pass through to `EvaluateDocPath`

## Phase 5: Match Engine (`services/test-agent/block_validators.go`)

- [x] Delete `ValidateSelfBlock` function
- [x] Delete `ValidateConsoleLogBlock` function
- [x] Add `MatchResult` struct (`Matches`, `Match`, `LastMatch`)
- [x] Add `ExecuteMatch` function — resolve source array, filter by `where`, build result
- [x] Add `evaluateWhereEntry` function — AND-list evaluation over `[]WhereEntry`
- [x] Add `evaluateSingleWhereEntry` function — handle `not`, `or`, `and`, simple assertion
- [x] `evaluateSingleWhereEntry`: construct `Assertion` from `WhereEntry`, call `ValidateAssertion` with scoped element
- [x] Add `savedMatchEntry` struct (`value`, `present` bool)
- [x] Add `MatchStack` struct with `Push`/`Pop` — track key presence separately from nil values
- [x] `MatchStack.Pop`: restore nil correctly (don't delete key when outer match had 0 results)
- [x] Add `desugarMatchCount` function — bare int → `CountAssertion{eq, n}`; object form → `CountAssertion`
- [x] Add `formatWhereDescription` function — serialize where criteria for error messages (recursive for `or`/`and`/`not`)

## Phase 6: Step Validation (`services/test-agent/step_validator.go`)

- [x] Remove three-way dispatch (console-log / match / self-block) — replace with single `validateBlock`
- [x] `validateBlock`: match → push stack → as → desugar count → loop → assertions → extract
- [x] Empty-matches handling: targeted errors for `$.match`/`$.lastMatch` assertions, but don't skip other assertions
- [x] Track `emptyMatchHandled` set to avoid double-evaluating assertions that got targeted errors
- [x] `as` handling: save `matchResult.Matches` to `varCtx`, update `rootCtx["variables"]`
- [x] Extract in match blocks: paths resolve against root context (e.g., `$.match.response.*`)
- [x] Add `executeExtract` helper — resolve dynamic key names via `varCtx.Resolve`, use `sortedExtractKeys`

## Phase 7: Loop Execution (`services/test-agent/loop_executor.go`, `step_runner.go`)

- [x] Delete `getStepLoop` function
- [x] Delete `getActionLoop` function
- [x] Add `getBlockLoop` helper — returns first non-nil from `ForEach`/`For`/`Repeat`
- [x] Add `executeBlockLoop` method on `StepValidator` — build iteration plan, run loop body per iteration
- [x] Add `extractLoopBody` function — convert nested loop fields into an `AssertionBlock`
- [x] `executeBlockLoop`: recursion via `validateBlock` on extracted body (supports nested loops)
- [x] `step_runner.go`: update `executeStepAt` — loop body is nested inside the loop struct, not sibling keys
- [x] Step-level loop body: extract action from loop struct, execute action per iteration
- [x] Step-level loop body: validate assertions/extract from loop body, not step siblings
- [x] Verify loop executor injects `index` property (zero-based iteration index) on the `as` variable per iteration

## Phase 8: Document Assembly (`services/test-agent/document_assembler.go`)

- [x] Tag timeline entries with `trafficIndex` (float64) and `direction` (`"request"` / `"response"`)
- [x] Add `annotateTimelineIndices` function — set `requestTimelineIndex` on each traffic entry
- [x] Set `responseTimelineIndex` on each traffic entry (nil when no response received)
- [x] Add `findTimelineIndex` helper
- [x] Call `annotateTimelineIndices` in `AssembleRootContext` after `mergeTimeline`

## Phase 9: Variable Resolution (`services/test-agent/variable_context.go`)

- [x] `ResolveAssertionBlocks`: remove match URL/origin resolution (fields no longer exist)
- [x] `ResolveAssertionBlocks`: remove console assertion resolution (struct removed)
- [x] Add `resolveAssertion` method — resolve source path (string form), shorthand paths, value
- [x] Add `resolveMatchCriteria` method — resolve `where` entry values
- [x] Add `resolveWhereEntry` method — resolve value in assertions, recurse into `or`/`and`/`not`
- [x] `resolveWhereEntry`: do NOT resolve `$$`-prefixed paths (resolved at match time, not variable time)
- [x] `ResolveAssertionBlocks`: resolve nested loop bodies recursively
- [x] `Extract`: add key interpolation via `vc.Resolve(variable)` for dynamic extract keys

---

## Phase 10: TypeScript Types (`shared/config/assertions.ts`)

- [x] Rewrite `AssertionBlock` — remove `count`, `assertionScope`, `service`, `consoleAssertions`; add `for`, `repeat`; make `assertions` optional
- [x] Add `MatchCriteria` interface — `path`, `where?`, `count?`, `as?`
- [x] Add `WhereEntry` union type — `WhereAssertion | WhereOr | WhereAnd | WhereNot`
- [x] Add `WhereAssertion`, `WhereOr`, `WhereAnd`, `WhereNot` interfaces
- [x] Update `Assertion` — `path` → `string | PathWithTransform`; add `count`, `type`, `keys`, `values`, `entries` source fields
- [x] Add `PathWithTransform` interface (`from`, `transform`)
- [x] Add `ValueRef` interface (`from`, `transform?`)
- [x] Update `AssertionOperator` — remove `'type'`, `'length'`, `'arrayContains'`, `'arrayNotContains'`
- [x] Add nested body fields to `ForEachLoop`, `ForLoop`, `RepeatLoop`
- [x] Delete `ConsoleLogAssertion` interface

## Phase 11: TypeScript Validator — Constants (`shared/definition-validator/constants.ts`)

- [x] Remove from `VALID_ASSERTION_OPERATORS`: `'type'`, `'length'`, `'arrayContains'`, `'arrayNotContains'`
- [x] Delete: `VALID_ASSERTION_SCOPES`, `VALID_CONSOLE_LOG_LEVELS`, `VALID_MESSAGE_OPERATORS`, `VALID_MESSAGE_FILTER_KEYS`, `VALID_CONSOLE_LOG_ASSERTION_KEYS`
- [x] Replace `VALID_MATCH_CRITERIA_KEYS` → `['path', 'where', 'count', 'as']`
- [x] Replace `VALID_ASSERTION_KEYS` → `['path', 'count', 'type', 'keys', 'values', 'entries', 'operator', 'value', 'disabled']`
- [x] Replace `VALID_ASSERTION_BLOCK_KEYS` → `['assertions', 'match', 'extract', 'forEach', 'for', 'repeat']`
- [x] Add `VALID_WHERE_ENTRY_KEYS` → `['path', 'operator', 'value', 'or', 'and', 'not']`
- [x] Add `VALID_TRANSFORMS` → `['length', 'type', 'keys', 'values', 'entries']`
- [x] Add `VALID_SOURCE_FIELDS` → `['path', 'count', 'type', 'keys', 'values', 'entries']`
- [x] Update `VALID_FOR_EACH_KEYS` to include body fields: `match`, `assertions`, `extract`, `forEach`, `for`, `repeat`, `action`, `steps`
- [x] Same for `VALID_FOR_KEYS` and `VALID_REPEAT_KEYS`

## Phase 12: TypeScript Validator — Assertions (`shared/definition-validator/validate-assertions.ts`)

- [x] Rewrite `validateAssertionBlock` — remove `count`/`assertionScope`/`service`/`consoleAssertions` validation
- [x] Add `validateMatchCriteria` — require `path` (string, `$.` prefix), validate optional `where`/`count`/`as`
- [x] `validateMatchCriteria`: `where` present → must be non-empty array; `where` omitted → match all
- [x] `validateMatchCriteria`: `count` → accept number (non-negative int) or `{operator, value}` object
- [x] `validateMatchCriteria`: `as` → non-empty alphanumeric string
- [x] Add `validateWhereEntry` (recursive) — exactly one of: assertion (`path`), `or`, `and`, `not`
- [x] `validateWhereEntry`: assertion paths must start with `$$.`
- [x] `validateWhereEntry`: `or`/`and` → non-empty array, recurse
- [x] `validateWhereEntry`: `not` → plain object, recurse
- [x] Rewrite `validateAssertion` — exactly one source field; validate string vs `PathWithTransform` for `path`
- [x] `validateAssertion`: add `validatePathWithTransform` — require `from` (`$.` prefix), require valid `transform`
- [x] `validateAssertion`: value — detect ValueRef via `$.` prefix on `from` key; validate `transform` if present
- [x] `validatePathFormat`: reject `$$` prefix outside `where` context
- [x] Delete `validateConsoleLogAssertion` function
- [x] Remove forEach+match mutual exclusion check (lines 331–339)

## Phase 13: TypeScript Validator — Loops (`shared/definition-validator/validate-loops.ts`)

- [x] Update `validateLoopModifiers` — accept `level` option (`'test'` | `'step'` | `'assertion-block'`)
- [x] Add `validateLoopBody` function (recursive) — validate body fields based on level
- [x] Test level: require `steps`, reject `action`/`match`/`assertions`/`extract`
- [x] Step level: allow `action`; allow `match`/`assertions`/`extract`; reject `steps`
- [x] Assertion-block level: allow `match`/`assertions`/`extract`; reject `action`/`steps`
- [x] Nested loops: recurse with level tier drop (test→step→assertion-block)
- [x] Validate `repeat.until` entries as standard assertions (supports transform shorthands, ValueRef)
- [x] Reject step-level sibling `assertions`/`extract` when a loop is present (body owns them)
- [x] Remove inline loop modifier validation from step/action/assertion-block levels

---

## Phase 14: Definition File Migration (33 files)

### traffic-tester definitions (16 files)

- [x] `assertion-scopes-and-counts.json` — match blocks, `assertionScope`, `count`
- [x] `advanced-assertions.json` — match blocks, assertion paths
- [x] `console-log-assertions.json` — `consoleAssertions`, `service`
- [x] `inter-service-traffic.json` — match blocks
- [x] `traffic-hopping.json` — match blocks
- [x] `variable-chaining.json` — match blocks, extract paths
- [x] `variable-ref.json` — no changes needed (already new format)
- [x] `http-methods-and-errors.json` — match blocks
- [x] `custom-responses-and-logging.json` — match blocks
- [x] `mock-body-matching.json` — match blocks
- [x] `mock-external-apis.json` — match blocks
- [x] `multi-ref-items.json` — no changes needed
- [x] `parallel-steps-and-variables.json` — no changes needed
- [x] `global-variables.json` — no changes needed
- [x] `regex-extract.json` — no changes needed
- [x] `database/*.json` (4 files) — length/type operators migrated

### loop-tests definitions (6 files)

- [x] `step-level-loops.json` — inline loop → nested body
- [x] `action-level-loops.json` — no changes needed (action-level assertions stay as siblings)
- [x] `assertion-and-transform.json` — inline loop → nested body, type operators
- [x] `test-level-loops.json` — length operator migrated
- [x] `combined-loops.json` — inline loops → nested bodies, type operators
- [x] `ui-substep-loops.json` — no changes needed

### demo-oauth-flow definitions (7 files)

- [x] `authenticated-flow.json` — match blocks, consoleAssertions, length operators
- [x] `oauth-userinfo-failure.json` — match blocks, consoleAssertions
- [x] `public-endpoints.json` — consoleAssertions, type/length operators
- [x] `oauth-redirect-flow.json` — match blocks, consoleAssertions
- [x] `single-post-endpoints.json` — no changes needed
- [x] `profile-posts-visibility.json` — length operators
- [x] `oauth-failure-cases.json` — match blocks, consoleAssertions

### control-tower definitions (1 file)

- [x] `healthcheck-ct.json` — no changes needed (already clean)

### Migration rules (all applied)

- [x] `match: { origin, method, url }` → `match: { path: "$.traffic", where: [...] }` with `$$`-prefixed paths
- [x] `$.response.*` in match-block assertions → `$.match.response.*`
- [x] `$.request.*` in match-block assertions → `$.match.request.*`
- [x] `$.responseTime` in match-block assertions → `$.match.responseTime`
- [x] `count` blocks → `count` on match or `count` assertion shorthand
- [x] `assertionScope` → remove (use `$.match`, `$.lastMatch`, or forEach over `$.matches`)
- [x] Extract rules inside match blocks: `$.response.*` → `$.match.response.*`
- [x] `consoleAssertions` → `match: { path: "$.consoleLogs", where: [...] }` + assertions
- [x] `service` field → `$$.service` in match `where`
- [x] `{ "operator": "length", ... }` → `{ "count": "$.path", ... }`
- [x] `{ "operator": "type", ... }` → `{ "type": "$.path", "operator": "eq", ... }`
- [x] `arrayContains` → `contains`; `arrayNotContains` → `notContains`
- [x] `$.x.y.length` in paths → N/A (no instances found)
- [x] Inline `forEach`/`for`/`repeat` (sibling keys) → nested loop with body content inside

---

## Phase 15: Tests — Go (`services/test-agent/`)

### `assertion_engine_test.go`

- [x] Remove tests for `.length` path resolution (N/A — never existed)
- [x] Add tests for negative indexing: `$.arr[-1]`, `$.arr[-2]`, out-of-bounds
- [x] Add tests for `$$` resolution with scoped context
- [x] Add tests for `$$` without scoped context (returns nil, false)
- [x] Add tests for bare `$$` (no trailing field) — returns nil, false
- [x] Remove tests for `type`, `length`, `arrayContains`, `arrayNotContains` operators (N/A — those operators were already removed from code)
- [x] Add tests for unified `contains`: string substring, array element, object key, null → error, number → error
- [x] Add tests for `notContains`: same dispatch matrix
- [x] Add tests for `resolveSource`: string path, object form, each shorthand, missing source, multiple sources
- [x] Add tests for `applyAssertionTransform`: each transform with correct input, each transform with wrong input type
- [x] Add tests for `resolveValue`: literal, ValueRef with `$.` prefix, ValueRef with transform, literal object with `from` key not starting with `$.` (e.g., `{ "from": "$50" }`)
- [x] Add tests for full `ValidateAssertion` pipeline: source → transform → value → compare

### `block_validators_test.go`

- [x] Remove tests for `ValidateSelfBlock` (N/A — already removed in earlier phase)
- [x] Remove tests for `ValidateConsoleLogBlock` (N/A — already removed)
- [x] Add tests for `ExecuteMatch`: basic where filtering, empty where (match all), no matches, multiple matches
- [x] Add tests for where `or`/`and`/`not` combinators — including nesting
- [x] Add tests for `MatchStack`: push/pop, nested push/pop, pop restores nil correctly (outer match had 0 results)
- [x] Add tests for `desugarMatchCount`: bare int, object form, nil
- [x] Add tests for `formatWhereDescription`: simple, nested or/and/not
- [x] Add tests for `as` — matches saved to variables, accessible in subsequent blocks

### `step_validator_test.go`

- [x] Add tests for unified `validateBlock` flow: match → loop → assertions → extract sequence
- [x] Add tests for match + forEach composition (match populates `$.matches`, forEach iterates)
- [x] Add tests for `as`-named results persisting across blocks while `$.match` is block-scoped

### `loop_executor_test.go`

- [x] Update tests for nested loop body structure (not inline modifiers)
- [x] Add tests for match inside loop body
- [x] Add tests for nested loops (forEach inside forEach)
- [x] Add tests for extract with dynamic keys (`userId_{{entry.index}}`)
- [x] Add tests for `repeat.until` with transform shorthands and ValueRef

### `variable_context_test.go`

- [x] Add tests for `resolveWhereEntry`: resolves `{{var}}` in values, does NOT resolve `$$` paths
- [x] Add tests for `resolveWhereEntry`: recurses into `or`/`and`/`not`
- [x] Add tests for extract key interpolation with `Resolve`

### `document_assembler_test.go`

- [x] Add tests for `requestTimelineIndex`/`responseTimelineIndex` on traffic entries
- [x] Add tests for `responseTimelineIndex` = nil when no response

## Phase 16: Tests — TypeScript (`shared/definition-validator/`)

### `validate-assertions.spec.ts`

- [x] Remove tests for `count`, `assertionScope`, `service`, `consoleAssertions` on assertion blocks
- [x] Remove tests for `type`, `length`, `arrayContains`, `arrayNotContains` operators
- [x] Add tests for new `MatchCriteria` validation: `path` required, `where` non-empty, `count` (int and object), `as`
- [x] Add tests for `validateWhereEntry`: assertion form (`$$.` required), `or`, `and`, `not`, mixing rejected
- [x] Add tests for assertion source fields: exactly one required, each shorthand validates as string path
- [x] Add tests for `PathWithTransform` validation: require `from` (`$.`), require valid `transform`
- [x] Add tests for `ValueRef` detection: `$.`-prefixed `from` → ValueRef, `$50` → literal
- [x] Add tests for `$$` rejected outside `where` context

### `validate-loops.spec.ts`

- [x] Update tests for nested loop body validation
- [x] Add tests for level-specific body validation (test→steps, step→action allowed, assertion-block→no action/steps)
- [x] Add tests for recursive nested loops
- [x] Remove tests for forEach+match mutual exclusion (now composable)
- [x] Add tests for `repeat.until` validation (accepts transform shorthands, ValueRef)
- [x] Add tests for step-level loop + sibling assertions/extract rejected

---

## Phase 17: Documentation

### Primary reference

- [x] `~/.dokkimi/dokkimi-instructions.md` — Full update:
  - [x] Assertion block section: new match structure, `$.match`/`$.matches`/`$.lastMatch`
  - [x] Assertion paths table: remove per-log `$` meaning, add `$$`
  - [x] Match block examples: `where`-based filtering, `or`/`and`/`not`
  - [x] Operator table: remove `type`/`length`/`arrayContains`/`arrayNotContains`, update `contains`
  - [x] Remove `count` block, `assertionScope`, `consoleAssertions`, `service` docs
  - [x] Add source resolution and transform docs (`count`, `type`, `keys`, `values`, `entries` shorthands)
  - [x] Add object form for `path` and `value` with `from`/`transform`
  - [x] Add negative indexing docs
  - [x] Add `as` on match docs
  - [x] Add root-context ValueRef in `where` values
  - [x] Update loop docs for nested structure

### Design docs (add "superseded" note)

- [x] `docs/implemented/DESIGN-unified-root-context.md` — add "superseded by consistent-root-document.md" header
- [x] `docs/implemented/DESIGN-loops.md` — add "superseded by consistent-root-document.md" header
- [x] `docs/implemented/DESIGN-inline-validation.md` — add "superseded by consistent-root-document.md" header

### npm/CLI

- [x] `scripts/npm-readme.md` — update match block example

### Astro doc pages

- [x] `apps/landing/src/pages/docs/assertions.astro` — assertion syntax, operators, match blocks, transforms, `$$`/`where`
- [x] `apps/landing/src/pages/docs/loops.astro` — nested loop structure
- [x] `apps/landing/src/pages/docs/tests-and-steps.astro` — no changes needed (no inline examples with old format)

### Astro blog posts

- [x] `apps/landing/src/content/blog/posted/03-how-traffic-interception-works.md` — update `consoleAssertions`, per-log `$` paths
- [x] `apps/landing/src/content/blog/posted/10-console-log-assertions.md` — full rewrite: `match: { path: "$.consoleLogs", where: [...] }` pattern

### Astro tutorials

- [x] `apps/landing/src/content/tutorials/posted/04-testing-llm-integrations.md` — update `assertionScope`, `arrayContains`, `consoleAssertions`

### VSCode extension

- [x] `apps/vscode` — update autocomplete for new match structure, `$$`, removed fields
- [x] `apps/vscode` — update snippets for new match/where/loop patterns
- [x] `apps/vscode` — update validation rules (mirrors TS validator changes)

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
