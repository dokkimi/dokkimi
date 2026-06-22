# Consistent Root Implementation — Issue Tracker

Audit findings from the unified-root branch review. Organized by priority.

## Fix Before Shipping

### 1. ~~No iteration cap on ForLoop in executeBlockLoop~~ DONE

**File:** `services/test-agent/step_validator.go:326-345`

`loop_executor.go` enforces `maxForIterations = 10000` via `forRangeValues`, but `executeBlockLoop` in `step_validator.go` reimplements the for-loop inline with no cap. A definition with `{from: 0, to: 999999999}` hangs the test agent. The index calculation is also wrong for non-unit steps — uses `float64(i - l.From)` instead of a zero-based iteration counter.

**Fix:** Call `forRangeValues` from `loop_executor.go` instead of reimplementing the iteration.

### 2. ~~Response timeline entries use request timestamp~~ DONE

**File:** `services/test-agent/document_assembler_lists.go:56-82`

Both request and response timeline entries use the same `logTime` (derived from `RequestSentAt`). The response entry should use `ResponseReceivedAt`. This makes the response timestamp data inaccurate, and combined with #3, makes `requestTimelineIndex`/`responseTimelineIndex` nondeterministic.

### 3. ~~sort.Slice is not stable — same-timestamp timeline entries get random order~~ DONE

**File:** `services/test-agent/document_assembler_lists.go:171-173`

