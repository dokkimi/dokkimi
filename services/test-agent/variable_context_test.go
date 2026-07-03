package main

import (
	"encoding/json"
	"testing"
)

// ---------------------------------------------------------------------------
// ExtractRule UnmarshalJSON
// ---------------------------------------------------------------------------

func TestExtractRule_UnmarshalJSON_String(t *testing.T) {
	var rule ExtractRule
	if err := json.Unmarshal([]byte(`"$.body.id"`), &rule); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if rule.Path != "$.body.id" {
		t.Errorf("expected path '$.body.id', got '%s'", rule.Path)
	}
	if rule.Pattern != "" {
		t.Errorf("expected empty pattern, got '%s'", rule.Pattern)
	}
	if rule.Group != nil {
		t.Errorf("expected nil group, got %d", *rule.Group)
	}
}

func TestExtractRule_UnmarshalJSON_Object(t *testing.T) {
	raw := `{"path": "$.body.msg", "pattern": "id=(\\d+)", "group": 1}`
	var rule ExtractRule
	if err := json.Unmarshal([]byte(raw), &rule); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if rule.Path != "$.body.msg" {
		t.Errorf("expected path '$.body.msg', got '%s'", rule.Path)
	}
	if rule.Pattern != `id=(\d+)` {
		t.Errorf("expected pattern 'id=(\\d+)', got '%s'", rule.Pattern)
	}
	if rule.Group == nil || *rule.Group != 1 {
		t.Errorf("expected group 1, got %v", rule.Group)
	}
}

func TestExtractRule_UnmarshalJSON_ObjectNoGroup(t *testing.T) {
	raw := `{"path": "$.body.msg", "pattern": "id=(\\d+)"}`
	var rule ExtractRule
	if err := json.Unmarshal([]byte(raw), &rule); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if rule.Group != nil {
		t.Errorf("expected nil group (defaults to 1 at extract time), got %d", *rule.Group)
	}
}

// ---------------------------------------------------------------------------
// Extract — simple path (backwards compat)
// ---------------------------------------------------------------------------

func TestExtract_SimplePath(t *testing.T) {
	vc := NewVariableContext()
	doc := map[string]interface{}{
		"body": map[string]interface{}{
			"id":   float64(42),
			"name": "alice",
		},
	}
	rules := map[string]ExtractRule{
		"userId":   {Path: "$.body.id"},
		"userName": {Path: "$.body.name"},
	}
	if err := vc.Extract(rules, doc); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if v := vc.variables["userId"]; v != float64(42) {
		t.Errorf("expected 42, got '%v'", v)
	}
	if v := vc.variables["userName"]; v != "alice" {
		t.Errorf("expected 'alice', got '%v'", v)
	}
}

// ---------------------------------------------------------------------------
// Extract — regex pattern
// ---------------------------------------------------------------------------

func TestExtract_RegexPattern(t *testing.T) {
	vc := NewVariableContext()
	doc := map[string]interface{}{
		"body": map[string]interface{}{
			"message": "Created order id=12345 for user",
		},
	}
	group1 := 1
	rules := map[string]ExtractRule{
		"orderId": {Path: "$.body.message", Pattern: `id=(\d+)`, Group: &group1},
	}
	if err := vc.Extract(rules, doc); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if v := vc.variables["orderId"]; v != "12345" {
		t.Errorf("expected '12345', got '%v'", v)
	}
}

func TestExtract_RegexPattern_DefaultGroup(t *testing.T) {
	vc := NewVariableContext()
	doc := map[string]interface{}{
		"headers": map[string]interface{}{
			"location": "/resources/789/details",
		},
	}
	rules := map[string]ExtractRule{
		"resourceId": {Path: "$.headers.location", Pattern: `/resources/(\d+)`},
	}
	if err := vc.Extract(rules, doc); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if v := vc.variables["resourceId"]; v != "789" {
		t.Errorf("expected '789', got '%v'", v)
	}
}

func TestExtract_RegexPattern_Group0_FullMatch(t *testing.T) {
	vc := NewVariableContext()
	doc := map[string]interface{}{
		"body": map[string]interface{}{
			"timestamp": "event at 2024-01-15T10:30:00Z end",
		},
	}
	group0 := 0
	rules := map[string]ExtractRule{
		"ts": {Path: "$.body.timestamp", Pattern: `\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z`, Group: &group0},
	}
	if err := vc.Extract(rules, doc); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if v := vc.variables["ts"]; v != "2024-01-15T10:30:00Z" {
		t.Errorf("expected '2024-01-15T10:30:00Z', got '%v'", v)
	}
}

