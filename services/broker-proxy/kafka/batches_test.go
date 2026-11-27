package main

import (
	"bytes"
	"compress/gzip"
	"encoding/binary"
	"encoding/json"
	"testing"

	"github.com/klauspost/compress/s2"
	"github.com/klauspost/compress/zstd"
	"github.com/pierrec/lz4/v4"
	"github.com/twmb/franz-go/pkg/kmsg"
)

type kv struct{ key, value string }

// rawRecords encodes records the way a v2 batch holds them (uncompressed).
func rawRecords(recs []kv) []byte {
	var out []byte
	for i, r := range recs {
		var rec []byte
		rec = append(rec, 0)                             // attributes
		rec = append(rec, 0)                             // timestamp delta
		rec = appendZigzagVarint(rec, int64(i))          // offset delta
		rec = appendZigzagVarint(rec, int64(len(r.key))) //
		rec = append(rec, r.key...)
		rec = appendZigzagVarint(rec, int64(len(r.value)))
		rec = append(rec, r.value...)
		rec = appendZigzagVarint(rec, 0) // headers
		out = appendZigzagVarint(out, int64(len(rec)))
		out = append(out, rec...)
	}
	return out
}

func compress(t *testing.T, codec int16, data []byte) []byte {
	t.Helper()
	var buf bytes.Buffer
	switch codec {
	case 0:
		return data
	case 1:
		w := gzip.NewWriter(&buf)
		w.Write(data)
		w.Close()
	case 2:
		return s2.EncodeSnappy(nil, data)
	case 3:
		w := lz4.NewWriter(&buf)
		w.Write(data)
		w.Close()
	case 4:
		enc, _ := zstd.NewWriter(nil)
		return enc.EncodeAll(data, nil)
	}
	return buf.Bytes()
}

// batch builds a v2 record batch with kmsg.
func batch(t *testing.T, firstOffset int64, attrs int16, producerID int64, codec int16, recs []kv) []byte {
	t.Helper()
	b := kmsg.RecordBatch{
		FirstOffset:     firstOffset,
		Magic:           2,
		Attributes:      attrs | codec,
		LastOffsetDelta: int32(len(recs) - 1),
		ProducerID:      producerID,
		NumRecords:      int32(len(recs)),
		Records:         compress(t, codec, rawRecords(recs)),
	}
	out := b.AppendTo(nil)
	binary.BigEndian.PutUint32(out[8:12], uint32(len(out)-12))
	return out
}

func values(recs []record) []string {
	var out []string
	for _, r := range recs {
		out = append(out, string(r.value))
	}
	return out
}

func equal(a, b []string) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}

// A partition's records can hold many batches; every one is read.
func TestReadRecords_EveryBatch(t *testing.T) {
	data := append(batch(t, 0, 0, -1, 0, []kv{{"", "a"}}), batch(t, 1, 0, -1, 0, []kv{{"", "b"}, {"", "c"}})...)
	data = append(data, batch(t, 3, 0, -1, 0, []kv{{"", "d"}})...)
	recs, err := readRecords(data, nil)
	if err != nil || !equal(values(recs), []string{"a", "b", "c", "d"}) {
		t.Errorf("got %v, %v", values(recs), err)
	}
	if recs[2].offset != 2 {
		t.Errorf("offset of c: got %d, want 2", recs[2].offset)
	}
}

// Every codec Kafka uses is decoded; snappy also in Java's xerial framing.
func TestReadRecords_Compressed(t *testing.T) {
	for codec, name := range map[int16]string{1: "gzip", 2: "snappy", 3: "lz4", 4: "zstd"} {
		recs, err := readRecords(batch(t, 0, 0, -1, codec, []kv{{"k", name}, {"k", name + "2"}}), nil)
		if err != nil || !equal(values(recs), []string{name, name + "2"}) {
			t.Errorf("%s: got %v, %v", name, values(recs), err)
		}
	}
	block := s2.EncodeSnappy(nil, rawRecords([]kv{{"", "xerial"}}))
	xerial := append(append([]byte{}, xerialPrefix...), 0, 0, 0, 1, 0, 0, 0, 1)
	xerial = binary.BigEndian.AppendUint32(xerial, uint32(len(block)))
	xerial = append(xerial, block...)
	b := kmsg.RecordBatch{Magic: 2, Attributes: 2, NumRecords: 1, Records: xerial}
	raw := b.AppendTo(nil)
	binary.BigEndian.PutUint32(raw[8:12], uint32(len(raw)-12))
	if recs, err := readRecords(raw, nil); err != nil || !equal(values(recs), []string{"xerial"}) {
		t.Errorf("xerial snappy: got %v, %v", values(recs), err)
	}
}

