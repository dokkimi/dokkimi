package main

import (
	"fmt"
	"testing"
)

func TestResolveForEachItems(t *testing.T) {
	varCtx := NewVariableContext()

	t.Run("inline array", func(t *testing.T) {
		items := []interface{}{"a", "b", "c"}
		result, err := resolveForEachItems(items, varCtx, nil)
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if len(result) != 3 || result[0] != "a" {
			t.Errorf("expected [a b c], got %v", result)
		}
	})

	t.Run("variable reference", func(t *testing.T) {
		varCtx.Set("myList", []interface{}{float64(1), float64(2)})
		result, err := resolveForEachItems("{{myList}}", varCtx, nil)
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if len(result) != 2 {
			t.Errorf("expected 2 items, got %d", len(result))
		}
	})

	t.Run("variable not an array", func(t *testing.T) {
		varCtx.Set("notArray", "hello")
		_, err := resolveForEachItems("{{notArray}}", varCtx, nil)
		if err == nil {
			t.Fatal("expected error for non-array variable")
		}
	})

	t.Run("doc path", func(t *testing.T) {
		rootCtx := map[string]interface{}{
			"response": map[string]interface{}{
				"body": []interface{}{"x", "y"},
			},
		}
		result, err := resolveForEachItems("$.response.body", varCtx, rootCtx)
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if len(result) != 2 || result[0] != "x" {
			t.Errorf("expected [x y], got %v", result)
		}
	})

	t.Run("invalid string format", func(t *testing.T) {
		_, err := resolveForEachItems("not-a-ref", varCtx, nil)
		if err == nil {
			t.Fatal("expected error for invalid string")
		}
	})
}

func TestForRangeValues(t *testing.T) {
	t.Run("ascending default step", func(t *testing.T) {
		fl := &ForLoop{From: 0, To: 3, As: "i"}
		vals := forRangeValues(fl)
		if len(vals) != 4 || vals[0] != 0 || vals[3] != 3 {
			t.Errorf("expected [0 1 2 3], got %v", vals)
		}
	})

	t.Run("ascending custom step", func(t *testing.T) {
		fl := &ForLoop{From: 0, To: 10, Step: 3, As: "i"}
		vals := forRangeValues(fl)
		if len(vals) != 4 || vals[3] != 9 {
			t.Errorf("expected [0 3 6 9], got %v", vals)
		}
	})

	t.Run("descending", func(t *testing.T) {
		fl := &ForLoop{From: 5, To: 1, Step: -2, As: "i"}
		vals := forRangeValues(fl)
		if len(vals) != 3 || vals[0] != 5 || vals[2] != 1 {
			t.Errorf("expected [5 3 1], got %v", vals)
		}
	})

	t.Run("single value", func(t *testing.T) {
		fl := &ForLoop{From: 7, To: 7, As: "i"}
		vals := forRangeValues(fl)
		if len(vals) != 1 || vals[0] != 7 {
			t.Errorf("expected [7], got %v", vals)
		}
	})
}

func TestSetForEachVars(t *testing.T) {
	t.Run("without name", func(t *testing.T) {
		varCtx := NewVariableContext()
		items := []interface{}{"alice", "bob"}
		setForEachVars(varCtx, "user", "", "alice", 0, items)

		if v, _ := varCtx.ResolveTyped("{{user}}"); v != "alice" {
			t.Errorf("expected alice, got %v", v)
		}
		if _, err := varCtx.ResolveTyped("{{loop}}"); err == nil {
			t.Error("expected loop var to not exist without name")
		}
	})

	t.Run("with name", func(t *testing.T) {
		varCtx := NewVariableContext()
		items := []interface{}{"alice", "bob"}
		setForEachVars(varCtx, "user", "userLoop", "alice", 0, items)

		if v, _ := varCtx.ResolveTyped("{{user}}"); v != "alice" {
			t.Errorf("expected alice, got %v", v)
		}
		loopVar, _ := varCtx.ResolveTyped("{{userLoop}}")
		m, ok := loopVar.(map[string]interface{})
		if !ok {
			t.Fatalf("expected map, got %T", loopVar)
		}
		if m["index"] != float64(0) {
			t.Errorf("expected index 0, got %v", m["index"])
		}
		if m["items"] == nil {
			t.Error("expected items array, got nil")
		}
	})
}

