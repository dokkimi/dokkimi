package main

import (
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
			if r.Error == "Step log not found" {
				return true
			}
			// Count assertion failed — only retry when actual < expected,
			// because logs only grow. If actual >= expected, more logs
			// will never fix it (e.g., expected eq 1 but got 2).
			if r.ResultKind == "count" && isCountRetryable(r) {
				return true
			}
			if r.ResultKind == "extract" && strings.Contains(r.Error, "not found") {
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

	rootCtx := AssembleRootContext(resolvedStep, stepExec, httpLogs, dbLogs, consoleLogs, sv.varCtx, stepResp)

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

	for blockIndex := 0; blockIndex < len(resolvedBlocks); blockIndex++ {
		block := resolvedBlocks[blockIndex]
		bi := blockIndex

		// Assertion-block-level forEach: iterate over items and validate per-element.
		if block.ForEach != nil {
			items, err := resolveForEachItems(block.ForEach.Items, sv.varCtx, rootCtx)
			if err != nil {
				results = append(results, AssertionResult{
					Passed:     false,
					Error:      err.Error(),
					BlockIndex: &bi,
					ResultKind: "field",
				})
				continue
			}
			for itemIdx, item := range items {
				setForEachVars(sv.varCtx, block.ForEach.As, block.ForEach.Name, item, itemIdx, items)
				// Update the rootCtx variables snapshot so $.variables.<as> paths resolve.
				rootCtx["variables"] = sv.varCtx.Snapshot()
				// Re-resolve the block's assertions with the updated variable context.
				iterBlocks := sv.varCtx.ResolveAssertionBlocks([]AssertionBlock{block})
				if len(iterBlocks) == 0 {
					continue
				}
				iterBlock := iterBlocks[0]
				iterBlock.ForEach = nil // prevent infinite recursion
				iterResults := ValidateSelfBlock(iterBlock, rootCtx)
				for i := range iterResults {
					iterResults[i].BlockIndex = &bi
				}
				results = append(results, iterResults...)
			}
			continue
		}

		if block.Extract != nil {
			blockExtractKeys := make([]string, 0, len(block.Extract))
			for k := range block.Extract {
				blockExtractKeys = append(blockExtractKeys, k)
			}
			sort.Strings(blockExtractKeys)
			for _, variable := range blockExtractKeys {
				rule := block.Extract[variable]
				value, err := ResolveExtractRule(rootCtx, variable, rule)
				if err != nil {
					results = append(results, AssertionResult{
						Passed:     false,
						Error:      err.Error(),
						Path:       rule.Path,
						BlockIndex: &bi,
						ResultKind: "extract",
					})
				} else {
					sv.varCtx.Set(variable, value)
					vars := rootCtx["variables"].(map[string]interface{})
					vars[variable] = value
					results = append(results, AssertionResult{
						Passed:     true,
						Path:       rule.Path,
						BlockIndex: &bi,
						ResultKind: "extract",
					})
				}
			}
		}

		var blockResults []AssertionResult
		if block.Service != "" && len(block.ConsoleAssertions) > 0 {
			blockResults = ValidateConsoleLogBlock(block, consoleLogs, block.Service)
		} else if block.Match != nil {
			blockResults = ValidateHttpCallBlock(block, stepExec, httpLogs)
		} else {
			blockResults = ValidateSelfBlock(block, rootCtx)
		}

		for i := range blockResults {
			blockResults[i].BlockIndex = &bi
		}
		results = append(results, blockResults...)
	}

	return results, allPassed(results)
}

func allPassed(results []AssertionResult) bool {
	for _, r := range results {
		if !r.Passed {
			return false
		}
	}
	return true
}
