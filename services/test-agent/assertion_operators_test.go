package main

import (
	"testing"
)

func TestLooseEqual(t *testing.T) {
	t.Run("nil equals nil", func(t *testing.T) {
		if !looseEqual(nil, nil) {
			t.Error("expected nil == nil")
		}
	})

	t.Run("nil not equal to zero", func(t *testing.T) {
		if looseEqual(nil, float64(0)) {
			t.Error("expected nil != 0")
		}
	})

	t.Run("nil not equal to empty string", func(t *testing.T) {
		if looseEqual(nil, "") {
			t.Error("expected nil != empty string")
		}
	})

	t.Run("nil not equal to false", func(t *testing.T) {
		if looseEqual(nil, false) {
			t.Error("expected nil != false")
		}
	})

	t.Run("numeric string equals float", func(t *testing.T) {
		if !looseEqual("42", float64(42)) {
			t.Error("expected '42' == 42.0")
		}
	})

	t.Run("bool string equals bool", func(t *testing.T) {
		if !looseEqual("true", true) {
			t.Error("expected 'true' == true")
		}
	})

	t.Run("different strings not equal", func(t *testing.T) {
		if looseEqual("abc", "def") {
			t.Error("expected abc != def")
		}
	})

	t.Run("deep equal slices", func(t *testing.T) {
		a := []interface{}{float64(1), "two"}
		b := []interface{}{float64(1), "two"}
		if !looseEqual(a, b) {
			t.Error("expected equal slices")
		}
	})

	t.Run("deep equal maps", func(t *testing.T) {
		a := map[string]interface{}{"x": float64(1)}
		b := map[string]interface{}{"x": float64(1)}
		if !looseEqual(a, b) {
			t.Error("expected equal maps")
		}
	})
}

func TestContainsIgnoreCaseDispatch(t *testing.T) {
	t.Run("string contains case-insensitive", func(t *testing.T) {
		r := containsIgnoreCaseDispatch("Hello World", "hello", false)
		if !r.Passed {
			t.Error("expected pass")
		}
	})

	t.Run("string not contains case-insensitive", func(t *testing.T) {
		r := containsIgnoreCaseDispatch("Hello World", "goodbye", true)
		if !r.Passed {
			t.Error("expected pass for notContains")
		}
	})

	t.Run("array contains element case-insensitive", func(t *testing.T) {
		arr := []interface{}{"Alpha", "BRAVO", "charlie"}
		r := containsIgnoreCaseDispatch(arr, "bravo", false)
		if !r.Passed {
			t.Error("expected pass for case-insensitive array contains")
		}
	})

	t.Run("array not contains element case-insensitive", func(t *testing.T) {
		arr := []interface{}{"Alpha", "BRAVO"}
		r := containsIgnoreCaseDispatch(arr, "delta", false)
		if r.Passed {
			t.Error("expected fail — delta not in array")
		}
	})

	t.Run("object contains key case-insensitive", func(t *testing.T) {
		obj := map[string]interface{}{"Content-Type": "application/json", "Authorization": "Bearer x"}
		r := containsIgnoreCaseDispatch(obj, "content-type", false)
		if !r.Passed {
			t.Error("expected pass for case-insensitive key lookup")
		}
	})

	t.Run("object not contains key case-insensitive", func(t *testing.T) {
		obj := map[string]interface{}{"Content-Type": "application/json"}
		r := containsIgnoreCaseDispatch(obj, "x-custom", false)
		if r.Passed {
			t.Error("expected fail — key not present")
		}
	})

	t.Run("negate on string", func(t *testing.T) {
		r := containsIgnoreCaseDispatch("Hello World", "HELLO", true)
		if r.Passed {
			t.Error("expected fail for negate — string does contain hello")
		}
	})

	t.Run("nil actual returns error", func(t *testing.T) {
		r := containsIgnoreCaseDispatch(nil, "test", false)
		if r.Passed {
			t.Error("expected fail for nil actual")
		}
		if r.Error == "" {
			t.Error("expected error message for nil actual")
		}
	})

	t.Run("unsupported type returns error", func(t *testing.T) {
		r := containsIgnoreCaseDispatch(float64(42), "test", false)
		if r.Passed {
			t.Error("expected fail for numeric actual")
		}
		if r.Error == "" {
			t.Error("expected error message for numeric actual")
		}
	})
}

func TestContainsDispatch(t *testing.T) {
	t.Run("string contains substring", func(t *testing.T) {
		r := containsDispatch("hello world", "world", false)
		if !r.Passed {
			t.Error("expected pass")
		}
	})

	t.Run("array contains element", func(t *testing.T) {
		arr := []interface{}{"a", "b", "c"}
		r := containsDispatch(arr, "b", false)
		if !r.Passed {
			t.Error("expected pass for array contains")
		}
	})

	t.Run("array not contains element", func(t *testing.T) {
		arr := []interface{}{"a", "b", "c"}
		r := containsDispatch(arr, "d", false)
		if r.Passed {
			t.Error("expected fail — d not in array")
		}
	})

	t.Run("object contains key", func(t *testing.T) {
		obj := map[string]interface{}{"name": "alice", "age": float64(30)}
		r := containsDispatch(obj, "name", false)
		if !r.Passed {
			t.Error("expected pass for object key existence")
		}
	})

	t.Run("object not contains key", func(t *testing.T) {
		obj := map[string]interface{}{"name": "alice"}
		r := containsDispatch(obj, "email", false)
		if r.Passed {
			t.Error("expected fail — email not a key")
		}
	})

	t.Run("negate array contains", func(t *testing.T) {
		arr := []interface{}{"a", "b"}
		r := containsDispatch(arr, "a", true)
		if r.Passed {
			t.Error("expected fail for negate — a is in array")
		}
	})

	t.Run("nil actual returns error", func(t *testing.T) {
		r := containsDispatch(nil, "test", false)
		if r.Passed {
			t.Error("expected fail for nil")
		}
		if r.Error == "" {
			t.Error("expected error message")
		}
	})
}