func TestSetForVars(t *testing.T) {
	t.Run("without name", func(t *testing.T) {
		varCtx := NewVariableContext()
		setForVars(varCtx, "i", "", 5, 2)

		if v, _ := varCtx.ResolveTyped("{{i}}"); v != float64(5) {
			t.Errorf("expected 5, got %v", v)
		}
	})

	t.Run("with name", func(t *testing.T) {
		varCtx := NewVariableContext()
		setForVars(varCtx, "i", "counter", 5, 2)

		if v, _ := varCtx.ResolveTyped("{{i}}"); v != float64(5) {
			t.Errorf("expected 5, got %v", v)
		}
		loopVar, _ := varCtx.ResolveTyped("{{counter}}")
		m, ok := loopVar.(map[string]interface{})
		if !ok {
			t.Fatalf("expected map, got %T", loopVar)
		}
		if m["index"] != float64(2) {
			t.Errorf("expected index 2, got %v", m["index"])
		}
	})
}

func TestSetRepeatVars(t *testing.T) {
	varCtx := NewVariableContext()
	setRepeatVars(varCtx, "attempt", 3)

	if v, _ := varCtx.ResolveTyped("{{attempt}}"); v != float64(3) {
		t.Errorf("expected 3, got %v", v)
	}
}

func TestEvaluateUntil(t *testing.T) {
	varCtx := NewVariableContext()

	t.Run("all pass", func(t *testing.T) {
		doc := map[string]interface{}{
			"response": map[string]interface{}{
				"body": map[string]interface{}{"status": "done"},
			},
		}
		until := []Assertion{
			{Path: "$.response.body.status", Operator: "eq", Value: "done"},
		}
		if !evaluateUntil(until, doc, varCtx) {
			t.Error("expected until to pass")
		}
	})

	t.Run("not all pass", func(t *testing.T) {
		doc := map[string]interface{}{
			"response": map[string]interface{}{
				"body": map[string]interface{}{"status": "pending"},
			},
		}
		until := []Assertion{
			{Path: "$.response.body.status", Operator: "eq", Value: "done"},
		}
		if evaluateUntil(until, doc, varCtx) {
			t.Error("expected until to fail")
		}
	})

	t.Run("empty until returns false", func(t *testing.T) {
		if evaluateUntil(nil, nil, varCtx) {
			t.Error("expected empty until to return false")
		}
	})
}

func TestSetLoopResult(t *testing.T) {
	t.Run("no-op when name is empty", func(t *testing.T) {
		varCtx := NewVariableContext()
		snapshot := varCtx.Snapshot()
		setLoopResult(varCtx, "", true, 5)
		after := varCtx.Snapshot()
		if len(after) != len(snapshot) {
			t.Error("expected no new variables to be set when name is empty")
		}
	})

	t.Run("sets completed and iterations", func(t *testing.T) {
		varCtx := NewVariableContext()
		setLoopResult(varCtx, "myLoop", true, 3)

		v, _ := varCtx.ResolveTyped("{{myLoop}}")
		m, ok := v.(map[string]interface{})
		if !ok {
			t.Fatalf("expected map, got %T", v)
		}
		if m["completed"] != true {
			t.Errorf("expected completed=true, got %v", m["completed"])
		}
		if m["iterations"] != float64(3) {
			t.Errorf("expected iterations=3, got %v", m["iterations"])
		}
	})

	t.Run("preserves existing meta-variables", func(t *testing.T) {
		varCtx := NewVariableContext()
		varCtx.Set("myLoop", map[string]interface{}{
			"index": float64(2),
			"items": []interface{}{"a", "b", "c"},
		})
		setLoopResult(varCtx, "myLoop", false, 3)

		v, _ := varCtx.ResolveTyped("{{myLoop}}")
		m := v.(map[string]interface{})
		if m["index"] != float64(2) {
			t.Errorf("expected index preserved as 2, got %v", m["index"])
		}
		if m["completed"] != false {
			t.Errorf("expected completed=false, got %v", m["completed"])
		}
	})

	t.Run("creates new map instead of mutating", func(t *testing.T) {
		varCtx := NewVariableContext()
		original := map[string]interface{}{"index": float64(0)}
		varCtx.Set("loop", original)
		setLoopResult(varCtx, "loop", true, 1)

		if _, ok := original["completed"]; ok {
			t.Error("original map was mutated — setLoopResult should create a new map")
		}
	})
}

