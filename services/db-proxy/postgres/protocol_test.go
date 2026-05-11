package main

import (
	"bytes"
	"encoding/binary"
	"testing"
)

func TestIsSSLRequest(t *testing.T) {
	// Valid SSL request: length=8, code=80877103
	raw := make([]byte, 8)
	binary.BigEndian.PutUint32(raw[0:4], 8)
	binary.BigEndian.PutUint32(raw[4:8], sslRequestCode)

	if !isSSLRequest(raw) {
		t.Error("expected SSL request to be detected")
	}

	// Not an SSL request
	binary.BigEndian.PutUint32(raw[4:8], 196608) // protocol version 3.0
	if isSSLRequest(raw) {
		t.Error("expected non-SSL request")
	}

	// Wrong length
	if isSSLRequest(raw[:4]) {
		t.Error("expected false for short buffer")
	}
}

func TestIsCancelRequest(t *testing.T) {
	raw := make([]byte, 16)
	binary.BigEndian.PutUint32(raw[0:4], 16)
	binary.BigEndian.PutUint32(raw[4:8], cancelRequestCode)

	if !isCancelRequest(raw) {
		t.Error("expected cancel request to be detected")
	}
}

func TestParseStartupParams(t *testing.T) {
	// Build a startup message: length(4) + version(4) + key\0value\0 ... \0
	var buf bytes.Buffer
	buf.Write(make([]byte, 4)) // placeholder for length
	binary.Write(&buf, binary.BigEndian, uint32(196608))
	buf.WriteString("user")
	buf.WriteByte(0)
	buf.WriteString("postgres")
	buf.WriteByte(0)
	buf.WriteString("database")
	buf.WriteByte(0)
	buf.WriteString("mydb")
	buf.WriteByte(0)
	buf.WriteByte(0) // terminator

	raw := buf.Bytes()
	binary.BigEndian.PutUint32(raw[0:4], uint32(len(raw)))

	params := parseStartupParams(raw)

	if params["user"] != "postgres" {
		t.Errorf("expected user=postgres, got %q", params["user"])
	}
	if params["database"] != "mydb" {
		t.Errorf("expected database=mydb, got %q", params["database"])
	}
}

func TestExtractSimpleQuery(t *testing.T) {
	query := "SELECT * FROM users WHERE id = 1"
	body := append([]byte(query), 0)
	bodyLen := len(body) + 4

	frame := make([]byte, 5+len(body))
	frame[0] = msgQuery
	binary.BigEndian.PutUint32(frame[1:5], uint32(bodyLen))
	copy(frame[5:], body)

	got := extractSimpleQuery(frame)
	if got != query {
		t.Errorf("expected %q, got %q", query, got)
	}
}

func TestExtractParseQuery(t *testing.T) {
	stmtName := "stmt1"
	query := "SELECT $1::int"

	var body bytes.Buffer
	body.WriteString(stmtName)
	body.WriteByte(0)
	body.WriteString(query)
	body.WriteByte(0)
	binary.Write(&body, binary.BigEndian, int16(1)) // 1 param type
	binary.Write(&body, binary.BigEndian, uint32(23)) // int4 OID

	bodyBytes := body.Bytes()
	bodyLen := len(bodyBytes) + 4

	frame := make([]byte, 5+len(bodyBytes))
	frame[0] = msgParse
	binary.BigEndian.PutUint32(frame[1:5], uint32(bodyLen))
	copy(frame[5:], bodyBytes)

	gotName, gotQuery := extractParseQuery(frame)
	if gotName != stmtName {
		t.Errorf("expected stmt name %q, got %q", stmtName, gotName)
	}
	if gotQuery != query {
		t.Errorf("expected query %q, got %q", query, gotQuery)
	}
}