func TestExtract_RegexPattern_NoMatch(t *testing.T) {
	vc := NewVariableContext()
	doc := map[string]interface{}{
		"body": map[string]interface{}{
			"message": "no numbers here",
		},
	}
	rules := map[string]ExtractRule{
		"num": {Path: "$.body.message", Pattern: `(\d+)`},
	}
	err := vc.Extract(rules, doc)
	if err == nil {
		t.Fatal("expected error for non-matching pattern")
	}
}

func TestExtract_RegexPattern_InvalidRegex(t *testing.T) {
	vc := NewVariableContext()
	doc := map[string]interface{}{
		"body": map[string]interface{}{
			"message": "test",
		},
	}
	rules := map[string]ExtractRule{
		"x": {Path: "$.body.message", Pattern: `[invalid`},
	}
	err := vc.Extract(rules, doc)
	if err == nil {
		t.Fatal("expected error for invalid regex")
	}
}

func TestExtract_RegexPattern_GroupOutOfRange(t *testing.T) {
	vc := NewVariableContext()
	doc := map[string]interface{}{
		"body": map[string]interface{}{
			"message": "id=123",
		},
	}
	group5 := 5
	rules := map[string]ExtractRule{
		"x": {Path: "$.body.message", Pattern: `id=(\d+)`, Group: &group5},
	}
	err := vc.Extract(rules, doc)
	if err == nil {
		t.Fatal("expected error for out-of-range capture group")
	}
}

// ---------------------------------------------------------------------------
// Dotted and bracketed variable path resolution
// ---------------------------------------------------------------------------

func TestVariableContext_DottedPathResolution(t *testing.T) {
	t.Run("resolves {{user.email}}", func(t *testing.T) {
		vc := NewVariableContext()
		vc.Set("user", map[string]interface{}{
			"name":  "Alice",
			"email": "alice@test.com",
		})
		result, err := vc.Resolve("{{user.email}}")
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if result != "alice@test.com" {
			t.Errorf("expected alice@test.com, got %v", result)
		}
	})

	t.Run("resolves {{users[0].name}}", func(t *testing.T) {
		vc := NewVariableContext()
		vc.Set("users", []interface{}{
			map[string]interface{}{"name": "Alice"},
			map[string]interface{}{"name": "Bob"},
		})
		result, err := vc.Resolve("{{users[0].name}}")
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if result != "Alice" {
			t.Errorf("expected Alice, got %v", result)
		}
	})

	t.Run("resolves {{users[1].name}}", func(t *testing.T) {
		vc := NewVariableContext()
		vc.Set("users", []interface{}{
			map[string]interface{}{"name": "Alice"},
			map[string]interface{}{"name": "Bob"},
		})
		result, err := vc.Resolve("{{users[1].name}}")
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if result != "Bob" {
			t.Errorf("expected Bob, got %v", result)
		}
	})

	t.Run("ResolveTyped returns typed value for {{user.email}}", func(t *testing.T) {
		vc := NewVariableContext()
		vc.Set("user", map[string]interface{}{
			"email": "alice@test.com",
			"age":   float64(30),
		})
		result, err := vc.ResolveTyped("{{user.age}}")
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if result != float64(30) {
			t.Errorf("expected 30, got %v (%T)", result, result)
		}
	})

	t.Run("resolves deeply nested {{a.b.c}}", func(t *testing.T) {
		vc := NewVariableContext()
		vc.Set("a", map[string]interface{}{
			"b": map[string]interface{}{
				"c": "deep",
			},
		})
		result, err := vc.Resolve("{{a.b.c}}")
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if result != "deep" {
			t.Errorf("expected deep, got %v", result)
		}
	})

	t.Run("errors on missing dotted path", func(t *testing.T) {
		vc := NewVariableContext()
		vc.Set("user", map[string]interface{}{"name": "Alice"})
		_, err := vc.Resolve("{{user.missing}}")
		if err == nil {
			t.Error("expected error for missing path")
		}
	})

	t.Run("mixed text with dotted path", func(t *testing.T) {
		vc := NewVariableContext()
		vc.Set("user", map[string]interface{}{"name": "Alice"})
		result, err := vc.Resolve("Hello {{user.name}}!")
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if result != "Hello Alice!" {
			t.Errorf("expected Hello Alice!, got %v", result)
		}
	})
}

