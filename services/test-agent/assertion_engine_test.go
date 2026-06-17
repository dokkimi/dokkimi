package main

import (
	"strings"
	"testing"
)

func TestEvaluateDocPath(t *testing.T) {
	doc := map[string]interface{}{
		"response": map[string]interface{}{
			"status": float64(200),
			"header": map[string]interface{}{
				"content-type": "application/json",
				"X-Request-Id": "abc",
			},
			"body": map[string]interface{}{
				"users": []interface{}{
					map[string]interface{}{"name": "Alice", "email": "alice@test.com"},
					map[string]interface{}{"name": "Bob", "email": "bob@test.com"},
				},
				"count":  float64(2),
				"nested": map[string]interface{}{"deep": map[string]interface{}{"value": float64(42)}},
			},
		},
		"request":      map[string]interface{}{"method": "GET", "url": "/users"},
		"responseTime": float64(150),
	}

	t.Run("resolves a top-level key", func(t *testing.T) {
		result, found := EvaluateDocPath(doc, "responseTime")
		if !found || result != float64(150) {
			t.Errorf("expected 150, got %v (found=%v)", result, found)
		}
	})

	t.Run("resolves a nested dotted path", func(t *testing.T) {
		result, found := EvaluateDocPath(doc, "response.status")
		if !found || result != float64(200) {
			t.Errorf("expected 200, got %v (found=%v)", result, found)
		}
	})

	t.Run("resolves deeply nested path", func(t *testing.T) {
		result, found := EvaluateDocPath(doc, "response.body.nested.deep.value")
		if !found || result != float64(42) {
			t.Errorf("expected 42, got %v (found=%v)", result, found)
		}
	})

	t.Run("resolves array index", func(t *testing.T) {
		result, found := EvaluateDocPath(doc, "response.body.users[0].name")
		if !found || result != "Alice" {
			t.Errorf("expected Alice, got %v (found=%v)", result, found)
		}
		result2, found2 := EvaluateDocPath(doc, "response.body.users[1].email")
		if !found2 || result2 != "bob@test.com" {
			t.Errorf("expected bob@test.com, got %v (found=%v)", result2, found2)
		}
	})

	t.Run("returns not-found for out-of-bounds array index", func(t *testing.T) {
		_, found := EvaluateDocPath(doc, "response.body.users[5].name")
		if found {
			t.Error("expected not found")
		}
	})

	t.Run("returns not-found for array index on non-array", func(t *testing.T) {
		_, found := EvaluateDocPath(doc, "response.status[0]")
		if found {
			t.Error("expected not found")
		}
	})

	t.Run("returns not-found for missing path", func(t *testing.T) {
		_, found := EvaluateDocPath(doc, "response.missing.field")
		if found {
			t.Error("expected not found")
		}
	})

	t.Run("returns not-found for empty path", func(t *testing.T) {
		_, found := EvaluateDocPath(doc, "")
		if found {
			t.Error("expected not found")
		}
	})

	t.Run("returns not-found for nil doc", func(t *testing.T) {
		_, found := EvaluateDocPath(nil, "foo")
		if found {
			t.Error("expected not found")
		}
	})

	t.Run("strips JSONPath root prefix $.", func(t *testing.T) {
		result, found := EvaluateDocPath(doc, "$.responseTime")
		if !found || result != float64(150) {
			t.Errorf("expected 150, got %v (found=%v)", result, found)
		}
		result2, found2 := EvaluateDocPath(doc, "$.response.body.count")
		if !found2 || result2 != float64(2) {
			t.Errorf("expected 2, got %v (found=%v)", result2, found2)
		}
	})

	t.Run("handles case-insensitive key fallback", func(t *testing.T) {
		result, found := EvaluateDocPath(doc, "response.header.x-request-id")
		if !found || result != "abc" {
			t.Errorf("expected abc, got %v (found=%v)", result, found)
		}
		result2, found2 := EvaluateDocPath(doc, "response.header.Content-Type")
		if !found2 || result2 != "application/json" {
			t.Errorf("expected application/json, got %v (found=%v)", result2, found2)
		}
	})

	t.Run("returns not-found for unclosed bracket", func(t *testing.T) {
		_, found := EvaluateDocPath(doc, "response.body.users[0")
		if found {
			t.Error("expected not found")
		}
	})

	t.Run("returns not-found through null intermediate", func(t *testing.T) {
		d := map[string]interface{}{"a": map[string]interface{}{"b": nil}}
		_, found := EvaluateDocPath(d, "a.b.c")
		if found {
			t.Error("expected not found")
		}
	})

	t.Run("returns found with nil for terminal null value", func(t *testing.T) {
		d := map[string]interface{}{"a": map[string]interface{}{"b": nil}}
		result, found := EvaluateDocPath(d, "a.b")
		if !found {
			t.Error("expected found=true for terminal null")
		}
		if result != nil {
			t.Errorf("expected nil value, got %v", result)
		}
	})

	t.Run("returns not-found for non-object intermediate (primitive)", func(t *testing.T) {
		d := map[string]interface{}{"a": "hello"}
		_, found := EvaluateDocPath(d, "a.b")
		if found {
			t.Error("expected not found")
		}
	})
}

