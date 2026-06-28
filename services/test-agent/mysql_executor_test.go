package main

import (
	"testing"
)

func TestCoerceMysqlString(t *testing.T) {
	t.Run("INT returns int64", func(t *testing.T) {
		got := coerceMysqlString("42", "INT")
		if got != int64(42) {
			t.Errorf("expected int64(42), got %v (%T)", got, got)
		}
	})

	t.Run("BIGINT returns int64", func(t *testing.T) {
		got := coerceMysqlString("9999999999", "BIGINT")
		if got != int64(9999999999) {
			t.Errorf("expected int64(9999999999), got %v (%T)", got, got)
		}
	})

	t.Run("TINYINT returns int64", func(t *testing.T) {
		got := coerceMysqlString("1", "TINYINT")
		if got != int64(1) {
			t.Errorf("expected int64(1), got %v (%T)", got, got)
		}
	})

	t.Run("DECIMAL returns float64", func(t *testing.T) {
		got := coerceMysqlString("49.99", "DECIMAL")
		if got != float64(49.99) {
			t.Errorf("expected float64(49.99), got %v (%T)", got, got)
		}
	})

	t.Run("FLOAT returns float64", func(t *testing.T) {
		got := coerceMysqlString("3.14", "FLOAT")
		if got != float64(3.14) {
			t.Errorf("expected float64(3.14), got %v (%T)", got, got)
		}
	})

	t.Run("DOUBLE returns float64", func(t *testing.T) {
		got := coerceMysqlString("2.718281828", "DOUBLE")
		if got != float64(2.718281828) {
			t.Errorf("expected float64(2.718281828), got %v (%T)", got, got)
		}
	})

	t.Run("YEAR returns int64", func(t *testing.T) {
		got := coerceMysqlString("2026", "YEAR")
		if got != int64(2026) {
			t.Errorf("expected int64(2026), got %v (%T)", got, got)
		}
	})

	t.Run("negative integer", func(t *testing.T) {
		got := coerceMysqlString("-100", "INT")
		if got != int64(-100) {
			t.Errorf("expected int64(-100), got %v (%T)", got, got)
		}
	})

	t.Run("unparseable int falls back to string", func(t *testing.T) {
		got := coerceMysqlString("not-a-number", "INT")
		if got != "not-a-number" {
			t.Errorf("expected string fallback, got %v (%T)", got, got)
		}
	})

	t.Run("unknown type returns string", func(t *testing.T) {
		got := coerceMysqlString("hello", "VARCHAR")
		if got != "hello" {
			t.Errorf("expected 'hello', got %v (%T)", got, got)
		}
	})

	t.Run("empty type name returns string", func(t *testing.T) {
		got := coerceMysqlString("5000", "")
		if got != "5000" {
			t.Errorf("expected string '5000', got %v (%T)", got, got)
		}
	})
}

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
