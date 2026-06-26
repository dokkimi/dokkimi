package main

import (
	"encoding/binary"
	"fmt"
	"io"
	"log"
)

// Kafka API keys
const (
	apiProduce  int16 = 0
	apiFetch    int16 = 1
	apiMetadata int16 = 3
)

// First Produce version that uses flexible encoding (compact strings/arrays).
const produceFlexVersion int16 = 9

// First Fetch version that uses flexible encoding.
const fetchFlexVersion int16 = 12

// requestHeader holds the parsed header common to every Kafka request.
type requestHeader struct {
	APIKey        int16
	APIVersion    int16
	CorrelationID int32
	ClientID      string
}

// producedRecord is a single record extracted from a Produce request.
type producedRecord struct {
	Topic     string
	Partition int32
	Key       []byte
	Value     []byte
}

// fetchedRecord is a single record extracted from a Fetch response.
type fetchedRecord struct {
	Topic     string
	Partition int32
	Offset    int64
	Key       []byte
	Value     []byte
}

// ---------- message framing ----------

// readMessage reads one length-prefixed Kafka message from r.
// Returns the raw bytes (including the 4-byte length prefix) and the payload.
func readMessage(r io.Reader) (raw, payload []byte, err error) {
	lenBuf := make([]byte, 4)
	if _, err = io.ReadFull(r, lenBuf); err != nil {
		return nil, nil, err
	}
	size := int(binary.BigEndian.Uint32(lenBuf))
	if size < 0 || size > 100*1024*1024 { // sanity: 100 MB max
		return nil, nil, fmt.Errorf("kafka message size out of range: %d", size)
	}

	payload = make([]byte, size)
	if _, err = io.ReadFull(r, payload); err != nil {
		return nil, nil, err
	}

	raw = make([]byte, 4+size)
	copy(raw, lenBuf)
	copy(raw[4:], payload)
	return raw, payload, nil
}

// ---------- request header ----------

func parseRequestHeader(payload []byte) (requestHeader, int, error) {
	if len(payload) < 8 {
		return requestHeader{}, 0, fmt.Errorf("request too short: %d", len(payload))
	}

	h := requestHeader{
		APIKey:        int16(binary.BigEndian.Uint16(payload[0:2])),
		APIVersion:    int16(binary.BigEndian.Uint16(payload[2:4])),
		CorrelationID: int32(binary.BigEndian.Uint32(payload[4:8])),
	}

	pos := 8

	// Client ID — nullable string (int16 length, -1 = null)
	if pos+2 > len(payload) {
		return h, pos, nil
	}
	clientIDLen := int16(binary.BigEndian.Uint16(payload[pos : pos+2]))
	pos += 2
	if clientIDLen > 0 {
		if pos+int(clientIDLen) > len(payload) {
			return h, pos, nil
		}
		h.ClientID = string(payload[pos : pos+int(clientIDLen)])
		pos += int(clientIDLen)
	}

	// v2 request header (flexible versions) has tagged fields after client ID
	if isFlexibleRequest(h.APIKey, h.APIVersion) {
		n, err := skipTaggedFields(payload, pos)
		if err == nil {
			pos = n
		}
	}

	return h, pos, nil
}

// ---------- Produce request parsing ----------

func parseProduceRequest(payload []byte, pos int, apiVersion int16) ([]producedRecord, error) {
	flex := apiVersion >= produceFlexVersion
	r := &reader{buf: payload, pos: pos, flex: flex}

	// Transactional ID (nullable string) — present from v3+
	if apiVersion >= 3 {
		if _, _, err := r.readNullableString(); err != nil {
			return nil, fmt.Errorf("transactional id: %w", err)
		}
	}

	// Acks (int16) + Timeout (int32)
	if err := r.skip(6); err != nil {
		return nil, fmt.Errorf("acks/timeout: %w", err)
	}

	topicCount, err := r.readArrayLen()
	if err != nil {
		return nil, fmt.Errorf("topic count: %w", err)
	}

	var records []producedRecord
	for i := 0; i < topicCount; i++ {
		topicName, err := r.readString()
		if err != nil {
			return records, fmt.Errorf("topic name: %w", err)
		}

		partCount, err := r.readArrayLen()
		if err != nil {
			return records, fmt.Errorf("partition count: %w", err)
		}

		for j := 0; j < partCount; j++ {
			partIndex, err := r.readInt32()
			if err != nil {
				return records, fmt.Errorf("partition index: %w", err)
			}

			batchBytes, err := r.readRawBytes()
			if err != nil {
				return records, fmt.Errorf("record batch bytes: %w", err)
			}

			parsed := parseRecordBatch(batchBytes, topicName, partIndex)
			records = append(records, parsed...)

			if flex {
				r.skipTaggedFields()
			}
		}

		if flex {
			r.skipTaggedFields()
		}
	}

	return records, nil
}

