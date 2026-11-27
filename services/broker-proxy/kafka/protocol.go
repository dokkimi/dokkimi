package main

import (
	"bytes"
	"compress/gzip"
	"encoding/binary"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"sort"
	"sync"

	"github.com/klauspost/compress/s2"
	"github.com/klauspost/compress/zstd"
	"github.com/pierrec/lz4/v4"
	"github.com/twmb/franz-go/pkg/kmsg"
)

// Kafka API keys
const (
	apiProduce  int16 = 0
	apiFetch    int16 = 1
	apiMetadata int16 = 3
)

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
	if isFlexible(h.APIKey, h.APIVersion) {
		n, err := skipTaggedFields(payload, pos)
		if err == nil {
			pos = n
		}
	}

	return h, pos, nil
}

// ---------- Produce, Fetch and Metadata ----------
//
// Requests and responses are decoded with franz-go's kmsg, which knows every
// version of every Kafka API, including the topic IDs that Produce v13+ and
// Fetch v13+ use instead of topic names.

// isFlexible reports whether an API version uses Kafka's flexible encoding,
// which also decides whether its request and response headers have tagged
// fields.
func isFlexible(apiKey, apiVersion int16) bool {
	req := kmsg.RequestForKey(apiKey)
	if req == nil {
		return false
	}
	req.SetVersion(apiVersion)
	return req.IsFlexible()
}

// responseBody returns a response payload without its header: the correlation
// ID, and the tagged fields a flexible response header has.
func responseBody(payload []byte, apiKey, apiVersion int16) ([]byte, error) {
	if len(payload) < 4 {
		return nil, fmt.Errorf("response too short: %d", len(payload))
	}
	pos := 4
	if isFlexible(apiKey, apiVersion) {
		n, err := skipTaggedFields(payload, pos)
		if err != nil {
			return nil, err
		}
		pos = n
	}
	return payload[pos:], nil
}

// topicNames maps topic IDs to names, learned from Metadata responses. It is
// shared by all connections: a client may fetch metadata on one connection
// and produce or fetch on another.
var topicNames sync.Map // [16]byte → string

func recordTopicNames(body []byte, apiVersion int16) error {
	resp := kmsg.NewPtrMetadataResponse()
	resp.Version = apiVersion
	if err := resp.ReadFrom(body); err != nil {
		return err
	}
	for _, t := range resp.Topics {
		if t.Topic != nil && t.TopicID != ([16]byte{}) {
			topicNames.Store(t.TopicID, *t.Topic)
		}
	}
	return nil
}

// topicName returns a topic's name, from the request or response itself or,
// for v13+, from its ID. An ID never seen in a Metadata response is shown as
// is.
func topicName(name string, id [16]byte) string {
	if name != "" || id == ([16]byte{}) {
		return name
	}
	if n, ok := topicNames.Load(id); ok {
		return n.(string)
	}
	return hex.EncodeToString(id[:])
}

func parseProduceRequest(body []byte, apiVersion int16) ([]producedRecord, error) {
	req := kmsg.NewPtrProduceRequest()
	req.Version = apiVersion
	if err := req.ReadFrom(body); err != nil {
		return nil, err
	}
	var records []producedRecord
	var firstErr error
	for _, t := range req.Topics {
		topic := topicName(t.Topic, t.TopicID)
		for _, p := range t.Partitions {
			recs, err := readRecords(p.Records, nil)
			if err != nil && firstErr == nil {
				firstErr = err
			}
			for _, r := range recs {
				records = append(records, producedRecord{Topic: topic, Partition: p.Partition, Key: r.key, Value: r.value})
			}
		}
	}
	return records, firstErr
}

func parseFetchResponse(body []byte, apiVersion int16) ([]fetchedRecord, error) {
	resp := kmsg.NewPtrFetchResponse()
	resp.Version = apiVersion
	if err := resp.ReadFrom(body); err != nil {
		return nil, err
	}
	var records []fetchedRecord
	var firstErr error
	for _, t := range resp.Topics {
		topic := topicName(t.Topic, t.TopicID)
		for _, p := range t.Partitions {
			recs, err := readRecords(p.RecordBatches, p.AbortedTransactions)
			if err != nil && firstErr == nil {
				firstErr = err
			}
			for _, r := range recs {
				records = append(records, fetchedRecord{Topic: topic, Partition: p.Partition, Offset: r.offset, Key: r.key, Value: r.value})
			}
		}
	}
	return records, firstErr
}

// ---------- record batches ----------

const (
	attrCompression   = 0x07
	attrTransactional = 0x10
	attrControl       = 0x20
)

// record is one message read from a record batch.
type record struct {
	offset int64
	key    []byte
	value  []byte
}

