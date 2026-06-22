package main

import (
	"testing"
)

func TestApplyAssertionTransform_Length(t *testing.T) {
	t.Run("array length", func(t *testing.T) {
		result, err := applyAssertionTransform([]interface{}{"a", "b", "c"}, "length")
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if result != float64(3) {
			t.Errorf("expected 3, got %v", result)
		}
	})

	t.Run("empty array length", func(t *testing.T) {
		result, err := applyAssertionTransform([]interface{}{}, "length")
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if result != float64(0) {
			t.Errorf("expected 0, got %v", result)
		}
	})

	t.Run("string length", func(t *testing.T) {
		result, err := applyAssertionTransform("hello", "length")
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if result != float64(5) {
			t.Errorf("expected 5, got %v", result)
		}
	})

	t.Run("empty string length", func(t *testing.T) {
		result, err := applyAssertionTransform("", "length")
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if result != float64(0) {
			t.Errorf("expected 0, got %v", result)
		}
	})

	t.Run("unicode string length counts runes", func(t *testing.T) {
		result, err := applyAssertionTransform("héllo", "length")
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if result != float64(5) {
			t.Errorf("expected 5, got %v", result)
		}
	})

	t.Run("errors on non-array non-string", func(t *testing.T) {
		_, err := applyAssertionTransform(float64(42), "length")
		if err == nil {
			t.Fatal("expected error for numeric input")
		}
	})

	t.Run("errors on nil", func(t *testing.T) {
		_, err := applyAssertionTransform(nil, "length")
		if err == nil {
			t.Fatal("expected error for nil input")
		}
	})
}

func TestApplyAssertionTransform_Type(t *testing.T) {
	tests := []struct {
		name     string
		input    interface{}
		expected string
	}{
		{"string", "hello", "string"},
		{"number", float64(42), "number"},
		{"boolean", true, "boolean"},
		{"null", nil, "null"},
		{"array", []interface{}{1, 2}, "array"},
		{"object", map[string]interface{}{"a": 1}, "object"},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			result, err := applyAssertionTransform(tc.input, "type")
			if err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
			if result != tc.expected {
				t.Errorf("expected %q, got %v", tc.expected, result)
			}
		})
	}
}

func TestApplyAssertionTransform_Keys(t *testing.T) {
	t.Run("extracts sorted keys", func(t *testing.T) {
		obj := map[string]interface{}{"c": 3, "a": 1, "b": 2}
		result, err := applyAssertionTransform(obj, "keys")
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		arr, ok := result.([]interface{})
		if !ok {
			t.Fatalf("expected []interface{}, got %T", result)
		}
		if len(arr) != 3 {
			t.Fatalf("expected 3 keys, got %d", len(arr))
		}
		if arr[0] != "a" || arr[1] != "b" || arr[2] != "c" {
			t.Errorf("expected [a b c], got %v", arr)
		}
	})

	t.Run("empty object", func(t *testing.T) {
		result, err := applyAssertionTransform(map[string]interface{}{}, "keys")
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		arr := result.([]interface{})
		if len(arr) != 0 {
			t.Errorf("expected empty, got %d", len(arr))
		}
	})

	t.Run("errors on non-object", func(t *testing.T) {
		_, err := applyAssertionTransform([]interface{}{1, 2}, "keys")
		if err == nil {
			t.Fatal("expected error for array input")
		}
	})
}

func TestApplyAssertionTransform_Values(t *testing.T) {
	t.Run("extracts sorted values", func(t *testing.T) {
		obj := map[string]interface{}{"b": "two", "a": "one"}
		result, err := applyAssertionTransform(obj, "values")
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		arr := result.([]interface{})
		if len(arr) != 2 {
			t.Fatalf("expected 2 values, got %d", len(arr))
		}
		// sorted by key: a→one, b→two
		if arr[0] != "one" || arr[1] != "two" {
			t.Errorf("expected [one two], got %v", arr)
		}
	})

	t.Run("errors on non-object", func(t *testing.T) {
		_, err := applyAssertionTransform("string", "values")
		if err == nil {
			t.Fatal("expected error for string input")
		}
	})
}

