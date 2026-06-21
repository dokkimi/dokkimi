package main

import (
	"fmt"
	"log"
	"sort"
	"strings"
	"time"
)

const (
	validationRetryInterval = 100 * time.Millisecond
	validationMaxWait       = 5 * time.Second
)

// StepValidator validates assertions for a step using in-memory log buffers.
type StepValidator struct {
	logBuffer *StepLogBuffer
	varCtx    *VariableContext
}

// NewStepValidator creates a new step validator.
func NewStepValidator(logBuffer *StepLogBuffer, varCtx *VariableContext) *StepValidator {
	return &StepValidator{
		logBuffer: logBuffer,
		varCtx:    varCtx,
	}
}

// ValidateStepWithRetry tries validation immediately. If the result looks like
// logs haven't arrived yet (retryable), it polls every 100ms and retries until
// validation passes, a non-retryable failure occurs, or the deadline is hit.
func (sv *StepValidator) ValidateStepWithRetry(step TestStep, stepExec StepExecution, stepResp map[string]interface{}) ([]AssertionResult, bool) {
	results, passed := sv.validateStep(step, stepExec, stepResp)
	if passed || !isRetryable(results) {
		sv.logBuffer.Flush()
		return results, passed
	}

	deadline := time.Now().Add(validationMaxWait)
	for time.Now().Before(deadline) {
		time.Sleep(validationRetryInterval)
		results, passed = sv.validateStep(step, stepExec, stepResp)
		if passed || !isRetryable(results) {
			sv.logBuffer.Flush()
			return results, passed
		}
	}

	log.Printf("Validation retry timed out after %v", validationMaxWait)
	sv.logBuffer.Flush()
	return results, passed
}

// isRetryable returns true if the failure looks like logs haven't arrived yet.
func isRetryable(results []AssertionResult) bool {
	for _, r := range results {
		if !r.Passed {
			if r.ResultKind == "pending" {
				return true
			}
			if r.ResultKind == "extract" && strings.Contains(r.Error, "not found") {
				return true
			}
			// Count assertion failed — only retry when actual < expected,
			// because logs only grow. If actual >= expected, more logs
			// will never fix it (e.g., expected eq 1 but got 2).
			if r.ResultKind == "count" && isCountRetryable(r) {
				return true
			}
		}
	}
	return false
}

// isCountRetryable returns true when a count failure could resolve with more logs.
// Logs only grow, so retrying helps when we need more matches (eq/gte/gt) but
// never when we need fewer (lt/lte — more logs only make it worse).
func isCountRetryable(r AssertionResult) bool {
	actual, aOk := toFloat(r.Actual)
	expected, eOk := toFloat(r.Expected)
	if !aOk || !eOk {
		return false
	}
	switch r.Operator {
	case "gt":
		return actual <= expected
	case "eq", "gte":
		return actual < expected
	default:
		return false
	}
}

// validateStep runs all assertion blocks for a step against the buffered logs.
// stepResp is the document returned by the step executor (non-nil for UI steps).
func (sv *StepValidator) validateStep(step TestStep, stepExec StepExecution, stepResp map[string]interface{}) ([]AssertionResult, bool) {
	httpLogs, dbLogs, consoleLogs := sv.logBuffer.Snapshot()
	var results []AssertionResult

	// Resolve variables in the step action so log matching compares resolved
	// values (e.g. actual query strings) rather than ${{var}} templates.
	resolvedStep := step
	if resolved, err := sv.varCtx.ResolveAction(step.Action); err == nil {
		resolvedStep.Action = resolved
	}

	rootCtx, actionLogFound := AssembleRootContext(resolvedStep, stepExec, httpLogs, dbLogs, consoleLogs, sv.varCtx, stepResp)

	if !actionLogFound {
		return []AssertionResult{{
			Passed:     false,
			Error:      "action log not yet received from sidecar",
			ResultKind: "pending",
		}}, false
	}

	if step.Extract != nil {
		extractKeys := make([]string, 0, len(step.Extract))
		for k := range step.Extract {
			extractKeys = append(extractKeys, k)
		}
		sort.Strings(extractKeys)
		for _, variable := range extractKeys {
			rule := step.Extract[variable]
			value, err := ResolveExtractRule(rootCtx, variable, rule)
			if err != nil {
				results = append(results, AssertionResult{
					Passed:     false,
					Error:      err.Error(),
					Path:       rule.Path,
					ResultKind: "extract",
				})
			} else {
				sv.varCtx.Set(variable, value)
				if vars, ok := rootCtx["variables"].(map[string]interface{}); ok {
					vars[variable] = value
				}
				results = append(results, AssertionResult{
					Passed:     true,
					Path:       rule.Path,
					ResultKind: "extract",
				})
			}
		}
	}

	if len(step.Assertions) == 0 {
		return results, allPassed(results)
	}

	resolvedBlocks := sv.varCtx.ResolveAssertionBlocks(step.Assertions)
	matchStack := &MatchStack{}

	for blockIndex := 0; blockIndex < len(resolvedBlocks); blockIndex++ {
		block := resolvedBlocks[blockIndex]
		bi := blockIndex

		blockResults := sv.validateBlock(block, rootCtx, matchStack)
		for i := range blockResults {
			blockResults[i].BlockIndex = &bi
		}
		results = append(results, blockResults...)
	}

	return results, allPassed(results)
}