func TestCompareValues(t *testing.T) {
	t.Run("eq passes for equal numbers", func(t *testing.T) {
		r := CompareValues("eq", float64(200), float64(200))
		if !r.Passed {
			t.Error("expected pass")
		}
	})

	t.Run("eq fails for unequal numbers", func(t *testing.T) {
		r := CompareValues("eq", float64(200), float64(404))
		if r.Passed {
			t.Error("expected fail")
		}
	})

	t.Run("eq is case-sensitive for strings", func(t *testing.T) {
		r := CompareValues("eq", "Hello", "hello")
		if r.Passed {
			t.Error("expected fail for case mismatch")
		}
	})

	t.Run("eq coerces numeric strings for cross-type comparison", func(t *testing.T) {
		r := CompareValues("eq", float64(1), "1")
		if !r.Passed {
			t.Error("expected pass for numeric string vs float64")
		}
	})

	t.Run("eq fails for genuinely different types", func(t *testing.T) {
		r := CompareValues("eq", float64(1), "one")
		if r.Passed {
			t.Error("expected fail for non-numeric string vs float64")
		}
	})

	t.Run("eqIgnoreCase passes for case-mismatched strings", func(t *testing.T) {
		r := CompareValues("eqIgnoreCase", "Hello", "hello")
		if !r.Passed {
			t.Error("expected pass")
		}
	})

	t.Run("eqIgnoreCase fails for different strings", func(t *testing.T) {
		r := CompareValues("eqIgnoreCase", "Hello", "world")
		if r.Passed {
			t.Error("expected fail")
		}
	})

	t.Run("ne passes for unequal values", func(t *testing.T) {
		r := CompareValues("ne", float64(200), float64(404))
		if !r.Passed {
			t.Error("expected pass")
		}
	})

	t.Run("ne fails for equal values", func(t *testing.T) {
		r := CompareValues("ne", float64(200), float64(200))
		if r.Passed {
			t.Error("expected fail")
		}
	})

	t.Run("ne passes for case-mismatched strings", func(t *testing.T) {
		r := CompareValues("ne", "Hello", "hello")
		if !r.Passed {
			t.Error("expected pass for case mismatch")
		}
	})

	t.Run("gt passes when actual > expected", func(t *testing.T) {
		r := CompareValues("gt", float64(10), float64(5))
		if !r.Passed {
			t.Error("expected pass")
		}
	})

	t.Run("gt fails when actual == expected", func(t *testing.T) {
		r := CompareValues("gt", float64(5), float64(5))
		if r.Passed {
			t.Error("expected fail")
		}
	})

	t.Run("gte passes when actual == expected", func(t *testing.T) {
		r := CompareValues("gte", float64(5), float64(5))
		if !r.Passed {
			t.Error("expected pass")
		}
	})

	t.Run("lt passes when actual < expected", func(t *testing.T) {
		r := CompareValues("lt", float64(3), float64(5))
		if !r.Passed {
			t.Error("expected pass")
		}
	})

	t.Run("lte passes when actual == expected", func(t *testing.T) {
		r := CompareValues("lte", float64(5), float64(5))
		if !r.Passed {
			t.Error("expected pass")
		}
	})

	t.Run("lte fails when actual > expected", func(t *testing.T) {
		r := CompareValues("lte", float64(6), float64(5))
		if r.Passed {
			t.Error("expected fail")
		}
	})

	t.Run("contains passes for exact case substring match", func(t *testing.T) {
		r := CompareValues("contains", "Hello World", "Hello")
		if !r.Passed {
			t.Error("expected pass")
		}
	})

	t.Run("contains fails for case mismatch", func(t *testing.T) {
		r := CompareValues("contains", "Hello World", "hello")
		if r.Passed {
			t.Error("expected fail")
		}
	})

	t.Run("contains fails when substring not present", func(t *testing.T) {
		r := CompareValues("contains", "Hello", "xyz")
		if r.Passed {
			t.Error("expected fail")
		}
	})

	t.Run("notContains passes when substring not present", func(t *testing.T) {
		r := CompareValues("notContains", "Hello", "xyz")
		if !r.Passed {
			t.Error("expected pass")
		}
	})

	t.Run("notContains fails for exact case substring match", func(t *testing.T) {
		r := CompareValues("notContains", "Hello World", "World")
		if r.Passed {
			t.Error("expected fail")
		}
	})

	t.Run("notContains passes for case mismatch", func(t *testing.T) {
		r := CompareValues("notContains", "Hello World", "world")
		if !r.Passed {
			t.Error("expected pass")
		}
	})

	t.Run("containsIgnoreCase passes for case-insensitive match", func(t *testing.T) {
		r := CompareValues("containsIgnoreCase", "Hello World", "hello")
		if !r.Passed {
			t.Error("expected pass")
		}
	})

	t.Run("containsIgnoreCase fails when substring not present", func(t *testing.T) {
		r := CompareValues("containsIgnoreCase", "Hello", "xyz")
		if r.Passed {
			t.Error("expected fail")
		}
	})

	t.Run("notContainsIgnoreCase passes when substring not present", func(t *testing.T) {
		r := CompareValues("notContainsIgnoreCase", "Hello", "xyz")
		if !r.Passed {
			t.Error("expected pass")
		}
	})

	t.Run("notContainsIgnoreCase fails for case-insensitive match", func(t *testing.T) {
		r := CompareValues("notContainsIgnoreCase", "Hello World", "world")
		if r.Passed {
			t.Error("expected fail")
		}
	})

	t.Run("matches passes for matching regex", func(t *testing.T) {
		r := CompareValues("matches", "abc123", "\\d+")
		if !r.Passed {
			t.Error("expected pass")
		}
	})

	t.Run("matches fails for non-matching regex", func(t *testing.T) {
		r := CompareValues("matches", "abcdef", "^\\d+$")
		if r.Passed {
			t.Error("expected fail")
		}
	})

	t.Run("matches returns error for invalid regex", func(t *testing.T) {
		r := CompareValues("matches", "test", "[invalid")
		if r.Passed {
			t.Error("expected fail")
		}
		if !strings.Contains(r.Error, "Invalid regex pattern") {
			t.Errorf("expected error about invalid regex, got: %s", r.Error)
		}
	})

	t.Run("in passes when value is in array", func(t *testing.T) {
		r := CompareValues("in", "a", []interface{}{"a", "b", "c"})
		if !r.Passed {
			t.Error("expected pass")
		}
	})

	t.Run("in fails when value is not in array", func(t *testing.T) {
		r := CompareValues("in", "z", []interface{}{"a", "b", "c"})
		if r.Passed {
			t.Error("expected fail")
		}
	})

	t.Run("in fails when expected is not an array", func(t *testing.T) {
		r := CompareValues("in", "a", "a")
		if r.Passed {
			t.Error("expected fail")
		}
	})

	t.Run("notIn passes when value is not in array", func(t *testing.T) {
		r := CompareValues("notIn", "z", []interface{}{"a", "b"})
		if !r.Passed {
			t.Error("expected pass")
		}
	})

	t.Run("notIn fails when value is in array", func(t *testing.T) {
		r := CompareValues("notIn", "a", []interface{}{"a", "b"})
		if r.Passed {
			t.Error("expected fail")
		}
	})

	t.Run("type detects string type", func(t *testing.T) {
		r := CompareValues("type", "hello", "string")
		if !r.Passed {
			t.Error("expected pass")
		}
	})

	t.Run("type detects number type", func(t *testing.T) {
		r := CompareValues("type", float64(42), "number")
		if !r.Passed {
			t.Error("expected pass")
		}
	})

	t.Run("type detects array type", func(t *testing.T) {
		r := CompareValues("type", []interface{}{float64(1), float64(2)}, "array")
		if !r.Passed {
			t.Error("expected pass")
		}
	})

	t.Run("type detects object type", func(t *testing.T) {
		r := CompareValues("type", map[string]interface{}{"a": float64(1)}, "object")
		if !r.Passed {
			t.Error("expected pass")
		}
	})

	t.Run("type fails for mismatched type", func(t *testing.T) {
		r := CompareValues("type", "hello", "number")
		if r.Passed {
			t.Error("expected fail")
		}
	})

	t.Run("length passes for correct array length", func(t *testing.T) {
		r := CompareValues("length", []interface{}{float64(1), float64(2), float64(3)}, float64(3))
		if !r.Passed {
			t.Error("expected pass")
		}
	})

	t.Run("length passes for correct string length", func(t *testing.T) {
		r := CompareValues("length", "hello", float64(5))
		if !r.Passed {
			t.Error("expected pass")
		}
	})

	t.Run("length fails for wrong length", func(t *testing.T) {
		r := CompareValues("length", []interface{}{float64(1), float64(2)}, float64(5))
		if r.Passed {
			t.Error("expected fail")
		}
	})

	t.Run("length fails for non-array/non-string", func(t *testing.T) {
		r := CompareValues("length", float64(42), float64(2))
		if r.Passed {
			t.Error("expected fail")
		}
	})

	t.Run("arrayContains passes when item present", func(t *testing.T) {
		r := CompareValues("arrayContains", []interface{}{float64(1), float64(2), float64(3)}, float64(2))
		if !r.Passed {
			t.Error("expected pass")
		}
	})

	t.Run("arrayContains fails when item missing", func(t *testing.T) {
		r := CompareValues("arrayContains", []interface{}{float64(1), float64(2), float64(3)}, float64(5))
		if r.Passed {
			t.Error("expected fail")
		}
	})

	t.Run("arrayContains fails for non-array", func(t *testing.T) {
		r := CompareValues("arrayContains", "not-array", "a")
		if r.Passed {
			t.Error("expected fail")
		}
		if r.Error != "Value is not an array" {
			t.Errorf("expected 'Value is not an array', got %s", r.Error)
		}
	})

	t.Run("arrayNotContains passes when item missing", func(t *testing.T) {
		r := CompareValues("arrayNotContains", []interface{}{float64(1), float64(2)}, float64(5))
		if !r.Passed {
			t.Error("expected pass")
		}
	})

	t.Run("arrayNotContains fails when item present", func(t *testing.T) {
		r := CompareValues("arrayNotContains", []interface{}{float64(1), float64(2)}, float64(2))
		if r.Passed {
			t.Error("expected fail")
		}
	})

	t.Run("arrayNotContains fails for non-array", func(t *testing.T) {
		r := CompareValues("arrayNotContains", "not-array", "a")
		if r.Passed {
			t.Error("expected fail")
		}
		if r.Error != "Value is not an array" {
			t.Errorf("expected 'Value is not an array', got %s", r.Error)
		}
	})

	t.Run("isEmpty passes for nil", func(t *testing.T) {
		r := CompareValues("isEmpty", nil, nil)
		if !r.Passed {
			t.Error("expected pass")
		}
	})

	t.Run("isEmpty passes for empty array", func(t *testing.T) {
		r := CompareValues("isEmpty", []interface{}{}, nil)
		if !r.Passed {
			t.Error("expected pass")
		}
	})

	t.Run("isEmpty passes for empty object", func(t *testing.T) {
		r := CompareValues("isEmpty", map[string]interface{}{}, nil)
		if !r.Passed {
			t.Error("expected pass")
		}
	})

	t.Run("isEmpty fails for non-empty string", func(t *testing.T) {
		r := CompareValues("isEmpty", "hello", nil)
		if r.Passed {
			t.Error("expected fail")
		}
	})

	t.Run("isEmpty fails for non-empty array", func(t *testing.T) {
		r := CompareValues("isEmpty", []interface{}{float64(1)}, nil)
		if r.Passed {
			t.Error("expected fail")
		}
	})

	t.Run("notEmpty passes for non-empty array", func(t *testing.T) {
		r := CompareValues("notEmpty", []interface{}{float64(1), float64(2)}, nil)
		if !r.Passed {
			t.Error("expected pass")
		}
	})

	t.Run("notEmpty fails for nil", func(t *testing.T) {
		r := CompareValues("notEmpty", nil, nil)
		if r.Passed {
			t.Error("expected fail")
		}
	})

	t.Run("notEmpty fails for empty object", func(t *testing.T) {
		r := CompareValues("notEmpty", map[string]interface{}{}, nil)
		if r.Passed {
			t.Error("expected fail")
		}
	})

	t.Run("returns error for unknown operator", func(t *testing.T) {
		r := CompareValues("unknownOp", float64(1), float64(1))
		if r.Passed {
			t.Error("expected fail")
		}
		if !strings.Contains(r.Error, "Unknown operator") {
			t.Errorf("expected Unknown operator error, got: %s", r.Error)
		}
	})
}