func TestApplyAssertionTransform_Entries(t *testing.T) {
	t.Run("extracts sorted entries", func(t *testing.T) {
		obj := map[string]interface{}{"b": float64(2), "a": float64(1)}
		result, err := applyAssertionTransform(obj, "entries")
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		arr := result.([]interface{})
		if len(arr) != 2 {
			t.Fatalf("expected 2 entries, got %d", len(arr))
		}
		first := arr[0].(map[string]interface{})
		if first["key"] != "a" || first["value"] != float64(1) {
			t.Errorf("expected {key:a, value:1}, got %v", first)
		}
		second := arr[1].(map[string]interface{})
		if second["key"] != "b" || second["value"] != float64(2) {
			t.Errorf("expected {key:b, value:2}, got %v", second)
		}
	})

	t.Run("errors on non-object", func(t *testing.T) {
		_, err := applyAssertionTransform(nil, "entries")
		if err == nil {
			t.Fatal("expected error for nil input")
		}
	})
}

func TestApplyAssertionTransform_Unknown(t *testing.T) {
	_, err := applyAssertionTransform(map[string]interface{}{}, "bogus")
	if err == nil {
		t.Fatal("expected error for unknown transform")
	}
}

func TestResolveSource_Transforms(t *testing.T) {
	t.Run("string path", func(t *testing.T) {
		a := Assertion{Path: "$.response.body"}
		path, transform, err := resolveSource(a)
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if path != "$.response.body" || transform != "" {
			t.Errorf("unexpected: path=%q transform=%q", path, transform)
		}
	})

	t.Run("rejects non-dollar path", func(t *testing.T) {
		a := Assertion{Path: "response.body"}
		_, _, err := resolveSource(a)
		if err == nil {
			t.Fatal("expected error for non-dollar path")
		}
	})

	t.Run("double-dollar path accepted", func(t *testing.T) {
		a := Assertion{Path: "$$.response.body"}
		path, _, err := resolveSource(a)
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if path != "$$.response.body" {
			t.Errorf("expected $$.response.body, got %q", path)
		}
	})

	t.Run("object path with from and transform", func(t *testing.T) {
		a := Assertion{Path: map[string]interface{}{"from": "$.response.body", "transform": "keys"}}
		path, transform, err := resolveSource(a)
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if path != "$.response.body" || transform != "keys" {
			t.Errorf("expected path=$.response.body transform=keys, got %q %q", path, transform)
		}
	})

	t.Run("count shorthand", func(t *testing.T) {
		a := Assertion{Count: "$.response.body.items"}
		path, transform, err := resolveSource(a)
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if path != "$.response.body.items" || transform != "length" {
			t.Errorf("expected items path + length transform, got %q %q", path, transform)
		}
	})

	t.Run("type shorthand", func(t *testing.T) {
		a := Assertion{Type: "$.response.body"}
		path, transform, err := resolveSource(a)
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if path != "$.response.body" || transform != "type" {
			t.Errorf("expected type transform, got %q %q", path, transform)
		}
	})

	t.Run("keys shorthand", func(t *testing.T) {
		a := Assertion{Keys: "$.response.body"}
		_, transform, err := resolveSource(a)
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if transform != "keys" {
			t.Errorf("expected keys transform, got %q", transform)
		}
	})

	t.Run("values shorthand", func(t *testing.T) {
		a := Assertion{Values: "$.response.body"}
		_, transform, err := resolveSource(a)
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if transform != "values" {
			t.Errorf("expected values transform, got %q", transform)
		}
	})

	t.Run("entries shorthand", func(t *testing.T) {
		a := Assertion{Entries: "$.response.body"}
		_, transform, err := resolveSource(a)
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if transform != "entries" {
			t.Errorf("expected entries transform, got %q", transform)
		}
	})

	t.Run("no source field is error", func(t *testing.T) {
		a := Assertion{Operator: "eq", Value: 42}
		_, _, err := resolveSource(a)
		if err == nil {
			t.Fatal("expected error for assertion with no source")
		}
	})
}

