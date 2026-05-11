package main

import (
	"bytes"
	"encoding/binary"
	"reflect"
	"testing"
)

func TestIndexOf(t *testing.T) {
	tests := []struct {
		name   string
		b      []byte
		target byte
		want   int
	}{
		{"found at start", []byte{0, 1, 2}, 0, 0},
		{"found in middle", []byte{1, 2, 3}, 2, 1},
		{"found at end", []byte{1, 2, 3}, 3, 2},
		{"not found", []byte{1, 2, 3}, 4, -1},
		{"empty slice", []byte{}, 0, -1},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := indexOf(tt.b, tt.target)
			if got != tt.want {
				t.Errorf("got %d, want %d", got, tt.want)
			}
		})
	}
}

func TestCoerceValue(t *testing.T) {
	tests := []struct {
		name string
		s    string
		oid  uint32
		want interface{}
	}{
		{"int2", "42", 21, int64(42)},
		{"int4", "100", 23, int64(100)},
		{"int8", "9999999999", 20, int64(9999999999)},
		{"negative int", "-5", 23, int64(-5)},
		{"float4", "3.14", 700, 3.14},
		{"float8", "2.718", 701, 2.718},
		{"numeric", "99.99", 1700, 99.99},
		{"bool true t", "t", 16, true},
		{"bool true word", "true", 16, true},
		{"bool false f", "f", 16, false},
		{"bool false word", "false", 16, false},
		{"text", "hello", 25, "hello"},
		{"invalid int", "abc", 23, "abc"},
		{"invalid float", "xyz", 701, "xyz"},
		{"unknown oid", "foo", 9999, "foo"},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := coerceValue(tt.s, tt.oid)
			if !reflect.DeepEqual(got, tt.want) {
				t.Errorf("got %v (%T), want %v (%T)", got, got, tt.want, tt.want)
			}
		})
	}
}

func TestReadStartupMessage_InvalidLength(t *testing.T) {
	// Length too small (< 4)
	buf := make([]byte, 4)
	binary.BigEndian.PutUint32(buf, 2)
	_, _, err := readStartupMessage(bytes.NewReader(buf))
	if err == nil {
		t.Error("expected error for too-small length")
	}

	// Length too large (> 10000)
	binary.BigEndian.PutUint32(buf, 20000)
	_, _, err = readStartupMessage(bytes.NewReader(buf))
	if err == nil {
		t.Error("expected error for too-large length")
	}
}

func TestReadStartupMessage_TruncatedBody(t *testing.T) {
	buf := make([]byte, 4)
	binary.BigEndian.PutUint32(buf, 100)
	// Only 4 bytes available, but message claims 100
	_, _, err := readStartupMessage(bytes.NewReader(buf))
	if err == nil {
		t.Error("expected error for truncated body")
	}
}

func TestParseStartupParams_EmptyParams(t *testing.T) {
	// Minimal startup: length(4) + version(4) + terminator(1)
	raw := make([]byte, 9)
	binary.BigEndian.PutUint32(raw[0:4], 9)
	binary.BigEndian.PutUint32(raw[4:8], 196608)
	raw[8] = 0

	params := parseStartupParams(raw)
	if len(params) != 0 {
		t.Errorf("expected 0 params, got %d", len(params))
	}
}

func TestParseStartupParams_MultipleParams(t *testing.T) {
	var buf bytes.Buffer
	buf.Write(make([]byte, 4)) // placeholder
	binary.Write(&buf, binary.BigEndian, uint32(196608))
	buf.WriteString("user")
	buf.WriteByte(0)
	buf.WriteString("admin")
	buf.WriteByte(0)
	buf.WriteString("database")
	buf.WriteByte(0)
	buf.WriteString("testdb")
	buf.WriteByte(0)
	buf.WriteString("application_name")
	buf.WriteByte(0)
	buf.WriteString("myapp")
	buf.WriteByte(0)
	buf.WriteByte(0)

	raw := buf.Bytes()
	binary.BigEndian.PutUint32(raw[0:4], uint32(len(raw)))

	params := parseStartupParams(raw)
	if params["user"] != "admin" {
		t.Errorf("user: got %q, want admin", params["user"])
	}
	if params["database"] != "testdb" {
		t.Errorf("database: got %q, want testdb", params["database"])
	}
	if params["application_name"] != "myapp" {
		t.Errorf("application_name: got %q, want myapp", params["application_name"])
	}
}

