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

	t.Run("resolves negative array index [-1]", func(t *testing.T) {
		result, found := EvaluateDocPath(doc, "response.body.users[-1].name")
		if !found || result != "Bob" {
			t.Errorf("expected Bob, got %v (found=%v)", result, found)
		}
	})
	t.Run("resolves negative array index [-2]", func(t *testing.T) {
		result, found := EvaluateDocPath(doc, "response.body.users[-2].name")
		if !found || result != "Alice" {
			t.Errorf("expected Alice, got %v (found=%v)", result, found)
		}
	})
	t.Run("returns not-found for negative out-of-bounds", func(t *testing.T) {
		_, found := EvaluateDocPath(doc, "response.body.users[-5].name")
		if found {
			t.Error("expected not found")
		}
	})
}

func TestEvaluateDocPath_RootContextPaths(t *testing.T) {
	rootCtx := map[string]interface{}{
		"variables": map[string]interface{}{
			"userId": float64(42),
			"nested": map[string]interface{}{"key": "val"},
		},
		"traffic": []interface{}{
			map[string]interface{}{
				"from": "client",
				"to":   "api",
				"request": map[string]interface{}{
					"method": "GET",
					"url":    "/users",
				},
			},
		},
		"consoleLogs": []interface{}{
			map[string]interface{}{
				"service": "api",
				"level":   "info",
				"message": "started",
			},
		},
		"dbLogs": []interface{}{
			map[string]interface{}{
				"database": "mydb",
				"query":    "SELECT 1",
			},
		},
		"timeline": []interface{}{
			map[string]interface{}{
				"type":      "httpTraffic",
				"timestamp": "2024-01-01T00:00:00Z",
			},
			map[string]interface{}{
				"type":      "dbQuery",
				"timestamp": "2024-01-01T00:00:01Z",
			},
		},
		"response": map[string]interface{}{
			"status": float64(200),
		},
	}

	t.Run("resolves $.variables.X", func(t *testing.T) {
		result, found := EvaluateDocPath(rootCtx, "variables.userId")
		if !found || result != float64(42) {
			t.Errorf("expected 42, got %v (found=%v)", result, found)
		}
	})

	t.Run("resolves $.variables.nested.key", func(t *testing.T) {
		result, found := EvaluateDocPath(rootCtx, "variables.nested.key")
		if !found || result != "val" {
			t.Errorf("expected val, got %v (found=%v)", result, found)
		}
	})

	t.Run("resolves $.traffic[0].to", func(t *testing.T) {
		result, found := EvaluateDocPath(rootCtx, "traffic[0].to")
		if !found || result != "api" {
			t.Errorf("expected api, got %v (found=%v)", result, found)
		}
	})

	t.Run("resolves $.consoleLogs[0].level", func(t *testing.T) {
		result, found := EvaluateDocPath(rootCtx, "consoleLogs[0].level")
		if !found || result != "info" {
			t.Errorf("expected info, got %v (found=%v)", result, found)
		}
	})

	t.Run("resolves $.dbLogs length via array index", func(t *testing.T) {
		result, found := EvaluateDocPath(rootCtx, "dbLogs[0].database")
		if !found || result != "mydb" {
			t.Errorf("expected mydb, got %v (found=%v)", result, found)
		}
	})

	t.Run("resolves $.timeline[0].type", func(t *testing.T) {
		result, found := EvaluateDocPath(rootCtx, "timeline[0].type")
		if !found || result != "httpTraffic" {
			t.Errorf("expected httpTraffic, got %v (found=%v)", result, found)
		}
	})

	t.Run("resolves $.timeline[1].type", func(t *testing.T) {
		result, found := EvaluateDocPath(rootCtx, "timeline[1].type")
		if !found || result != "dbQuery" {
			t.Errorf("expected dbQuery, got %v (found=%v)", result, found)
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

	t.Run("eq coerces string true to bool true", func(t *testing.T) {
		r := CompareValues("eq", "true", true)
		if !r.Passed {
			t.Error("expected pass for string 'true' vs bool true")
		}
	})

	t.Run("eq coerces string false to bool false", func(t *testing.T) {
		r := CompareValues("eq", false, "false")
		if !r.Passed {
			t.Error("expected pass for bool false vs string 'false'")
		}
	})

	t.Run("eq coerces string TRUE (case-insensitive) to bool true", func(t *testing.T) {
		r := CompareValues("eq", "TRUE", true)
		if !r.Passed {
			t.Error("expected pass for string 'TRUE' vs bool true")
		}
	})

	t.Run("eq fails for string true vs bool false", func(t *testing.T) {
		r := CompareValues("eq", "true", false)
		if r.Passed {
			t.Error("expected fail for string 'true' vs bool false")
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

	t.Run("contains passes for array element membership", func(t *testing.T) {
		r := CompareValues("contains", []interface{}{float64(1), float64(2), float64(3)}, float64(2))
		if !r.Passed {
			t.Error("expected pass")
		}
	})

	t.Run("contains fails for missing array element", func(t *testing.T) {
		r := CompareValues("contains", []interface{}{float64(1), float64(2)}, float64(5))
		if r.Passed {
			t.Error("expected fail")
		}
	})

	t.Run("contains passes for object key membership", func(t *testing.T) {
		r := CompareValues("contains", map[string]interface{}{"name": "Alice", "age": float64(30)}, "name")
		if !r.Passed {
			t.Error("expected pass")
		}
	})

	t.Run("contains errors on nil", func(t *testing.T) {
		r := CompareValues("contains", nil, "x")
		if r.Passed {
			t.Error("expected fail")
		}
		if r.Error == "" {
			t.Error("expected type error")
		}
	})

	t.Run("contains errors on number", func(t *testing.T) {
		r := CompareValues("contains", float64(42), "x")
		if r.Passed {
			t.Error("expected fail")
		}
		if r.Error == "" {
			t.Error("expected type error")
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
		r := ValidateAssertion(Assertion{Path: "$.response.status", Operator: "exists"}, doc)
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
		r := ValidateAssertion(Assertion{Path: "$.response.status", Operator: "exists"}, nullDoc)
		if r.Passed {
			t.Error("expected fail for null value")
		}
	})

	t.Run("validates exists for missing value", func(t *testing.T) {
		r := ValidateAssertion(Assertion{Path: "$.response.missing", Operator: "exists"}, doc)
		if r.Passed {
			t.Error("expected fail")
		}
		if r.Actual != "not found" {
			t.Errorf("expected actual 'not found', got %v", r.Actual)
		}
	})

	t.Run("validates notExists for missing value", func(t *testing.T) {
		r := ValidateAssertion(Assertion{Path: "$.response.missing", Operator: "notExists"}, doc)
		if !r.Passed {
			t.Error("expected pass")
		}
	})

	t.Run("validates notExists for null value", func(t *testing.T) {
		nullDoc := map[string]interface{}{
			"response": map[string]interface{}{"status": nil},
		}
		r := ValidateAssertion(Assertion{Path: "$.response.status", Operator: "notExists"}, nullDoc)
		if !r.Passed {
			t.Error("expected pass for null value")
		}
	})

	t.Run("validates notExists fails for present value", func(t *testing.T) {
		r := ValidateAssertion(Assertion{Path: "$.response.status", Operator: "notExists"}, doc)
		if r.Passed {
			t.Error("expected fail")
		}
		if r.Actual != "exists" {
			t.Errorf("expected actual 'exists', got %v", r.Actual)
		}
	})

	t.Run("returns error when path not found and operator is not exists/notExists", func(t *testing.T) {
		r := ValidateAssertion(Assertion{Path: "$.response.missing", Operator: "eq", Value: float64(200)}, doc)
		if r.Passed {
			t.Error("expected fail")
		}
		if !strings.Contains(r.Error, "Path '$.response.missing' not found") {
			t.Errorf("expected path not found error, got: %s", r.Error)
		}
	})

	t.Run("delegates to CompareValues for standard operators", func(t *testing.T) {
		r := ValidateAssertion(Assertion{Path: "$.response.status", Operator: "eq", Value: float64(200)}, doc)
		if !r.Passed {
			t.Error("expected pass")
		}
	})

	t.Run("rejects path without $. prefix", func(t *testing.T) {
		r := ValidateAssertion(Assertion{Path: "response.status", Operator: "eq", Value: float64(200)}, doc)
		if r.Passed {
			t.Error("expected fail for unprefixed path")
		}
		if !strings.Contains(r.Error, "$.-prefixed path") {
			t.Errorf("expected prefix error, got: %s", r.Error)
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

	t.Run("transform keys from path", func(t *testing.T) {
		d := map[string]interface{}{
			"response": map[string]interface{}{
				"body": map[string]interface{}{"a": float64(1), "b": float64(2)},
			},
		}
		result, err := ResolveExtractRule(d, "keys", ExtractRule{Path: "response.body", Transform: "keys"})
		if err != nil {
			t.Fatal(err)
		}
		arr, ok := result.([]interface{})
		if !ok {
			t.Fatalf("expected array, got %T", result)
		}
		if len(arr) != 2 {
			t.Errorf("expected 2 keys, got %d", len(arr))
		}
	})

	t.Run("transform values from path", func(t *testing.T) {
		d := map[string]interface{}{
			"response": map[string]interface{}{
				"body": map[string]interface{}{"x": float64(10), "y": float64(20)},
			},
		}
		result, err := ResolveExtractRule(d, "vals", ExtractRule{Path: "response.body", Transform: "values"})
		if err != nil {
			t.Fatal(err)
		}
		arr, ok := result.([]interface{})
		if !ok {
			t.Fatalf("expected array, got %T", result)
		}
		if len(arr) != 2 {
			t.Errorf("expected 2 values, got %d", len(arr))
		}
	})

	t.Run("transform entries from path", func(t *testing.T) {
		d := map[string]interface{}{
			"response": map[string]interface{}{
				"body": map[string]interface{}{"name": "Alice"},
			},
		}
		result, err := ResolveExtractRule(d, "entries", ExtractRule{Path: "response.body", Transform: "entries"})
		if err != nil {
			t.Fatal(err)
		}
		arr, ok := result.([]interface{})
		if !ok {
			t.Fatalf("expected array, got %T", result)
		}
		if len(arr) != 1 {
			t.Errorf("expected 1 entry, got %d", len(arr))
		}
		entry, ok := arr[0].(map[string]interface{})
		if !ok {
			t.Fatalf("expected entry to be map, got %T", arr[0])
		}
		if entry["key"] != "name" || entry["value"] != "Alice" {
			t.Errorf("expected {key:name, value:Alice}, got %v", entry)
		}
	})

	t.Run("transform from variable reference", func(t *testing.T) {
		d := map[string]interface{}{
			"variables": map[string]interface{}{
				"config": map[string]interface{}{"timeout": float64(30), "retries": float64(3)},
			},
		}
		result, err := ResolveExtractRule(d, "configKeys", ExtractRule{From: "{{config}}", Transform: "keys"})
		if err != nil {
			t.Fatal(err)
		}
		arr, ok := result.([]interface{})
		if !ok {
			t.Fatalf("expected array, got %T", result)
		}
		if len(arr) != 2 {
			t.Errorf("expected 2 keys, got %d", len(arr))
		}
	})

	t.Run("transform errors on non-object source", func(t *testing.T) {
		d := map[string]interface{}{
			"response": map[string]interface{}{
				"body": []interface{}{"a", "b"},
			},
		}
		_, err := ResolveExtractRule(d, "keys", ExtractRule{Path: "response.body", Transform: "keys"})
		if err == nil {
			t.Fatal("expected error for non-object source")
		}
	})

	t.Run("transform errors when from reference not found", func(t *testing.T) {
		d := map[string]interface{}{
			"variables": map[string]interface{}{},
		}
		_, err := ResolveExtractRule(d, "keys", ExtractRule{From: "{{missing}}", Transform: "keys"})
		if err == nil {
			t.Fatal("expected error for missing variable")
		}
	})
}

func TestEvaluateDocPath_ScopedContext(t *testing.T) {
	doc := map[string]interface{}{
		"variables": map[string]interface{}{"x": float64(1)},
	}
	scoped := map[string]interface{}{
		"origin":  "service-a",
		"request": map[string]interface{}{"method": "POST", "url": "/api"},
	}

	t.Run("$$ resolves against scoped context", func(t *testing.T) {
		result, found := EvaluateDocPath(doc, "$$.origin", scoped)
		if !found || result != "service-a" {
			t.Errorf("expected service-a, got %v (found=%v)", result, found)
		}
	})
	t.Run("$$ nested path", func(t *testing.T) {
		result, found := EvaluateDocPath(doc, "$$.request.method", scoped)
		if !found || result != "POST" {
			t.Errorf("expected POST, got %v (found=%v)", result, found)
		}
	})
	t.Run("$$ without scoped context returns not-found", func(t *testing.T) {
		_, found := EvaluateDocPath(doc, "$$.origin")
		if found {
			t.Error("expected not found without scoped context")
		}
	})
	t.Run("$$ with nil scoped context returns not-found", func(t *testing.T) {
		_, found := EvaluateDocPath(doc, "$$.origin", nil)
		if found {
			t.Error("expected not found with nil scoped context")
		}
	})
	t.Run("bare $$ returns not-found", func(t *testing.T) {
		_, found := EvaluateDocPath(doc, "$$", scoped)
		if found {
			t.Error("expected not found for bare $$")
		}
	})
}

func TestResolveSource(t *testing.T) {
	t.Run("string path", func(t *testing.T) {
		a := Assertion{Path: "$.response.status"}
		p, tr, err := resolveSource(a)
		if err != nil {
			t.Fatal(err)
		}
		if p != "$.response.status" || tr != "" {
			t.Errorf("got path=%q transform=%q", p, tr)
		}
	})
	t.Run("PathWithTransform object", func(t *testing.T) {
		a := Assertion{Path: map[string]interface{}{"from": "$.response.body.items", "transform": "length"}}
		p, tr, err := resolveSource(a)
		if err != nil {
			t.Fatal(err)
		}
		if p != "$.response.body.items" || tr != "length" {
			t.Errorf("got path=%q transform=%q", p, tr)
		}
	})
	t.Run("count shorthand", func(t *testing.T) {
		a := Assertion{Count: "$.response.body.items"}
		p, tr, err := resolveSource(a)
		if err != nil {
			t.Fatal(err)
		}
		if p != "$.response.body.items" || tr != "length" {
			t.Errorf("got path=%q transform=%q", p, tr)
		}
	})
	t.Run("type shorthand", func(t *testing.T) {
		a := Assertion{Type: "$.response.body.value"}
		p, tr, err := resolveSource(a)
		if err != nil {
			t.Fatal(err)
		}
		if p != "$.response.body.value" || tr != "type" {
			t.Errorf("got path=%q transform=%q", p, tr)
		}
	})
	t.Run("keys shorthand", func(t *testing.T) {
		a := Assertion{Keys: "$.response.body"}
		p, tr, err := resolveSource(a)
		if err != nil {
			t.Fatal(err)
		}
		if p != "$.response.body" || tr != "keys" {
			t.Errorf("got path=%q transform=%q", p, tr)
		}
	})
	t.Run("values shorthand", func(t *testing.T) {
		a := Assertion{Values: "$.response.body"}
		p, tr, err := resolveSource(a)
		if err != nil {
			t.Fatal(err)
		}
		if p != "$.response.body" || tr != "values" {
			t.Errorf("got path=%q transform=%q", p, tr)
		}
	})
	t.Run("entries shorthand", func(t *testing.T) {
		a := Assertion{Entries: "$.response.body"}
		p, tr, err := resolveSource(a)
		if err != nil {
			t.Fatal(err)
		}
		if p != "$.response.body" || tr != "entries" {
			t.Errorf("got path=%q transform=%q", p, tr)
		}
	})
	t.Run("no source field returns error", func(t *testing.T) {
		a := Assertion{Operator: "eq", Value: float64(1)}
		_, _, err := resolveSource(a)
		if err == nil {
			t.Error("expected error for missing source")
		}
	})
	t.Run("invalid path.from returns error", func(t *testing.T) {
		a := Assertion{Path: map[string]interface{}{"from": "noprefix"}}
		_, _, err := resolveSource(a)
		if err == nil {
			t.Error("expected error for non-$. from")
		}
	})
}

func TestApplyAssertionTransform(t *testing.T) {
	t.Run("length of array", func(t *testing.T) {
		r, err := applyAssertionTransform([]interface{}{1, 2, 3}, "length")
		if err != nil {
			t.Fatal(err)
		}
		if r != float64(3) {
			t.Errorf("expected 3, got %v", r)
		}
	})
	t.Run("length of string", func(t *testing.T) {
		r, err := applyAssertionTransform("hello", "length")
		if err != nil {
			t.Fatal(err)
		}
		if r != float64(5) {
			t.Errorf("expected 5, got %v", r)
		}
	})
	t.Run("length of wrong type errors", func(t *testing.T) {
		_, err := applyAssertionTransform(float64(42), "length")
		if err == nil {
			t.Error("expected error")
		}
	})
	t.Run("type of string", func(t *testing.T) {
		r, err := applyAssertionTransform("hello", "type")
		if err != nil {
			t.Fatal(err)
		}
		if r != "string" {
			t.Errorf("expected 'string', got %v", r)
		}
	})
	t.Run("type of number", func(t *testing.T) {
		r, err := applyAssertionTransform(float64(42), "type")
		if err != nil {
			t.Fatal(err)
		}
		if r != "number" {
			t.Errorf("expected 'number', got %v", r)
		}
	})
	t.Run("type of array", func(t *testing.T) {
		r, err := applyAssertionTransform([]interface{}{}, "type")
		if err != nil {
			t.Fatal(err)
		}
		if r != "array" {
			t.Errorf("expected 'array', got %v", r)
		}
	})
	t.Run("type of object", func(t *testing.T) {
		r, err := applyAssertionTransform(map[string]interface{}{}, "type")
		if err != nil {
			t.Fatal(err)
		}
		if r != "object" {
			t.Errorf("expected 'object', got %v", r)
		}
	})
	t.Run("type of nil", func(t *testing.T) {
		r, err := applyAssertionTransform(nil, "type")
		if err != nil {
			t.Fatal(err)
		}
		if r != "null" {
			t.Errorf("expected 'null', got %v", r)
		}
	})
	t.Run("type of bool", func(t *testing.T) {
		r, err := applyAssertionTransform(true, "type")
		if err != nil {
			t.Fatal(err)
		}
		if r != "boolean" {
			t.Errorf("expected 'boolean', got %v", r)
		}
	})
	t.Run("keys of object", func(t *testing.T) {
		r, err := applyAssertionTransform(map[string]interface{}{"a": 1, "b": 2}, "keys")
		if err != nil {
			t.Fatal(err)
		}
		arr := r.([]interface{})
		if len(arr) != 2 {
			t.Errorf("expected 2, got %d", len(arr))
		}
	})
	t.Run("keys of non-object errors", func(t *testing.T) {
		_, err := applyAssertionTransform([]interface{}{}, "keys")
		if err == nil {
			t.Error("expected error")
		}
	})
	t.Run("values of object", func(t *testing.T) {
		r, err := applyAssertionTransform(map[string]interface{}{"x": float64(10)}, "values")
		if err != nil {
			t.Fatal(err)
		}
		arr := r.([]interface{})
		if len(arr) != 1 || arr[0] != float64(10) {
			t.Errorf("got %v", arr)
		}
	})
	t.Run("entries of object", func(t *testing.T) {
		r, err := applyAssertionTransform(map[string]interface{}{"k": "v"}, "entries")
		if err != nil {
			t.Fatal(err)
		}
		arr := r.([]interface{})
		entry := arr[0].(map[string]interface{})
		if entry["key"] != "k" || entry["value"] != "v" {
			t.Errorf("got %v", entry)
		}
	})
	t.Run("unknown transform errors", func(t *testing.T) {
		_, err := applyAssertionTransform("x", "unknown")
		if err == nil {
			t.Error("expected error")
		}
	})
}

func TestResolveValue(t *testing.T) {
	doc := map[string]interface{}{
		"response": map[string]interface{}{
			"body": map[string]interface{}{"items": []interface{}{1, 2, 3}},
		},
	}

	t.Run("literal value passes through", func(t *testing.T) {
		r, err := resolveValue(float64(42), doc)
		if err != nil {
			t.Fatal(err)
		}
		if r != float64(42) {
			t.Errorf("expected 42, got %v", r)
		}
	})
	t.Run("literal string passes through", func(t *testing.T) {
		r, err := resolveValue("hello", doc)
		if err != nil {
			t.Fatal(err)
		}
		if r != "hello" {
			t.Errorf("expected hello, got %v", r)
		}
	})
	t.Run("ValueRef resolves path", func(t *testing.T) {
		ref := map[string]interface{}{"from": "$.response.body.items"}
		r, err := resolveValue(ref, doc)
		if err != nil {
			t.Fatal(err)
		}
		arr := r.([]interface{})
		if len(arr) != 3 {
			t.Errorf("expected 3 items, got %d", len(arr))
		}
	})
	t.Run("ValueRef with transform", func(t *testing.T) {
		ref := map[string]interface{}{"from": "$.response.body.items", "transform": "length"}
		r, err := resolveValue(ref, doc)
		if err != nil {
			t.Fatal(err)
		}
		if r != float64(3) {
			t.Errorf("expected 3, got %v", r)
		}
	})
	t.Run("non-$. from is literal object", func(t *testing.T) {
		obj := map[string]interface{}{"from": "$50", "to": "$100"}
		r, err := resolveValue(obj, doc)
		if err != nil {
			t.Fatal(err)
		}
		// Should be returned as-is
		m := r.(map[string]interface{})
		if m["from"] != "$50" {
			t.Errorf("expected literal, got %v", r)
		}
	})
	t.Run("ValueRef with missing path returns error", func(t *testing.T) {
		ref := map[string]interface{}{"from": "$.response.missing"}
		_, err := resolveValue(ref, doc)
		if err == nil {
			t.Error("expected error")
		}
	})
}

func TestValidateAssertion_Pipeline(t *testing.T) {
	doc := map[string]interface{}{
		"response": map[string]interface{}{
			"body": map[string]interface{}{
				"items":  []interface{}{"a", "b", "c"},
				"config": map[string]interface{}{"timeout": float64(30)},
				"name":   "Alice",
			},
			"status": float64(200),
		},
	}

	t.Run("count shorthand checks array length", func(t *testing.T) {
		r := ValidateAssertion(Assertion{Count: "$.response.body.items", Operator: "eq", Value: float64(3)}, doc)
		if !r.Passed {
			t.Errorf("expected pass, got error: %s", r.Error)
		}
	})
	t.Run("count shorthand fails for wrong length", func(t *testing.T) {
		r := ValidateAssertion(Assertion{Count: "$.response.body.items", Operator: "eq", Value: float64(5)}, doc)
		if r.Passed {
			t.Error("expected fail")
		}
	})
	t.Run("type shorthand checks value type", func(t *testing.T) {
		r := ValidateAssertion(Assertion{Type: "$.response.body.items", Operator: "eq", Value: "array"}, doc)
		if !r.Passed {
			t.Errorf("expected pass, got error: %s", r.Error)
		}
	})
	t.Run("type shorthand string", func(t *testing.T) {
		r := ValidateAssertion(Assertion{Type: "$.response.body.name", Operator: "eq", Value: "string"}, doc)
		if !r.Passed {
			t.Errorf("expected pass, got error: %s", r.Error)
		}
	})
	t.Run("keys shorthand", func(t *testing.T) {
		r := ValidateAssertion(Assertion{Keys: "$.response.body.config", Operator: "contains", Value: "timeout"}, doc)
		if !r.Passed {
			t.Errorf("expected pass, got error: %s", r.Error)
		}
	})
	t.Run("PathWithTransform object form", func(t *testing.T) {
		a := Assertion{
			Path:     map[string]interface{}{"from": "$.response.body.items", "transform": "length"},
			Operator: "gte", Value: float64(2),
		}
		r := ValidateAssertion(a, doc)
		if !r.Passed {
			t.Errorf("expected pass, got error: %s", r.Error)
		}
	})
	t.Run("ValueRef compares against document path", func(t *testing.T) {
		a := Assertion{
			Path:     "$.response.status",
			Operator: "eq",
			Value:    map[string]interface{}{"from": "$.response.status"},
		}
		r := ValidateAssertion(a, doc)
		if !r.Passed {
			t.Errorf("expected pass, got error: %s", r.Error)
		}
	})
}
