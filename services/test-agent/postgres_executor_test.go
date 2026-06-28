package main

import (
	"testing"
)

func TestCoercePostgresString(t *testing.T) {
	t.Run("INT2 returns int64", func(t *testing.T) {
		got := coercePostgresString("42", "INT2")
		if got != int64(42) {
			t.Errorf("expected int64(42), got %v (%T)", got, got)
		}
	})

	t.Run("INT4 returns int64", func(t *testing.T) {
		got := coercePostgresString("5000", "INT4")
		if got != int64(5000) {
			t.Errorf("expected int64(5000), got %v (%T)", got, got)
		}
	})

	t.Run("INT8 returns int64", func(t *testing.T) {
		got := coercePostgresString("9999999999", "INT8")
		if got != int64(9999999999) {
			t.Errorf("expected int64(9999999999), got %v (%T)", got, got)
		}
	})

	t.Run("NUMERIC integer value returns float64", func(t *testing.T) {
		got := coercePostgresString("5000", "NUMERIC")
		if got != float64(5000) {
			t.Errorf("expected float64(5000), got %v (%T)", got, got)
		}
	})

	t.Run("NUMERIC decimal value returns float64", func(t *testing.T) {
		got := coercePostgresString("49.99", "NUMERIC")
		if got != float64(49.99) {
			t.Errorf("expected float64(49.99), got %v (%T)", got, got)
		}
	})

	t.Run("FLOAT4 returns float64", func(t *testing.T) {
		got := coercePostgresString("3.14", "FLOAT4")
		if got != float64(3.14) {
			t.Errorf("expected float64(3.14), got %v (%T)", got, got)
		}
	})

	t.Run("FLOAT8 returns float64", func(t *testing.T) {
		got := coercePostgresString("2.718281828", "FLOAT8")
		if got != float64(2.718281828) {
			t.Errorf("expected float64(2.718281828), got %v (%T)", got, got)
		}
	})

	t.Run("negative integer", func(t *testing.T) {
		got := coercePostgresString("-100", "INT4")
		if got != int64(-100) {
			t.Errorf("expected int64(-100), got %v (%T)", got, got)
		}
	})

	t.Run("negative numeric", func(t *testing.T) {
		got := coercePostgresString("-99.5", "NUMERIC")
		if got != float64(-99.5) {
			t.Errorf("expected float64(-99.5), got %v (%T)", got, got)
		}
	})

	t.Run("unparseable int falls back to string", func(t *testing.T) {
		got := coercePostgresString("not-a-number", "INT4")
		if got != "not-a-number" {
			t.Errorf("expected string fallback, got %v (%T)", got, got)
		}
	})

	t.Run("unparseable numeric falls back to string", func(t *testing.T) {
		got := coercePostgresString("not-a-number", "NUMERIC")
		if got != "not-a-number" {
			t.Errorf("expected string fallback, got %v (%T)", got, got)
		}
	})

	t.Run("unknown type returns string", func(t *testing.T) {
		got := coercePostgresString("hello", "TEXT")
		if got != "hello" {
			t.Errorf("expected 'hello', got %v (%T)", got, got)
		}
	})

	t.Run("empty type name returns string", func(t *testing.T) {
		got := coercePostgresString("5000", "")
		if got != "5000" {
			t.Errorf("expected string '5000', got %v (%T)", got, got)
		}
	})
}

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
