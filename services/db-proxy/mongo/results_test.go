package main

import (
	"bytes"
	"compress/zlib"
	"encoding/binary"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"
	"time"

	shared "github.com/dokkimi/dokkimi/services/db-proxy/shared"
	"github.com/golang/snappy"
	"github.com/klauspost/compress/zstd"
	"go.mongodb.org/mongo-driver/v2/bson"
)

// compressed wraps a message in OP_COMPRESSED, as a driver configured with
// that compressor sends it
func compressed(t *testing.T, msg []byte, compressor byte) []byte {
	t.Helper()
	body := msg[headerSize:]
	var data []byte
	switch compressor {
	case compressorNoop:
		data = body
	case compressorSnappy:
		data = snappy.Encode(nil, body)
	case compressorZlib:
		var buf bytes.Buffer
		w := zlib.NewWriter(&buf)
		w.Write(body)
		w.Close()
		data = buf.Bytes()
	case compressorZstd:
		enc, _ := zstd.NewWriter(nil)
		data = enc.EncodeAll(body, nil)
	}
	out := append([]byte(nil), msg[:headerSize]...)
	binary.LittleEndian.PutUint32(out[12:16], uint32(opCompressed))
	out = binary.LittleEndian.AppendUint32(out, uint32(opMsg))
	out = binary.LittleEndian.AppendUint32(out, uint32(len(body)))
	out = append(out, compressor)
	out = append(out, data...)
	binary.LittleEndian.PutUint32(out[0:4], uint32(len(out)))
	return out
}

// A compressed operation is read as the operation it holds, and forwarded
// as it came. Before, it was never logged.
func TestReadMessage_Compressed(t *testing.T) {
	doc, _ := bson.Marshal(bson.D{{Key: "insert", Value: "orders"}, {Key: "documents", Value: bson.A{bson.D{{Key: "id", Value: 1}}}}})
	plain := buildOPMsg(7, 0, 0, doc)

	for name, c := range map[string]byte{"noop": compressorNoop, "snappy": compressorSnappy, "zlib": compressorZlib, "zstd": compressorZstd} {
		wire := compressed(t, plain, c)
		msg, err := readMessage(bytes.NewReader(wire))
		if err != nil {
			t.Fatalf("%s: %v", name, err)
		}
		if !bytes.Equal(msg.wire, wire) {
			t.Errorf("%s: forwarded bytes changed", name)
		}
		if !bytes.Equal(msg.raw, plain) || msg.opCode != opMsg || msg.requestID != 7 {
			t.Errorf("%s: read as opcode %d, %d bytes; want the plain OP_MSG", name, msg.opCode, len(msg.raw))
		}
		if cmd := extractCommandInfo(msg); cmd.commandName != "insert" || cmd.collectionName != "orders" {
			t.Errorf("%s: command %+v", name, cmd)
		}
	}
}

// A compressed message that can't be decompressed is still forwarded.
func TestReadMessage_CompressedCorrupt(t *testing.T) {
	doc, _ := bson.Marshal(bson.D{{Key: "ping", Value: 1}})
	wire := compressed(t, buildOPMsg(1, 0, 0, doc), compressorZlib)
	wire[len(wire)-3] ^= 0xff
	msg, err := readMessage(bytes.NewReader(wire))
	if err != nil || !bytes.Equal(msg.wire, wire) || msg.opCode != opCompressed {
		t.Errorf("got %v, opcode %d; want it read as is", err, msg.opCode)
	}
}

func recordingConnection(t *testing.T) (*proxyConnection, func() []shared.DatabaseLogMessage) {
	t.Helper()
	logger, logs := recordingLogger(t)
	return newProxyConnection(nil, nil, &shared.Config{}, logger, newCursorRegistry()), logs
}

// recordingLogger sends logs to a fake Control Tower and returns what it got
func recordingLogger(t *testing.T) (*shared.QueryLogger, func() []shared.DatabaseLogMessage) {
	t.Helper()
	var mu sync.Mutex
	var got []shared.DatabaseLogMessage
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var m shared.DatabaseLogMessage
		if json.NewDecoder(r.Body).Decode(&m) == nil {
			mu.Lock()
			got = append(got, m)
			mu.Unlock()
		}
	}))
	t.Cleanup(srv.Close)
	logger := shared.NewQueryLogger(srv.URL, 2*time.Second)
	t.Cleanup(logger.Stop)
	return logger, func() []shared.DatabaseLogMessage {
		time.Sleep(300 * time.Millisecond)
		mu.Lock()
		defer mu.Unlock()
		return append([]shared.DatabaseLogMessage(nil), got...)
	}
}

func reply(t *testing.T, doc bson.D) *mongoMessage {
	t.Helper()
	raw, err := bson.Marshal(doc)
	if err != nil {
		t.Fatal(err)
	}
	return &mongoMessage{raw: buildOPMsg(2, 1, 0, raw), opCode: opMsg, responseTo: 1}
}

// A write the server rejects is answered with ok: 1 and writeErrors. Before,
// it was logged as a success.
func TestLogQuery_WriteErrors(t *testing.T) {
	pc, logs := recordingConnection(t)
	insert := pendingQuery{command: commandInfo{commandName: "insert", collectionName: "orders"}, startTime: time.Now()}
	pc.logQuery(insert, reply(t, bson.D{
		{Key: "n", Value: int32(0)},
		{Key: "writeErrors", Value: bson.A{bson.D{{Key: "index", Value: int32(0)}, {Key: "code", Value: int32(11000)}, {Key: "errmsg", Value: "E11000 duplicate key error"}}}},
		{Key: "ok", Value: float64(1)},
	}))
	pc.logQuery(insert, reply(t, bson.D{
		{Key: "n", Value: int32(1)},
		{Key: "writeConcernError", Value: bson.D{{Key: "code", Value: int32(64)}, {Key: "errmsg", Value: "waiting for replication timed out"}}},
		{Key: "ok", Value: float64(1)},
	}))

	got := logs()
	if len(got) != 2 {
		t.Fatalf("got %d entries, want 2", len(got))
	}
	if got[0].Success || got[0].Error != "E11000 duplicate key error" {
		t.Errorf("write error logged as %+v", got[0])
	}
	if got[1].Success || got[1].Error != "waiting for replication timed out" || got[1].RowsAffected != 1 {
		t.Errorf("write concern error logged as %+v", got[1])
	}
}

// rowsAffected is the rows a write changed or a read returned, and 0 rather
// than left out.
func TestLogQuery_RowsAffected(t *testing.T) {
	pc, logs := recordingConnection(t)
	pc.logQuery(pendingQuery{command: commandInfo{commandName: "update", collectionName: "orders"}, startTime: time.Now()},
		reply(t, bson.D{{Key: "n", Value: int32(2)}, {Key: "nModified", Value: int32(0)}, {Key: "ok", Value: float64(1)}}))
	pc.logQuery(pendingQuery{command: commandInfo{commandName: "aggregate", collectionName: "orders"}, startTime: time.Now()},
		reply(t, bson.D{{Key: "cursor", Value: bson.D{{Key: "firstBatch", Value: bson.A{bson.D{{Key: "a", Value: 1}}, bson.D{{Key: "a", Value: 2}}}}, {Key: "id", Value: int64(0)}}}, {Key: "ok", Value: float64(1)}}))

	got := logs()
	if len(got) != 2 || got[0].RowsAffected != 0 || got[1].RowsAffected != 2 {
		t.Errorf("got %+v, want rowsAffected 0 (nothing modified) and 2 (rows returned)", got)
	}
}
