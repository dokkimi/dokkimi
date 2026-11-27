package main

import (
	"context"
	"testing"
	"time"

	shared "github.com/dokkimi/dokkimi/services/db-proxy/shared"
	"go.mongodb.org/mongo-driver/v2/bson"
)

func cursorReply(t *testing.T, batchKey string, id int64, docs ...string) *mongoMessage {
	t.Helper()
	batch := bson.A{}
	for _, name := range docs {
		batch = append(batch, bson.D{{Key: "name", Value: name}})
	}
	return reply(t, bson.D{
		{Key: "cursor", Value: bson.D{{Key: batchKey, Value: batch}, {Key: "id", Value: id}, {Key: "ns", Value: "db.orders"}}},
		{Key: "ok", Value: float64(1)},
	})
}

func command(t *testing.T, name string, body bson.D) pendingQuery {
	t.Helper()
	raw, err := bson.Marshal(body)
	if err != nil {
		t.Fatal(err)
	}
	return pendingQuery{command: commandInfo{commandName: name, collectionName: "orders", rawBSONBody: raw}, startTime: time.Now()}
}

func names(m shared.DatabaseLogMessage) []string {
	var got []string
	for _, d := range m.Data {
		got = append(got, d["name"].(string))
	}
	return got
}

// Before, each connection kept its own cursors: a find continued on another
// pooled connection was never logged, and its getMore was logged on its own
func TestCursorContinuedOnAnotherConnection(t *testing.T) {
	logger, logs := recordingLogger(t)
	cursors := newCursorRegistry()
	a := newProxyConnection(nil, nil, &shared.Config{}, logger, cursors)
	b := newProxyConnection(nil, nil, &shared.Config{}, logger, cursors)

	a.logQuery(command(t, "find", bson.D{{Key: "find", Value: "orders"}}), cursorReply(t, "firstBatch", 42, "a", "b"))
	b.logQuery(command(t, "getMore", bson.D{{Key: "getMore", Value: int64(42)}, {Key: "collection", Value: "orders"}}), cursorReply(t, "nextBatch", 43, "c"))
	a.logQuery(command(t, "getMore", bson.D{{Key: "getMore", Value: int64(43)}, {Key: "collection", Value: "orders"}}), cursorReply(t, "nextBatch", 0, "d"))

	got := logs()
	if len(got) != 1 {
		t.Fatalf("logs = %d, want 1: %+v", len(got), got)
	}
	if n := names(got[0]); len(n) != 4 || n[0] != "a" || n[3] != "d" {
		t.Errorf("data = %v, want [a b c d]", n)
	}
	if got[0].RowsAffected != 4 {
		t.Errorf("rowsAffected = %d, want 4", got[0].RowsAffected)
	}
}

// Before, an aggregate was logged with its first batch only
func TestAggregateGathersItsBatches(t *testing.T) {
	pc, logs := recordingConnection(t)
	pc.logQuery(command(t, "aggregate", bson.D{{Key: "aggregate", Value: "orders"}, {Key: "pipeline", Value: bson.A{}}}), cursorReply(t, "firstBatch", 7, "a"))
	pc.logQuery(command(t, "getMore", bson.D{{Key: "getMore", Value: int64(7)}, {Key: "collection", Value: "orders"}}), cursorReply(t, "nextBatch", 0, "b"))

	got := logs()
	if len(got) != 1 || len(got[0].Data) != 2 {
		t.Fatalf("logs = %+v, want one with 2 documents", got)
	}
}

// Before, a cursor the client closed early was never logged
func TestKilledCursorLogsWhatWasRead(t *testing.T) {
	pc, logs := recordingConnection(t)
	pc.logQuery(command(t, "find", bson.D{{Key: "find", Value: "orders"}}), cursorReply(t, "firstBatch", 9, "a"))
	pc.logQuery(command(t, "killCursors", bson.D{{Key: "killCursors", Value: "orders"}, {Key: "cursors", Value: bson.A{int64(9)}}}), reply(t, bson.D{{Key: "ok", Value: float64(1)}}))

	got := logs()
	if len(got) != 1 || len(got[0].Data) != 1 {
		t.Fatalf("logs = %+v, want the find only, with 1 document", got)
	}
}

func TestShutdownLogsOpenCursors(t *testing.T) {
	logger, logs := recordingLogger(t)
	p := NewProxy(&shared.Config{}, logger)
	p.cursors.start(5, &cursorAccumulator{query: "db.orders.find({})", startTime: time.Now(), data: []map[string]interface{}{{"name": "a"}}})

	p.Shutdown(context.Background())

	got := logs()
	if len(got) != 1 || got[0].Query != "db.orders.find({})" {
		t.Fatalf("logs = %+v, want the open find", got)
	}
}