// readRecords reads the records of every record batch in data (one partition's
// "records" field, which can hold many batches back to back). Control batches,
// Kafka's transaction markers, are not messages and are skipped. aborted lists
// the transactions a read_committed Fetch says were aborted: their records
// are skipped too, as the consumer skips them. A batch cut off at the end of
// data (a Fetch can end mid-batch) is ignored.
func readRecords(data []byte, aborted []kmsg.FetchResponseTopicPartitionAbortedTransaction) ([]record, error) {
	aborted = append([]kmsg.FetchResponseTopicPartitionAbortedTransaction(nil), aborted...)
	sort.Slice(aborted, func(i, j int) bool { return aborted[i].FirstOffset < aborted[j].FirstOffset })
	inAbortedTxn := map[int64]bool{} // producer ID → its current transaction was aborted

	var records []record
	var firstErr error
	for len(data) >= 12 {
		size := 12 + int(int32(binary.BigEndian.Uint32(data[8:12])))
		if size < 12 || size > len(data) {
			break
		}
		batchBytes := data[:size]
		data = data[size:]

		var b kmsg.RecordBatch
		if err := b.ReadFrom(batchBytes); err != nil {
			if firstErr == nil {
				firstErr = err
			}
			continue
		}
		if b.Magic != 2 {
			continue // older message formats
		}

		for len(aborted) > 0 && aborted[0].FirstOffset <= b.FirstOffset {
			inAbortedTxn[aborted[0].ProducerID] = true
			aborted = aborted[1:]
		}
		transactional := b.Attributes&attrTransactional != 0
		if b.Attributes&attrControl != 0 {
			if transactional {
				delete(inAbortedTxn, b.ProducerID) // the commit or abort marker ends it
			}
			continue
		}
		if transactional && inAbortedTxn[b.ProducerID] {
			continue
		}

		raw, err := decompress(b.Attributes&attrCompression, b.Records)
		if err != nil {
			if firstErr == nil {
				firstErr = err
			}
			continue
		}
		pos := 0
		for i := int32(0); i < b.NumRecords && pos < len(raw); i++ {
			r, next, err := parseRecord(raw, pos)
			if err != nil {
				if firstErr == nil {
					firstErr = err
				}
				break
			}
			pos = next
			records = append(records, record{offset: b.FirstOffset + int64(r.offsetDelta), key: r.key, value: r.value})
		}
	}
	return records, firstErr
}

// maxDecompressed bounds what one batch may decompress to.
const maxDecompressed = 256 << 20

var zstdDecoder, _ = zstd.NewReader(nil, zstd.WithDecoderConcurrency(0), zstd.WithDecoderMaxMemory(maxDecompressed))

var xerialPrefix = []byte{130, 83, 78, 65, 80, 80, 89, 0}

// decompress returns a record batch's records uncompressed. Codecs: 1 gzip,
// 2 snappy (raw, or in the xerial framing Java producers use), 3 lz4, 4 zstd.
func decompress(codec int16, data []byte) ([]byte, error) {
	readAll := func(r io.Reader) ([]byte, error) {
		out, err := io.ReadAll(io.LimitReader(r, maxDecompressed+1))
		if err == nil && len(out) > maxDecompressed {
			err = errors.New("decompressed batch is too large")
		}
		return out, err
	}
	switch codec {
	case 0:
		return data, nil
	case 1:
		zr, err := gzip.NewReader(bytes.NewReader(data))
		if err != nil {
			return nil, fmt.Errorf("gzip: %w", err)
		}
		return readAll(zr)
	case 2:
		if len(data) > 16 && bytes.HasPrefix(data, xerialPrefix) {
			return xerialDecode(data[16:])
		}
		return s2.Decode(nil, data)
	case 3:
		return readAll(lz4.NewReader(bytes.NewReader(data)))
	case 4:
		return zstdDecoder.DecodeAll(data, nil)
	default:
		return nil, fmt.Errorf("unknown compression codec %d", codec)
	}
}

// xerialDecode decodes xerial-framed snappy (after its 16-byte header): chunks
// of a 4-byte length and a snappy block.
func xerialDecode(src []byte) ([]byte, error) {
	var out []byte
	for len(src) > 0 {
		if len(src) < 4 {
			return nil, errors.New("malformed xerial framing")
		}
		size := int(int32(binary.BigEndian.Uint32(src)))
		src = src[4:]
		if size < 0 || size > len(src) {
			return nil, errors.New("malformed xerial framing")
		}
		chunk, err := s2.Decode(nil, src[:size])
		if err != nil {
			return nil, err
		}
		out = append(out, chunk...)
		if len(out) > maxDecompressed {
			return nil, errors.New("decompressed batch is too large")
		}
		src = src[size:]
	}
	return out, nil
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
