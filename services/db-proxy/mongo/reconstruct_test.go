package main

import (
	"fmt"
	"testing"

	"go.mongodb.org/mongo-driver/v2/bson"
)

// These tests verify what reconstructQuery produces for the BSON documents
// that the Go mongo driver actually sends on the wire for each operation.
// The test definitions must use these exact strings as query fields.

func buildRealOPMsg(doc bson.D) *mongoMessage {
	raw, err := bson.Marshal(doc)
	if err != nil {
		panic(err)
	}
	msg := buildOPMsg(1, 0, 0, raw)
	m := &mongoMessage{raw: msg, opCode: opMsg}
	return m
}

func TestReconstructRealFind(t *testing.T) {
	// Go driver sends: {find: "orders", filter: {}, $db: "dokkimi", lsid: {...}}
	doc := bson.D{
		{Key: "find", Value: "orders"},
		{Key: "filter", Value: bson.D{}},
		{Key: "$db", Value: "dokkimi"},
	}
	msg := buildRealOPMsg(doc)
	ci := extractCommandInfo(msg)
	got := reconstructQuery(ci)
	fmt.Printf("find: %s\n", got)

	want := `{"operation":"find","collection":"orders","filter":{}}`
	if got != want {
		t.Errorf("find:\n  got:  %s\n  want: %s", got, want)
	}
}

func TestReconstructRealFindWithFilter(t *testing.T) {
	doc := bson.D{
		{Key: "find", Value: "orders"},
		{Key: "filter", Value: bson.D{{Key: "orderId", Value: "ORD-001"}}},
		{Key: "$db", Value: "dokkimi"},
	}
	msg := buildRealOPMsg(doc)
	ci := extractCommandInfo(msg)
	got := reconstructQuery(ci)
	fmt.Printf("find w/ filter: %s\n", got)

	want := `{"operation":"find","collection":"orders","filter":{"orderId":"ORD-001"}}`
	if got != want {
		t.Errorf("find w/ filter:\n  got:  %s\n  want: %s", got, want)
	}
}

func TestReconstructRealFindOne(t *testing.T) {
	// findOne sends "find" with limit:1 and singleBatch:true
	doc := bson.D{
		{Key: "find", Value: "orders"},
		{Key: "filter", Value: bson.D{{Key: "orderId", Value: "ORD-001"}}},
		{Key: "limit", Value: int64(1)},
		{Key: "singleBatch", Value: true},
		{Key: "$db", Value: "dokkimi"},
	}
	msg := buildRealOPMsg(doc)
	ci := extractCommandInfo(msg)
	got := reconstructQuery(ci)
	fmt.Printf("findOne: %s\n", got)

	want := `{"operation":"findOne","collection":"orders","filter":{"orderId":"ORD-001"}}`
	if got != want {
		t.Errorf("findOne:\n  got:  %s\n  want: %s", got, want)
	}
}

func TestReconstructRealInsertOne(t *testing.T) {
	// insertOne sends: {insert: "orders", documents: [{...}], ordered: true, $db: "dokkimi"}
	doc := bson.D{
		{Key: "insert", Value: "orders"},
		{Key: "documents", Value: bson.A{bson.D{{Key: "orderId", Value: "ORD-100"}, {Key: "customer", Value: "test@example.com"}}}},
		{Key: "ordered", Value: true},
		{Key: "$db", Value: "dokkimi"},
	}
	msg := buildRealOPMsg(doc)
	ci := extractCommandInfo(msg)
	got := reconstructQuery(ci)
	fmt.Printf("insertOne: %s\n", got)

	want := `{"operation":"insertOne","collection":"orders","document":{"orderId":"ORD-100","customer":"test@example.com"}}`
	if got != want {
		t.Errorf("insertOne:\n  got:  %s\n  want: %s", got, want)
	}
}

func TestReconstructRealInsertMany(t *testing.T) {
	doc := bson.D{
		{Key: "insert", Value: "orders"},
		{Key: "documents", Value: bson.A{
			bson.D{{Key: "orderId", Value: "ORD-100"}},
			bson.D{{Key: "orderId", Value: "ORD-101"}},
		}},
		{Key: "ordered", Value: true},
		{Key: "$db", Value: "dokkimi"},
	}
	msg := buildRealOPMsg(doc)
	ci := extractCommandInfo(msg)
	got := reconstructQuery(ci)
	fmt.Printf("insertMany: %s\n", got)

	want := `{"operation":"insertMany","collection":"orders","documents":[{"orderId":"ORD-100"},{"orderId":"ORD-101"}]}`
	if got != want {
		t.Errorf("insertMany:\n  got:  %s\n  want: %s", got, want)
	}
}