func TestExtractParseQuery_UnnamedStatement(t *testing.T) {
	query := "INSERT INTO logs (msg) VALUES ($1)"

	var body bytes.Buffer
	body.WriteByte(0) // empty statement name
	body.WriteString(query)
	body.WriteByte(0)
	binary.Write(&body, binary.BigEndian, int16(0))

	bodyBytes := body.Bytes()
	frame := make([]byte, 5+len(bodyBytes))
	frame[0] = msgParse
	binary.BigEndian.PutUint32(frame[1:5], uint32(len(bodyBytes)+4))
	copy(frame[5:], bodyBytes)

	gotName, gotQuery := extractParseQuery(frame)
	if gotName != "" {
		t.Errorf("expected empty stmt name, got %q", gotName)
	}
	if gotQuery != query {
		t.Errorf("expected query %q, got %q", query, gotQuery)
	}
}

func TestExtractCommandTag(t *testing.T) {
	tests := []struct {
		tag          string
		wantTag      string
		wantRows     int64
	}{
		{"INSERT 0 5", "INSERT 0 5", 5},
		{"UPDATE 3", "UPDATE 3", 3},
		{"DELETE 0", "DELETE 0", 0},
		{"SELECT 10", "SELECT 10", 10},
		{"CREATE TABLE", "CREATE TABLE", 0},
	}

	for _, tt := range tests {
		body := append([]byte(tt.tag), 0)
		frame := make([]byte, 5+len(body))
		frame[0] = msgCommandComplete
		binary.BigEndian.PutUint32(frame[1:5], uint32(len(body)+4))
		copy(frame[5:], body)

		gotTag, gotRows := extractCommandTag(frame)
		if gotTag != tt.wantTag {
			t.Errorf("tag %q: expected tag %q, got %q", tt.tag, tt.wantTag, gotTag)
		}
		if gotRows != tt.wantRows {
			t.Errorf("tag %q: expected rows %d, got %d", tt.tag, tt.wantRows, gotRows)
		}
	}
}

func TestExtractErrorMessage(t *testing.T) {
	// Build an ErrorResponse frame
	var body bytes.Buffer
	body.WriteByte('S') // severity
	body.WriteString("FATAL")
	body.WriteByte(0)
	body.WriteByte('M') // message
	body.WriteString("relation \"foo\" does not exist")
	body.WriteByte(0)
	body.WriteByte(0) // terminator

	bodyBytes := body.Bytes()
	frame := make([]byte, 5+len(bodyBytes))
	frame[0] = msgErrorResponse
	binary.BigEndian.PutUint32(frame[1:5], uint32(len(bodyBytes)+4))
	copy(frame[5:], bodyBytes)

	got := extractErrorMessage(frame)
	if got != `relation "foo" does not exist` {
		t.Errorf("expected error message, got %q", got)
	}
}

func TestReadMessage(t *testing.T) {
	query := "SELECT 1"
	body := append([]byte(query), 0)

	var buf bytes.Buffer
	buf.WriteByte(msgQuery)
	binary.Write(&buf, binary.BigEndian, int32(len(body)+4))
	buf.Write(body)

	msgType, frame, err := readMessage(&buf)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if msgType != msgQuery {
		t.Errorf("expected msg type 'Q', got %c", msgType)
	}
	if len(frame) != 1+4+len(body) {
		t.Errorf("expected frame length %d, got %d", 1+4+len(body), len(frame))
	}
}

func TestExtractBindStmtName(t *testing.T) {
	var body bytes.Buffer
	body.WriteString("portal1") // destination portal
	body.WriteByte(0)
	body.WriteString("stmt1") // source statement
	body.WriteByte(0)
	// rest of Bind message...
	binary.Write(&body, binary.BigEndian, int16(0)) // param format codes
	binary.Write(&body, binary.BigEndian, int16(0)) // param values
	binary.Write(&body, binary.BigEndian, int16(0)) // result format codes

	bodyBytes := body.Bytes()
	frame := make([]byte, 5+len(bodyBytes))
	frame[0] = msgBind
	binary.BigEndian.PutUint32(frame[1:5], uint32(len(bodyBytes)+4))
	copy(frame[5:], bodyBytes)

	got := extractBindStmtName(frame)
	if got != "stmt1" {
		t.Errorf("expected stmt1, got %q", got)
	}
}

