package main

import (
	"bufio"
	"bytes"
	"fmt"
	"testing"
)

func TestBoolToInt(t *testing.T) {
	if boolToInt("t") != 1 {
		t.Error("expected 1 for 't'")
	}
	if boolToInt("f") != 0 {
		t.Error("expected 0 for 'f'")
	}
	if boolToInt("anything") != 0 {
		t.Error("expected 0 for unknown string")
	}
	if boolToInt("") != 0 {
		t.Error("expected 0 for empty string")
	}
}

func TestExtractCommand_NonArray(t *testing.T) {
	tests := []struct {
		name string
		val  respValue
		want string
	}{
		{"null array", respValue{typ: respArray, isNull: true}, ""},
		{"empty array", respValue{typ: respArray, array: []respValue{}}, ""},
		{"integer", respValue{typ: respInteger, integer: 42}, ""},
		{"bulk string", respValue{typ: respBulkString, str: "test"}, ""},
		{"null bulk", respValue{typ: respBulkString, isNull: true}, ""},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := extractCommand(&tt.val)
			if got != tt.want {
				t.Errorf("got %q, want %q", got, tt.want)
			}
		})
	}
}

func TestExtractCommandName_EdgeCases(t *testing.T) {
	tests := []struct {
		name string
		val  respValue
		want string
	}{
		{"null array", respValue{typ: respArray, isNull: true}, ""},
		{"empty array", respValue{typ: respArray, array: []respValue{}}, ""},
		{"simple string multi-word", respValue{typ: respSimpleString, str: "ping extra"}, "PING"},
		{"simple string single", respValue{typ: respSimpleString, str: "quit"}, "QUIT"},
		{"integer type", respValue{typ: respInteger, integer: 5}, ""},
		{"lowercase command", respValue{typ: respArray, array: []respValue{
			{typ: respBulkString, str: "hgetall"},
		}}, "HGETALL"},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := extractCommandName(&tt.val)
			if got != tt.want {
				t.Errorf("got %q, want %q", got, tt.want)
			}
		})
	}
}

func TestNormalizeResponse_Double(t *testing.T) {
	val := &respValue{typ: respDouble, str: "3.14"}
	result := normalizeResponse("SOME_CMD", val)
	if len(result) != 1 {
		t.Fatalf("expected 1 row, got %d", len(result))
	}
	if result[0]["value"] != "3.14" {
		t.Errorf("expected '3.14', got %v", result[0]["value"])
	}
}

func TestNormalizeResponse_EmptyArray(t *testing.T) {
	val := &respValue{typ: respArray, array: []respValue{}}
	result := normalizeResponse("KEYS", val)
	if len(result) != 0 {
		t.Errorf("expected 0 rows, got %d", len(result))
	}
}

func TestNormalizeResponse_Set(t *testing.T) {
	val := &respValue{
		typ: respSet,
		array: []respValue{
			{typ: respBulkString, str: "a"},
			{typ: respBulkString, str: "b"},
		},
	}
	result := normalizeResponse("SMEMBERS", val)
	if len(result) != 2 {
		t.Fatalf("expected 2 rows, got %d", len(result))
	}
	if result[0]["value"] != "a" {
		t.Errorf("expected 'a', got %v", result[0]["value"])
	}
}

func TestNormalizeResponse_UnknownType(t *testing.T) {
	val := &respValue{typ: respBigNumber, str: "999999999999999999"}
	result := normalizeResponse("DEBUG", val)
	if len(result) != 0 {
		t.Errorf("expected 0 rows for unknown type, got %d", len(result))
	}
}

func TestNormalizeResponse_NilValue(t *testing.T) {
	result := normalizeResponse("GET", nil)
	if len(result) != 0 {
		t.Errorf("expected 0 rows for nil, got %d", len(result))
	}
}

func TestNormalizeResponse_HGETALL_OddCount(t *testing.T) {
	val := &respValue{
		typ: respArray,
		array: []respValue{
			{typ: respBulkString, str: "field1"},
			{typ: respBulkString, str: "value1"},
			{typ: respBulkString, str: "orphan"},
		},
	}
	result := normalizeResponse("HGETALL", val)
	// Odd count → falls through to regular array normalization
	if len(result) != 3 {
		t.Fatalf("expected 3 rows (array fallback), got %d", len(result))
	}
}

func TestNormalizeResponse_MapOddElements(t *testing.T) {
	val := &respValue{
		typ:   respMap,
		array: []respValue{{typ: respSimpleString, str: "lone"}},
	}
	result := normalizeResponse("INFO", val)
	if len(result) != 0 {
		t.Errorf("expected 0 rows for odd map elements, got %d", len(result))
	}
}

func TestRespToInterface_AllTypes(t *testing.T) {
	tests := []struct {
		name string
		val  respValue
		want interface{}
	}{
		{"null", respValue{isNull: true}, nil},
		{"integer", respValue{typ: respInteger, integer: 42}, int64(42)},
		{"double", respValue{typ: respDouble, str: "3.14"}, 3.14},
		{"double invalid", respValue{typ: respDouble, str: "not-a-number"}, "not-a-number"},
		{"boolean true", respValue{typ: respBoolean, integer: 1}, true},
		{"boolean false", respValue{typ: respBoolean, integer: 0}, false},
		{"bulk string", respValue{typ: respBulkString, str: "hello"}, "hello"},
		{"simple string", respValue{typ: respSimpleString, str: "OK"}, "OK"},
		{"big number", respValue{typ: respBigNumber, str: "99999999"}, "99999999"},
		{"error type", respValue{typ: respError, str: "ERR"}, "ERR"},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := respToInterface(tt.val)
			if fmt.Sprintf("%v", got) != fmt.Sprintf("%v", tt.want) {
				t.Errorf("got %v (%T), want %v (%T)", got, got, tt.want, tt.want)
			}
		})
	}
}