// ---------- Fetch response parsing ----------

func parseFetchResponse(payload []byte, apiVersion int16) ([]fetchedRecord, error) {
	flex := apiVersion >= fetchFlexVersion
	pos := 4 // skip correlation ID

	// v1 response header (flexible) has tagged fields
	if flex {
		n, err := skipTaggedFields(payload, pos)
		if err != nil {
			return nil, err
		}
		pos = n
	}

	r := &reader{buf: payload, pos: pos, flex: flex}

	// Throttle time (int32)
	if err := r.skip(4); err != nil {
		return nil, fmt.Errorf("throttle time: %w", err)
	}

	// Error code (int16) — v7+
	if apiVersion >= 7 {
		if err := r.skip(2); err != nil {
			return nil, fmt.Errorf("error code: %w", err)
		}
	}

	// Session ID (int32) — v7+
	if apiVersion >= 7 {
		if err := r.skip(4); err != nil {
			return nil, fmt.Errorf("session id: %w", err)
		}
	}

	topicCount, err := r.readArrayLen()
	if err != nil {
		return nil, fmt.Errorf("topic count: %w", err)
	}

	var records []fetchedRecord
	for i := 0; i < topicCount; i++ {
		topicName, err := r.readString()
		if err != nil {
			return records, fmt.Errorf("topic name: %w", err)
		}

		partCount, err := r.readArrayLen()
		if err != nil {
			return records, fmt.Errorf("partition count: %w", err)
		}

		for j := 0; j < partCount; j++ {
			partIndex, err := r.readInt32()
			if err != nil {
				return records, fmt.Errorf("partition index: %w", err)
			}

			// Error code (int16)
			if err := r.skip(2); err != nil {
				return records, nil
			}

			// High watermark (int64)
			if err := r.skip(8); err != nil {
				return records, nil
			}

			// Last stable offset (int64) — v4+
			if apiVersion >= 4 {
				if err := r.skip(8); err != nil {
					return records, nil
				}
			}

			// Log start offset (int64) — v5+
			if apiVersion >= 5 {
				if err := r.skip(8); err != nil {
					return records, nil
				}
			}

			// Aborted transactions — v4+
			if apiVersion >= 4 {
				abortedCount, err := r.readArrayLen()
				if err != nil {
					return records, nil
				}
				// Each aborted transaction: producerId(int64) + firstOffset(int64)
				for k := 0; k < abortedCount; k++ {
					if err := r.skip(16); err != nil {
						return records, nil
					}
					if flex {
						r.skipTaggedFields()
					}
				}
			}

			// Preferred read replica (int32) — v11+
			if apiVersion >= 11 {
				if err := r.skip(4); err != nil {
					return records, nil
				}
			}

			// Records (nullable bytes — the record batch)
			batchBytes, err := r.readNullableRawBytes()
			if err != nil {
				return records, nil
			}

			if batchBytes != nil {
				parsed := parseFetchRecordBatch(batchBytes, topicName, partIndex)
				records = append(records, parsed...)
			}

			if flex {
				r.skipTaggedFields()
			}
		}

		if flex {
			r.skipTaggedFields()
		}
	}

	return records, nil
}

// ---------- record batch ----------