func TestValidateAssertion(t *testing.T) {
	doc := map[string]interface{}{
		"response": map[string]interface{}{
			"status": float64(200),
			"body":   map[string]interface{}{"name": "Alice"},
		},
	}

	t.Run("validates exists for present value", func(t *testing.T) {
		r := ValidateAssertion(Assertion{Path: "response.status", Operator: "exists"}, doc)
		if !r.Passed {
			t.Error("expected pass")
		}
		if r.Actual != "exists" {
			t.Errorf("expected actual 'exists', got %v", r.Actual)
		}
	})

	t.Run("validates exists for null value", func(t *testing.T) {
		nullDoc := map[string]interface{}{
			"response": map[string]interface{}{"status": nil},
		}
		r := ValidateAssertion(Assertion{Path: "response.status", Operator: "exists"}, nullDoc)
		if r.Passed {
			t.Error("expected fail for null value")
		}
	})

	t.Run("validates exists for missing value", func(t *testing.T) {
		r := ValidateAssertion(Assertion{Path: "response.missing", Operator: "exists"}, doc)
		if r.Passed {
			t.Error("expected fail")
		}
		if r.Actual != "not found" {
			t.Errorf("expected actual 'not found', got %v", r.Actual)
		}
	})

	t.Run("validates notExists for missing value", func(t *testing.T) {
		r := ValidateAssertion(Assertion{Path: "response.missing", Operator: "notExists"}, doc)
		if !r.Passed {
			t.Error("expected pass")
		}
	})

	t.Run("validates notExists for null value", func(t *testing.T) {
		nullDoc := map[string]interface{}{
			"response": map[string]interface{}{"status": nil},
		}
		r := ValidateAssertion(Assertion{Path: "response.status", Operator: "notExists"}, nullDoc)
		if !r.Passed {
			t.Error("expected pass for null value")
		}
	})

	t.Run("validates notExists fails for present value", func(t *testing.T) {
		r := ValidateAssertion(Assertion{Path: "response.status", Operator: "notExists"}, doc)
		if r.Passed {
			t.Error("expected fail")
		}
		if r.Actual != "exists" {
			t.Errorf("expected actual 'exists', got %v", r.Actual)
		}
	})

	t.Run("returns error when path not found and operator is not exists/notExists", func(t *testing.T) {
		r := ValidateAssertion(Assertion{Path: "response.missing", Operator: "eq", Value: float64(200)}, doc)
		if r.Passed {
			t.Error("expected fail")
		}
		if !strings.Contains(r.Error, "Path 'response.missing' not found") {
			t.Errorf("expected path not found error, got: %s", r.Error)
		}
	})

	t.Run("delegates to CompareValues for standard operators", func(t *testing.T) {
		r := ValidateAssertion(Assertion{Path: "response.status", Operator: "eq", Value: float64(200)}, doc)
		if !r.Passed {
			t.Error("expected pass")
		}
	})
}

