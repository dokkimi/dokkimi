package main

import (
	"encoding/json"
	"testing"

	"go.mongodb.org/mongo-driver/v2/bson"
)

func reconstruct(t *testing.T, doc bson.D) string {
	t.Helper()
	return reconstructQuery(extractCommandInfo(buildRealOPMsg(doc)))
}

func TestReconstructKeepsIdInFilter(t *testing.T) {
	got := reconstruct(t, bson.D{
		{Key: "find", Value: "c"},
		{Key: "filter", Value: bson.D{{Key: "_id", Value: int64(5)}}},
		{Key: "limit", Value: int64(1)}, {Key: "singleBatch", Value: true},
		{Key: "$db", Value: "dokkimi"},
	})
	if want := `{"operation":"findOne","collection":"c","filter":{"_id":5}}`; got != want {
		t.Errorf("got  %s\nwant %s", got, want)
	}
}

func TestReconstructFindAndModifyKeepsFilter(t *testing.T) {
	got := reconstruct(t, bson.D{
		{Key: "findAndModify", Value: "c"},
		{Key: "query", Value: bson.D{{Key: "_id", Value: int64(3)}}},
		{Key: "update", Value: bson.D{{Key: "$set", Value: bson.D{{Key: "v", Value: int64(30)}}}}},
		{Key: "new", Value: true},
		{Key: "$db", Value: "dokkimi"},
	})
	if want := `{"operation":"findAndModify","collection":"c","filter":{"_id":3},"update":{"$set":{"v":30}},"new":true}`; got != want {
		t.Errorf("got  %s\nwant %s", got, want)
	}
}

func TestReconstructAggregateKeepsPipeline(t *testing.T) {
	got := reconstruct(t, bson.D{
		{Key: "aggregate", Value: "c"},
		{Key: "pipeline", Value: bson.A{bson.D{{Key: "$count", Value: "n"}}}},
		{Key: "cursor", Value: bson.D{}},
		{Key: "$db", Value: "dokkimi"},
	})
	if want := `{"operation":"aggregate","collection":"c","pipeline":[{"$count":"n"}]}`; got != want {
		t.Errorf("got  %s\nwant %s", got, want)
	}
}

func TestExtractResponseDataAggregateAndFindAndModify(t *testing.T) {
	agg, _ := bson.Marshal(bson.D{
		{Key: "cursor", Value: bson.D{{Key: "firstBatch", Value: bson.A{bson.D{{Key: "n", Value: int32(4)}}}}, {Key: "id", Value: int64(0)}}},
		{Key: "ok", Value: 1.0},
	})
	if data := extractResponseData(agg, "aggregate"); len(data) != 1 || data[0]["n"] != int64(4) {
		t.Errorf("aggregate: got %#v", data)
	}

	fam, _ := bson.Marshal(bson.D{
		{Key: "lastErrorObject", Value: bson.D{{Key: "n", Value: int32(1)}}},
		{Key: "value", Value: bson.D{{Key: "_id", Value: int64(3)}, {Key: "v", Value: int64(30)}}},
		{Key: "ok", Value: 1.0},
	})
	if data := extractResponseData(fam, "findAndModify"); len(data) != 1 || data[0]["v"] != int64(30) || data[0]["_id"] != int64(3) {
		t.Errorf("findAndModify: got %#v", data)
	}

	none, _ := bson.Marshal(bson.D{{Key: "value", Value: nil}, {Key: "ok", Value: 1.0}})
	if data := extractResponseData(none, "findAndModify"); data == nil || len(data) != 0 {
		t.Errorf("findAndModify with no match: got %#v, want an empty list", data)
	}
}

func TestResultDocumentsKeepObjectIdAsHex(t *testing.T) {
	id := bson.NewObjectID()
	raw, _ := json.Marshal(bsonDToMap(bson.D{{Key: "_id", Value: id}, {Key: "v", Value: int64(1)}}))
	if want := `{"_id":"` + id.Hex() + `","v":1}`; string(raw) != want {
		t.Errorf("got  %s\nwant %s", raw, want)
	}
}
