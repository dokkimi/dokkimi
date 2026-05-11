package main

import (
	"bufio"
	"bytes"
	"testing"
)

func TestReadRESP_SimpleString(t *testing.T) {
	input := "+OK\r\n"
	r := bufio.NewReader(bytes.NewReader([]byte(input)))
	val, err := readRESP(r)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if val.typ != respSimpleString {
		t.Errorf("expected type '+', got '%c'", val.typ)
	}
	if val.str != "OK" {
		t.Errorf("expected 'OK', got '%s'", val.str)
	}
	if string(val.rawBytes) != input {
		t.Errorf("rawBytes mismatch: %q vs %q", val.rawBytes, input)
	}
}

func TestReadRESP_Error(t *testing.T) {
	input := "-ERR unknown command\r\n"
	r := bufio.NewReader(bytes.NewReader([]byte(input)))
	val, err := readRESP(r)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if val.typ != respError {
		t.Errorf("expected type '-', got '%c'", val.typ)
	}
	if val.str != "ERR unknown command" {
		t.Errorf("expected 'ERR unknown command', got '%s'", val.str)
	}
}

func TestReadRESP_Integer(t *testing.T) {
	input := ":42\r\n"
	r := bufio.NewReader(bytes.NewReader([]byte(input)))
	val, err := readRESP(r)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if val.typ != respInteger {
		t.Errorf("expected type ':', got '%c'", val.typ)
	}
	if val.integer != 42 {
		t.Errorf("expected 42, got %d", val.integer)
	}
}

func TestReadRESP_BulkString(t *testing.T) {
	input := "$6\r\nfoobar\r\n"
	r := bufio.NewReader(bytes.NewReader([]byte(input)))
	val, err := readRESP(r)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if val.typ != respBulkString {
		t.Errorf("expected type '$', got '%c'", val.typ)
	}
	if val.str != "foobar" {
		t.Errorf("expected 'foobar', got '%s'", val.str)
	}
}

func TestReadRESP_NullBulkString(t *testing.T) {
	input := "$-1\r\n"
	r := bufio.NewReader(bytes.NewReader([]byte(input)))
	val, err := readRESP(r)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !val.isNull {
		t.Error("expected null bulk string")
	}
}

func TestReadRESP_Array(t *testing.T) {
	input := "*3\r\n$3\r\nSET\r\n$3\r\nkey\r\n$5\r\nvalue\r\n"
	r := bufio.NewReader(bytes.NewReader([]byte(input)))
	val, err := readRESP(r)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if val.typ != respArray {
		t.Errorf("expected type '*', got '%c'", val.typ)
	}
	if len(val.array) != 3 {
		t.Fatalf("expected 3 elements, got %d", len(val.array))
	}
	if val.array[0].str != "SET" {
		t.Errorf("expected 'SET', got '%s'", val.array[0].str)
	}
	if val.array[1].str != "key" {
		t.Errorf("expected 'key', got '%s'", val.array[1].str)
	}
	if val.array[2].str != "value" {
		t.Errorf("expected 'value', got '%s'", val.array[2].str)
	}
	if string(val.rawBytes) != input {
		t.Errorf("rawBytes mismatch: %q vs %q", val.rawBytes, input)
	}
}

func TestReadRESP_NullArray(t *testing.T) {
	input := "*-1\r\n"
	r := bufio.NewReader(bytes.NewReader([]byte(input)))
	val, err := readRESP(r)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !val.isNull {
		t.Error("expected null array")
	}
}

func TestExtractCommand(t *testing.T) {
	tests := []struct {
		name     string
		input    string
		expected string
	}{
		{
			"SET command",
			"*3\r\n$3\r\nSET\r\n$3\r\nkey\r\n$5\r\nvalue\r\n",
			"SET key value",
		},
		{
			"GET command",
			"*2\r\n$3\r\nGET\r\n$3\r\nkey\r\n",
			"GET key",
		},
		{
			"PING inline",
			"+PING\r\n",
			"PING",
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			r := bufio.NewReader(bytes.NewReader([]byte(tc.input)))
			val, err := readRESP(r)
			if err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
			cmd := extractCommand(val)
			if cmd != tc.expected {
				t.Errorf("expected %q, got %q", tc.expected, cmd)
			}
		})
	}
}