func TestValidateCount(t *testing.T) {
	t.Run("eq passes for matching count", func(t *testing.T) {
		r := ValidateCount(3, CountAssertion{Operator: "eq", Value: 3})
		if !r.Passed {
			t.Error("expected pass")
		}
	})

	t.Run("eq fails for non-matching count", func(t *testing.T) {
		r := ValidateCount(2, CountAssertion{Operator: "eq", Value: 3})
		if r.Passed {
			t.Error("expected fail")
		}
	})

	t.Run("gte passes at boundary", func(t *testing.T) {
		r := ValidateCount(3, CountAssertion{Operator: "gte", Value: 3})
		if !r.Passed {
			t.Error("expected pass")
		}
	})

	t.Run("gte passes above boundary", func(t *testing.T) {
		r := ValidateCount(5, CountAssertion{Operator: "gte", Value: 3})
		if !r.Passed {
			t.Error("expected pass")
		}
	})

	t.Run("gte fails below boundary", func(t *testing.T) {
		r := ValidateCount(2, CountAssertion{Operator: "gte", Value: 3})
		if r.Passed {
			t.Error("expected fail")
		}
	})

	t.Run("lte passes at boundary", func(t *testing.T) {
		r := ValidateCount(3, CountAssertion{Operator: "lte", Value: 3})
		if !r.Passed {
			t.Error("expected pass")
		}
	})

	t.Run("gt passes above boundary", func(t *testing.T) {
		r := ValidateCount(4, CountAssertion{Operator: "gt", Value: 3})
		if !r.Passed {
			t.Error("expected pass")
		}
	})

	t.Run("gt fails at boundary", func(t *testing.T) {
		r := ValidateCount(3, CountAssertion{Operator: "gt", Value: 3})
		if r.Passed {
			t.Error("expected fail")
		}
	})

	t.Run("lt passes below boundary", func(t *testing.T) {
		r := ValidateCount(2, CountAssertion{Operator: "lt", Value: 3})
		if !r.Passed {
			t.Error("expected pass")
		}
	})

	t.Run("lt fails at boundary", func(t *testing.T) {
		r := ValidateCount(3, CountAssertion{Operator: "lt", Value: 3})
		if r.Passed {
			t.Error("expected fail")
		}
	})

	t.Run("returns error for unknown operator", func(t *testing.T) {
		r := ValidateCount(1, CountAssertion{Operator: "xxx", Value: 1})
		if r.Passed {
			t.Error("expected fail")
		}
		if !strings.Contains(r.Error, "Unknown operator") {
			t.Errorf("expected Unknown operator error, got: %s", r.Error)
		}
	})
}

