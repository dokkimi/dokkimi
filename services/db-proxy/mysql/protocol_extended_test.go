package main

import (
	"bytes"
	"encoding/binary"
	"math"
	"reflect"
	"testing"
)

func TestReadPacket(t *testing.T) {
	tests := []struct {
		name      string
		input     []byte
		wantSeqID byte
		wantLen   int
		wantErr   bool
	}{
		{
			"simple packet",
			func() []byte {
				payload := []byte{0x01, 0x02, 0x03}
				hdr := []byte{3, 0, 0, 1}
				return append(hdr, payload...)
			}(),
			1, 3, false,
		},
		{
			"empty payload",
			[]byte{0, 0, 0, 5},
			5, 0, false,
		},
		{
			"truncated header",
			[]byte{0, 0},
			0, 0, true,
		},
		{
			"truncated payload",
			[]byte{10, 0, 0, 0, 0x01, 0x02},
			0, 0, true,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			pkt, err := readPacket(bytes.NewReader(tt.input))
			if tt.wantErr {
				if err == nil {
					t.Fatal("expected error")
				}
				return
			}
			if err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
			if pkt.sequenceID != tt.wantSeqID {
				t.Errorf("sequence ID: got %d, want %d", pkt.sequenceID, tt.wantSeqID)
			}
			if len(pkt.payload) != tt.wantLen {
				t.Errorf("payload length: got %d, want %d", len(pkt.payload), tt.wantLen)
			}
		})
	}
}

func TestReadPacketRoundtrip(t *testing.T) {
	original := &mysqlPacket{sequenceID: 7, payload: []byte("SELECT 1")}
	raw := original.rawBytes()
	pkt, err := readPacket(bytes.NewReader(raw))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if pkt.sequenceID != original.sequenceID {
		t.Errorf("sequence ID: got %d, want %d", pkt.sequenceID, original.sequenceID)
	}
	if !reflect.DeepEqual(pkt.payload, original.payload) {
		t.Errorf("payload mismatch")
	}
}

func TestParseColumnDef(t *testing.T) {
	buildColumnDef := func(catalog, schema, table, orgTable, name, orgName string, ft byte) []byte {
		var buf []byte
		for _, s := range []string{catalog, schema, table, orgTable, name, orgName} {
			buf = append(buf, byte(len(s)))
			buf = append(buf, []byte(s)...)
		}
		buf = append(buf, 0x0c)       // fixed_length_fields marker
		buf = append(buf, 0, 0)       // character_set
		buf = append(buf, 0, 0, 0, 0) // column_length
		buf = append(buf, ft)         // type
		buf = append(buf, 0, 0)       // flags
		buf = append(buf, 0)          // decimals
		buf = append(buf, 0, 0)       // filler
		return buf
	}

	tests := []struct {
		name     string
		payload  []byte
		wantName string
		wantType byte
	}{
		{
			"varchar column",
			buildColumnDef("def", "mydb", "users", "users", "username", "username", fieldTypeVarString),
			"username", fieldTypeVarString,
		},
		{
			"int column",
			buildColumnDef("def", "mydb", "users", "users", "id", "id", fieldTypeLong),
			"id", fieldTypeLong,
		},
		{
			"empty payload",
			[]byte{},
			"", 0,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			col := parseColumnDef(tt.payload)
			if col.name != tt.wantName {
				t.Errorf("name: got %q, want %q", col.name, tt.wantName)
			}
			if col.fieldType != tt.wantType {
				t.Errorf("type: got %d, want %d", col.fieldType, tt.wantType)
			}
		})
	}
}