Since request and response entries currently share the same timestamp (#2), `sort.Slice` puts them in arbitrary order across runs. This makes `requestTimelineIndex`/`responseTimelineIndex` flaky, and any assertion on `$.timeline[n]` is fragile.

**Fix:** Use `sort.SliceStable` and fix the response timestamp (#2). These two must be fixed together.

### 4. ~~Unsafe type assertion in resolveAction~~ DONE

**File:** `services/test-agent/variable_context.go:151`

`resolved.Params = resolvedParams.(map[string]interface{})` will panic if `resolveValue` returns a non-map type. Should use comma-ok form.

### 5. ~~stepTimeWindow silently continues with zero-value time on parse failure~~ DONE

**File:** `services/test-agent/document_assembler.go:201-215`

If `StartTime` or `EndTime` fails to parse, it logs a warning but proceeds with year-0001 `time.Time`, silently corrupting the filter window (either including everything or excluding everything depending on direction).

## Fix Before Users Hit Them

### 6. ~~operator not enforced as required on assertions or where entries~~ DONE

**File:** `shared/definition-validator/validate-assertions.ts:364-375` and `validate-assertions.ts:115-125`

An assertion like `{ path: "$.response.status", value: 200 }` (missing operator) passes validation. The Go runtime catches this with an `"Unknown operator: "` error, so it doesn't silently pass — but the error message is confusing. The validator should reject it upfront.

### 7. ~~resolveAssertions doesn't resolve shorthand source field paths~~ DONE

**File:** `services/test-agent/variable_context.go:221-237`

`resolveAssertions` resolves `Path` and `Value` but skips `Count`, `Type`, `Keys`, `Values`, `Entries`. A shorthand like `count: "$.variables.{{listName}}"` won't have `{{listName}}` interpolated. `evaluateUntil` (for `repeat.until`) does resolve these fields — inconsistent behavior.

### 8. ~~$$. paths pass validatePathFormat — accepted outside where context~~ DONE

**File:** `shared/definition-validator/validate-helpers.ts:60`

`validatePathFormat` checks for `$.` prefix. Since `$$.` also starts with `$`, a path like `$$.foo` in a regular assertion (not inside where) passes validation. The spec says `$$` must be rejected outside where. At runtime this resolves to `(nil, false)` so it fails — but the validator should catch it.

### 9. containsIgnoreCase uses different comparison semantics than contains for arrays — NO FIX NEEDED

**File:** `services/test-agent/assertion_operators.go:191-197`

`contains` uses `reflect.DeepEqual`, but `containsIgnoreCase` converts both sides to strings via `fmt.Sprintf("%v")` then uses `strings.EqualFold`. For nested objects/arrays in an array, these produce different results. This is a deliberate tradeoff (case-insensitive inherently means string comparison), but it means `containsIgnoreCase` is strictly looser — e.g., `containsIgnoreCase([1], "1")` passes, `contains([1], "1")` does not.

### 10. ~~repeat loop as variable doesn't get an .index property~~ DONE

Spec says "loop executor injects index property on the as variable per iteration." For `forEach`/`for`, index is accessible via the `name` meta-variable. For `repeat`, the `as` value IS the index (a bare number), so `{{attempt.index}}` doesn't work — only `{{attempt}}`. Inconsistent with the other loop types.

### 11. ~~for loop from === to with negative step is rejected, but accepted with positive step~~ DONE

**File:** `shared/definition-validator/validate-loops.ts:296-302`

`from === to` should produce exactly one iteration regardless of step direction.

### 12. ~~regexp.Compile called on every matches operator evaluation~~ DONE

**File:** `services/test-agent/assertion_operators.go:57-62`

In a `where` loop over N traffic entries, the same regex pattern gets compiled N times. Should cache compiled patterns.

## Cleanup

### 13. ~~Nil vs empty slice for zero matches~~ DONE

**File:** `services/test-agent/block_validators.go:43`

When where filters match zero elements, `matches` is a nil `[]interface{}`. If someone stores zero-match results via `match.as` and then does a `count` on that variable downstream, `applyAssertionTransform(nil, "length")` errors instead of returning 0. Edge case — `len(nil)` works fine for the common path (count on the match block itself).

### 14. resolveSource silently accepts multiple source fields — ALREADY HANDLED BY VALIDATOR

**File:** `services/test-agent/assertion_transforms.go:11-41`

`{path: "$.foo", count: "$.bar"}` silently uses path and ignores count. First-match-wins is deterministic. The TS validator already enforces mutual exclusion (issue #14 in validate-assertions.ts lines 312-325), so this can only happen if someone bypasses the validator. No additional fix needed.

### 15. ~~emptyMatch false positive when matched element is JSON null~~ DONE

**File:** `services/test-agent/step_validator.go:217`

If the source array contains a literal `null` that passes the where filter, `matches[0]` is nil, `result.Match` is nil, and `emptyMatch` is incorrectly set to true. Extremely unlikely in practice.

### 16. ~~$$foo (no dot separator) not rejected~~ DONE

**File:** `services/test-agent/doc_path.go:22-34`

`$$foo` doesn't match `$$` or `$$.` checks, falls through to root doc resolution, resolves to `(nil, false)`. Not a correctness bug — just doesn't match anything. Validator should reject it.

### 17. ~~ForLoop iteration logic duplicated~~ DONE (fixed by #1)

**File:** `services/test-agent/step_validator.go:326-345` vs `services/test-agent/loop_executor.go:96-125`

Root cause of #1. Two implementations with different safety properties. Fix #1 by delegating to `forRangeValues` and this goes away.

### 18. ~~applyAssertionTransform and applyTransform are largely duplicate~~ DONE

**File:** `services/test-agent/assertion_transforms.go:43-91` vs `assertion_transforms.go:199-228`

Both implement keys/values/entries logic. Could share code.

### 19. ~~Dead/redundant guard clause in where mutual-exclusion check~~ DONE

**File:** `shared/definition-validator/validate-assertions.ts:104`

Correct by accident, confusing to read.

## Spec Deviations

### 20. resolveSource doesn't validate string-form path starts with $.

**File:** `services/test-agent/assertion_transforms.go:12-16`

Object form validates the `$.` prefix; string form does not.

### 21. Shorthand fields not validated for $. prefix

**File:** `services/test-agent/assertion_transforms.go:25-39`

`Count`, `Type`, `Keys`, `Values`, `Entries` are not checked for `$.` prefix.

### 22. PathWithTransform.transform is optional in type; spec says required

**File:** `shared/definition-validator/validate-assertions.ts:243`

### 23. MatchCriteria.as not validated as alphanumeric

**File:** `shared/definition-validator/validate-assertions.ts:189`

Loop `as` validates this; match `as` does not.

### 24. Traffic entries missing responseTime field

**File:** `services/test-agent/document_assembler_lists.go:38-54`

Root-level `AssembleHttpDocument` sets `responseTime`, but traffic array entries don't include it. Data completeness gap.

### 25. ~~Dead reference to removed service key in parallel-step warning~~ DONE

**File:** `shared/definition-validator/validate-tests.ts:316`

## Performance

### 26. O(n^2) string concatenation in parsePathSegments

**File:** `services/test-agent/doc_path.go:112`

Uses `current += string(path[i])` — should use `strings.Builder`. Low severity.

### 27. findTimelineIndex is O(n) linear scan per traffic entry

**File:** `services/test-agent/document_assembler_lists.go:204-217`

Called 2x per traffic entry — O(traffic x timeline). A single-pass map would be O(n). Low severity.

### 28. Case-insensitive key fallback does linear scan on every miss

**File:** `services/test-agent/doc_path.go:69-78`

Hot path in where evaluation. Low severity.

### 29. ResolveAssertionBlocks copies all assertions on every validation retry

`ValidateStepWithRetry` can retry up to 50 times, each calling `ResolveAssertionBlocks` which allocates new slices for all blocks/assertions/where entries. GC pressure in the retry path.

## Test Gaps

### 30. ~~TestRunLoop_NestedLoopBody hard-codes value instead of using loop variable~~ DONE

**File:** `services/test-agent/loop_executor_test.go:694`

Uses `Value: "svc-a"` instead of `"{{svcName}}"` — would pass even if loop variable interpolation in where clauses were broken.

### 31. ~~TestRunLoop_ExtractWithDynamicKeys tests the test, not production code~~ DONE

**File:** `services/test-agent/loop_executor_test.go:990`

Manually calls `varCtx.Set()` instead of going through `executeExtract`. Tests the loop harness, not the actual `Resolve(variable)` -> `Set(resolvedKey, value)` path.

### 32. ~~No test for where using ValueRef~~ DONE

No test for `{from: "$.variables.expectedId"}` in where entry values. Added `TestWhereWithValueRef` in `block_validators_test.go`.

### 33. ~~No test for empty-match targeted error messages~~ DONE

`step_validator.go:217-241` generates targeted errors when match produces zero results and assertions reference `$.match.*`. No test coverage. Added `TestEmptyMatchTargetedErrors` in `block_validators_test.go`.

### 34. ~~No test for match path resolving to a non-array~~ DONE

Should error. No test. Added `TestMatchPathNonArray` in `block_validators_test.go`.

### 35. ~~No test for block-level extract within a match block~~ DONE

Added `TestBlockExtractWithinMatch` in `block_validators_test.go`.

### 36. ~~No test for interleaved non-HTTP timeline entries in annotateTimelineIndices~~ DONE

Added test case "correct indices with interleaved non-HTTP entries" in `TestAnnotateTimelineIndices` in `document_assembler_lists_test.go`.

### 37. ~~No definition tests for nested loops~~ DONE

No definition file exercises true nested loops (e.g., assertion-block `forEach` containing another `forEach`, or a step-level loop whose assertion block contains a loop). `combined-loops.json` has test-level `forEach` with step-level `for`, but that's structural nesting across different levels, not a loop body containing another loop.

Added `nested-loops.json` definition file.

### 38. ~~No definition tests for dynamic variable names~~ DONE

`executeExtract` at `step_validator.go:375` resolves `{{var}}` in extract keys via `varCtx.Resolve(variable)`, but no definition file exercises this. E.g., `extract: { "user_{{idx}}": "$.response.body.id" }` inside a loop is untested end-to-end.

Added `dynamic-variable-names.json` definition file.

### 39. ~~No unit tests for dynamic variable names through executeExtract~~ DONE

The existing `TestRunLoop_ExtractWithDynamicKeys` (#31) manually calls `varCtx.Set()`. There is no unit test that feeds `"user_{{idx}}"` through `executeExtract` and verifies `user_0`, `user_1`, etc. appear in the variable context.

Rewrote `TestRunLoop_ExtractWithDynamicKeys` to call `sv.executeExtract` with `"user_{{idx}}"` extract keys.

## Cosmetic / Low Priority

### 40. "Assertion" typo throughout Go codebase

`AssertionResult`, `AssertionBlock`, etc. — consistent so not a bug, but visible in error messages users see.

### 41. variablePattern regex uses \w which doesn't support hyphens

`{{my-service}}` silently fails to resolve. Users expecting kebab-case variable names will hit this.

### 42. ~~Non-object entries in assertions array silently skipped by TS validator~~ DONE

The validator skips non-object entries instead of erroring. A typo like `[{ ... }, "oops", { ... }]` would pass validation with the middle entry silently ignored.