func parseRecordBatch(data []byte, topic string, partition int32) []producedRecord {
	// Record batch header: baseOffset(8) + batchLength(4) + partLeaderEpoch(4) +
	//   magic(1) + crc(4) + attributes(2) + lastOffsetDelta(4) +
	//   firstTimestamp(8) + maxTimestamp(8) + producerId(8) + producerEpoch(2) +
	//   baseSequence(4) + recordCount(4) = 61 bytes
	if len(data) < 61 {
		return nil
	}

	magic := data[16]
	if magic != 2 {
		return nil // only v2 record batches
	}

	attributes := binary.BigEndian.Uint16(data[21:23])
	compression := attributes & 0x07
	if compression != 0 {
		log.Printf("Kafka: skipping compressed record batch (codec=%d) in topic — messages will not appear in $.messageLogs", compression)
		return nil
	}

	baseOffset := int64(binary.BigEndian.Uint64(data[0:8]))
	recordCount := int32(binary.BigEndian.Uint32(data[57:61]))
	pos := 61

	var records []producedRecord
	for i := int32(0); i < recordCount && pos < len(data); i++ {
		rec, newPos, err := parseRecord(data, pos)
		if err != nil {
			break
		}
		pos = newPos

		records = append(records, producedRecord{
			Topic:     topic,
			Partition: partition,
			Key:       rec.key,
			Value:     rec.value,
		})
		_ = baseOffset // available if needed
	}

	return records
}

func parseFetchRecordBatch(data []byte, topic string, partition int32) []fetchedRecord {
	if len(data) < 61 {
		return nil
	}

	magic := data[16]
	if magic != 2 {
		return nil
	}

	attributes := binary.BigEndian.Uint16(data[21:23])
	compression := attributes & 0x07
	if compression != 0 {
		log.Printf("Kafka: skipping compressed record batch (codec=%d) in topic — messages will not appear in $.messageLogs", compression)
		return nil
	}

	baseOffset := int64(binary.BigEndian.Uint64(data[0:8]))
	recordCount := int32(binary.BigEndian.Uint32(data[57:61]))
	pos := 61

	var records []fetchedRecord
	for i := int32(0); i < recordCount && pos < len(data); i++ {
		rec, newPos, err := parseRecord(data, pos)
		if err != nil {
			break
		}
		pos = newPos

		records = append(records, fetchedRecord{
			Topic:     topic,
			Partition: partition,
			Offset:    baseOffset + int64(rec.offsetDelta),
			Key:       rec.key,
			Value:     rec.value,
		})
	}

	return records
}

// rawRecord holds fields from a single v2 record.
type rawRecord struct {
	offsetDelta int32
	key         []byte
	value       []byte
}

func parseRecord(data []byte, pos int) (rawRecord, int, error) {
	// Record length (zigzag varint)
	recLen, n, err := readZigzagVarint(data, pos)
	if err != nil {
		return rawRecord{}, pos, err
	}
	pos = n
	recEnd := pos + int(recLen)
	if recEnd > len(data) {
		return rawRecord{}, pos, fmt.Errorf("record extends beyond batch")
	}

	// Attributes (1 byte)
	if pos >= recEnd {
		return rawRecord{}, recEnd, fmt.Errorf("record too short for attributes")
	}
	pos++

	// Timestamp delta (zigzag varint)
	_, pos, err = readZigzagVarint(data, pos)
	if err != nil {
		return rawRecord{}, recEnd, err
	}

	// Offset delta (zigzag varint)
	offsetDelta, pos, err := readZigzagVarint(data, pos)
	if err != nil {
		return rawRecord{}, recEnd, err
	}

	// Key length (zigzag varint, -1 = null)
	keyLen, pos, err := readZigzagVarint(data, pos)
	if err != nil {
		return rawRecord{}, recEnd, err
	}
	var key []byte
	if keyLen >= 0 {
		if pos+int(keyLen) > len(data) {
			return rawRecord{}, recEnd, fmt.Errorf("key extends beyond data")
		}
		key = data[pos : pos+int(keyLen)]
		pos += int(keyLen)
	}

	// Value length (zigzag varint, -1 = null)
	valLen, pos, err := readZigzagVarint(data, pos)
	if err != nil {
		return rawRecord{}, recEnd, err
	}
	var value []byte
	if valLen >= 0 {
		if pos+int(valLen) > len(data) {
			return rawRecord{}, recEnd, fmt.Errorf("value extends beyond data")
		}
		value = data[pos : pos+int(valLen)]
		pos += int(valLen)
	}

	// Skip headers — advance to record end
	return rawRecord{
		offsetDelta: int32(offsetDelta),
		key:         key,
		value:       value,
	}, recEnd, nil
}