func TestBuildIterationPlan(t *testing.T) {
	t.Run("forEach builds iterations from items", func(t *testing.T) {
		varCtx := NewVariableContext()
		forEach := &ForEachLoop{
			Items:   []interface{}{"alice", "bob"},
			As:      "user",
			Name:    "userLoop",
			DelayMs: 100,
		}
		plan, err := buildIterationPlan(forEach, nil, nil, varCtx)
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if len(plan.Iterations) != 2 {
			t.Fatalf("expected 2 iterations, got %d", len(plan.Iterations))
		}
		if plan.DelayMs != 100 {
			t.Errorf("expected delayMs=100, got %d", plan.DelayMs)
		}
		if plan.LoopName != "userLoop" {
			t.Errorf("expected loopName=userLoop, got %q", plan.LoopName)
		}
		if plan.Repeat != nil {
			t.Error("expected Repeat to be nil for forEach")
		}
		if plan.Iterations[0].Label != "[user=alice]" {
			t.Errorf("expected label [user=alice], got %q", plan.Iterations[0].Label)
		}
	})

	t.Run("for builds iterations from range", func(t *testing.T) {
		varCtx := NewVariableContext()
		forLoop := &ForLoop{From: 1, To: 3, As: "i", Name: "counter"}
		plan, err := buildIterationPlan(nil, forLoop, nil, varCtx)
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if len(plan.Iterations) != 3 {
			t.Fatalf("expected 3 iterations, got %d", len(plan.Iterations))
		}
		if plan.LoopName != "counter" {
			t.Errorf("expected loopName=counter, got %q", plan.LoopName)
		}
		if plan.Iterations[0].Label != "[i=1]" {
			t.Errorf("expected label [i=1], got %q", plan.Iterations[0].Label)
		}
	})

	t.Run("repeat builds iterations from count", func(t *testing.T) {
		varCtx := NewVariableContext()
		repeat := &RepeatLoop{Count: 3, As: "attempt", Name: "retry"}
		plan, err := buildIterationPlan(nil, nil, repeat, varCtx)
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if len(plan.Iterations) != 3 {
			t.Fatalf("expected 3 iterations, got %d", len(plan.Iterations))
		}
		if plan.Repeat != repeat {
			t.Error("expected Repeat to be set for repeat loops")
		}
		if plan.Iterations[2].Label != "[attempt=2]" {
			t.Errorf("expected label [attempt=2], got %q", plan.Iterations[2].Label)
		}
	})

	t.Run("all nil returns empty plan", func(t *testing.T) {
		varCtx := NewVariableContext()
		plan, err := buildIterationPlan(nil, nil, nil, varCtx)
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if len(plan.Iterations) != 0 {
			t.Errorf("expected 0 iterations, got %d", len(plan.Iterations))
		}
	})

	t.Run("setupFn sets variables correctly", func(t *testing.T) {
		varCtx := NewVariableContext()
		forEach := &ForEachLoop{
			Items: []interface{}{"x", "y"},
			As:    "val",
		}
		plan, _ := buildIterationPlan(forEach, nil, nil, varCtx)
		plan.Iterations[1].SetupFn()

		v, _ := varCtx.ResolveTyped("{{val}}")
		if v != "y" {
			t.Errorf("expected val=y after setupFn, got %v", v)
		}
	})
}

