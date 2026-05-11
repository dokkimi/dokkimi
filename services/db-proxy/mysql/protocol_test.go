package main

import (
	"encoding/binary"
	"reflect"
	"testing"
)

func TestReadLenEncInt(t *testing.T) {
	tests := []struct {
		name    string
		data    []byte
		wantVal uint64
		wantN   int
	}{
		{"1-byte", []byte{42}, 42, 1},
		{"1-byte zero", []byte{0}, 0, 1},
		{"1-byte max", []byte{0xfa}, 250, 1},
		{"2-byte", []byte{0xfc, 0x01, 0x02}, 0x0201, 3},
		{"3-byte", []byte{0xfd, 0x01, 0x02, 0x03}, 0x030201, 4},
		{"8-byte", append([]byte{0xfe}, make([]byte, 8)...), 0, 9},
		{"empty", []byte{}, 0, 0},
		{"null marker", []byte{0xfb}, 0, 0},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			val, n := readLenEncInt(tt.data)
			if val != tt.wantVal || n != tt.wantN {
				t.Errorf("got (%d, %d), want (%d, %d)", val, n, tt.wantVal, tt.wantN)
			}
		})
	}
}

func TestReadLenEncString(t *testing.T) {
	tests := []struct {
		name     string
		data     []byte
		wantStr  string
		wantN    int
		wantNull bool
	}{
		{"simple", []byte{5, 'h', 'e', 'l', 'l', 'o'}, "hello", 6, false},
		{"empty string", []byte{0}, "", 1, false},
		{"null", []byte{nullValue}, "", 1, true},
		{"empty input", []byte{}, "", 0, false},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			s, n, isNull := readLenEncString(tt.data)
			if s != tt.wantStr || n != tt.wantN || isNull != tt.wantNull {
				t.Errorf("got (%q, %d, %v), want (%q, %d, %v)", s, n, isNull, tt.wantStr, tt.wantN, tt.wantNull)
			}
		})
	}
}

func TestMysqlPacketRawBytes(t *testing.T) {
	pkt := &mysqlPacket{sequenceID: 3, payload: []byte{0x01, 0x02, 0x03}}
	raw := pkt.rawBytes()

	if len(raw) != 7 {
		t.Fatalf("expected 7 bytes, got %d", len(raw))
	}
	if raw[0] != 3 || raw[1] != 0 || raw[2] != 0 {
		t.Errorf("payload length wrong: %x %x %x", raw[0], raw[1], raw[2])
	}
	if raw[3] != 3 {
		t.Errorf("sequence ID wrong: got %d, want 3", raw[3])
	}
	if !reflect.DeepEqual(raw[4:], []byte{0x01, 0x02, 0x03}) {
		t.Errorf("payload mismatch")
	}
}

func TestPacketClassification(t *testing.T) {
	ok := &mysqlPacket{payload: []byte{okHeader, 0x00, 0x00}}
	if !ok.isOK() {
		t.Error("expected isOK")
	}

	errPkt := &mysqlPacket{payload: []byte{errHeader, 0x00, 0x00}}
	if !errPkt.isERR() {
		t.Error("expected isERR")
	}

	eof := &mysqlPacket{payload: []byte{eofHeader, 0x00, 0x00, 0x00, 0x00}}
	if !eof.isEOF() {
		t.Error("expected isEOF")
	}

	longEof := &mysqlPacket{payload: make([]byte, 10)}
	longEof.payload[0] = eofHeader
	if longEof.isEOF() {
		t.Error("long packet with 0xFE should not be EOF")
	}

	rs := &mysqlPacket{payload: []byte{0x03}}
	if !rs.isResultSet() {
		t.Error("expected isResultSet for column count byte")
	}

	empty := &mysqlPacket{payload: []byte{}}
	if empty.isOK() || empty.isERR() || empty.isEOF() || empty.isResultSet() {
		t.Error("empty payload should not match any type")
	}
}