// ---------------------------------------------------------------------------
// Full step unmarshal with mixed extract rules
// ---------------------------------------------------------------------------

func TestTestStep_UnmarshalExtract_Mixed(t *testing.T) {
	raw := `{
		"action": {"type": "httpRequest", "method": "GET", "url": "http://example.com"},
		"extract": {
			"simple": "$.body.id",
			"withRegex": {
				"path": "$.body.log",
				"pattern": "trace=(\\w+)",
				"group": 1
			}
		}
	}`
	var step TestStep
	if err := json.Unmarshal([]byte(raw), &step); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(step.Extract) != 2 {
		t.Fatalf("expected 2 extract rules, got %d", len(step.Extract))
	}
	if step.Extract["simple"].Path != "$.body.id" {
		t.Errorf("expected simple path '$.body.id', got '%s'", step.Extract["simple"].Path)
	}
	if step.Extract["withRegex"].Pattern != `trace=(\w+)` {
		t.Errorf("unexpected pattern: %s", step.Extract["withRegex"].Pattern)
	}
}

func TestResolveWhereEntries(t *testing.T) {
	t.Run("resolves {{var}} in where entry values", func(t *testing.T) {
		vc := NewVariableContext()
		vc.Set("svcName", "service-a")
		entries := []WhereEntry{
			{Path: "$$.origin", Operator: "eq", Value: "{{svcName}}"},
		}
		resolved := vc.resolveWhereEntries(entries)
		if resolved[0].Value != "service-a" {
			t.Errorf("expected service-a, got %v", resolved[0].Value)
		}
	})

	t.Run("does NOT resolve $$ paths (left for match time)", func(t *testing.T) {
		vc := NewVariableContext()
		entries := []WhereEntry{
			{Path: "$$.request.method", Operator: "eq", Value: "POST"},
		}
		resolved := vc.resolveWhereEntries(entries)
		if resolved[0].Path != "$$.request.method" {
			t.Errorf("expected $$.request.method, got %v", resolved[0].Path)
		}
	})

	t.Run("recurses into or", func(t *testing.T) {
		vc := NewVariableContext()
		vc.Set("target", "api")
		entries := []WhereEntry{
			{Or: []WhereEntry{
				{Path: "$$.origin", Operator: "eq", Value: "{{target}}"},
			}},
		}
		resolved := vc.resolveWhereEntries(entries)
		if resolved[0].Or[0].Value != "api" {
			t.Errorf("expected api in or clause, got %v", resolved[0].Or[0].Value)
		}
	})

	t.Run("recurses into and", func(t *testing.T) {
		vc := NewVariableContext()
		vc.Set("method", "GET")
		entries := []WhereEntry{
			{And: []WhereEntry{
				{Path: "$$.request.method", Operator: "eq", Value: "{{method}}"},
			}},
		}
		resolved := vc.resolveWhereEntries(entries)
		if resolved[0].And[0].Value != "GET" {
			t.Errorf("expected GET in and clause, got %v", resolved[0].And[0].Value)
		}
	})

	t.Run("recurses into not", func(t *testing.T) {
		vc := NewVariableContext()
		vc.Set("excluded", "internal")
		not := WhereEntry{Path: "$$.origin", Operator: "eq", Value: "{{excluded}}"}
		entries := []WhereEntry{
			{Not: &not},
		}
		resolved := vc.resolveWhereEntries(entries)
		if resolved[0].Not.Value != "internal" {
			t.Errorf("expected internal in not clause, got %v", resolved[0].Not.Value)
		}
	})
}