// Control batches are transaction markers, not messages.
func TestReadRecords_SkipsControlBatches(t *testing.T) {
	data := append(batch(t, 0, attrTransactional, 7, 0, []kv{{"", "committed"}}),
		batch(t, 1, attrTransactional|attrControl, 7, 0, []kv{{"\x00\x00\x00\x01", "\x00\x00\x00\x00\x00\x00"}})...)
	if recs, _ := readRecords(data, nil); !equal(values(recs), []string{"committed"}) {
		t.Errorf("got %v", values(recs))
	}
}

// A read_committed fetch lists aborted transactions; their records aren't
// delivered to the consumer, so they aren't logged as consumed.
func TestReadRecords_SkipsAbortedTransactions(t *testing.T) {
	var data []byte
	data = append(data, batch(t, 0, attrTransactional, 7, 0, []kv{{"", "aborted"}})...)
	data = append(data, batch(t, 1, attrTransactional|attrControl, 7, 0, []kv{{"\x00\x00\x00\x00", "x"}})...)
	data = append(data, batch(t, 2, attrTransactional, 7, 0, []kv{{"", "committed"}})...)
	data = append(data, batch(t, 3, 0, -1, 0, []kv{{"", "plain"}})...)
	aborted := []kmsg.FetchResponseTopicPartitionAbortedTransaction{{ProducerID: 7, FirstOffset: 0}}
	if recs, _ := readRecords(data, aborted); !equal(values(recs), []string{"committed", "plain"}) {
		t.Errorf("got %v", values(recs))
	}
}

// A fetch can end in the middle of a batch.
func TestReadRecords_IgnoresACutOffBatch(t *testing.T) {
	data := append(batch(t, 0, 0, -1, 0, []kv{{"", "whole"}}), batch(t, 1, 0, -1, 0, []kv{{"", "cut"}})[:30]...)
	if recs, _ := readRecords(data, nil); !equal(values(recs), []string{"whole"}) {
		t.Errorf("got %v", values(recs))
	}
}

// Fetch v13+ and Produce v13+ name topics by ID; the name comes from a
// Metadata response.
func TestTopicIDsAreResolvedFromMetadata(t *testing.T) {
	id := [16]byte{1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16}
	name := "orders"

	md := kmsg.NewPtrMetadataResponse()
	md.Version = 12
	mt := kmsg.NewMetadataResponseTopic()
	mt.Topic, mt.TopicID = &name, id
	md.Topics = append(md.Topics, mt)
	if err := recordTopicNames(md.AppendTo(nil), 12); err != nil {
		t.Fatal(err)
	}

	fr := kmsg.NewPtrFetchResponse()
	fr.Version = 16
	ft := kmsg.NewFetchResponseTopic()
	ft.TopicID = id
	fp := kmsg.NewFetchResponseTopicPartition()
	fp.Partition = 3
	fp.RecordBatches = batch(t, 5, 0, -1, 4, []kv{{"", `{"n":1}`}})
	ft.Partitions = append(ft.Partitions, fp)
	fr.Topics = append(fr.Topics, ft)
	fetched, err := parseFetchResponse(fr.AppendTo(nil), 16)
	if err != nil || len(fetched) != 1 || fetched[0].Topic != name || fetched[0].Partition != 3 || fetched[0].Offset != 5 {
		t.Fatalf("fetch: got %+v, %v", fetched, err)
	}

	pr := kmsg.NewPtrProduceRequest()
	pr.Version = 13
	pt := kmsg.NewProduceRequestTopic()
	pt.TopicID = id
	pp := kmsg.NewProduceRequestTopicPartition()
	pp.Records = batch(t, 0, 0, -1, 0, []kv{{"", "a"}, {"", "b"}})
	pt.Partitions = append(pt.Partitions, pp)
	pr.Topics = append(pr.Topics, pt)
	produced, err := parseProduceRequest(pr.AppendTo(nil), 13)
	if err != nil || len(produced) != 2 || produced[0].Topic != name {
		t.Fatalf("produce: got %+v, %v", produced, err)
	}
}

// Large integers stay exact in a logged body.
func TestDecodeJSON_KeepsNumbersExact(t *testing.T) {
	v, ok := decodeJSON([]byte(`{"id":1234567890123456789}`))
	out, _ := json.Marshal(v)
	if !ok || string(out) != `{"id":1234567890123456789}` {
		t.Errorf("got %s", out)
	}
	if _, ok := decodeJSON([]byte(`{"a":1} trailing`)); ok {
		t.Error("text after the JSON should make it not JSON")
	}
}