func TestExtractErrorMessage(t *testing.T) {
	// ERR packet: header(1) + error_code(2) + '#' + sql_state(5) + message
	payload := []byte{errHeader, 0x28, 0x00, '#', '4', '2', '0', '0', '0'}
	payload = append(payload, []byte("Table not found")...)

	msg := extractErrorMessage(payload)
	if msg != "Table not found" {
		t.Errorf("got %q, want %q", msg, "Table not found")
	}

	// Without sql_state marker
	payload2 := []byte{errHeader, 0x28, 0x00}
	payload2 = append(payload2, []byte("Simple error")...)
	msg2 := extractErrorMessage(payload2)
	if msg2 != "Simple error" {
		t.Errorf("got %q, want %q", msg2, "Simple error")
	}
}

func TestExtractOKAffectedRows(t *testing.T) {
	// OK packet: header(0x00) + affected_rows(lenenc) + last_insert_id(lenenc)
	payload := []byte{okHeader, 5, 0}
	rows := extractOKAffectedRows(payload)
	if rows != 5 {
		t.Errorf("got %d, want 5", rows)
	}
}

func TestCoerceValue(t *testing.T) {
	tests := []struct {
		name      string
		s         string
		fieldType byte
		want      interface{}
	}{
		{"int from TINY", "42", fieldTypeTiny, int64(42)},
		{"int from LONG", "12345", fieldTypeLong, int64(12345)},
		{"int from LONGLONG", "9999999999", fieldTypeLongLong, int64(9999999999)},
		{"float from DOUBLE", "3.14", fieldTypeDouble, 3.14},
		{"float from DECIMAL", "99.99", fieldTypeNewDecimal, 99.99},
		{"string from VARCHAR", "hello", fieldTypeVarString, "hello"},
		{"non-numeric int falls back to string", "abc", fieldTypeLong, "abc"},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := coerceValue(tt.s, tt.fieldType)
			if !reflect.DeepEqual(got, tt.want) {
				t.Errorf("got %v (%T), want %v (%T)", got, got, tt.want, tt.want)
			}
		})
	}
}

func TestExtractQueryText(t *testing.T) {
	payload := append([]byte{comQuery}, []byte("SELECT 1")...)
	got := extractQueryText(payload)
	if got != "SELECT 1" {
		t.Errorf("got %q, want %q", got, "SELECT 1")
	}

	if extractQueryText([]byte{comQuery}) != "" {
		t.Error("single-byte payload should return empty")
	}
}

func TestExtractStmtID(t *testing.T) {
	payload := make([]byte, 5)
	payload[0] = comStmtExecute
	binary.LittleEndian.PutUint32(payload[1:5], 42)

	got := extractStmtID(payload)
	if got != 42 {
		t.Errorf("got %d, want 42", got)
	}
}

func TestExtractPrepareOKStmtID(t *testing.T) {
	payload := make([]byte, 12)
	payload[0] = okHeader
	binary.LittleEndian.PutUint32(payload[1:5], 7)
	binary.LittleEndian.PutUint16(payload[5:7], 3)
	binary.LittleEndian.PutUint16(payload[7:9], 2)

	stmtID, numCols, numParams := extractPrepareOKStmtID(payload)
	if stmtID != 7 || numCols != 3 || numParams != 2 {
		t.Errorf("got (%d, %d, %d), want (7, 3, 2)", stmtID, numCols, numParams)
	}
}

func TestParseTextRowValues(t *testing.T) {
	// Build a row with: "hello" (lenenc string), NULL (0xFB), "42" (lenenc string)
	var payload []byte
	payload = append(payload, 5, 'h', 'e', 'l', 'l', 'o')
	payload = append(payload, nullValue)
	payload = append(payload, 2, '4', '2')

	values := parseTextRowValues(payload, 3)
	if len(values) != 3 {
		t.Fatalf("expected 3 values, got %d", len(values))
	}
	if values[0] != "hello" {
		t.Errorf("col 0: got %v, want hello", values[0])
	}
	if values[1] != nil {
		t.Errorf("col 1: got %v, want nil", values[1])
	}
	if values[2] != "42" {
		t.Errorf("col 2: got %v, want 42", values[2])
	}
}
