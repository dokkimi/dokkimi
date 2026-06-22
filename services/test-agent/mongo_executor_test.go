package main

import (
	"encoding/json"
	"testing"

	"go.mongodb.org/mongo-driver/v2/bson"
)

func TestJsonDecToValue(t *testing.T) {
	decode := func(jsonStr string) bson.D {
		return jsonToBsonD(json.RawMessage(jsonStr))
	}
	decodeValue := func(jsonStr string) interface{} {
		// Wrap in object to decode a single value via jsonDecToValue
		full := `{"v":` + jsonStr + `}`
		d := jsonToBsonD(json.RawMessage(full))
		if len(d) == 0 {
			return nil
		}
		return d[0].Value
	}

	t.Run("integer stays int64 not int32", func(t *testing.T) {
		val := decodeValue("42")
		if v, ok := val.(int64); !ok || v != 42 {
			t.Errorf("expected int64(42), got %T(%v)", val, val)
		}
	})

	t.Run("large integer not truncated", func(t *testing.T) {
		val := decodeValue("1719000000000")
		if v, ok := val.(int64); !ok || v != 1719000000000 {
			t.Errorf("expected int64(1719000000000), got %T(%v)", val, val)
		}
	})

	t.Run("max int64", func(t *testing.T) {
		val := decodeValue("9223372036854775807")
		if v, ok := val.(int64); !ok || v != 9223372036854775807 {
			t.Errorf("expected max int64, got %T(%v)", val, val)
		}
	})

	t.Run("float value", func(t *testing.T) {
		val := decodeValue("3.14")
		if v, ok := val.(float64); !ok || v != 3.14 {
			t.Errorf("expected float64(3.14), got %T(%v)", val, val)
		}
	})

	t.Run("string value", func(t *testing.T) {
		val := decodeValue(`"hello"`)
		if v, ok := val.(string); !ok || v != "hello" {
			t.Errorf("expected string hello, got %T(%v)", val, val)
		}
	})

	t.Run("bool value", func(t *testing.T) {
		val := decodeValue("true")
		if v, ok := val.(bool); !ok || !v {
			t.Errorf("expected true, got %T(%v)", val, val)
		}
	})

	t.Run("null value", func(t *testing.T) {
		val := decodeValue("null")
		if val != nil {
			t.Errorf("expected nil, got %T(%v)", val, val)
		}
	})

	t.Run("nested object returns bson.D", func(t *testing.T) {
		val := decodeValue(`{"a": 1, "b": "two"}`)
		d, ok := val.(bson.D)
		if !ok {
			t.Fatalf("expected bson.D, got %T", val)
		}
		if len(d) != 2 {
			t.Fatalf("expected 2 elements, got %d", len(d))
		}
		if d[0].Key != "a" || d[1].Key != "b" {
			t.Errorf("expected keys a,b got %s,%s", d[0].Key, d[1].Key)
		}
	})

	t.Run("array returns bson.A", func(t *testing.T) {
		val := decodeValue(`[1, "two", true]`)
		arr, ok := val.(bson.A)
		if !ok {
			t.Fatalf("expected bson.A, got %T", val)
		}
		if len(arr) != 3 {
			t.Errorf("expected 3 elements, got %d", len(arr))
		}
	})

	t.Run("preserves key order", func(t *testing.T) {
		d := decode(`{"z": 1, "a": 2, "m": 3}`)
		if len(d) != 3 {
			t.Fatalf("expected 3 elements, got %d", len(d))
		}
		if d[0].Key != "z" || d[1].Key != "a" || d[2].Key != "m" {
			t.Errorf("key order not preserved: %s, %s, %s", d[0].Key, d[1].Key, d[2].Key)
		}
	})
}

func TestParseMongoCommand(t *testing.T) {
	t.Run("parses find command", func(t *testing.T) {
		cmd, err := parseMongoCommand(`{"operation":"find","collection":"users","filter":{"age":25}}`)
		if err != nil {
			t.Fatal(err)
		}
		if cmd.Operation != "find" {
			t.Errorf("expected find, got %s", cmd.Operation)
		}
		if cmd.Collection != "users" {
			t.Errorf("expected users, got %s", cmd.Collection)
		}
		if len(cmd.Filter) != 1 || cmd.Filter[0].Key != "age" {
			t.Errorf("expected filter {age:25}, got %v", cmd.Filter)
		}
	})

	t.Run("parses insertMany with documents array", func(t *testing.T) {
		cmd, err := parseMongoCommand(`{"operation":"insertMany","collection":"items","documents":[{"name":"a"},{"name":"b"}]}`)
		if err != nil {
			t.Fatal(err)
		}
		if len(cmd.Documents) != 2 {
			t.Fatalf("expected 2 documents, got %d", len(cmd.Documents))
		}
		if cmd.Documents[0][0].Value != "a" {
			t.Errorf("expected first doc name=a, got %v", cmd.Documents[0][0].Value)
		}
	})

	t.Run("handles large integer in filter", func(t *testing.T) {
		cmd, err := parseMongoCommand(`{"operation":"find","collection":"events","filter":{"ts":1719000000000}}`)
		if err != nil {
			t.Fatal(err)
		}
		val := cmd.Filter[0].Value
		if v, ok := val.(int64); !ok || v != 1719000000000 {
			t.Errorf("expected int64(1719000000000), got %T(%v)", val, val)
		}
	})

	t.Run("returns error for invalid JSON", func(t *testing.T) {
		_, err := parseMongoCommand("not json")
		if err == nil {
			t.Error("expected error for invalid JSON")
		}
	})
}

func TestJsonToBsonD(t *testing.T) {
	t.Run("returns nil for non-object", func(t *testing.T) {
		d := jsonToBsonD(json.RawMessage(`"just a string"`))
		if d != nil {
			t.Errorf("expected nil for non-object, got %v", d)
		}
	})

	t.Run("empty object returns empty bson.D", func(t *testing.T) {
		d := jsonToBsonD(json.RawMessage(`{}`))
		if len(d) != 0 {
			t.Errorf("expected empty bson.D, got %v", d)
		}
	})

	t.Run("deeply nested structure", func(t *testing.T) {
		d := jsonToBsonD(json.RawMessage(`{"a":{"b":{"c":1}}}`))
		if len(d) != 1 {
			t.Fatalf("expected 1 element, got %d", len(d))
		}
		inner, ok := d[0].Value.(bson.D)
		if !ok {
			t.Fatalf("expected nested bson.D, got %T", d[0].Value)
		}
		innerInner, ok := inner[0].Value.(bson.D)
		if !ok {
			t.Fatalf("expected double-nested bson.D, got %T", inner[0].Value)
		}
		if v, ok := innerInner[0].Value.(int64); !ok || v != 1 {
			t.Errorf("expected int64(1), got %T(%v)", innerInner[0].Value, innerInner[0].Value)
		}
	})
}