func TestRunLoop(t *testing.T) {
	t.Run("executes all iterations and calls setLoopResult", func(t *testing.T) {
		varCtx := NewVariableContext()
		plan := IterationPlan{
			Iterations: []Iteration{
				{Label: "[i=0]", SetupFn: func() { varCtx.Set("i", float64(0)) }},
				{Label: "[i=1]", SetupFn: func() { varCtx.Set("i", float64(1)) }},
				{Label: "[i=2]", SetupFn: func() { varCtx.Set("i", float64(2)) }},
			},
			LoopName: "counter",
		}

		var calls []int
		result, err := runLoop(plan, varCtx, func(iterIdx int, iter Iteration) (map[string]interface{}, error) {
			iter.SetupFn()
			calls = append(calls, iterIdx)
			return nil, nil
		})
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if len(calls) != 3 {
			t.Errorf("expected 3 calls, got %d", len(calls))
		}
		if result.IterationsRan != 3 {
			t.Errorf("expected iterationsRan=3, got %d", result.IterationsRan)
		}
		if !result.Completed {
			t.Error("expected completed=true")
		}

		v, _ := varCtx.ResolveTyped("{{counter}}")
		m := v.(map[string]interface{})
		if m["completed"] != true {
			t.Error("expected setLoopResult to set completed=true")
		}
	})

	t.Run("stops on body error", func(t *testing.T) {
		varCtx := NewVariableContext()
		plan := IterationPlan{
			Iterations: []Iteration{
				{Label: "a", SetupFn: func() {}},
				{Label: "b", SetupFn: func() {}},
				{Label: "c", SetupFn: func() {}},
			},
			LoopName: "test",
		}

		var calls int
		result, err := runLoop(plan, varCtx, func(iterIdx int, iter Iteration) (map[string]interface{}, error) {
			iter.SetupFn()
			calls++
			if iterIdx == 1 {
				return nil, fmt.Errorf("boom")
			}
			return nil, nil
		})
		if err == nil {
			t.Fatal("expected error")
		}
		if calls != 2 {
			t.Errorf("expected 2 calls (stopped on error), got %d", calls)
		}
		if result.IterationsRan != 1 {
			t.Errorf("expected iterationsRan=1 (error before increment), got %d", result.IterationsRan)
		}
	})

	t.Run("repeat until stops loop early", func(t *testing.T) {
		varCtx := NewVariableContext()
		plan := IterationPlan{
			Iterations: []Iteration{
				{Label: "[0]", SetupFn: func() {}},
				{Label: "[1]", SetupFn: func() {}},
				{Label: "[2]", SetupFn: func() {}},
			},
			LoopName: "poll",
			Repeat: &RepeatLoop{
				Count: 3,
				As:    "attempt",
				Until: []Assertion{
					{Path: "$.response.status", Operator: "eq", Value: float64(200)},
				},
			},
		}

		var calls int
		result, err := runLoop(plan, varCtx, func(iterIdx int, iter Iteration) (map[string]interface{}, error) {
			iter.SetupFn()
			calls++
			status := float64(500)
			if iterIdx == 1 {
				status = float64(200)
			}
			return map[string]interface{}{"statusCode": status}, nil
		})
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if calls != 2 {
			t.Errorf("expected 2 calls (until met at idx 1), got %d", calls)
		}
		if result.IterationsRan != 2 {
			t.Errorf("expected iterationsRan=2, got %d", result.IterationsRan)
		}
		if !result.Completed {
			t.Error("expected completed=true when until triggers")
		}
	})

	t.Run("repeat until not met sets completed=false", func(t *testing.T) {
		varCtx := NewVariableContext()
		plan := IterationPlan{
			Iterations: []Iteration{
				{Label: "[0]", SetupFn: func() {}},
				{Label: "[1]", SetupFn: func() {}},
			},
			LoopName: "poll",
			Repeat: &RepeatLoop{
				Count: 2,
				As:    "attempt",
				Until: []Assertion{
					{Path: "$.response.status", Operator: "eq", Value: float64(200)},
				},
			},
		}

		result, err := runLoop(plan, varCtx, func(iterIdx int, iter Iteration) (map[string]interface{}, error) {
			iter.SetupFn()
			return map[string]interface{}{"statusCode": float64(500)}, nil
		})
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if result.Completed {
			t.Error("expected completed=false when until never triggers")
		}
	})

	t.Run("empty plan runs zero iterations", func(t *testing.T) {
		varCtx := NewVariableContext()
		plan := IterationPlan{LoopName: "empty"}

		var calls int
		result, err := runLoop(plan, varCtx, func(iterIdx int, iter Iteration) (map[string]interface{}, error) {
			iter.SetupFn()
			calls++
			return nil, nil
		})
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if calls != 0 {
			t.Errorf("expected 0 calls, got %d", calls)
		}
		if result.IterationsRan != 0 {
			t.Errorf("expected iterationsRan=0, got %d", result.IterationsRan)
		}
	})
}

// ── Audit finding #1: $.path items correctly rejected at runtime (validator now catches this earlier) ──

func TestBuildIterationPlan_DocPathItemsFailWithNilRootCtx(t *testing.T) {
	varCtx := NewVariableContext()
	forEach := &ForEachLoop{
		Items: "$.response.body.users",
		As:    "user",
	}

	// buildIterationPlan passes nil rootCtx, so $.path items are correctly
	// rejected. The TS validator now also rejects $.path at non-assertion
	// levels, so this error should never reach the Go runtime in practice.
	_, err := buildIterationPlan(forEach, nil, nil, varCtx)
	if err == nil {
		t.Error("expected error for $.path items with nil rootCtx")
	}
}