func TestReconstructRealUpdateOne(t *testing.T) {
	// updateOne sends: {update: "orders", updates: [{q: {filter}, u: {$set: {...}}, multi: false}], $db: "dokkimi"}
	doc := bson.D{
		{Key: "update", Value: "orders"},
		{Key: "updates", Value: bson.A{bson.D{
			{Key: "q", Value: bson.D{{Key: "orderId", Value: "ORD-001"}}},
			{Key: "u", Value: bson.D{{Key: "$set", Value: bson.D{{Key: "status", Value: "shipped"}}}}},
			{Key: "multi", Value: false},
		}}},
		{Key: "ordered", Value: true},
		{Key: "$db", Value: "dokkimi"},
	}
	msg := buildRealOPMsg(doc)
	ci := extractCommandInfo(msg)
	got := reconstructQuery(ci)
	fmt.Printf("updateOne: %s\n", got)

	want := `{"operation":"updateOne","collection":"orders","filter":{"orderId":"ORD-001"},"update":{"$set":{"status":"shipped"}}}`
	if got != want {
		t.Errorf("updateOne:\n  got:  %s\n  want: %s", got, want)
	}
}

func TestReconstructRealUpdateMany(t *testing.T) {
	doc := bson.D{
		{Key: "update", Value: "orders"},
		{Key: "updates", Value: bson.A{bson.D{
			{Key: "q", Value: bson.D{{Key: "status", Value: "pending"}}},
			{Key: "u", Value: bson.D{{Key: "$set", Value: bson.D{{Key: "status", Value: "cancelled"}}}}},
			{Key: "multi", Value: true},
		}}},
		{Key: "ordered", Value: true},
		{Key: "$db", Value: "dokkimi"},
	}
	msg := buildRealOPMsg(doc)
	ci := extractCommandInfo(msg)
	got := reconstructQuery(ci)
	fmt.Printf("updateMany: %s\n", got)

	want := `{"operation":"updateMany","collection":"orders","filter":{"status":"pending"},"update":{"$set":{"status":"cancelled"}}}`
	if got != want {
		t.Errorf("updateMany:\n  got:  %s\n  want: %s", got, want)
	}
}

func TestReconstructRealDeleteOne(t *testing.T) {
	// deleteOne sends: {delete: "orders", deletes: [{q: {filter}, limit: 1}], $db: "dokkimi"}
	doc := bson.D{
		{Key: "delete", Value: "orders"},
		{Key: "deletes", Value: bson.A{bson.D{
			{Key: "q", Value: bson.D{{Key: "orderId", Value: "ORD-DELETE"}}},
			{Key: "limit", Value: int32(1)},
		}}},
		{Key: "ordered", Value: true},
		{Key: "$db", Value: "dokkimi"},
	}
	msg := buildRealOPMsg(doc)
	ci := extractCommandInfo(msg)
	got := reconstructQuery(ci)
	fmt.Printf("deleteOne: %s\n", got)

	want := `{"operation":"deleteOne","collection":"orders","filter":{"orderId":"ORD-DELETE"}}`
	if got != want {
		t.Errorf("deleteOne:\n  got:  %s\n  want: %s", got, want)
	}
}

func TestReconstructRealDeleteMany(t *testing.T) {
	doc := bson.D{
		{Key: "delete", Value: "orders"},
		{Key: "deletes", Value: bson.A{bson.D{
			{Key: "q", Value: bson.D{{Key: "status", Value: "cancelled"}}},
			{Key: "limit", Value: int32(0)},
		}}},
		{Key: "ordered", Value: true},
		{Key: "$db", Value: "dokkimi"},
	}
	msg := buildRealOPMsg(doc)
	ci := extractCommandInfo(msg)
	got := reconstructQuery(ci)
	fmt.Printf("deleteMany: %s\n", got)

	want := `{"operation":"deleteMany","collection":"orders","filter":{"status":"cancelled"}}`
	if got != want {
		t.Errorf("deleteMany:\n  got:  %s\n  want: %s", got, want)
	}
}