func TestResolveAction_FormData(t *testing.T) {
	t.Run("resolves variables in formData string values", func(t *testing.T) {
		vc := NewVariableContext()
		vc.Set("userId", "user-123")
		action := StepAction{
			Type:   "httpRequest",
			Method: "POST",
			URL:    "svc/upload",
			FormData: map[string]interface{}{
				"fileId": "{{userId}}",
			},
		}
		resolved, err := vc.ResolveAction(action)
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if resolved.FormData["fileId"] != "user-123" {
			t.Errorf("expected user-123, got %v", resolved.FormData["fileId"])
		}
	})

	t.Run("resolves variables in nested formData objects", func(t *testing.T) {
		vc := NewVariableContext()
		vc.Set("fname", "secret.txt")
		action := StepAction{
			Type:   "httpRequest",
			Method: "POST",
			URL:    "svc/upload",
			FormData: map[string]interface{}{
				"file": map[string]interface{}{
					"filename": "{{fname}}",
					"content":  "data",
				},
			},
		}
		resolved, err := vc.ResolveAction(action)
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		fileMap := resolved.FormData["file"].(map[string]interface{})
		if fileMap["filename"] != "secret.txt" {
			t.Errorf("expected secret.txt, got %v", fileMap["filename"])
		}
	})

	t.Run("nil formData is left nil", func(t *testing.T) {
		vc := NewVariableContext()
		action := StepAction{
			Type:   "httpRequest",
			Method: "GET",
			URL:    "svc/path",
		}
		resolved, err := vc.ResolveAction(action)
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if resolved.FormData != nil {
			t.Error("expected nil formData")
		}
	})
}

func TestResolveAction_QueryParams(t *testing.T) {
	t.Run("resolves variables in queryParams values", func(t *testing.T) {
		vc := NewVariableContext()
		vc.Set("pageSize", "10")
		action := StepAction{
			Type:   "httpRequest",
			Method: "GET",
			URL:    "svc/items",
			QueryParams: map[string]interface{}{
				"limit": "{{pageSize}}",
			},
		}
		resolved, err := vc.ResolveAction(action)
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if resolved.QueryParams["limit"] != "10" {
			t.Errorf("expected 10, got %v", resolved.QueryParams["limit"])
		}
	})

	t.Run("nil queryParams is left nil", func(t *testing.T) {
		vc := NewVariableContext()
		action := StepAction{
			Type:   "httpRequest",
			Method: "GET",
			URL:    "svc/path",
		}
		resolved, err := vc.ResolveAction(action)
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if resolved.QueryParams != nil {
			t.Error("expected nil queryParams")
		}
	})
}

func TestResolveValue_MapKeys(t *testing.T) {
	t.Run("resolves {{var}} in map keys", func(t *testing.T) {
		vc := NewVariableContext()
		vc.Set("questionId", "q1abc")
		input := map[string]interface{}{
			"{{questionId}}": "my answer",
		}
		result, err := vc.resolveValue(input)
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		m := result.(map[string]interface{})
		if v, ok := m["q1abc"]; !ok || v != "my answer" {
			t.Errorf("expected key 'q1abc' with value 'my answer', got %v", m)
		}
		if _, ok := m["{{questionId}}"]; ok {
			t.Error("unresolved key '{{questionId}}' should not be present")
		}
	})

	t.Run("resolves {{var}} in both key and value", func(t *testing.T) {
		vc := NewVariableContext()
		vc.Set("field", "email")
		vc.Set("val", "test@example.com")
		input := map[string]interface{}{
			"{{field}}": "{{val}}",
		}
		result, err := vc.resolveValue(input)
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		m := result.(map[string]interface{})
		if m["email"] != "test@example.com" {
			t.Errorf("expected email=test@example.com, got %v", m)
		}
	})

	t.Run("plain keys are unaffected", func(t *testing.T) {
		vc := NewVariableContext()
		input := map[string]interface{}{
			"name": "Alice",
		}
		result, err := vc.resolveValue(input)
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		m := result.(map[string]interface{})
		if m["name"] != "Alice" {
			t.Errorf("expected name=Alice, got %v", m)
		}
	})
}

func TestExtractKeyInterpolation(t *testing.T) {
	vc := NewVariableContext()
	vc.Set("prefix", "user")
	vc.Set("idx", "0")

	t.Run("resolves variable in extract key", func(t *testing.T) {
		key := "{{prefix}}_id"
		resolved, err := vc.Resolve(key)
		if err != nil {
			t.Fatal(err)
		}
		if resolved != "user_id" {
			t.Errorf("expected user_id, got %v", resolved)
		}
	})

	t.Run("resolves multiple variables in key", func(t *testing.T) {
		key := "{{prefix}}_{{idx}}"
		resolved, err := vc.Resolve(key)
		if err != nil {
			t.Fatal(err)
		}
		if resolved != "user_0" {
			t.Errorf("expected user_0, got %v", resolved)
		}
	})
}