// ── Audit finding #3: UI sub-step position encoding ──

func TestSubStepPositionEncoding_NoCollisions(t *testing.T) {
	encode := func(subStepIndex, iterIdx, j int) int {
		return subStepIndex*100_000_000 + iterIdx*10_000 + j
	}

	t.Run("10000 sub-steps fits within iteration slot", func(t *testing.T) {
		a := encode(0, 0, 9999) // group 0, iter 0, last sub-step
		b := encode(0, 1, 0)    // group 0, iter 1, first sub-step
		if a >= b {
			t.Errorf("position collision: (group=0, iter=0, j=9999) = %d >= (group=0, iter=1, j=0) = %d", a, b)
		}
	})

	t.Run("10000 iterations fits within group slot", func(t *testing.T) {
		a := encode(0, 9999, 9999) // group 0, last iter, last sub-step
		b := encode(1, 0, 0)       // group 1, first iter, first sub-step
		if a >= b {
			t.Errorf("position collision: (group=0, iter=9999, j=9999) = %d >= (group=1, iter=0, j=0) = %d", a, b)
		}
	})
}

// ── Audit finding #4: forEach loop variables cleaned up after block completes ──

func TestStepValidator_ForEachVarsCleanedUpBetweenBlocks(t *testing.T) {
	varCtx := NewVariableContext()
	logBuffer := NewStepLogBuffer()
	sv := NewStepValidator(logBuffer, varCtx)

	// Step with two assertion blocks:
	//   Block 0: forEach over ["alice","bob"], asserts {{item}} exists (passes)
	//   Block 1: no forEach, asserts {{item}} equals "leaked" — should fail
	//            because {{item}} must not leak from block 0
	step := TestStep{
		Action: StepAction{Type: "wait"},
		Assertions: []AssertionBlock{
			{
				ForEach: &ForEachLoop{
					Items: []interface{}{"alice", "bob"},
					As:    "item",
				},
				Assertions: []Assertion{
					{Path: "$.variables.item", Operator: "exists"},
				},
			},
			{
				Assertions: []Assertion{
					{Path: "$.variables.item", Operator: "eq", Value: "leaked"},
				},
			},
		},
	}

	stepExec := StepExecution{StepIndex: 0}
	results, _ := sv.validateStep(step, stepExec, nil)

	// Block 1's assertion should fail because {{item}} was cleaned up.
	// If it passes with value "bob" (the last forEach iteration), the leak is proven.
	for _, r := range results {
		if r.Path == "$.variables.item" && r.Operator == "eq" && r.Passed {
			t.Error("Bug #4: forEach variable {{item}} leaked from block 0 into block 1 — " +
				"block 1 matched the last iteration value instead of failing")
		}
	}
}

// ── Audit finding #5: completed=true returned alongside errors for non-repeat loops ──

func TestRunLoop_CompletedShouldBeFalseOnBodyError(t *testing.T) {
	varCtx := NewVariableContext()
	plan := IterationPlan{
		Iterations: []Iteration{
			{Label: "a", SetupFn: func() {}},
			{Label: "b", SetupFn: func() {}},
			{Label: "c", SetupFn: func() {}},
		},
		LoopName: "test",
	}

	result, err := runLoop(plan, varCtx, func(iterIdx int, iter Iteration) (map[string]interface{}, error) {
		iter.SetupFn()
		if iterIdx == 1 {
			return nil, fmt.Errorf("boom")
		}
		return nil, nil
	})
	if err == nil {
		t.Fatal("expected error from body")
	}
	if result.Completed {
		t.Error("Bug #5: completed should be false when loop body returns an error, got true")
	}
}

func TestValueToString(t *testing.T) {
	tests := []struct {
		input    interface{}
		expected string
	}{
		{"hello", "hello"},
		{float64(42), "42"},
		{float64(3.14), "3.14"},
		{true, "true"},
		{nil, ""},
	}
	for _, tt := range tests {
		result := valueToString(tt.input)
		if result != tt.expected {
			t.Errorf("valueToString(%v) = %q, want %q", tt.input, result, tt.expected)
		}
	}
}
