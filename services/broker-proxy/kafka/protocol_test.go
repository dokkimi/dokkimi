package main

import (
	"encoding/binary"
	"testing"
)

func TestReadUvarint(t *testing.T) {
	tests := []struct {
		name string
		data []byte
		want uint64
	}{
		{"zero", []byte{0x00}, 0},
		{"one", []byte{0x01}, 1},
		{"127", []byte{0x7F}, 127},
		{"128", []byte{0x80, 0x01}, 128},
		{"300", []byte{0xAC, 0x02}, 300},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, _, err := readUvarint(tt.data, 0)
			if err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
			if got != tt.want {
				t.Errorf("got %d, want %d", got, tt.want)
			}
		})
	}
}

func TestReadZigzagVarint(t *testing.T) {
	tests := []struct {
		name string
		data []byte
		want int64
	}{
		{"zero", []byte{0x00}, 0},
		{"minus one", []byte{0x01}, -1},
		{"one", []byte{0x02}, 1},
		{"minus two", []byte{0x03}, -2},
		{"two", []byte{0x04}, 2},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, _, err := readZigzagVarint(tt.data, 0)
			if err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
			if got != tt.want {
				t.Errorf("got %d, want %d", got, tt.want)
			}
		})
	}
}

func TestParseRequestHeader(t *testing.T) {
	// Build a minimal Kafka request header
	payload := make([]byte, 14)
	binary.BigEndian.PutUint16(payload[0:2], 0)  // apiKey = Produce
	binary.BigEndian.PutUint16(payload[2:4], 3)  // apiVersion = 3
	binary.BigEndian.PutUint32(payload[4:8], 42) // correlationID = 42
	binary.BigEndian.PutUint16(payload[8:10], 4) // clientID length = 4
	copy(payload[10:14], "test")                 // clientID = "test"

	hdr, _, err := parseRequestHeader(payload)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if hdr.APIKey != 0 {
		t.Errorf("APIKey: got %d, want 0", hdr.APIKey)
	}
	if hdr.APIVersion != 3 {
		t.Errorf("APIVersion: got %d, want 3", hdr.APIVersion)
	}
	if hdr.CorrelationID != 42 {
		t.Errorf("CorrelationID: got %d, want 42", hdr.CorrelationID)
	}
	if hdr.ClientID != "test" {
		t.Errorf("ClientID: got %q, want %q", hdr.ClientID, "test")
	}
}

func TestReadRecords(t *testing.T) {
	// A minimal v2 record batch with one record
	records, err := readRecords(buildTestRecordBatch(t, "hello-key", `{"msg":"hello"}`), nil)
	if err != nil || len(records) != 1 {
		t.Fatalf("got %d records, %v; want 1", len(records), err)
	}
	if string(records[0].key) != "hello-key" || string(records[0].value) != `{"msg":"hello"}` {
		t.Errorf("got key %q value %q", records[0].key, records[0].value)
	}
}

func TestReadRecords_NullKey(t *testing.T) {
	records, _ := readRecords(buildTestRecordBatch(t, "", `{"data":1}`), nil)
	if len(records) != 1 || records[0].key != nil || string(records[0].value) != `{"data":1}` {
		t.Errorf("got %+v", records)
	}
}

// ---------- helpers ----------

func buildTestRecordBatch(t *testing.T, key, value string) []byte {
	t.Helper()

	// Build the record first
	var rec []byte

	// Attributes (1 byte)
	rec = append(rec, 0)

	// Timestamp delta (zigzag varint: 0)
	rec = append(rec, 0)

	// Offset delta (zigzag varint: 0)
	rec = append(rec, 0)

	// Key
	if key == "" {
		rec = appendZigzagVarint(rec, -1) // null key
	} else {
		rec = appendZigzagVarint(rec, int64(len(key)))
		rec = append(rec, key...)
	}

	// Value
	rec = appendZigzagVarint(rec, int64(len(value)))
	rec = append(rec, value...)

	// Headers count (zigzag varint: 0)
	rec = appendZigzagVarint(rec, 0)

	// Length-prefix the record (zigzag varint)
	var recordBytes []byte
	recordBytes = appendZigzagVarint(recordBytes, int64(len(rec)))
	recordBytes = append(recordBytes, rec...)

	// Build batch header (61 bytes)
	header := make([]byte, 61)
	binary.BigEndian.PutUint64(header[0:8], 0)                            // baseOffset
	binary.BigEndian.PutUint32(header[8:12], uint32(len(recordBytes)+49)) // batchLength (from partLeaderEpoch to end)
	binary.BigEndian.PutUint32(header[12:16], 0)                          // partitionLeaderEpoch
	header[16] = 2                                                        // magic
	binary.BigEndian.PutUint32(header[17:21], 0)                          // crc (not validated by proxy)
	binary.BigEndian.PutUint16(header[21:23], 0)                          // attributes (no compression)
	binary.BigEndian.PutUint32(header[23:27], 0)                          // lastOffsetDelta
	binary.BigEndian.PutUint64(header[27:35], 0)                          // firstTimestamp
	binary.BigEndian.PutUint64(header[35:43], 0)                          // maxTimestamp
	binary.BigEndian.PutUint64(header[43:51], 0)                          // producerId
	binary.BigEndian.PutUint16(header[51:53], 0)                          // producerEpoch
	binary.BigEndian.PutUint32(header[53:57], 0)                          // baseSequence
	binary.BigEndian.PutUint32(header[57:61], 1)                          // recordCount = 1

	return append(header, recordBytes...)
}

func appendZigzagVarint(buf []byte, v int64) []byte {
	// Zigzag encode
	uv := uint64((v << 1) ^ (v >> 63))
	for uv >= 0x80 {
		buf = append(buf, byte(uv)|0x80)
		uv >>= 7
	}
	buf = append(buf, byte(uv))
	return buf
}