func TestRespToInterface_NestedArray(t *testing.T) {
	val := respValue{
		typ: respArray,
		array: []respValue{
			{typ: respInteger, integer: 1},
			{typ: respArray, array: []respValue{
				{typ: respBulkString, str: "nested"},
			}},
		},
	}
	result := respToInterface(val)
	arr, ok := result.([]interface{})
	if !ok {
		t.Fatalf("expected []interface{}, got %T", result)
	}
	if len(arr) != 2 {
		t.Fatalf("expected 2 elements, got %d", len(arr))
	}
	inner, ok := arr[1].([]interface{})
	if !ok {
		t.Fatalf("expected nested []interface{}, got %T", arr[1])
	}
	if inner[0] != "nested" {
		t.Errorf("expected 'nested', got %v", inner[0])
	}
}

func TestRespToInterface_Map(t *testing.T) {
	val := respValue{
		typ: respMap,
		array: []respValue{
			{typ: respSimpleString, str: "key"},
			{typ: respInteger, integer: 42},
		},
	}
	result := respToInterface(val)
	m, ok := result.(map[string]interface{})
	if !ok {
		t.Fatalf("expected map[string]interface{}, got %T", result)
	}
	if m["key"] != int64(42) {
		t.Errorf("expected 42, got %v", m["key"])
	}
}

func TestReadRESP_EmptyBulkString(t *testing.T) {
	input := "$0\r\n\r\n"
	r := bufio.NewReader(bytes.NewReader([]byte(input)))
	val, err := readRESP(r)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if val.str != "" {
		t.Errorf("expected empty string, got %q", val.str)
	}
	if val.isNull {
		t.Error("expected non-null")
	}
}

func TestReadRESP_NegativeInteger(t *testing.T) {
	input := ":-100\r\n"
	r := bufio.NewReader(bytes.NewReader([]byte(input)))
	val, err := readRESP(r)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if val.integer != -100 {
		t.Errorf("expected -100, got %d", val.integer)
	}
}

func TestReadRESP_EmptyArray(t *testing.T) {
	input := "*0\r\n"
	r := bufio.NewReader(bytes.NewReader([]byte(input)))
	val, err := readRESP(r)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if val.typ != respArray {
		t.Errorf("expected array, got '%c'", val.typ)
	}
	if len(val.array) != 0 {
		t.Errorf("expected 0 elements, got %d", len(val.array))
	}
}

func TestReadRESP_InlineCommand(t *testing.T) {
	input := "PING\r\n"
	r := bufio.NewReader(bytes.NewReader([]byte(input)))
	val, err := readRESP(r)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if val.typ != respSimpleString {
		t.Errorf("expected simple string, got '%c'", val.typ)
	}
	if val.str != "PING" {
		t.Errorf("expected 'PING', got %q", val.str)
	}
}

func TestReadRESP_NullVerbatimString(t *testing.T) {
	input := "=-1\r\n"
	r := bufio.NewReader(bytes.NewReader([]byte(input)))
	val, err := readRESP(r)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !val.isNull {
		t.Error("expected null verbatim string")
	}
}

func TestReadRESP_NullBulkError(t *testing.T) {
	input := "!-1\r\n"
	r := bufio.NewReader(bytes.NewReader([]byte(input)))
	val, err := readRESP(r)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !val.isNull {
		t.Error("expected null bulk error")
	}
}

func TestReadRESP_Attribute(t *testing.T) {
	input := "|1\r\n+key\r\n+val\r\n"
	r := bufio.NewReader(bytes.NewReader([]byte(input)))
	val, err := readRESP(r)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if val.typ != respAttribute {
		t.Errorf("expected attribute type, got '%c'", val.typ)
	}
	if len(val.array) != 2 {
		t.Fatalf("expected 2 elements, got %d", len(val.array))
	}
}

func TestReadRESP_Push(t *testing.T) {
	input := ">2\r\n+subscribe\r\n+channel\r\n"
	r := bufio.NewReader(bytes.NewReader([]byte(input)))
	val, err := readRESP(r)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if val.typ != respPush {
		t.Errorf("expected push type, got '%c'", val.typ)
	}
	if len(val.array) != 2 {
		t.Fatalf("expected 2 elements, got %d", len(val.array))
	}
}

func TestNormalizeResponse_BulkString(t *testing.T) {
	val := &respValue{typ: respBulkString, str: "hello world"}
	result := normalizeResponse("GET", val)
	if len(result) != 1 {
		t.Fatalf("expected 1 row, got %d", len(result))
	}
	if result[0]["value"] != "hello world" {
		t.Errorf("expected 'hello world', got %v", result[0]["value"])
	}
}

func TestNormalizeResponse_Attribute(t *testing.T) {
	val := &respValue{
		typ: respAttribute,
		array: []respValue{
			{typ: respSimpleString, str: "ttl"},
			{typ: respInteger, integer: 3600},
		},
	}
	result := normalizeResponse("DEBUG", val)
	if len(result) != 1 {
		t.Fatalf("expected 1 row, got %d", len(result))
	}
	if result[0]["ttl"] != int64(3600) {
		t.Errorf("expected 3600, got %v", result[0]["ttl"])
	}
}