func TestExtractCommandName(t *testing.T) {
	input := "*3\r\n$3\r\nset\r\n$3\r\nkey\r\n$5\r\nvalue\r\n"
	r := bufio.NewReader(bytes.NewReader([]byte(input)))
	val, err := readRESP(r)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	name := extractCommandName(val)
	if name != "SET" {
		t.Errorf("expected 'SET', got '%s'", name)
	}
}

func TestNormalizeResponse_Scalar(t *testing.T) {
	val := &respValue{typ: respSimpleString, str: "OK"}
	result := normalizeResponse("SET", val)
	if len(result) != 1 {
		t.Fatalf("expected 1 row, got %d", len(result))
	}
	if result[0]["value"] != "OK" {
		t.Errorf("expected 'OK', got %v", result[0]["value"])
	}
}

func TestNormalizeResponse_Integer(t *testing.T) {
	val := &respValue{typ: respInteger, integer: 5}
	result := normalizeResponse("INCR", val)
	if len(result) != 1 {
		t.Fatalf("expected 1 row, got %d", len(result))
	}
	if result[0]["value"] != int64(5) {
		t.Errorf("expected 5, got %v", result[0]["value"])
	}
}

func TestNormalizeResponse_Array(t *testing.T) {
	val := &respValue{
		typ: respArray,
		array: []respValue{
			{typ: respBulkString, str: "a"},
			{typ: respBulkString, str: "b"},
			{typ: respBulkString, str: "c"},
		},
	}
	result := normalizeResponse("LRANGE", val)
	if len(result) != 3 {
		t.Fatalf("expected 3 rows, got %d", len(result))
	}
	if result[0]["value"] != "a" {
		t.Errorf("expected 'a', got %v", result[0]["value"])
	}
}

func TestNormalizeResponse_HGETALL(t *testing.T) {
	val := &respValue{
		typ: respArray,
		array: []respValue{
			{typ: respBulkString, str: "field1"},
			{typ: respBulkString, str: "value1"},
			{typ: respBulkString, str: "field2"},
			{typ: respBulkString, str: "value2"},
		},
	}
	result := normalizeResponse("HGETALL", val)
	if len(result) != 1 {
		t.Fatalf("expected 1 row, got %d", len(result))
	}
	if result[0]["field1"] != "value1" {
		t.Errorf("expected 'value1', got %v", result[0]["field1"])
	}
	if result[0]["field2"] != "value2" {
		t.Errorf("expected 'value2', got %v", result[0]["field2"])
	}
}

func TestNormalizeResponse_Null(t *testing.T) {
	val := &respValue{typ: respBulkString, isNull: true}
	result := normalizeResponse("GET", val)
	if len(result) != 0 {
		t.Errorf("expected 0 rows for null, got %d", len(result))
	}
}

func TestNormalizeResponse_Error(t *testing.T) {
	val := &respValue{typ: respError, str: "ERR something went wrong"}
	result := normalizeResponse("SET", val)
	if result != nil {
		t.Errorf("expected nil for error, got %v", result)
	}
}

// --- RESP3 tests ---