func TestResolveExtractRule(t *testing.T) {
	doc := map[string]interface{}{
		"response": map[string]interface{}{
			"body":   map[string]interface{}{"id": float64(123), "message": "User created: id=456"},
			"status": float64(200),
		},
	}

	t.Run("extracts typed numeric value", func(t *testing.T) {
		result, err := ResolveExtractRule(doc, "statusCode", ExtractRule{Path: "response.status"})
		if err != nil {
			t.Fatal(err)
		}
		if result != float64(200) {
			t.Errorf("expected 200, got %v", result)
		}
	})

	t.Run("extracts string value preserving type", func(t *testing.T) {
		d := map[string]interface{}{"name": "Alice"}
		result, err := ResolveExtractRule(d, "username", ExtractRule{Path: "name"})
		if err != nil {
			t.Fatal(err)
		}
		if result != "Alice" {
			t.Errorf("expected 'Alice', got '%v'", result)
		}
	})

	t.Run("extracts numeric value preserving type", func(t *testing.T) {
		result, err := ResolveExtractRule(doc, "bodyId", ExtractRule{Path: "response.body.id"})
		if err != nil {
			t.Fatal(err)
		}
		if result != float64(123) {
			t.Errorf("expected 123, got %v", result)
		}
	})

	t.Run("returns error when path not found", func(t *testing.T) {
		_, err := ResolveExtractRule(doc, "missing", ExtractRule{Path: "response.missing"})
		if err == nil {
			t.Fatal("expected error")
		}
		if !strings.Contains(err.Error(), "path 'response.missing' not found") {
			t.Errorf("expected path not found error, got: %s", err.Error())
		}
	})

	t.Run("extracts with regex pattern default group 1", func(t *testing.T) {
		result, err := ResolveExtractRule(doc, "userId", ExtractRule{
			Path:    "response.body.message",
			Pattern: `id=(\d+)`,
		})
		if err != nil {
			t.Fatal(err)
		}
		if result != "456" {
			t.Errorf("expected '456', got '%s'", result)
		}
	})

	t.Run("extracts with explicit capture group 0", func(t *testing.T) {
		group := 0
		result, err := ResolveExtractRule(doc, "match", ExtractRule{
			Path:    "response.body.message",
			Pattern: `id=\d+`,
			Group:   &group,
		})
		if err != nil {
			t.Fatal(err)
		}
		if result != "id=456" {
			t.Errorf("expected 'id=456', got '%s'", result)
		}
	})

	t.Run("returns error when regex pattern does not match", func(t *testing.T) {
		_, err := ResolveExtractRule(doc, "x", ExtractRule{
			Path:    "response.body.message",
			Pattern: `NOMATCH(\d+)`,
		})
		if err == nil {
			t.Fatal("expected error")
		}
		if !strings.Contains(err.Error(), "did not match") {
			t.Errorf("expected 'did not match' error, got: %s", err.Error())
		}
	})

	t.Run("returns error when capture group is out of range", func(t *testing.T) {
		group := 5
		_, err := ResolveExtractRule(doc, "x", ExtractRule{
			Path:    "response.body.message",
			Pattern: `id=(\d+)`,
			Group:   &group,
		})
		if err == nil {
			t.Fatal("expected error")
		}
		if !strings.Contains(err.Error(), "capture group 5 out of range") {
			t.Errorf("expected capture group error, got: %s", err.Error())
		}
	})

	t.Run("extracts object value preserving type", func(t *testing.T) {
		d := map[string]interface{}{
			"data": map[string]interface{}{
				"nested": map[string]interface{}{"a": float64(1)},
			},
		}
		result, err := ResolveExtractRule(d, "obj", ExtractRule{Path: "data.nested"})
		if err != nil {
			t.Fatal(err)
		}
		obj, ok := result.(map[string]interface{})
		if !ok {
			t.Fatalf("expected map, got %T", result)
		}
		if obj["a"] != float64(1) {
			t.Errorf("expected {a:1}, got %v", result)
		}
	})
}
