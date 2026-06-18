package main

import (
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
	varCtx := NewVariableContext()
	items := []interface{}{"alice", "bob"}
	setForEachVars(varCtx, "user", "alice", 0, items)

	if v, _ := varCtx.ResolveTyped("{{user}}"); v != "alice" {
		t.Errorf("expected alice, got %v", v)
	}
	if v, _ := varCtx.ResolveTyped("{{user.__index}}"); v != float64(0) {
		t.Errorf("expected 0, got %v", v)
	}
	if v, _ := varCtx.ResolveTyped("{{user.__items}}"); v == nil {
		t.Error("expected items array, got nil")
	}
}

func TestSetForVars(t *testing.T) {
	varCtx := NewVariableContext()
	setForVars(varCtx, "i", 5, 2)

	if v, _ := varCtx.ResolveTyped("{{i}}"); v != float64(5) {
		t.Errorf("expected 5, got %v", v)
	}
	if v, _ := varCtx.ResolveTyped("{{i.__index}}"); v != float64(2) {
		t.Errorf("expected 2, got %v", v)
	}
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