func TestReadRESP_Map(t *testing.T) {
	// %2\r\n+key1\r\n:10\r\n+key2\r\n:20\r\n
	input := "%2\r\n+key1\r\n:10\r\n+key2\r\n:20\r\n"
	r := bufio.NewReader(bytes.NewReader([]byte(input)))
	val, err := readRESP(r)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if val.typ != respMap {
		t.Errorf("expected type '%%', got '%c'", val.typ)
	}
	// 2 entries = 4 elements in array
	if len(val.array) != 4 {
		t.Fatalf("expected 4 elements (2 key-value pairs), got %d", len(val.array))
	}
	if val.array[0].str != "key1" {
		t.Errorf("expected 'key1', got '%s'", val.array[0].str)
	}
	if val.array[1].integer != 10 {
		t.Errorf("expected 10, got %d", val.array[1].integer)
	}
	if val.array[2].str != "key2" {
		t.Errorf("expected 'key2', got '%s'", val.array[2].str)
	}
	if val.array[3].integer != 20 {
		t.Errorf("expected 20, got %d", val.array[3].integer)
	}
	if string(val.rawBytes) != input {
		t.Errorf("rawBytes mismatch: %q vs %q", val.rawBytes, input)
	}
}

func TestReadRESP_Null(t *testing.T) {
	input := "_\r\n"
	r := bufio.NewReader(bytes.NewReader([]byte(input)))
	val, err := readRESP(r)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !val.isNull {
		t.Error("expected null")
	}
}

func TestReadRESP_Double(t *testing.T) {
	input := ",3.14\r\n"
	r := bufio.NewReader(bytes.NewReader([]byte(input)))
	val, err := readRESP(r)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if val.typ != respDouble {
		t.Errorf("expected type ',', got '%c'", val.typ)
	}
	if val.str != "3.14" {
		t.Errorf("expected '3.14', got '%s'", val.str)
	}
}

func TestReadRESP_Boolean(t *testing.T) {
	tests := []struct {
		input    string
		expected int64
	}{
		{"#t\r\n", 1},
		{"#f\r\n", 0},
	}
	for _, tc := range tests {
		r := bufio.NewReader(bytes.NewReader([]byte(tc.input)))
		val, err := readRESP(r)
		if err != nil {
			t.Fatalf("unexpected error for %q: %v", tc.input, err)
		}
		if val.typ != respBoolean {
			t.Errorf("expected type '#', got '%c'", val.typ)
		}
		if val.integer != tc.expected {
			t.Errorf("expected %d, got %d", tc.expected, val.integer)
		}
	}
}

func TestReadRESP_BulkError(t *testing.T) {
	input := "!11\r\nERR timeout\r\n"
	r := bufio.NewReader(bytes.NewReader([]byte(input)))
	val, err := readRESP(r)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	// Bulk errors are normalized to respError
	if val.typ != respError {
		t.Errorf("expected type '-' (error), got '%c'", val.typ)
	}
	if val.str != "ERR timeout" {
		t.Errorf("expected 'ERR timeout', got '%s'", val.str)
	}
}

func TestReadRESP_VerbatimString(t *testing.T) {
	// =15\r\ntxt:hello world\r\n (3 byte encoding + : + content)
	input := "=15\r\ntxt:hello world\r\n"
	r := bufio.NewReader(bytes.NewReader([]byte(input)))
	val, err := readRESP(r)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	// Verbatim strings are normalized to respBulkString with encoding stripped
	if val.typ != respBulkString {
		t.Errorf("expected type '$' (bulk string), got '%c'", val.typ)
	}
	if val.str != "hello world" {
		t.Errorf("expected 'hello world', got '%s'", val.str)
	}
}

func TestReadRESP_Set(t *testing.T) {
	input := "~3\r\n+a\r\n+b\r\n+c\r\n"
	r := bufio.NewReader(bytes.NewReader([]byte(input)))
	val, err := readRESP(r)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if val.typ != respSet {
		t.Errorf("expected type '~', got '%c'", val.typ)
	}
	if len(val.array) != 3 {
		t.Fatalf("expected 3 elements, got %d", len(val.array))
	}
}