func TestIsSSLRequest_EdgeCases(t *testing.T) {
	// Exactly the right length but wrong code
	raw := make([]byte, 8)
	binary.BigEndian.PutUint32(raw[0:4], 8)
	binary.BigEndian.PutUint32(raw[4:8], 12345)
	if isSSLRequest(raw) {
		t.Error("expected false for wrong code")
	}

	// Too long
	raw = make([]byte, 12)
	binary.BigEndian.PutUint32(raw[4:8], sslRequestCode)
	if isSSLRequest(raw) {
		t.Error("expected false for wrong length")
	}
}

func TestIsCancelRequest_TooShort(t *testing.T) {
	if isCancelRequest([]byte{0, 0, 0}) {
		t.Error("expected false for short buffer")
	}
}

func TestExtractSimpleQuery_EdgeCases(t *testing.T) {
	if extractSimpleQuery([]byte{msgQuery, 0, 0, 0, 4}) != "" {
		t.Error("expected empty for no body")
	}
	if extractSimpleQuery([]byte{}) != "" {
		t.Error("expected empty for empty frame")
	}
}

func TestExtractParseQuery_EdgeCases(t *testing.T) {
	// Frame too short
	name, query := extractParseQuery([]byte{msgParse})
	if name != "" || query != "" {
		t.Error("expected empty for short frame")
	}

	// No null terminator for name
	frame := make([]byte, 10)
	frame[0] = msgParse
	binary.BigEndian.PutUint32(frame[1:5], 6)
	// Fill body with non-null bytes
	for i := 5; i < 10; i++ {
		frame[i] = 'a'
	}
	name, query = extractParseQuery(frame)
	if name != "" || query != "" {
		t.Error("expected empty when no null terminator found")
	}
}

func TestExtractCommandTag_EdgeCases(t *testing.T) {
	tests := []struct {
		tag      string
		wantTag  string
		wantRows int64
	}{
		{"BEGIN", "BEGIN", 0},
		{"COMMIT", "COMMIT", 0},
		{"ROLLBACK", "ROLLBACK", 0},
		{"COPY 100", "COPY 100", 100},
		{"INSERT 0 0", "INSERT 0 0", 0},
		{"UPDATE 0", "UPDATE 0", 0},
	}

	for _, tt := range tests {
		body := append([]byte(tt.tag), 0)
		frame := make([]byte, 5+len(body))
		frame[0] = msgCommandComplete
		binary.BigEndian.PutUint32(frame[1:5], uint32(len(body)+4))
		copy(frame[5:], body)

		gotTag, gotRows := extractCommandTag(frame)
		if gotTag != tt.wantTag || gotRows != tt.wantRows {
			t.Errorf("tag %q: got (%q, %d), want (%q, %d)", tt.tag, gotTag, gotRows, tt.wantTag, tt.wantRows)
		}
	}
}

func TestExtractColumnInfo_EdgeCases(t *testing.T) {
	// Too short
	if extractColumnInfo([]byte{msgRowDescription, 0, 0, 0, 4}) != nil {
		t.Error("expected nil for too-short frame")
	}

	// Zero columns
	var body bytes.Buffer
	binary.Write(&body, binary.BigEndian, int16(0))
	bodyBytes := body.Bytes()
	frame := make([]byte, 5+len(bodyBytes))
	frame[0] = msgRowDescription
	binary.BigEndian.PutUint32(frame[1:5], uint32(len(bodyBytes)+4))
	copy(frame[5:], bodyBytes)

	cols := extractColumnInfo(frame)
	if len(cols) != 0 {
		t.Errorf("expected 0 columns, got %d", len(cols))
	}
}

