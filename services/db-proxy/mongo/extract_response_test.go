package main

import (
	"testing"

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