func TestResolveValue_Transforms(t *testing.T) {
	doc := map[string]interface{}{
		"response": map[string]interface{}{
			"body": map[string]interface{}{
				"items": []interface{}{"a", "b"},
				"config": map[string]interface{}{
					"x": float64(1),
					"y": float64(2),
				},
			},
		},
	}

	t.Run("non-map value passes through", func(t *testing.T) {
		result, err := resolveValue("hello", doc)
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if result != "hello" {
			t.Errorf("expected hello, got %v", result)
		}
	})

	t.Run("value ref resolves path", func(t *testing.T) {
		ref := map[string]interface{}{"from": "$.response.body.items"}
		result, err := resolveValue(ref, doc)
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		arr, ok := result.([]interface{})
		if !ok {
			t.Fatalf("expected array, got %T", result)
		}
		if len(arr) != 2 {
			t.Errorf("expected 2 items, got %d", len(arr))
		}
	})

	t.Run("value ref with transform", func(t *testing.T) {
		ref := map[string]interface{}{"from": "$.response.body.config", "transform": "keys"}
		result, err := resolveValue(ref, doc)
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		arr := result.([]interface{})
		if len(arr) != 2 {
			t.Errorf("expected 2 keys, got %d", len(arr))
		}
	})

	t.Run("missing path returns error", func(t *testing.T) {
		ref := map[string]interface{}{"from": "$.response.body.missing"}
		_, err := resolveValue(ref, doc)
		if err == nil {
			t.Fatal("expected error for missing path")
		}
	})

	t.Run("map without from passes through", func(t *testing.T) {
		m := map[string]interface{}{"key": "value"}
		result, err := resolveValue(m, doc)
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		rm := result.(map[string]interface{})
		if rm["key"] != "value" {
			t.Errorf("expected passthrough, got %v", rm)
		}
	})
}

func TestResolveExtractRule_SimplePath(t *testing.T) {
	doc := map[string]interface{}{
		"response": map[string]interface{}{
			"body": map[string]interface{}{
				"id":   float64(42),
				"name": "Alice",
				"tags": []interface{}{"admin", "user"},
			},
		},
	}

	t.Run("extracts number preserving type", func(t *testing.T) {
		rule := ExtractRule{Path: "$.response.body.id"}
		result, err := ResolveExtractRule(doc, "userId", rule)
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if result != float64(42) {
			t.Errorf("expected 42, got %v", result)
		}
	})

	t.Run("extracts string", func(t *testing.T) {
		rule := ExtractRule{Path: "$.response.body.name"}
		result, err := ResolveExtractRule(doc, "name", rule)
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if result != "Alice" {
			t.Errorf("expected Alice, got %v", result)
		}
	})

	t.Run("extracts array", func(t *testing.T) {
		rule := ExtractRule{Path: "$.response.body.tags"}
		result, err := ResolveExtractRule(doc, "tags", rule)
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		arr, ok := result.([]interface{})
		if !ok {
			t.Fatalf("expected array, got %T", result)
		}
		if len(arr) != 2 {
			t.Errorf("expected 2 tags, got %d", len(arr))
		}
	})

	t.Run("missing path returns error", func(t *testing.T) {
		rule := ExtractRule{Path: "$.response.body.missing"}
		_, err := ResolveExtractRule(doc, "x", rule)
		if err == nil {
			t.Fatal("expected error for missing path")
		}
	})
}

func TestResolveExtractRule_Regex(t *testing.T) {
	doc := map[string]interface{}{
		"response": map[string]interface{}{
			"body": map[string]interface{}{
				"message": "User ID: 12345 created",
			},
		},
	}

	t.Run("extracts regex group", func(t *testing.T) {
		rule := ExtractRule{Path: "$.response.body.message", Pattern: `ID: (\d+)`}
		result, err := ResolveExtractRule(doc, "userId", rule)
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if result != "12345" {
			t.Errorf("expected 12345, got %v", result)
		}
	})

	t.Run("custom group index", func(t *testing.T) {
		group := 0
		rule := ExtractRule{Path: "$.response.body.message", Pattern: `(ID: \d+)`, Group: &group}
		result, err := ResolveExtractRule(doc, "full", rule)
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if result != "ID: 12345" {
			t.Errorf("expected 'ID: 12345', got %v", result)
		}
	})

	t.Run("no match returns error", func(t *testing.T) {
		rule := ExtractRule{Path: "$.response.body.message", Pattern: `email: (.+)`}
		_, err := ResolveExtractRule(doc, "email", rule)
		if err == nil {
			t.Fatal("expected error for no match")
		}
	})

	t.Run("invalid regex returns error", func(t *testing.T) {
		rule := ExtractRule{Path: "$.response.body.message", Pattern: `[invalid(`}
		_, err := ResolveExtractRule(doc, "x", rule)
		if err == nil {
			t.Fatal("expected error for invalid regex")
		}
	})

	t.Run("group out of range returns error", func(t *testing.T) {
		group := 5
		rule := ExtractRule{Path: "$.response.body.message", Pattern: `(\d+)`, Group: &group}
		_, err := ResolveExtractRule(doc, "x", rule)
		if err == nil {
			t.Fatal("expected error for group out of range")
		}
	})
}