func TestExtractTypedDataRow(t *testing.T) {
	cols := []columnMeta{
		{name: "id", typeOID: 23},    // int4
		{name: "name", typeOID: 25},  // text
		{name: "active", typeOID: 16}, // bool
		{name: "score", typeOID: 701}, // float8
	}

	var body bytes.Buffer
	binary.Write(&body, binary.BigEndian, int16(4))
	// id: "42"
	binary.Write(&body, binary.BigEndian, int32(2))
	body.WriteString("42")
	// name: "Alice"
	binary.Write(&body, binary.BigEndian, int32(5))
	body.WriteString("Alice")
	// active: "t"
	binary.Write(&body, binary.BigEndian, int32(1))
	body.WriteByte('t')
	// score: "3.14"
	binary.Write(&body, binary.BigEndian, int32(4))
	body.WriteString("3.14")

	bodyBytes := body.Bytes()
	frame := make([]byte, 5+len(bodyBytes))
	frame[0] = msgDataRow
	binary.BigEndian.PutUint32(frame[1:5], uint32(len(bodyBytes)+4))
	copy(frame[5:], bodyBytes)

	values := extractTypedDataRow(frame, cols)
	if len(values) != 4 {
		t.Fatalf("expected 4 values, got %d", len(values))
	}
	if v, ok := values[0].(int64); !ok || v != 42 {
		t.Errorf("expected id=42 (int64), got %v (%T)", values[0], values[0])
	}
	if v, ok := values[1].(string); !ok || v != "Alice" {
		t.Errorf("expected name=Alice (string), got %v (%T)", values[1], values[1])
	}
	if v, ok := values[2].(bool); !ok || v != true {
		t.Errorf("expected active=true (bool), got %v (%T)", values[2], values[2])
	}
	if v, ok := values[3].(float64); !ok || v != 3.14 {
		t.Errorf("expected score=3.14 (float64), got %v (%T)", values[3], values[3])
	}
}

func TestExtractColumnInfo(t *testing.T) {
	var body bytes.Buffer
	binary.Write(&body, binary.BigEndian, int16(2))
	// Field 1: "id" with typeOID 23 (int4)
	body.WriteString("id")
	body.WriteByte(0)
	body.Write(make([]byte, 6))                                  // tableOID(4)+colAttr(2)
	binary.Write(&body, binary.BigEndian, uint32(23))             // typeOID
	body.Write(make([]byte, 8))                                  // typeLen(2)+typeMod(4)+fmtCode(2)
	// Field 2: "name" with typeOID 25 (text)
	body.WriteString("name")
	body.WriteByte(0)
	body.Write(make([]byte, 6))
	binary.Write(&body, binary.BigEndian, uint32(25))
	body.Write(make([]byte, 8))

	bodyBytes := body.Bytes()
	frame := make([]byte, 5+len(bodyBytes))
	frame[0] = msgRowDescription
	binary.BigEndian.PutUint32(frame[1:5], uint32(len(bodyBytes)+4))
	copy(frame[5:], bodyBytes)

	cols := extractColumnInfo(frame)
	if len(cols) != 2 {
		t.Fatalf("expected 2 columns, got %d", len(cols))
	}
	if cols[0].name != "id" || cols[0].typeOID != 23 {
		t.Errorf("expected id/23, got %s/%d", cols[0].name, cols[0].typeOID)
	}
	if cols[1].name != "name" || cols[1].typeOID != 25 {
		t.Errorf("expected name/25, got %s/%d", cols[1].name, cols[1].typeOID)
	}
}

func TestReadStartupMessage(t *testing.T) {
	var buf bytes.Buffer
	// Build a minimal startup message: length(4) + version(4) + terminator
	msg := make([]byte, 9)
	binary.BigEndian.PutUint32(msg[0:4], 9)
	binary.BigEndian.PutUint32(msg[4:8], 196608) // version 3.0
	msg[8] = 0                                    // terminator
	buf.Write(msg)

	msgLen, raw, err := readStartupMessage(&buf)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if msgLen != 9 {
		t.Errorf("expected length 9, got %d", msgLen)
	}
	if len(raw) != 9 {
		t.Errorf("expected raw length 9, got %d", len(raw))
	}
}
