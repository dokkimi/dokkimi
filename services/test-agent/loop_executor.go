package main

import (
	"fmt"
	"log"
	"time"
)

// loopResult is the document exposed to step-level assertions via $.completed / $.iterations.
type loopResult struct {
	Iterations int  `json:"iterations"`
	Completed  bool `json:"completed"`
}

// resolveForEachItems resolves the items array for a forEach loop.
// Accepts: inline []interface{}, "{{varName}}" string, or "$.path" string.
func resolveForEachItems(items interface{}, varCtx *VariableContext, rootCtx map[string]interface{}) ([]interface{}, error) {
	switch v := items.(type) {
	case []interface{}:
		return v, nil
	case string:
		if len(v) >= 4 && v[:2] == "{{" && v[len(v)-2:] == "}}" {
			resolved, err := varCtx.ResolveTyped(v)
			if err != nil {
				return nil, fmt.Errorf("forEach items: %w", err)
			}
			arr, ok := resolved.([]interface{})
			if !ok {
				return nil, fmt.Errorf("forEach items: variable %q did not resolve to an array", v)
			}
			return arr, nil
		}
		if len(v) >= 2 && v[:2] == "$." && rootCtx != nil {
			resolved, ok := EvaluateDocPath(rootCtx, v)
			if !ok {
				return nil, fmt.Errorf("forEach items: path %q not found in root context", v)
			}
			arr, ok := resolved.([]interface{})
			if !ok {
				return nil, fmt.Errorf("forEach items: path %q did not resolve to an array", v)
			}
			return arr, nil
		}
		return nil, fmt.Errorf("forEach items: string must be a {{variable}} reference or a $.path")
	default:
		return nil, fmt.Errorf("forEach items: must be an array or string, got %T", items)
	}
}

// setForEachVars sets the loop variables for a forEach iteration.
func setForEachVars(varCtx *VariableContext, as string, item interface{}, index int, items []interface{}) {
	varCtx.Set(as, item)
	varCtx.Set(as+".__index", float64(index))
	varCtx.Set(as+".__items", items)
}

// setForVars sets the loop variable for a for-range iteration.
func setForVars(varCtx *VariableContext, as string, value int, index int) {
	varCtx.Set(as, float64(value))
	varCtx.Set(as+".__index", float64(index))
}

// setRepeatVars sets the loop variable for a repeat iteration.
func setRepeatVars(varCtx *VariableContext, as string, index int) {
	varCtx.Set(as, float64(index))
}

// forRangeValues generates the range values for a for loop.
func forRangeValues(fl *ForLoop) []int {
	step := fl.Step
	if step == 0 {
		step = 1
	}
	var values []int
	if step > 0 {
		for v := fl.From; v <= fl.To; v += step {
			values = append(values, v)
		}
	} else {
		for v := fl.From; v >= fl.To; v += step {
			values = append(values, v)
		}
	}
	return values
}

// getStepLoop returns the loop modifier on a step (if any). At most one is non-nil.
func getStepLoop(step TestStep) (forEach *ForEachLoop, forLoop *ForLoop, repeat *RepeatLoop) {
	return step.ForEach, step.For, step.Repeat
}

// getActionLoop returns the loop modifier on an action (if any).
func getActionLoop(action StepAction) (forEach *ForEachLoop, forLoop *ForLoop, repeat *RepeatLoop) {
	return action.ForEach, action.For, action.Repeat
}

// evaluateUntil checks the until assertions against the root context.
// Returns true if all until assertions pass.
func evaluateUntil(until []Assertion, rootCtx map[string]interface{}, varCtx *VariableContext) bool {
	if len(until) == 0 {
		return false
	}
	for _, a := range until {
		// Resolve variable references in the assertion path and value.
		resolvedPath := a.Path
		if path, err := varCtx.Resolve(a.Path); err == nil {
			resolvedPath = path
		}
		resolvedAssertion := Assertion{
			Path:     resolvedPath,
			Operator: a.Operator,
			Value:    a.Value,
		}
		if a.Value != nil {
			if s, ok := a.Value.(string); ok {
				if resolved, err := varCtx.ResolveTyped(s); err == nil {
					resolvedAssertion.Value = resolved
				}
			}
		}
		result := ValidateAssertion(resolvedAssertion, rootCtx)
		if !result.Passed {
			return false
		}
	}
	return true
}

// delayBetweenIterations sleeps for delayMs if > 0 and not the first iteration.
func delayBetweenIterations(iteration int, delayMs int) {
	if iteration > 0 && delayMs > 0 {
		log.Printf("Loop delay: %dms before iteration %d", delayMs, iteration)
		time.Sleep(time.Duration(delayMs) * time.Millisecond)
	}
}