// ---------- helpers ----------

// isFlexibleRequest returns true if this API key + version uses flexible encoding.
func isFlexibleRequest(apiKey, apiVersion int16) bool {
	switch apiKey {
	case apiProduce:
		return apiVersion >= produceFlexVersion
	case apiFetch:
		return apiVersion >= fetchFlexVersion
	case apiMetadata:
		return apiVersion >= 9
	default:
		return apiVersion >= 2 // conservative default
	}
}

// reader provides sequential reading from a byte slice, with awareness of
// flexible vs non-flexible encoding.
type reader struct {
	buf  []byte
	pos  int
	flex bool
}

func (r *reader) readInt16() (int16, error) {
	if r.pos+2 > len(r.buf) {
		return 0, fmt.Errorf("need 2 bytes at %d, have %d", r.pos, len(r.buf))
	}
	v := int16(binary.BigEndian.Uint16(r.buf[r.pos : r.pos+2]))
	r.pos += 2
	return v, nil
}

func (r *reader) readInt32() (int32, error) {
	if r.pos+4 > len(r.buf) {
		return 0, fmt.Errorf("need 4 bytes at %d, have %d", r.pos, len(r.buf))
	}
	v := int32(binary.BigEndian.Uint32(r.buf[r.pos : r.pos+4]))
	r.pos += 4
	return v, nil
}

func (r *reader) skip(n int) error {
	if r.pos+n > len(r.buf) {
		return fmt.Errorf("cannot skip %d at pos %d, len %d", n, r.pos, len(r.buf))
	}
	r.pos += n
	return nil
}

// readString reads a string. In flexible mode, uses compact encoding.
func (r *reader) readString() (string, error) {
	if r.flex {
		return r.readCompactString()
	}
	return r.readLegacyString()
}

func (r *reader) readNullableString() (string, bool, error) {
	if r.flex {
		return r.readCompactNullableString()
	}
	return r.readLegacyNullableString()
}

func (r *reader) readLegacyString() (string, error) {
	if r.pos+2 > len(r.buf) {
		return "", fmt.Errorf("string length at %d", r.pos)
	}
	length := int(binary.BigEndian.Uint16(r.buf[r.pos : r.pos+2]))
	r.pos += 2
	if r.pos+length > len(r.buf) {
		return "", fmt.Errorf("string body %d at %d", length, r.pos)
	}
	s := string(r.buf[r.pos : r.pos+length])
	r.pos += length
	return s, nil
}

func (r *reader) readLegacyNullableString() (string, bool, error) {
	if r.pos+2 > len(r.buf) {
		return "", false, fmt.Errorf("nullable string length at %d", r.pos)
	}
	length := int16(binary.BigEndian.Uint16(r.buf[r.pos : r.pos+2]))
	r.pos += 2
	if length < 0 {
		return "", false, nil
	}
	if r.pos+int(length) > len(r.buf) {
		return "", false, fmt.Errorf("nullable string body %d at %d", length, r.pos)
	}
	s := string(r.buf[r.pos : r.pos+int(length)])
	r.pos += int(length)
	return s, true, nil
}

func (r *reader) readCompactString() (string, error) {
	length, err := r.readUvarint()
	if err != nil {
		return "", err
	}
	if length == 0 {
		return "", fmt.Errorf("compact string is null")
	}
	strLen := int(length) - 1
	if r.pos+strLen > len(r.buf) {
		return "", fmt.Errorf("compact string body %d at %d", strLen, r.pos)
	}
	s := string(r.buf[r.pos : r.pos+strLen])
	r.pos += strLen
	return s, nil
}

