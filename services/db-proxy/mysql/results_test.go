package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"
	"time"

	shared "github.com/dokkimi/dokkimi/services/db-proxy/shared"
)

// recordingConnection is a proxyConnection whose logs are kept, with one
// query waiting for its result.
func recordingConnection(t *testing.T, sql string) (*proxyConnection, func() []shared.DatabaseLogMessage) {
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
	pc := newProxyConnection(nil, nil, &shared.Config{}, logger)
	pc.lastCommand = comQuery
	pc.pending = []pendingQuery{{sql: sql, startTime: time.Now()}}
	return pc, func() []shared.DatabaseLogMessage {
		time.Sleep(300 * time.Millisecond)
		mu.Lock()
		defer mu.Unlock()
		return append([]shared.DatabaseLogMessage(nil), got...)
	}
}

// okPacket is an OK packet with affected rows, no insert ID, and status flags
func okPacket(affected byte, status uint16) *mysqlPacket {
	return &mysqlPacket{payload: []byte{okHeader, affected, 0, byte(status), byte(status >> 8), 0, 0}}
}

const autocommit = 0x0002

// Several statements in one query are one entry. When a later one fails,
// the entry is failed.
func TestBatchFailingAfterFirstStatement(t *testing.T) {
	pc, logs := recordingConnection(t, "INSERT INTO t VALUES (1); INSERT INTO missing VALUES (2)")
	pc.processServerPacket(okPacket(1, autocommit|serverMoreResultsExists))
	errPkt := append([]byte{errHeader, 0x7a, 0x04, '#', '4', '2', 'S', '0', '2'}, "Table 'missing' doesn't exist"...)
	pc.processServerPacket(&mysqlPacket{payload: errPkt})

	got := logs()
	if len(got) != 1 || got[0].Success || got[0].Error != "Table 'missing' doesn't exist" {
		t.Errorf("got %+v, want one failed entry", got)
	}
}

// A query with several results is logged with its last; rowsAffected is 0
// when that changed nothing, not left out.
func TestBatchLogsLastResult(t *testing.T) {
	pc, logs := recordingConnection(t, "UPDATE t SET a = 1; UPDATE t SET a = 1 WHERE false")
	pc.processServerPacket(okPacket(3, autocommit|serverMoreResultsExists))
	pc.processServerPacket(okPacket(0, autocommit))

	got := logs()
	if len(got) != 1 || !got[0].Success || got[0].RowsAffected != 0 {
		t.Errorf("got %+v, want one entry with rowsAffected 0", got)
	}
}

// A CALL's rows are logged, although it ends with a bare OK
func TestCallLogsItsResultSet(t *testing.T) {
	pc, logs := recordingConnection(t, "CALL p()")
	pc.processServerPacket(&mysqlPacket{payload: []byte{1}}) // one column
	pc.processServerPacket(&mysqlPacket{payload: columnDefPacket("id")})
	pc.processServerPacket(&mysqlPacket{payload: []byte{eofHeader, 0, 0, 0x0a, 0}}) // after the columns
	pc.processServerPacket(&mysqlPacket{payload: []byte{1, '7'}})                   // row: "7"
	pc.processServerPacket(&mysqlPacket{payload: []byte{eofHeader, 0, 0, 0x0a, 0}}) // more results
	pc.processServerPacket(okPacket(0, autocommit))

	got := logs()
	if len(got) != 1 || !got[0].Success || got[0].RowsAffected != 1 || len(got[0].Data) != 1 || got[0].Data[0]["id"] == nil {
		t.Errorf("got %+v, want the procedure's row", got)
	}
}

// columnDefPacket is a column definition (protocol 41) of a VARCHAR column
func columnDefPacket(name string) []byte {
	p := []byte{}
	for _, s := range []string{"def", "dokkimi", "t", "t", name, name} {
		p = append(append(p, byte(len(s))), s...)
	}
	return append(p, 0x0c, 0x21, 0, 0xff, 0, 0, 0, 0xfd, 0, 0, 0, 0, 0)
}

func TestMoreResultsFlags(t *testing.T) {
	if !okMoreResults(okPacket(1, serverMoreResultsExists).payload) || okMoreResults(okPacket(1, autocommit).payload) {
		t.Error("OK packet flags read wrong")
	}
	eof := func(status uint16) []byte { return []byte{eofHeader, 0, 0, byte(status), byte(status >> 8)} }
	if !eofMoreResults(eof(serverMoreResultsExists)) || eofMoreResults(eof(autocommit)) {
		t.Error("EOF packet flags read wrong")
	}
	if okMoreResults([]byte{okHeader}) || eofMoreResults([]byte{eofHeader}) {
		t.Error("a short packet says more results follow")
	}
}
