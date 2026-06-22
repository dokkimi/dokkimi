package main

import (
	"testing"
)

func TestConvertPostgresParams(t *testing.T) {
	t.Run("nil params returns nil args", func(t *testing.T) {
		query, args := convertPostgresParams("SELECT 1", nil)
		if query != "SELECT 1" {
			t.Errorf("expected query unchanged, got %q", query)
		}
		if args != nil {
			t.Errorf("expected nil args, got %v", args)
		}
	})

	t.Run("empty params returns nil args", func(t *testing.T) {
		query, args := convertPostgresParams("SELECT 1", map[string]interface{}{})
		if query != "SELECT 1" {
			t.Errorf("expected query unchanged, got %q", query)
		}
		if args != nil {
			t.Errorf("expected nil args, got %v", args)
		}
	})

	t.Run("single positional param", func(t *testing.T) {
		params := map[string]interface{}{"1": "alice"}
		query, args := convertPostgresParams("SELECT * FROM users WHERE name = $1", params)
		if query != "SELECT * FROM users WHERE name = $1" {
			t.Errorf("expected query unchanged, got %q", query)
		}
		if len(args) != 1 {
			t.Fatalf("expected 1 arg, got %d", len(args))
		}
		if args[0] != "alice" {
			t.Errorf("expected 'alice', got %v", args[0])
		}
	})

	t.Run("multiple positional params", func(t *testing.T) {
		params := map[string]interface{}{
			"1": "alice",
			"2": float64(30),
			"3": true,
		}
		_, args := convertPostgresParams("INSERT INTO users (name, age, active) VALUES ($1, $2, $3)", params)
		if len(args) != 3 {
			t.Fatalf("expected 3 args, got %d", len(args))
		}
		if args[0] != "alice" {
			t.Errorf("expected args[0]='alice', got %v", args[0])
		}
		if args[1] != float64(30) {
			t.Errorf("expected args[1]=30, got %v", args[1])
		}
		if args[2] != true {
			t.Errorf("expected args[2]=true, got %v", args[2])
		}
	})

	t.Run("non-numeric keys are ignored", func(t *testing.T) {
		params := map[string]interface{}{
			"name": "alice",
			"age":  float64(30),
		}
		_, args := convertPostgresParams("SELECT 1", params)
		if args != nil {
			t.Errorf("expected nil args for non-numeric keys, got %v", args)
		}
	})

	t.Run("sparse positional params fills gaps with nil", func(t *testing.T) {
		params := map[string]interface{}{
			"1": "first",
			"3": "third",
		}
		_, args := convertPostgresParams("SELECT $1, $2, $3", params)
		if len(args) != 3 {
			t.Fatalf("expected 3 args, got %d", len(args))
		}
		if args[0] != "first" {
			t.Errorf("expected args[0]='first', got %v", args[0])
		}
		if args[1] != nil {
			t.Errorf("expected args[1]=nil, got %v", args[1])
		}
		if args[2] != "third" {
			t.Errorf("expected args[2]='third', got %v", args[2])
		}
	})

	t.Run("query string passes through unchanged", func(t *testing.T) {
		original := "SELECT * FROM users WHERE id = $1 AND active = $2"
		params := map[string]interface{}{"1": float64(42), "2": true}
		query, _ := convertPostgresParams(original, params)
		if query != original {
			t.Errorf("expected query unchanged, got %q", query)
		}
	})
}