func TestParseBinaryRowValues(t *testing.T) {
	columns := []columnDef{
		{name: "tiny", fieldType: fieldTypeTiny},
		{name: "short", fieldType: fieldTypeShort},
		{name: "long", fieldType: fieldTypeLong},
		{name: "longlong", fieldType: fieldTypeLongLong},
		{name: "float", fieldType: fieldTypeFloat},
		{name: "double", fieldType: fieldTypeDouble},
		{name: "text", fieldType: fieldTypeVarString},
	}

	numCols := len(columns)
	nullBitmapLen := (numCols + 7 + 2) / 8

	var payload []byte
	payload = append(payload, 0x00)                           // header
	payload = append(payload, make([]byte, nullBitmapLen)...) // null bitmap (all non-null)

	payload = append(payload, 42) // tiny: 42

	shortBuf := make([]byte, 2)
	binary.LittleEndian.PutUint16(shortBuf, 1000)
	payload = append(payload, shortBuf...) // short: 1000

	longBuf := make([]byte, 4)
	binary.LittleEndian.PutUint32(longBuf, 50000)
	payload = append(payload, longBuf...) // long: 50000

	longlongBuf := make([]byte, 8)
	binary.LittleEndian.PutUint64(longlongBuf, 9999999999)
	payload = append(payload, longlongBuf...) // longlong: 9999999999

	floatBuf := make([]byte, 4)
	binary.LittleEndian.PutUint32(floatBuf, math.Float32bits(3.14))
	payload = append(payload, floatBuf...) // float: 3.14

	doubleBuf := make([]byte, 8)
	binary.LittleEndian.PutUint64(doubleBuf, math.Float64bits(2.718281828))
	payload = append(payload, doubleBuf...) // double: 2.718281828

	payload = append(payload, 5, 'h', 'e', 'l', 'l', 'o') // text: "hello"

	values := parseBinaryRowValues(payload, columns)
	if len(values) != numCols {
		t.Fatalf("expected %d values, got %d", numCols, len(values))
	}
	if v := values[0].(int64); v != 42 {
		t.Errorf("tiny: got %d, want 42", v)
	}
	if v := values[1].(int64); v != 1000 {
		t.Errorf("short: got %d, want 1000", v)
	}
	if v := values[2].(int64); v != 50000 {
		t.Errorf("long: got %d, want 50000", v)
	}
	if v := values[3].(int64); v != 9999999999 {
		t.Errorf("longlong: got %d, want 9999999999", v)
	}
	if v := values[4].(float64); v < 3.13 || v > 3.15 {
		t.Errorf("float: got %f, want ~3.14", v)
	}
	if v := values[5].(float64); v < 2.71 || v > 2.72 {
		t.Errorf("double: got %f, want ~2.718", v)
	}
	if v := values[6].(string); v != "hello" {
		t.Errorf("text: got %q, want hello", v)
	}
}

func TestParseBinaryRowValues_WithNulls(t *testing.T) {
	columns := []columnDef{
		{name: "a", fieldType: fieldTypeLong},
		{name: "b", fieldType: fieldTypeVarString},
		{name: "c", fieldType: fieldTypeLong},
	}

	numCols := 3
	nullBitmapLen := (numCols + 7 + 2) / 8

	var payload []byte
	payload = append(payload, 0x00)
	bitmap := make([]byte, nullBitmapLen)
	// Mark column 1 (index 1) as null: bit position = (1+2) % 8 = 3, byte = (1+2)/8 = 0
	bitmap[0] |= 1 << 3
	payload = append(payload, bitmap...)

	// column 0: int value
	longBuf := make([]byte, 4)
	binary.LittleEndian.PutUint32(longBuf, 99)
	payload = append(payload, longBuf...)

	// column 1 is null, skip

	// column 2: int value
	binary.LittleEndian.PutUint32(longBuf, 77)
	payload = append(payload, longBuf...)

	values := parseBinaryRowValues(payload, columns)
	if len(values) != 3 {
		t.Fatalf("expected 3 values, got %d", len(values))
	}
	if values[0].(int64) != 99 {
		t.Errorf("col 0: got %v, want 99", values[0])
	}
	if values[1] != nil {
		t.Errorf("col 1: got %v, want nil", values[1])
	}
	if values[2].(int64) != 77 {
		t.Errorf("col 2: got %v, want 77", values[2])
	}
}

