package main

import (
	"log"
	"time"
)

const (
	defaultPollInterval    = 100 * time.Millisecond
	defaultQuiescencePeriod = 500 * time.Millisecond
	defaultMaxWait         = 10 * time.Second
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

// WaitForQuiescence waits until no new logs arrive for the quiescence period.
func (sv *StepValidator) WaitForQuiescence() {
	time.Sleep(defaultQuiescencePeriod)

	deadline := time.Now().Add(defaultMaxWait)
	lastCount := sv.logBuffer.LogCount()

	for time.Now().Before(deadline) {
		time.Sleep(defaultPollInterval)
		currentCount := sv.logBuffer.LogCount()
		if currentCount == lastCount {
			lastLogTime := sv.logBuffer.LastLogTime()
			if lastLogTime.IsZero() || time.Since(lastLogTime) >= defaultQuiescencePeriod {
				return
			}
		}
		lastCount = currentCount
	}

	log.Printf("Quiescence detection timed out after %v", defaultMaxWait)
}

// ValidateStep runs all assertion blocks for a step against the buffered logs.
// stepResp is the document returned by the step executor (non-nil for UI steps).
// Returns per-assertion results and whether the step passed overall.
func (sv *StepValidator) ValidateStep(step TestStep, stepExec StepExecution, stepResp map[string]interface{}) ([]AssertionResult, bool) {
	httpLogs, dbLogs, consoleLogs := sv.logBuffer.Snapshot()
	var results []AssertionResult

	// Resolve variables in the step action so log matching compares resolved
	// values (e.g. actual query strings) rather than ${{var}} templates.
	resolvedStep := step
	if resolved, err := sv.varCtx.ResolveAction(step.Action); err == nil {
		resolvedStep.Action = resolved
	}

	var stepDoc, extractDoc map[string]interface{}
	if step.Action.Type == "ui" && stepResp != nil {
		stepDoc = stepResp
		extractDoc = stepResp
	} else {
		stepDoc = AssembleStepDocument(resolvedStep, httpLogs, dbLogs, stepExec)
		extractDoc = AssembleExtractDocument(resolvedStep, httpLogs, dbLogs, stepExec)
	}

	if step.Extract != nil {
		for variable, rule := range step.Extract {
			value, err := ResolveExtractRule(extractDoc, variable, rule)
			if err != nil {
				results = append(results, AssertionResult{
					Passed:     false,
					Error:      err.Error(),
					Path:       rule.Path,
					ResultKind: "extract",
				})
			} else {
				sv.varCtx.Set(variable, value)
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

		if block.Extract != nil {
			for variable, rule := range block.Extract {
				value, err := ResolveExtractRule(stepDoc, variable, rule)
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
			blockResults = ValidateSelfBlock(block, stepDoc)
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
