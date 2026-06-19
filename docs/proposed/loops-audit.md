Loops Branch Review
Architecture Assessment: B+ (Sound foundation, needs decomposition)
The design is architecturally sound — loops as modifiers rather than new action types was the right call. The modifier pattern keeps the schema additive and avoids combinatorial explosion. The three-way split (forEach/for/repeat) with clear semantics at each level (test/step/action/assertion-block/UI-sub-step) is clean and well-thought-out.

That said, the implementation has grown organically and needs structural cleanup before this ships.

1. BUGS
   Bug 1 (High): normalizeResponseForUntil shape mismatch with unified root context
   test_executor.go:912-926 — The until evaluation path constructs a different document shape than what regular assertions use. executeAPIStep returns {statusCode, body, headers}, then normalizeResponseForUntil wraps it and adds a status alias. But the unified root context that regular assertions use has {response: {status, headers, body}} — note status not statusCode, and nested under response.

This means a user writing until assertions would need different paths than their regular assertions:

Regular assertion: $.response.status
until at step/action level: $.response.statusCode or $.response.status (the alias)
The body structure also differs — regular assertions get $.response.body.X resolved via the interceptor log's parsed body, but until gets it from the raw extraction doc which may have different structure.

Fix: until evaluation should build a proper root context document, or at least normalize the response shape to match what AssembleRootContext produces.

Bug 2 (High): UI sub-step group SubStepIndex collision
ui_executor.go:545 — subStepIndex*1000 + iterIdx*100 + j collides when:

More than 10 iterations (iterIdx >= 10 overflows into the next subStep group's range)
More than 100 sub-steps per group (j >= 100 overflows)
A for: {from: 1, to: 20} loop with 5 sub-steps would produce collisions. This index is used for artifact naming and log correlation — collisions mean misattributed screenshots and confusing logs.

Fix: Use a compound key or a different encoding scheme that doesn't assume small counts.

Bug 3 (Medium): forRangeValues has no iteration cap
loop_executor.go:92-109 — A for: {from: 0, to: 1000000} would allocate a million-element slice. The validator doesn't enforce a max on to - from. While timeoutSeconds provides an eventual safety net, the OOM from slice allocation happens before any iteration runs.

Fix: Add a runtime cap (e.g., 10,000) in forRangeValues, and/or add a validator check on abs(to - from) / step.

Bug 4 (Medium): Shallow Snapshot() allows cross-mutation
variable_context.go:274-282 — Snapshot() copies the top-level map but not nested values. When the assertion-block forEach calls rootCtx["variables"] = sv.varCtx.Snapshot(), the nested map values are shared references. Subsequent mutations via setForEachVars or setLoopResult on the shared VariableContext could affect the snapshot's nested maps.

In practice this works because mutations are sequential, but it's fragile — any future parallelism or reordering would introduce subtle corruption.

Bug 5 (Medium): Assertion-block forEach leaks loop variables
step_validator.go:161-163 — setForEachVars(sv.varCtx, ...) during assertion-block forEach mutates the shared VariableContext. After the forEach finishes, the loop variable remains set to the last item. If a subsequent assertion block in the same step references that variable name, it gets the leaked value. There's no cleanup.

2. CODE DUPLICATION (The spaghetti problem)
   This is the biggest structural issue. The iteration-plan-build pattern is copy-pasted 5 times:

Location Lines What it does
test_executor.go:427-571 (ExecuteTests) ~145 Test-level loop
test_executor.go:170-334 (executeStepAt) ~165 Step-level loop
test_executor.go:664-758 (executeActionLoop) ~95 Action-level loop
ui_executor.go:484-574 (runSubStepGroup) ~90 UI sub-step loop
step_validator.go:150-179 (validateStep) ~30 Assertion-block forEach
Each copy follows the exact same pattern:

Check which loop modifier is present (forEach / for / repeat)
Build an iterations slice of {label, setupFn} structs
Loop: delay → setupFn → execute body → check until → track completed/iterations
After loop: extract loop name from whichever modifier was set → setLoopResult
Steps 1, 2, 3 (except body), and 4 are identical across all five locations. Only the body execution differs.

Additionally, the loop-name extraction (3-way if/else on forEach/for/repeat to get the Name field) appears 4 times:

test_executor.go:321-327
test_executor.go:747-754
test_executor.go:562-569
(implicitly in runSubStepGroup, though it doesn't call setLoopResult — which is itself a bug, see below)
Recommendation: Extract a generic runLoop function:

type LoopPlan struct {
Iterations []struct{ Label string; Setup func() }
DelayMs int
Until []Assertion // nil for forEach/for
Name string
}

func buildLoopPlan(forEach *ForEachLoop, forLoop *ForLoop, repeat *RepeatLoop, varCtx *VariableContext, rootCtx map[string]interface{}) (\*LoopPlan, error)

func runLoop(plan *LoopPlan, body func(iterIdx int) (map[string]interface{}, error), varCtx *VariableContext) (completed bool, iterations int, lastResp map[string]interface{}, err error)
This would reduce each call site to ~10 lines (build plan + call runLoop with a body closure) and eliminate the duplication.

3. FILE DECOMPOSITION PLAN
   test_executor.go (1084 lines → 3 files)
   New file Contents ~Lines
   test_executor.go TestExecutor struct, NewTestExecutor, SetUIStepExecutor, SetInlineValidation, CloseUI, VarContext, flatStep, flattenSteps, ExecuteTests, ExecuteStep ~250
   step_executor.go executeStepAt, executeStepOnce, executeStep, executeAction, executeActionLoop, executeParallelAction ~350
   api_executor.go APIResponse, executeAPIStep, doAPIRequest, apiResponseToExtractDoc, executeDbQueryStep, stripScheme, retry constants, rootCause, normalizeResponseForUntil, toFloat64 ~250
   assertion_engine.go (581 lines → 2 files)
   New file Contents ~Lines
   assertion_engine.go EvaluateDocPath, parsePathSegments, ValidateAssertion, ValidateCount, AssertionResult, Assertion, CountAssertion ~250
   extract.go ResolveExtractRule, resolveTransformExtract, applyTransform ~120
   comparators.go CompareValues, looseEqual, ciEquals, toFloat, toBool, goTypeLabel, getLength, isEmptyValue, toMap, toSlice ~200
4. DESIGN ASYMMETRIES & SMELLS
   UI sub-step loops don't set loop result metadata
   ui_executor.go:484-574 — runSubStepGroup never calls setLoopResult. If a user names their UI loop and then checks {{loopName.completed}} or {{loopName.iterations}}, those variables won't exist. All other loop levels (test/step/action) call setLoopResult.

resolveForEachItems has two code paths for $ paths
loop_executor.go:27-36 — The $.path branch only works when rootCtx != nil. At the step and test levels, resolveForEachItems is called with rootCtx as nil, so $.path items are impossible. But the validator doesn't enforce this — a user could write items: "$.response.body.users" on a step-level forEach and get a runtime error. Either the validator should reject $. items at step/test level, or the executor should build a rootCtx to resolve against.

lastStepResponse is set but never read at the right time
test_executor.go:621-627 — e.lastStepResponse is set after executeStep and executeActionLoop. But it's read in ExecuteTests for test-level repeat.until at line 547. This works because steps within a test execute sequentially, but the naming (lastStepResponse) and the field's scope (on TestExecutor rather than local to the test group) makes it look like a cross-test leak. If tests ever run in parallel, this breaks.

5. TEST COVERAGE GAPS
   The loop test definitions are good for happy paths but have notable gaps:

No test for for loops with custom positive step (e.g., step: 2 counting 1,3,5) — only negative step is exercised
No test for repeat without until at the action level — action-level semantics differ from step-level
No nested loops beyond one level — e.g., step-level loop containing action-level loop
No test for repeat until at UI sub-step level
No test for cross-iteration extract usage — extracting in iteration N and using in iteration N+1
No test for $.path items on assertion-block forEach — only {{variable}} items are tested
No negative tests for loop validation — e.g., verifying that forEach without as is rejected at the integration level
The unit tests in Go are solid for the features they cover but thin for edge cases:

loop_executor_test.go (225 lines) tests resolution and iteration helpers but not the full execution path
No test for forRangeValues with very large ranges
No test for evaluateUntil with variable-reference paths 6. VALIDATOR QUALITY (TypeScript)
validate-loops.ts is clean and well-structured — 229 lines, clear separation. This is actually one of the best-organized files on the branch.

validate-assertions.ts at 393 lines is fine — the path-format validation with deprecation warnings and migration suggestions is thoughtful.

One gap: the validator doesn't enforce a maximum iteration count for for loops (from and to can be arbitrarily far apart). This pairs with Bug 3 above.

7. CROSS-CUTTING CONCERNS
   Definition file migration (breaking changes)
   The branch migrated ~70 existing definition files to the new unified root context paths. The scale of this migration is concerning — every existing user-authored definition will break on upgrade. The validator does provide helpful migration suggestions via OLD_PATH_SUGGESTIONS, which is good.

The header → headers rename in AssembleHttpDocument is another breaking change. The validator warns about deprecated $.body. paths but doesn't warn about $.response.header. (singular) vs $.response.headers..

8. PRIORITIZED ACTION ITEMS

# Action Effort Impact

1 Extract runLoop/buildLoopPlan to eliminate 5x duplication Medium Removes ~400 lines of duplicated code, makes all loop levels behave consistently
2 Split test_executor.go into 3 files Low Pure refactor, easier to navigate and review
3 Fix normalizeResponseForUntil shape mismatch Low Prevents user confusion with until paths vs assertion paths
4 Add setLoopResult to UI sub-step groups Low Feature parity across loop levels
5 Fix SubStepIndex encoding in runSubStepGroup Low Prevents artifact correlation bugs
6 Add iteration cap to forRangeValues and/or validator Low Prevents OOM from large ranges
7 Split assertion_engine.go into 2-3 files Low Pure refactor
8 Add cross-iteration extract test + positive-step for test Medium Confidence in under-tested paths
Items 1 and 2 address the spaghetti concern directly. Item 3 is the most likely bug to bite users. Items 4-6 are quick fixes. Items 7-8 are cleanup.

NEW BUG: TypeScript type/validator mismatches (High)
Four concrete type mismatches where the validator accepts fields the TypeScript interfaces don't declare:

name field missing from all three loop interfaces — assertions.ts:44-63 — ForEachLoop, ForLoop, RepeatLoop all lack name?: string. The validator accepts it, Go uses it, but TS code (definition-resolver, VSCode extension, CLI) can't access it through the type system.

Action interfaces lack loop modifier fields — assertions.ts:127-152 — HttpRequestAction, DbQueryAction, WaitAction don't have forEach/for/repeat fields. The validator accepts them, Go parses them, but TS code can't represent action-level loops. Any TS round-trip would strip the loop fields silently.

NEW BUG: repeat.until skips path format validation (High)
validate-loops.ts:159-183 — until assertions check that path is a non-empty string and operator is valid, but never call validatePathFormat. Regular assertions do. This means deprecated paths like response.status or $.body.x pass validation inside until but fail at runtime or produce wrong results.

NEW BUG: Test-level loop resets variables every iteration (Medium-High)
test_executor.go:506-519 — When hasLoop is true, varCtx.Reset() fires at the start of every iteration. Variables extracted by previous iterations are destroyed. This conflicts with repeat + until patterns where a user might want state to accumulate across iterations (e.g., checking {{counter}} in until where counter is extracted per iteration). The until check at line 543-558 only sees the current iteration's variables.

NEW BUG: evaluateUntil only resolves string values (Low-Medium)
loop_executor.go:138-143 — Variable resolution of assertion values is attempted only when a.Value is a string. But in/notIn operators use array values that might contain {{variable}} references. Regular assertion resolution via ResolveAssertionBlocks handles arrays/objects recursively; evaluateUntil does not.

NEW BUG: Step-level loop doesn't flush StepLogBuffer between iterations (Medium)
test_executor.go:241-316 — The log buffer is only flushed inside ValidateStepWithRetry when assertions or extract rules exist. For steps without assertions, logs accumulate across iterations. Later iterations' time-window matching in AssembleRootContext could pick up logs from earlier iterations if timestamps overlap.

NEW BUG: ForLoop.Step zero-value ambiguity (Medium)
loop_executor.go:92-97 — Go's int zero-value means "no step field" and "step: 0" both arrive as Step=0. The runtime defaults to 1, which is correct for the absent case, but the log warning "the validator should reject this" is misleading. Using \*int would disambiguate.

NEW FINDING: Massive test coverage gaps
The agents found that none of the loop control flow is unit-tested in Go:

test_executor_test.go — Zero tests for executeStepAt, executeActionLoop, or ExecuteTests with loop modifiers
No UI sub-step group loop tests at all
No test for forRangeValues with extreme ranges
No test for Snapshot() with nested values
On the TS side:

No validator tests for assertion-block forEach (reject for/repeat, accept forEach, reject forEach + match)
No validator tests for extract transform rules ({path, transform}, {from, transform})
No integration tests for loop modifiers within step/test context
NEW FINDING: ValidateHttpCallBlock uses per-log document, not full root context (Medium)
block_validators.go:105-108 — Match-block assertions evaluate against AssembleHttpDocument (which has only request, response, responseTime) rather than the full root context. Users can't reference $.variables or $.traffic in match blocks — a silent capability gap.

NEW FINDING: forEach with $.path items silently fails at most levels (Medium)
resolveForEachItems is called with rootCtx=nil at step, action, test, and UI levels. The $.path branch requires rootCtx != nil, so items: "$.response.body.users" always fails at these levels with a generic error message that doesn't explain the limitation.

Updated priority list

# Action Severity

1 Fix TS type interfaces (add name to loops, add loop modifiers to actions) High — silent data loss
2 Add validatePathFormat to repeat.until assertions High — validation gap
3 Extract runLoop/buildLoopPlan to eliminate 5x duplication High — structural
4 Fix normalizeResponseForUntil shape mismatch High — user confusion
5 Add setLoopResult to UI sub-step groups Medium — feature parity
6 Fix SubStepIndex encoding Medium — silent corruption
7 Add iteration cap to forRangeValues Medium — OOM risk
8 Deep copy in Snapshot() Medium — latent corruption
9 Split test_executor.go Medium — maintainability
10 Add Go unit tests for loop control flow High — no coverage at all
11 Add TS validator tests for assertion-block forEach and extract transforms High — no coverage
The workflow is still running its verify and synthesize phases, but the review phase's findings are all in. Items 1-2 are quick fixes; 3 is the most impactful structural change; 10-11 are the biggest confidence gaps.