// validateBlock executes a single assertion block: match → push stack → as → count → loop → assertions → extract.
func (sv *StepValidator) validateBlock(block AssertionBlock, rootCtx map[string]interface{}, matchStack *MatchStack) []AssertionResult {
	var results []AssertionResult

	// 1. Match
	if block.Match != nil {
		matchResult, err := ExecuteMatch(block.Match, rootCtx)
		if err != nil {
			results = append(results, AssertionResult{Passed: false, Error: err.Error(), ResultKind: "field"})
			return results
		}

		matchStack.Push(rootCtx, matchResult)
		defer matchStack.Pop(rootCtx)

		// as — save to variables
		if block.Match.As != "" {
			sv.varCtx.Set(block.Match.As, matchResult.Matches)
			if vars, ok := rootCtx["variables"].(map[string]interface{}); ok {
				vars[block.Match.As] = matchResult.Matches
			}
		}

		// count assertion on match
		if countAssertion := desugarMatchCount(block.Match.Count); countAssertion != nil {
			r := ValidateCount(len(matchResult.Matches), *countAssertion)
			r.ResultKind = "count"
			r.Operator = countAssertion.Operator
			if !r.Passed {
				r.Error = fmt.Sprintf("match count failed: expected %s %d entry matching {path: %s, where: [%s]}, found %d",
					countAssertion.Operator, countAssertion.Value, block.Match.Path,
					formatWhereDescription(block.Match.Where), len(matchResult.Matches))
			}
			results = append(results, r)
			if !r.Passed {
				return results
			}
		}
	}

	// 2. Loop (if present)
	loop := getBlockLoop(block)
	if loop != nil {
		loopResults := sv.executeBlockLoop(loop, rootCtx, matchStack)
		results = append(results, loopResults...)
	}

	// 3. Assertions — with targeted errors for empty match results
	emptyMatch := block.Match != nil && rootCtx["match"] == nil
	emptyMatchHandled := make(map[int]bool)

	if emptyMatch {
		for i, a := range block.Assertions {
			if a.Disabled {
				continue
			}
			pathStr, _ := a.Path.(string)
			if pathStr == "" {
				continue
			}
			trimmed := strings.TrimPrefix(pathStr, "$.")
			if strings.HasPrefix(trimmed, "match.") || strings.HasPrefix(trimmed, "lastMatch.") {
				results = append(results, AssertionResult{
					Passed:     false,
					Error:      fmt.Sprintf("no entries matched {path: %s, where: [%s]} — %s is null", block.Match.Path, formatWhereDescription(block.Match.Where), "$."+strings.SplitN(trimmed, ".", 2)[0]),
					Path:       pathStr,
					Operator:   a.Operator,
					ResultKind: "field",
				})
				emptyMatchHandled[i] = true
			}
		}
	}

	for i, a := range block.Assertions {
		if a.Disabled || emptyMatchHandled[i] {
			continue
		}
		r := ValidateAssertion(a, rootCtx)
		r.Operator = a.Operator
		r.ResultKind = "field"
		results = append(results, r)
	}

	// 4. Extract
	if block.Extract != nil {
		extractResults := sv.executeExtract(block.Extract, rootCtx)
		results = append(results, extractResults...)
	}

	return results
}

// getBlockLoop returns the first non-nil loop from an assertion block.
func getBlockLoop(block AssertionBlock) interface{} {
	if block.ForEach != nil {
		return block.ForEach
	}
	if block.For != nil {
		return block.For
	}
	if block.Repeat != nil {
		return block.Repeat
	}
	return nil
}

// runLoopIterationBody runs one iteration of a loop body through validateBlock.
// When assertions are blocks (step-level), each block is validated independently.
// When assertions are flat (assertion-block level), a single AssertionBlock is built
// from all body fields so match/assertions/extract/nested-loops execute in correct order.
// Assertions are re-resolved on each iteration so loop variables (e.g. {{field}})
// are interpolated after the loop sets them.
func (sv *StepValidator) runLoopIterationBody(la LoopAssertions, match *MatchCriteria, extract map[string]ExtractRule,
	forEach *ForEachLoop, forLoop *ForLoop, repeat *RepeatLoop,
	rootCtx map[string]interface{}, matchStack *MatchStack) []AssertionResult {
	if len(la.Blocks) > 0 {
		resolved := sv.varCtx.ResolveAssertionBlocks(la.Blocks)
		var results []AssertionResult
		for _, block := range resolved {
			results = append(results, sv.validateBlock(block, rootCtx, matchStack)...)
		}
		return results
	}
	body := AssertionBlock{
		Match:      match,
		Assertions: la.Flat,
		Extract:    extract,
		ForEach:    forEach,
		For:        forLoop,
		Repeat:     repeat,
	}
	resolved := sv.varCtx.ResolveAssertionBlocks([]AssertionBlock{body})
	return sv.validateBlock(resolved[0], rootCtx, matchStack)
}

