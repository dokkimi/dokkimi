package main

import (
	"bytes"
	"encoding/binary"
	"testing"
	"time"

	"go.mongodb.org/mongo-driver/v2/bson"
	)

func buildFindResponseMsg(cursorDoc bson.D) *mongoMessage {
	responseDoc := bson.D{
		{Key: "cursor", Value: cursorDoc},
		{Key: "ok", Value: float64(1)},
	}
	raw, err := bson.Marshal(responseDoc)
	if err != nil {
		panic(err)
	}
	msg := buildOPMsg(1, 42, 0, raw)
	return &mongoMessage{raw: msg, opCode: opMsg, responseTo: 42}
}

func TestExtractResponseDataFindTwoDocs(t *testing.T) {
	cursor := bson.D{
		{Key: "firstBatch", Value: bson.A{
			bson.D{
				{Key: "_id", Value: bson.NewObjectID()},
				{Key: "orderId", Value: "ORD-001"},
				{Key: "customer", Value: "alice@example.com"},
				{Key: "items", Value: bson.A{
					bson.D{{Key: "sku", Value: "Widget"}, {Key: "qty", Value: int32(2)}, {Key: "price", Value: 9.99}},
				}},
				{Key: "total", Value: 19.98},
				{Key: "status", Value: "completed"},
			},
			bson.D{
				{Key: "_id", Value: bson.NewObjectID()},
				{Key: "orderId", Value: "ORD-002"},
				{Key: "customer", Value: "bob@example.com"},
				{Key: "items", Value: bson.A{
					bson.D{{Key: "sku", Value: "Gadget"}, {Key: "qty", Value: int32(1)}, {Key: "price", Value: 24.99}},
				}},
				{Key: "total", Value: 24.99},
				{Key: "status", Value: "pending"},
			},
		}},
		{Key: "id", Value: int64(0)},
		{Key: "ns", Value: "dokkimi.orders"},
	}

	msg := buildFindResponseMsg(cursor)
	ri := extractResponseInfo(msg, "find")

	if ri.data == nil {
		t.Fatal("extractResponseData returned nil for valid find response with 2 docs")
	}
	if len(ri.data) != 2 {
		t.Fatalf("expected 2 results, got %d", len(ri.data))
	}
	if ri.data[0]["customer"] != "alice@example.com" {
		t.Errorf("data[0].customer = %v, want alice@example.com", ri.data[0]["customer"])
	}
}

func TestExtractResponseDataFindEmpty(t *testing.T) {
	cursor := bson.D{
		{Key: "firstBatch", Value: bson.A{}},
		{Key: "id", Value: int64(0)},
		{Key: "ns", Value: "dokkimi.orders"},
	}
	msg := buildFindResponseMsg(cursor)
	ri := extractResponseInfo(msg, "find")

	if ri.data == nil {
		t.Fatal("extractResponseData returned nil for empty firstBatch (should return [])")
	}
	if len(ri.data) != 0 {
		t.Fatalf("expected 0 results, got %d", len(ri.data))
	}
}

func TestStripCompressionOnFindResponse(t *testing.T) {
	cursor := bson.D{
		{Key: "firstBatch", Value: bson.A{
			bson.D{
				{Key: "_id", Value: bson.NewObjectID()},
				{Key: "orderId", Value: "ORD-001"},
				{Key: "customer", Value: "alice@example.com"},
			},
			bson.D{
				{Key: "_id", Value: bson.NewObjectID()},
				{Key: "orderId", Value: "ORD-002"},
				{Key: "customer", Value: "bob@example.com"},
			},
		}},
		{Key: "id", Value: int64(0)},
		{Key: "ns", Value: "dokkimi.orders"},
	}
	responseDoc := bson.D{
		{Key: "cursor", Value: cursor},
		{Key: "ok", Value: float64(1)},
	}
	raw, _ := bson.Marshal(responseDoc)
	msgBytes := buildOPMsg(1, 42, 0, raw)

	stripped := stripCompressionFromHello(msgBytes)
	msg := &mongoMessage{raw: stripped, opCode: opMsg, responseTo: 42}
	ri := extractResponseInfo(msg, "find")

	if ri.data == nil {
		t.Fatal("stripCompressionFromHello corrupted the find response - data is nil")
	}
	if len(ri.data) != 2 {
		t.Fatalf("expected 2 results after stripping, got %d", len(ri.data))
	}
}