func TestReadRESP_BigNumber(t *testing.T) {
	input := "(3492890328409238509324850943850943825024385\r\n"
	r := bufio.NewReader(bytes.NewReader([]byte(input)))
	val, err := readRESP(r)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if val.typ != respBigNumber {
		t.Errorf("expected type '(', got '%c'", val.typ)
	}
	if val.str != "3492890328409238509324850943850943825024385" {
		t.Errorf("unexpected big number: %s", val.str)
	}
}

func TestReadRESP_NestedMapInArray(t *testing.T) {
	// Array containing a map: *1\r\n%1\r\n+k\r\n+v\r\n
	input := "*1\r\n%1\r\n+k\r\n+v\r\n"
	r := bufio.NewReader(bytes.NewReader([]byte(input)))
	val, err := readRESP(r)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if val.typ != respArray {
		t.Fatalf("expected array, got '%c'", val.typ)
	}
	if len(val.array) != 1 {
		t.Fatalf("expected 1 element, got %d", len(val.array))
	}
	inner := val.array[0]
	if inner.typ != respMap {
		t.Errorf("expected map, got '%c'", inner.typ)
	}
	if len(inner.array) != 2 {
		t.Fatalf("expected 2 elements in map, got %d", len(inner.array))
	}
}

func TestReadRESP_HELLO3Response(t *testing.T) {
	// Simulates a HELLO 3 response: a RESP3 map with nested values
	// %3\r\n+server\r\n+redis\r\n+version\r\n+7.0.0\r\n+proto\r\n:3\r\n
	input := "%3\r\n+server\r\n+redis\r\n+version\r\n+7.0.0\r\n+proto\r\n:3\r\n"
	r := bufio.NewReader(bytes.NewReader([]byte(input)))
	val, err := readRESP(r)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if val.typ != respMap {
		t.Errorf("expected map type, got '%c'", val.typ)
	}
	// 3 entries = 6 elements
	if len(val.array) != 6 {
		t.Fatalf("expected 6 elements, got %d", len(val.array))
	}
	// Verify we can convert to interface without panic
	iface := respToInterface(*val)
	m, ok := iface.(map[string]interface{})
	if !ok {
		t.Fatalf("expected map[string]interface{}, got %T", iface)
	}
	if m["server"] != "redis" {
		t.Errorf("expected server=redis, got %v", m["server"])
	}
	if m["proto"] != int64(3) {
		t.Errorf("expected proto=3, got %v", m["proto"])
	}
	// rawBytes should contain the entire message
	if string(val.rawBytes) != input {
		t.Errorf("rawBytes mismatch: %q vs %q", val.rawBytes, input)
	}
}

func TestNormalizeResponse_Map(t *testing.T) {
	val := &respValue{
		typ: respMap,
		array: []respValue{
			{typ: respSimpleString, str: "server"},
			{typ: respSimpleString, str: "redis"},
			{typ: respSimpleString, str: "proto"},
			{typ: respInteger, integer: 3},
		},
	}
	result := normalizeResponse("HELLO", val)
	if len(result) != 1 {
		t.Fatalf("expected 1 row, got %d", len(result))
	}
	if result[0]["server"] != "redis" {
		t.Errorf("expected 'redis', got %v", result[0]["server"])
	}
	if result[0]["proto"] != int64(3) {
		t.Errorf("expected 3, got %v", result[0]["proto"])
	}
}

func TestNormalizeResponse_Boolean(t *testing.T) {
	val := &respValue{typ: respBoolean, str: "t", integer: 1}
	result := normalizeResponse("EXISTS", val)
	if len(result) != 1 {
		t.Fatalf("expected 1 row, got %d", len(result))
	}
	if result[0]["value"] != true {
		t.Errorf("expected true, got %v", result[0]["value"])
	}
}

func TestNormalizeResponse_RESP3Null(t *testing.T) {
	val := &respValue{typ: respNull, isNull: true}
	result := normalizeResponse("GET", val)
	if len(result) != 0 {
		t.Errorf("expected 0 rows for RESP3 null, got %d", len(result))
	}
}
