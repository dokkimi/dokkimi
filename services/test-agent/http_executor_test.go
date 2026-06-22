package main

import (
	"errors"
	"fmt"
	"testing"
)

func TestApiResponseToExtractDoc(t *testing.T) {
	t.Run("parses JSON body", func(t *testing.T) {
		resp := &APIResponse{
			StatusCode: 200,
			Body:       []byte(`{"name":"Alice","age":30}`),
		}
		doc := apiResponseToExtractDoc(resp)
		if doc["statusCode"] != 200 {
			t.Errorf("expected statusCode 200, got %v", doc["statusCode"])
		}
		body, ok := doc["body"].(map[string]interface{})
		if !ok {
			t.Fatalf("expected parsed body, got %T", doc["body"])
		}
		if body["name"] != "Alice" {
			t.Errorf("expected name=Alice, got %v", body["name"])
		}
	})

	t.Run("non-JSON body stored as string", func(t *testing.T) {
		resp := &APIResponse{
			StatusCode: 200,
			Body:       []byte(`not json`),
		}
		doc := apiResponseToExtractDoc(resp)
		if doc["body"] != "not json" {
			t.Errorf("expected raw string body, got %v", doc["body"])
		}
	})

	t.Run("empty body omits body key", func(t *testing.T) {
		resp := &APIResponse{StatusCode: 204, Body: nil}
		doc := apiResponseToExtractDoc(resp)
		if _, ok := doc["body"]; ok {
			t.Error("expected no body key for nil body")
		}
	})

	t.Run("headers lowercased", func(t *testing.T) {
		resp := &APIResponse{
			StatusCode: 200,
			Body:       []byte(`{}`),
			Headers: map[string][]string{
				"Content-Type": {"application/json"},
				"X-Request-ID": {"abc123"},
			},
		}
		doc := apiResponseToExtractDoc(resp)
		headers := doc["headers"].(map[string]interface{})
		if _, ok := headers["content-type"]; !ok {
			t.Error("expected lowercased content-type key")
		}
		if _, ok := headers["x-request-id"]; !ok {
			t.Error("expected lowercased x-request-id key")
		}
	})

	t.Run("nil headers omits key", func(t *testing.T) {
		resp := &APIResponse{StatusCode: 200}
		doc := apiResponseToExtractDoc(resp)
		if _, ok := doc["headers"]; ok {
			t.Error("expected no headers key when nil")
		}
	})

	t.Run("JSON array body", func(t *testing.T) {
		resp := &APIResponse{
			StatusCode: 200,
			Body:       []byte(`[1,2,3]`),
		}
		doc := apiResponseToExtractDoc(resp)
		arr, ok := doc["body"].([]interface{})
		if !ok {
			t.Fatalf("expected parsed array body, got %T", doc["body"])
		}
		if len(arr) != 3 {
			t.Errorf("expected 3 elements, got %d", len(arr))
		}
	})
}

func TestNormalizeResponseForUntil(t *testing.T) {
	t.Run("remaps statusCode to status", func(t *testing.T) {
		raw := map[string]interface{}{
			"statusCode": 200,
			"body":       map[string]interface{}{"ok": true},
		}
		norm := normalizeResponseForUntil(raw)
		if _, ok := norm["statusCode"]; ok {
			t.Error("expected statusCode to be removed")
		}
		status, ok := toFloat(norm["status"])
		if !ok || status != 200 {
			t.Errorf("expected status=200, got %v", norm["status"])
		}
	})

	t.Run("preserves existing status", func(t *testing.T) {
		raw := map[string]interface{}{
			"statusCode": 200,
			"status":     float64(201),
		}
		norm := normalizeResponseForUntil(raw)
		if norm["status"] != float64(201) {
			t.Errorf("expected existing status=201 preserved, got %v", norm["status"])
		}
	})

	t.Run("adds missing headers and body", func(t *testing.T) {
		raw := map[string]interface{}{"statusCode": 404}
		norm := normalizeResponseForUntil(raw)
		if norm["headers"] == nil {
			t.Error("expected empty headers map")
		}
		if norm["body"] == nil {
			t.Error("expected empty body map")
		}
	})

	t.Run("nil input returns safe defaults", func(t *testing.T) {
		norm := normalizeResponseForUntil(nil)
		if norm["status"] != nil {
			t.Errorf("expected nil status, got %v", norm["status"])
		}
		if norm["headers"] == nil {
			t.Error("expected empty headers map")
		}
		if norm["body"] == nil {
			t.Error("expected empty body map")
		}
	})

	t.Run("does not mutate input", func(t *testing.T) {
		raw := map[string]interface{}{"statusCode": 200}
		normalizeResponseForUntil(raw)
		if _, ok := raw["statusCode"]; !ok {
			t.Error("original map should not be mutated")
		}
	})
}

func TestStripScheme(t *testing.T) {
	tests := []struct {
		input    string
		expected string
	}{
		{"http://example.com/path", "example.com/path"},
		{"https://example.com/path", "example.com/path"},
		{"example.com/path", "example.com/path"},
		{"http://", ""},
		{"https://", ""},
		{"", ""},
		{"ftp://example.com", "ftp://example.com"},
	}
	for _, tc := range tests {
		t.Run(tc.input, func(t *testing.T) {
			result := stripScheme(tc.input)
			if result != tc.expected {
				t.Errorf("stripScheme(%q) = %q, expected %q", tc.input, result, tc.expected)
			}
		})
	}
}

func TestRootCause(t *testing.T) {
	t.Run("nil error", func(t *testing.T) {
		if rootCause(nil) != "unknown error" {
			t.Error("expected 'unknown error' for nil")
		}
	})

	t.Run("simple error", func(t *testing.T) {
		err := errors.New("something broke")
		if rootCause(err) != "something broke" {
			t.Errorf("expected 'something broke', got %q", rootCause(err))
		}
	})

	t.Run("wrapped error unwraps to root", func(t *testing.T) {
		inner := errors.New("root cause")
		mid := fmt.Errorf("mid layer: %w", inner)
		outer := fmt.Errorf("outer layer: %w", mid)
		if rootCause(outer) != "root cause" {
			t.Errorf("expected 'root cause', got %q", rootCause(outer))
		}
	})
}