func TestResolveExtractRule_Transform(t *testing.T) {
	doc := map[string]interface{}{
		"response": map[string]interface{}{
			"body": map[string]interface{}{
				"config": map[string]interface{}{
					"debug": true,
					"port":  float64(8080),
				},
			},
		},
		"variables": map[string]interface{}{
			"settings": map[string]interface{}{
				"a": float64(1),
				"b": float64(2),
			},
		},
	}

	t.Run("path + keys transform", func(t *testing.T) {
		rule := ExtractRule{Path: "$.response.body.config", Transform: "keys"}
		result, err := ResolveExtractRule(doc, "configKeys", rule)
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		arr := result.([]interface{})
		if len(arr) != 2 {
			t.Errorf("expected 2 keys, got %d", len(arr))
		}
	})

	t.Run("path + values transform", func(t *testing.T) {
		rule := ExtractRule{Path: "$.response.body.config", Transform: "values"}
		result, err := ResolveExtractRule(doc, "configValues", rule)
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		arr := result.([]interface{})
		if len(arr) != 2 {
			t.Errorf("expected 2 values, got %d", len(arr))
		}
	})

	t.Run("path + entries transform", func(t *testing.T) {
		rule := ExtractRule{Path: "$.response.body.config", Transform: "entries"}
		result, err := ResolveExtractRule(doc, "configEntries", rule)
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		arr := result.([]interface{})
		if len(arr) != 2 {
			t.Errorf("expected 2 entries, got %d", len(arr))
		}
		entry := arr[0].(map[string]interface{})
		if _, ok := entry["key"]; !ok {
			t.Error("expected entry to have 'key' field")
		}
		if _, ok := entry["value"]; !ok {
			t.Error("expected entry to have 'value' field")
		}
	})

	t.Run("from + transform resolves variable", func(t *testing.T) {
		rule := ExtractRule{From: "{{settings}}", Transform: "keys"}
		result, err := ResolveExtractRule(doc, "settingKeys", rule)
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		arr := result.([]interface{})
		if len(arr) != 2 {
			t.Errorf("expected 2 keys, got %d", len(arr))
		}
	})

	t.Run("transform on non-object returns error", func(t *testing.T) {
		rule := ExtractRule{Path: "$.response.body.config.debug", Transform: "keys"}
		_, err := ResolveExtractRule(doc, "x", rule)
		if err == nil {
			t.Fatal("expected error for non-object transform source")
		}
	})

	t.Run("from with missing variable returns error", func(t *testing.T) {
		rule := ExtractRule{From: "{{nonexistent}}", Transform: "keys"}
		_, err := ResolveExtractRule(doc, "x", rule)
		if err == nil {
			t.Fatal("expected error for missing variable")
		}
	})

	t.Run("transform without path or from returns error", func(t *testing.T) {
		rule := ExtractRule{Transform: "keys"}
		_, err := ResolveExtractRule(doc, "x", rule)
		if err == nil {
			t.Fatal("expected error when neither path nor from is set")
		}
	})
}

func TestSortedKeys(t *testing.T) {
	m := map[string]int{"z": 1, "a": 2, "m": 3}
	keys := sortedKeys(m)
	if len(keys) != 3 {
		t.Fatalf("expected 3 keys, got %d", len(keys))
	}
	if keys[0] != "a" || keys[1] != "m" || keys[2] != "z" {
		t.Errorf("expected [a m z], got %v", keys)
	}
}
