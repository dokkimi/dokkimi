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
	if v := vc.variables["userId"]; v != "42" {
		t.Errorf("expected '42', got '%s'", v)
	}
	if v := vc.variables["userName"]; v != "alice" {
		t.Errorf("expected 'alice', got '%s'", v)
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
		t.Errorf("expected '12345', got '%s'", v)
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
		t.Errorf("expected '789', got '%s'", v)
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
		t.Errorf("expected '2024-01-15T10:30:00Z', got '%s'", v)
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