func TestHelloResponseSkipBSONAllTypes(t *testing.T) {
	// Build a hello response with the types MongoDB actually uses
	doc := bson.D{
		{Key: "ismaster", Value: true},                          // bool 0x08
		{Key: "maxBsonObjectSize", Value: int32(16777216)},      // int32 0x10
		{Key: "maxMessageSizeBytes", Value: int32(48000000)},    // int32
		{Key: "localTime", Value: bson.DateTime(time.Now().UnixMilli())}, // datetime 0x09
		{Key: "connectionId", Value: int64(42)},                 // int64 0x12
		{Key: "minWireVersion", Value: int32(0)},                // int32
		{Key: "maxWireVersion", Value: int32(21)},               // int32
		{Key: "readOnly", Value: false},                         // bool
		{Key: "topologyVersion", Value: bson.D{                  // document 0x03
			{Key: "processId", Value: bson.NewObjectID()},
			{Key: "counter", Value: int64(0)},
		}},
		{Key: "compression", Value: bson.A{"zstd", "snappy"}},  // array 0x04
		{Key: "ok", Value: float64(1)},                          // double 0x01
	}

	raw, _ := bson.Marshal(doc)
	msgBytes := buildOPMsg(1, 1, 0, raw)

	stripped := stripCompressionFromHello(msgBytes)
	if len(stripped) >= len(msgBytes) {
		t.Error("compression should have been stripped")
	}

	// Verify no compression field remains
	msg, _ := readMessage(bytes.NewReader(stripped))
	body := msg.raw[headerSize:]
	bsonDoc := body[5:]
	docLen := int(binary.LittleEndian.Uint32(bsonDoc[0:4]))

	pos := 4
	for pos < docLen-1 && pos < len(bsonDoc) {
		elemType := bsonDoc[pos]
		pos++
		fieldName, newPos := readCString(bsonDoc, pos, docLen)
		if fieldName == "" {
			break
		}
		pos = newPos
		if fieldName == "compression" {
			t.Error("compression field should have been removed")
		}
		nextPos := skipBSONValue(elemType, bsonDoc, pos, docLen)
		if nextPos < 0 {
			t.Fatalf("skipBSONValue failed for field %q (type 0x%02x) at pos %d", fieldName, elemType, pos)
		}
		pos = nextPos
	}
}

func TestHelloWithOperationTime(t *testing.T) {
	// operationTime uses BSON Timestamp type (0x11) which is different from datetime
	// $clusterTime contains a binary signature hash
	doc := bson.D{
		{Key: "ismaster", Value: true},
		{Key: "maxWireVersion", Value: int32(21)},
		{Key: "compression", Value: bson.A{"zstd"}},
		{Key: "operationTime", Value: bson.Timestamp{T: 1714444800, I: 1}}, // timestamp 0x11
		{Key: "$clusterTime", Value: bson.D{
			{Key: "clusterTime", Value: bson.Timestamp{T: 1714444800, I: 1}},
			{Key: "signature", Value: bson.D{
				{Key: "hash", Value: bson.Binary{Subtype: 0x00, Data: make([]byte, 20)}}, // binary 0x05
				{Key: "keyId", Value: int64(0)},
			}},
		}},
		{Key: "ok", Value: float64(1)},
	}

	raw, _ := bson.Marshal(doc)
	msgBytes := buildOPMsg(1, 1, 0, raw)

	stripped := stripCompressionFromHello(msgBytes)
	if len(stripped) >= len(msgBytes) {
		t.Error("compression should have been stripped even with operationTime/clusterTime")
	}
}