func TestParseBinaryRowValues_Int24(t *testing.T) {
	columns := []columnDef{
		{name: "val", fieldType: fieldTypeInt24},
	}
	nullBitmapLen := (1 + 7 + 2) / 8
	var payload []byte
	payload = append(payload, 0x00)
	payload = append(payload, make([]byte, nullBitmapLen)...)
	longBuf := make([]byte, 4)
	binary.LittleEndian.PutUint32(longBuf, 12345)
	payload = append(payload, longBuf...)

	values := parseBinaryRowValues(payload, columns)
	if len(values) != 1 {
		t.Fatalf("expected 1 value, got %d", len(values))
	}
	if values[0].(int64) != 12345 {
		t.Errorf("got %v, want 12345", values[0])
	}
}

func TestParseBinaryRowValues_TooShort(t *testing.T) {
	columns := []columnDef{{name: "a", fieldType: fieldTypeLong}}
	result := parseBinaryRowValues([]byte{0x00}, columns)
	if result != nil {
		t.Errorf("expected nil for too-short payload, got %v", result)
	}
}

func TestExtractStmtPrepareQuery(t *testing.T) {
	tests := []struct {
		name    string
		payload []byte
		want    string
	}{
		{"normal", append([]byte{comStmtPrepare}, []byte("SELECT * FROM users WHERE id = ?")...), "SELECT * FROM users WHERE id = ?"},
		{"empty", []byte{comStmtPrepare}, ""},
		{"too short", []byte{}, ""},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := extractStmtPrepareQuery(tt.payload)
			if got != tt.want {
				t.Errorf("got %q, want %q", got, tt.want)
			}
		})
	}
}

func TestIsResultSet_EdgeCases(t *testing.T) {
	tests := []struct {
		name   string
		pkt    mysqlPacket
		expect bool
	}{
		{"null marker", mysqlPacket{payload: []byte{nullValue}}, false},
		{"ok header", mysqlPacket{payload: []byte{okHeader}}, false},
		{"err header", mysqlPacket{payload: []byte{errHeader}}, false},
		{"eof header short", mysqlPacket{payload: []byte{eofHeader, 0, 0}}, false},
		{"column count 1", mysqlPacket{payload: []byte{0x01}}, true},
		{"column count 10", mysqlPacket{payload: []byte{0x0a}}, true},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := tt.pkt.isResultSet()
			if got != tt.expect {
				t.Errorf("got %v, want %v", got, tt.expect)
			}
		})
	}
}

func TestExtractErrorMessage_EdgeCases(t *testing.T) {
	tests := []struct {
		name    string
		payload []byte
		want    string
	}{
		{"too short", []byte{errHeader, 0x00}, ""},
		{"empty message after sql state", []byte{errHeader, 0x28, 0x00, '#', '4', '2', '0', '0', '0'}, ""},
		{"no hash marker", append([]byte{errHeader, 0x28, 0x00}, []byte("just an error")...), "just an error"},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := extractErrorMessage(tt.payload)
			if got != tt.want {
				t.Errorf("got %q, want %q", got, tt.want)
			}
		})
	}
}

func TestExtractOKAffectedRows_EdgeCases(t *testing.T) {
	if extractOKAffectedRows([]byte{okHeader}) != 0 {
		t.Error("expected 0 for too-short payload")
	}
	if extractOKAffectedRows([]byte{}) != 0 {
		t.Error("expected 0 for empty payload")
	}

	// Large affected rows (2-byte lenenc)
	payload := []byte{okHeader, 0xfc, 0x00, 0x04}
	got := extractOKAffectedRows(payload)
	if got != 1024 {
		t.Errorf("got %d, want 1024", got)
	}
}

func TestExtractStmtID_EdgeCases(t *testing.T) {
	if extractStmtID([]byte{comStmtExecute, 0, 0}) != 0 {
		t.Error("expected 0 for short payload")
	}
	if extractStmtID([]byte{}) != 0 {
		t.Error("expected 0 for empty payload")
	}
}

func TestExtractPrepareOKStmtID_EdgeCases(t *testing.T) {
	stmtID, numCols, numParams := extractPrepareOKStmtID([]byte{okHeader, 0, 0})
	if stmtID != 0 || numCols != 0 || numParams != 0 {
		t.Error("expected all zeros for short payload")
	}
}