// executeBlockLoop runs the loop body per iteration. Dispatches on loop type.
func (sv *StepValidator) executeBlockLoop(loop interface{}, rootCtx map[string]interface{}, matchStack *MatchStack) []AssertionResult {
	switch l := loop.(type) {
	case *ForEachLoop:
		items, err := resolveForEachItems(l.Items, sv.varCtx, rootCtx)
		if err != nil {
			return []AssertionResult{{Passed: false, Error: err.Error(), ResultKind: "field"}}
		}
		var results []AssertionResult
		for itemIdx, item := range items {
			setForEachVars(sv.varCtx, l.As, l.Name, item, itemIdx, items)
			rootCtx["variables"] = sv.varCtx.Snapshot()
			results = append(results, sv.runLoopIterationBody(l.Assertions, l.Match, l.Extract, l.ForEach, l.For, l.Repeat, rootCtx, matchStack)...)
		}
		sv.varCtx.Delete(l.As)
		if l.Name != "" {
			sv.varCtx.Delete(l.Name)
		}
		rootCtx["variables"] = sv.varCtx.Snapshot()
		return results

	case *ForLoop:
		step := l.Step
		if step == 0 {
			step = 1
		}
		var results []AssertionResult
		for i := l.From; (step > 0 && i <= l.To) || (step < 0 && i >= l.To); i += step {
			sv.varCtx.Set(l.As, float64(i))
			if l.Name != "" {
				sv.varCtx.Set(l.Name, map[string]interface{}{"index": float64(i - l.From)})
			}
			rootCtx["variables"] = sv.varCtx.Snapshot()
			results = append(results, sv.runLoopIterationBody(l.Assertions, l.Match, l.Extract, l.ForEach, l.For, l.Repeat, rootCtx, matchStack)...)
		}
		sv.varCtx.Delete(l.As)
		if l.Name != "" {
			sv.varCtx.Delete(l.Name)
		}
		rootCtx["variables"] = sv.varCtx.Snapshot()
		return results

	case *RepeatLoop:
		var results []AssertionResult
		for i := 0; i < l.Count; i++ {
			sv.varCtx.Set(l.As, float64(i))
			if l.Name != "" {
				sv.varCtx.Set(l.Name, map[string]interface{}{"index": float64(i)})
			}
			rootCtx["variables"] = sv.varCtx.Snapshot()
			results = append(results, sv.runLoopIterationBody(l.Assertions, l.Match, l.Extract, l.ForEach, l.For, l.Repeat, rootCtx, matchStack)...)

			// Check until conditions
			if len(l.Until) > 0 {
				allPass := true
				for _, u := range l.Until {
					r := ValidateAssertion(u, rootCtx)
					if !r.Passed {
						allPass = false
						break
					}
				}
				if allPass {
					break
				}
			}
		}
		sv.varCtx.Delete(l.As)
		if l.Name != "" {
			sv.varCtx.Delete(l.Name)
		}
		rootCtx["variables"] = sv.varCtx.Snapshot()
		return results
	}
	return nil
}

// executeExtract resolves extract rules against the root context, supporting dynamic key names.
func (sv *StepValidator) executeExtract(extract map[string]ExtractRule, rootCtx map[string]interface{}) []AssertionResult {
	var results []AssertionResult
	for _, variable := range sortedExtractKeys(extract) {
		resolvedKey, _ := sv.varCtx.Resolve(variable)
		rule := extract[variable]
		value, err := ResolveExtractRule(rootCtx, resolvedKey, rule)
		if err != nil {
			results = append(results, AssertionResult{
				Passed:     false,
				Error:      err.Error(),
				Path:       rule.Path,
				ResultKind: "extract",
			})
		} else {
			sv.varCtx.Set(resolvedKey, value)
			if vars, ok := rootCtx["variables"].(map[string]interface{}); ok {
				vars[resolvedKey] = value
			}
			results = append(results, AssertionResult{
				Passed:     true,
				Path:       rule.Path,
				ResultKind: "extract",
			})
		}
	}
	return results
}

func allPassed(results []AssertionResult) bool {
	for _, r := range results {
		if !r.Passed {
			return false
		}
	}
	return true
}