func (r *reader) readCompactNullableString() (string, bool, error) {
	length, err := r.readUvarint()
	if err != nil {
		return "", false, err
	}
	if length == 0 {
		return "", false, nil
	}
	strLen := int(length) - 1
	if r.pos+strLen > len(r.buf) {
		return "", false, fmt.Errorf("compact nullable string body %d at %d", strLen, r.pos)
	}
	s := string(r.buf[r.pos : r.pos+strLen])
	r.pos += strLen
	return s, true, nil
}

// readArrayLen reads an array count.
func (r *reader) readArrayLen() (int, error) {
	if r.flex {
		n, err := r.readUvarint()
		if err != nil {
			return 0, err
		}
		return int(n) - 1, nil // compact arrays encode count+1
	}
	v, err := r.readInt32()
	return int(v), err
}

// readRawBytes reads a length-prefixed bytes field.
func (r *reader) readRawBytes() ([]byte, error) {
	var length int
	if r.flex {
		n, err := r.readUvarint()
		if err != nil {
			return nil, err
		}
		length = int(n) - 1
	} else {
		v, err := r.readInt32()
		if err != nil {
			return nil, err
		}
		length = int(v)
	}
	if length < 0 {
		return nil, nil
	}
	if r.pos+length > len(r.buf) {
		return nil, fmt.Errorf("bytes field %d at %d", length, r.pos)
	}
	b := r.buf[r.pos : r.pos+length]
	r.pos += length
	return b, nil
}

// readNullableRawBytes reads a nullable length-prefixed bytes field.
func (r *reader) readNullableRawBytes() ([]byte, error) {
	var length int
	if r.flex {
		n, err := r.readUvarint()
		if err != nil {
			return nil, err
		}
		if n == 0 {
			return nil, nil
		}
		length = int(n) - 1
	} else {
		v, err := r.readInt32()
		if err != nil {
			return nil, err
		}
		if v < 0 {
			return nil, nil
		}
		length = int(v)
	}
	if r.pos+length > len(r.buf) {
		return nil, fmt.Errorf("nullable bytes field %d at %d", length, r.pos)
	}
	b := r.buf[r.pos : r.pos+length]
	r.pos += length
	return b, nil
}

func (r *reader) readUvarint() (uint64, error) {
	v, n, err := readUvarint(r.buf, r.pos)
	if err != nil {
		return 0, err
	}
	r.pos = n
	return v, nil
}

func (r *reader) skipTaggedFields() {
	n, err := skipTaggedFields(r.buf, r.pos)
	if err == nil {
		r.pos = n
	}
}

// ---------- varint encoding ----------

// readUvarint reads an unsigned variable-length integer (protobuf encoding).
func readUvarint(data []byte, pos int) (uint64, int, error) {
	var result uint64
	var shift uint
	for i := 0; i < 10; i++ {
		if pos >= len(data) {
			return 0, pos, fmt.Errorf("uvarint: unexpected end at %d", pos)
		}
		b := data[pos]
		pos++
		result |= uint64(b&0x7F) << shift
		if b&0x80 == 0 {
			return result, pos, nil
		}
		shift += 7
	}
	return 0, pos, fmt.Errorf("uvarint: too many bytes")
}

// readZigzagVarint reads a zigzag-encoded signed varint (used in record batches).
func readZigzagVarint(data []byte, pos int) (int64, int, error) {
	uv, newPos, err := readUvarint(data, pos)
	if err != nil {
		return 0, newPos, err
	}
	// Zigzag decode: (uv >> 1) ^ -(uv & 1)
	return int64(uv>>1) ^ -int64(uv&1), newPos, nil
}

// skipTaggedFields skips over a tagged fields section (flexible versions).
// Format: uvarint count, then for each: uvarint tag + uvarint size + bytes.
func skipTaggedFields(data []byte, pos int) (int, error) {
	count, newPos, err := readUvarint(data, pos)
	if err != nil {
		return pos, err
	}
	pos = newPos
	for i := uint64(0); i < count; i++ {
		// Tag
		_, pos, err = readUvarint(data, pos)
		if err != nil {
			return pos, err
		}
		// Size
		size, np, err := readUvarint(data, pos)
		if err != nil {
			return pos, err
		}
		pos = np + int(size)
		if pos > len(data) {
			return pos, fmt.Errorf("tagged field extends beyond data")
		}
	}
	return pos, nil
}
