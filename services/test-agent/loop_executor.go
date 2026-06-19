package main

import (
	"fmt"
	"log"
	"time"
)

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
// Meta-variables (index, items) are only set when name is non-empty.
func setForEachVars(varCtx *VariableContext, as string, name string, item interface{}, index int, items []interface{}) {
	varCtx.Set(as, item)
	if name != "" {
		varCtx.Set(name, map[string]interface{}{
			"index": float64(index),
			"items": items,
		})
	}
}

// setForVars sets the loop variable for a for-range iteration.
// Meta-variables (index) are only set when name is non-empty.
func setForVars(varCtx *VariableContext, as string, name string, value int, index int) {
	varCtx.Set(as, float64(value))
	if name != "" {
		varCtx.Set(name, map[string]interface{}{
			"index": float64(index),
		})
	}
}

// setRepeatVars sets the loop variable for a repeat iteration.
func setRepeatVars(varCtx *VariableContext, as string, index int) {
	varCtx.Set(as, float64(index))
}

// setLoopResult sets completed/iterations on the named loop variable after a loop finishes.
// No-op if name is empty. Creates a new map to avoid mutating any prior snapshot.
func setLoopResult(varCtx *VariableContext, name string, completed bool, iterations int) {
	if name == "" {
		return
	}
	result := map[string]interface{}{
		"completed":  completed,
		"iterations": float64(iterations),
	}
	existing, _ := varCtx.ResolveTyped("{{" + name + "}}")
	if m, ok := existing.(map[string]interface{}); ok {
		for k, v := range m {
			if k != "completed" && k != "iterations" {
				result[k] = v
			}
		}
	}
	varCtx.Set(name, result)
}

const maxForIterations = 10000

// forRangeValues generates the range values for a for loop.
func forRangeValues(fl *ForLoop) []int {
	step := fl.Step
	if step == 0 {
		log.Printf("WARNING: for loop step is 0, defaulting to 1 — the validator should reject this")
		step = 1
	}
	count := 0
	if step > 0 {
		count = (fl.To-fl.From)/step + 1
	} else {
		count = (fl.From-fl.To)/(-step) + 1
	}
	if count < 0 {
		count = 0
	}
	if count > maxForIterations {
		log.Printf("WARNING: for loop would produce %d iterations, capping at %d", count, maxForIterations)
		count = maxForIterations
	}
	values := make([]int, 0, count)
	if step > 0 {
		for v := fl.From; v <= fl.To && len(values) < maxForIterations; v += step {
			values = append(values, v)
		}
	} else {
		for v := fl.From; v >= fl.To && len(values) < maxForIterations; v += step {
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