func TestExtractTypedDataRow_NullColumns(t *testing.T) {
	cols := []columnMeta{
		{name: "id", typeOID: 23},
		{name: "name", typeOID: 25},
	}

	var body bytes.Buffer
	binary.Write(&body, binary.BigEndian, int16(2))
	// id: NULL (-1)
	binary.Write(&body, binary.BigEndian, int32(-1))
	// name: "test"
	binary.Write(&body, binary.BigEndian, int32(4))
	body.WriteString("test")

	bodyBytes := body.Bytes()
	frame := make([]byte, 5+len(bodyBytes))
	frame[0] = msgDataRow
	binary.BigEndian.PutUint32(frame[1:5], uint32(len(bodyBytes)+4))
	copy(frame[5:], bodyBytes)

	values := extractTypedDataRow(frame, cols)
	if len(values) != 2 {
		t.Fatalf("expected 2, got %d", len(values))
	}
	if values[0] != nil {
		t.Errorf("expected nil for col 0, got %v", values[0])
	}
	if values[1] != "test" {
		t.Errorf("expected 'test' for col 1, got %v", values[1])
	}
}

func TestExtractTypedDataRow_EmptyString(t *testing.T) {
	cols := []columnMeta{{name: "val", typeOID: 25}}

	var body bytes.Buffer
	binary.Write(&body, binary.BigEndian, int16(1))
	binary.Write(&body, binary.BigEndian, int32(0)) // empty string (length 0)

	bodyBytes := body.Bytes()
	frame := make([]byte, 5+len(bodyBytes))
	frame[0] = msgDataRow
	binary.BigEndian.PutUint32(frame[1:5], uint32(len(bodyBytes)+4))
	copy(frame[5:], bodyBytes)

	values := extractTypedDataRow(frame, cols)
	if len(values) != 1 {
		t.Fatalf("expected 1, got %d", len(values))
	}
	if values[0] != "" {
		t.Errorf("expected empty string, got %v", values[0])
	}
}

func TestExtractErrorMessage_NoMessageField(t *testing.T) {
	var body bytes.Buffer
	body.WriteByte('S')
	body.WriteString("ERROR")
	body.WriteByte(0)
	body.WriteByte('C') // code, not message
	body.WriteString("42P01")
	body.WriteByte(0)
	body.WriteByte(0) // terminator

	bodyBytes := body.Bytes()
	frame := make([]byte, 5+len(bodyBytes))
	frame[0] = msgErrorResponse
	binary.BigEndian.PutUint32(frame[1:5], uint32(len(bodyBytes)+4))
	copy(frame[5:], bodyBytes)

	got := extractErrorMessage(frame)
	if got != "" {
		t.Errorf("expected empty string when no 'M' field, got %q", got)
	}
}

func TestReadMessage_InvalidLength(t *testing.T) {
	var buf bytes.Buffer
	buf.WriteByte(msgQuery)
	binary.Write(&buf, binary.BigEndian, int32(2)) // body length = -2 (less than 4)

	_, _, err := readMessage(&buf)
	if err == nil {
		t.Error("expected error for invalid message length")
	}
}

func TestExtractBindStmtName_EdgeCases(t *testing.T) {
	// Empty portal and statement
	var body bytes.Buffer
	body.WriteByte(0) // empty portal
	body.WriteByte(0) // empty statement

	bodyBytes := body.Bytes()
	frame := make([]byte, 5+len(bodyBytes))
	frame[0] = msgBind
	binary.BigEndian.PutUint32(frame[1:5], uint32(len(bodyBytes)+4))
	copy(frame[5:], bodyBytes)

	got := extractBindStmtName(frame)
	if got != "" {
		t.Errorf("expected empty string, got %q", got)
	}

	// Too short
	if extractBindStmtName([]byte{msgBind, 0, 0}) != "" {
		t.Error("expected empty for short frame")
	}
}
