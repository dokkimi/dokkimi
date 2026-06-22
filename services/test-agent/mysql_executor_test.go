package main

import (
	"testing"
)

func TestBindMysqlParams(t *testing.T) {
	t.Run("returns nil for empty params", func(t *testing.T) {
		result := bindMysqlParams("SELECT * FROM users WHERE id = ?", nil)
		if result != nil {
			t.Errorf("expected nil, got %v", result)
		}
	})

	t.Run("returns nil when no placeholders", func(t *testing.T) {
		result := bindMysqlParams("SELECT * FROM users", map[string]interface{}{"1": "val"})
		if result != nil {
			t.Errorf("expected nil, got %v", result)
		}
	})

	t.Run("binds single param", func(t *testing.T) {
		result := bindMysqlParams("SELECT * FROM users WHERE id = ?", map[string]interface{}{
			"1": 42,
		})
		if len(result) != 1 {
			t.Fatalf("expected 1 arg, got %d", len(result))
		}
		if result[0] != 42 {
			t.Errorf("expected 42, got %v", result[0])
		}
	})

	t.Run("binds multiple params in order", func(t *testing.T) {
		result := bindMysqlParams("INSERT INTO users (name, age) VALUES (?, ?)", map[string]interface{}{
			"1": "Alice",
			"2": 30,
		})
		if len(result) != 2 {
			t.Fatalf("expected 2 args, got %d", len(result))
		}
		if result[0] != "Alice" {
			t.Errorf("arg[0]: expected Alice, got %v", result[0])
		}
		if result[1] != 30 {
			t.Errorf("arg[1]: expected 30, got %v", result[1])
		}
	})

	t.Run("missing param leaves nil in slot", func(t *testing.T) {
		result := bindMysqlParams("SELECT * FROM t WHERE a = ? AND b = ?", map[string]interface{}{
			"2": "only-second",
		})
		if len(result) != 2 {
			t.Fatalf("expected 2 args, got %d", len(result))
		}
		if result[0] != nil {
			t.Errorf("arg[0]: expected nil, got %v", result[0])
		}
		if result[1] != "only-second" {
			t.Errorf("arg[1]: expected only-second, got %v", result[1])
		}
	})

	t.Run("extra params are ignored", func(t *testing.T) {
		result := bindMysqlParams("SELECT * FROM t WHERE id = ?", map[string]interface{}{
			"1": "used",
			"2": "extra",
			"3": "also-extra",
		})
		if len(result) != 1 {
			t.Fatalf("expected 1 arg, got %d", len(result))
		}
		if result[0] != "used" {
			t.Errorf("expected used, got %v", result[0])
		}
	})
}
