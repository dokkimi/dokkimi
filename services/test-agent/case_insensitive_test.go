package main

import "testing"

// Case-insensitive lookups must see the map as it is now, not as it was the
// last time it was looked at.
func TestEvaluateDocPath_CaseInsensitiveSeesNewKeys(t *testing.T) {
	headers := map[string]interface{}{"content-type": "application/json"}
	doc := map[string]interface{}{"headers": headers}
	if v, ok := EvaluateDocPath(doc, "$.headers.Content-Type"); !ok || v != "application/json" {
		t.Fatalf("got %v %v", v, ok)
	}
	headers["x-request-id"] = "abc"
	if v, ok := EvaluateDocPath(doc, "$.headers.X-Request-Id"); !ok || v != "abc" {
		t.Errorf("a key added after the first lookup: got %v %v, want abc", v, ok)
	}
	delete(headers, "content-type")
	if v, ok := EvaluateDocPath(doc, "$.headers.Content-Type"); ok {
		t.Errorf("a removed key is still found: %v", v)
	}
}

func TestVariableContext_CaseInsensitiveSeesNewVariables(t *testing.T) {
	vc := NewVariableContext()
	vc.Set("user", map[string]interface{}{"email": "a@b.c"})
	if v, err := vc.Resolve("{{User.email}}"); err != nil || v != "a@b.c" { // falls back on the variables map
		t.Fatalf("got %q %v", v, err)
	}
	vc.Set("orderId", "o-1")
	if v, err := vc.Resolve("{{OrderID}}"); err != nil || v != "o-1" {
		t.Errorf("a variable set after the first lookup: got %q %v, want o-1", v, err)
	}
}

// When several keys differ only in case and none matches exactly, the same
// one is chosen every time: the first in byte order.
func TestEvaluateDocPath_CaseInsensitiveIsDeterministic(t *testing.T) {
	doc := map[string]interface{}{"Name": "first", "nAME": "second"}
	for i := 0; i < 50; i++ {
		if v, _ := EvaluateDocPath(doc, "$.NAME"); v != "first" {
			t.Fatalf("got %v on try %d, want first (key Name) every time", v, i)
		}
	}
}