func TestCoerceValue_EdgeCases(t *testing.T) {
	tests := []struct {
		name      string
		s         string
		fieldType byte
		want      interface{}
	}{
		{"float from FLOAT", "2.5", fieldTypeFloat, 2.5},
		{"non-numeric float", "abc", fieldTypeFloat, "abc"},
		{"negative int", "-42", fieldTypeLong, int64(-42)},
		{"int from SHORT", "100", fieldTypeShort, int64(100)},
		{"int from INT24", "500", fieldTypeInt24, int64(500)},
		{"unknown type returns string", "foo", 0x99, "foo"},
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

func TestParseTextRowValues_EdgeCases(t *testing.T) {
	// All NULLs
	payload := []byte{nullValue, nullValue, nullValue}
	values := parseTextRowValues(payload, 3)
	if len(values) != 3 {
		t.Fatalf("expected 3, got %d", len(values))
	}
	for i, v := range values {
		if v != nil {
			t.Errorf("col %d: got %v, want nil", i, v)
		}
	}

	// Empty payload
	values = parseTextRowValues([]byte{}, 2)
	if len(values) != 0 {
		t.Errorf("expected 0 for empty payload, got %d", len(values))
	}

	// More columns than data
	payload = []byte{1, 'a'}
	values = parseTextRowValues(payload, 5)
	if len(values) != 1 {
		t.Errorf("expected 1 (ran out of data), got %d", len(values))
	}
}

func TestStripDeprecateEOFFromGreeting(t *testing.T) {
	// Build a minimal HandshakeV10 payload:
	// protocol(1) + version(NUL-terminated) + conn_id(4) + auth1(8) + filler(1) +
	// cap_lower(2) + charset(1) + status(2) + cap_upper(2) + ...
	version := "8.0.33\x00"
	payload := make([]byte, 0, 64)
	payload = append(payload, 0x0a) // protocol version
	payload = append(payload, []byte(version)...)
	payload = append(payload, 0x01, 0x00, 0x00, 0x00) // conn_id = 1
	payload = append(payload, make([]byte, 8)...)     // auth_plugin_data_part_1
	payload = append(payload, 0x00)                   // filler
	payload = append(payload, 0xFF, 0xFF)             // cap_lower (all bits set)
	payload = append(payload, 0x21)                   // charset
	payload = append(payload, 0x02, 0x00)             // status flags
	// cap_upper: set CLIENT_DEPRECATE_EOF (bit 24 = bit 8 of upper = bit 0 of upper byte 1)
	payload = append(payload, 0xFF, 0xFF)          // all bits set in upper caps
	payload = append(payload, make([]byte, 10)...) // remaining fields

	pkt := &mysqlPacket{sequenceID: 0, payload: payload}

	nulPos := 1 + len(version) - 1 // position of NUL byte
	upperCapOff := nulPos + 19

	// Verify bit 24 is set before stripping
	if pkt.payload[upperCapOff+1]&0x01 == 0 {
		t.Fatal("CLIENT_DEPRECATE_EOF should be set before strip")
	}

	stripDeprecateEOFFromGreeting(pkt)

	// Bit 24 should be cleared
	if pkt.payload[upperCapOff+1]&0x01 != 0 {
		t.Error("CLIENT_DEPRECATE_EOF should be cleared after strip")
	}
	// Other bits should remain
	if pkt.payload[upperCapOff+1]&0xFE != 0xFE {
		t.Errorf("other upper cap bits should be preserved, got %02x", pkt.payload[upperCapOff+1])
	}
	if pkt.payload[upperCapOff]&0xFF != 0xFF {
		t.Error("lower byte of upper caps should be unchanged")
	}

	// Test with non-handshake packet (should be no-op)
	errPkt := &mysqlPacket{payload: []byte{0xFF, 0x01, 0x00}}
	stripDeprecateEOFFromGreeting(errPkt)

	// Test with too-short packet (should be no-op)
	shortPkt := &mysqlPacket{payload: []byte{0x0a}}
	stripDeprecateEOFFromGreeting(shortPkt)
}
