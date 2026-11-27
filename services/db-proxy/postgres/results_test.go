package main

import (
	"encoding/binary"
	"net"
	"testing"
	"time"

	"github.com/dokkimi/dokkimi/services/db-proxy/shared"
)

// A simple query with several statements is one entry. When a later
// statement fails, the entry is failed: the server rolls the batch back.
func TestRelay_BatchFailingAfterFirstStatement(t *testing.T) {
	logger, logs := recordingLogger(t)
	client, server := startRelay(t, logger)

	batch := "INSERT INTO t VALUES (1); INSERT INTO missing VALUES (2)"
	errResp := pgMsg(msgErrorResponse, append([]byte(`Mrelation "missing" does not exist`), 0, 0))
	exchange(t, client, server, pgMsg(msgQuery, cstr(batch)),
		pgMsg(msgCommandComplete, cstr("INSERT 0 1")), errResp, ready)
	exchange(t, client, server, pgMsg(msgQuery, cstr("SELECT 3 AS c")),
		rowDescription(col("c", 23)), dataRow([]byte("3")), selectComplete, ready)

	got := logs()
	if len(got) != 2 {
		t.Fatalf("got %d entries, want 2: %+v", len(got), got)
	}
	if got[0].Query != batch || got[0].Success || got[0].Error != `relation "missing" does not exist` {
		t.Errorf("batch logged as %+v, want failed with the error", got[0])
	}
	if got[1].Query != "SELECT 3 AS c" || !got[1].Success || got[1].RowsAffected != 1 {
		t.Errorf("next query logged as %+v", got[1])
	}
}

// A batch that succeeds is logged with its last statement's result, as
// libpq's PQexec returns it.
func TestRelay_BatchLogsLastResult(t *testing.T) {
	logger, logs := recordingLogger(t)
	client, server := startRelay(t, logger)

	exchange(t, client, server, pgMsg(msgQuery, cstr("UPDATE t SET a = 1; SELECT 2 AS b")),
		pgMsg(msgCommandComplete, cstr("UPDATE 5")),
		rowDescription(col("b", 23)), dataRow([]byte("2")), selectComplete, ready)

	got := logs()
	if len(got) != 1 || !got[0].Success || got[0].RowsAffected != 1 || len(got[0].Data) != 1 || got[0].Data[0]["b"] != float64(2) {
		t.Errorf("got %+v, want one entry with SELECT 2's result", got)
	}
}

// A later statement without rows (COMMIT) doesn't hide the batch's rows
func TestRelay_BatchKeepsResultSet(t *testing.T) {
	logger, logs := recordingLogger(t)
	client, server := startRelay(t, logger)

	exchange(t, client, server, pgMsg(msgQuery, cstr("BEGIN; SELECT 2 AS b; COMMIT")),
		pgMsg(msgCommandComplete, cstr("BEGIN")),
		rowDescription(col("b", 23)), dataRow([]byte("2")), selectComplete,
		pgMsg(msgCommandComplete, cstr("COMMIT")), ready)

	got := logs()
	if len(got) != 1 || !got[0].Success || got[0].RowsAffected != 1 || len(got[0].Data) != 1 {
		t.Errorf("got %+v, want SELECT 2's result", got)
	}
}

// A statement that can't be prepared is logged as failed (Go's db.Prepare
// sends Parse, Describe, Sync and runs nothing). One that can is not logged
// until it runs.
func TestRelay_PrepareError(t *testing.T) {
	logger, logs := recordingLogger(t)
	client, server := startRelay(t, logger)

	prepare := func(sql string) []byte {
		m := pgMsg(msgParse, append(append(cstr("s1"), cstr(sql)...), u16(0)...))
		m = append(m, pgMsg(msgDescribe, append([]byte{'S'}, cstr("s1")...))...)
		return append(m, pgMsg(msgSync, nil)...)
	}
	readN := func(n int) {
		server.SetReadDeadline(time.Now().Add(2 * time.Second))
		for i := 0; i < n; i++ {
			if _, _, err := readMessage(server); err != nil {
				t.Fatalf("server read: %v", err)
			}
		}
	}

	go client.Write(prepare("SELECT 1 AS a"))
	readN(3)
	server.Write(append(append(append(pgMsg(msgParseComplete, nil), pgMsg('t', u16(0))...), rowDescription(col("a", 23))...), ready...))
	time.Sleep(50 * time.Millisecond)

	go client.Write(prepare("SELEC 1"))
	readN(3)
	server.Write(append(pgMsg(msgErrorResponse, append([]byte(`Msyntax error at or near "SELEC"`), 0, 0)), ready...))

	got := logs()
	if len(got) != 1 || got[0].Query != "SELEC 1" || got[0].Success || got[0].Error == "" {
		t.Errorf("got %+v, want only SELEC 1, failed", got)
	}
}

// A client asking for GSSAPI encryption is told no, like for SSL, and goes on
// with its startup message. Before, the proxy took the request for a startup
// message and the client waited for an answer forever.
func TestHandleConnection_GSSRequestRefused(t *testing.T) {
	p := NewProxy(&shared.Config{DatabasePort: "1"}, nil)
	client, proxySide := net.Pipe()
	defer client.Close()
	go p.handleConnection(proxySide)

	req := binary.BigEndian.AppendUint32(binary.BigEndian.AppendUint32(nil, 8), gssRequestCode)
	go client.Write(req)
	client.SetReadDeadline(time.Now().Add(2 * time.Second))
	reply := make([]byte, 1)
	if _, err := client.Read(reply); err != nil || reply[0] != 'N' {
		t.Fatalf("got %q, %v; want N", reply, err)
	}
}

// A startup packet too short to hold a protocol version is refused. Before,
// reading its parameters crashed the whole proxy.
func TestHandleConnection_ShortStartupPacket(t *testing.T) {
	p := NewProxy(&shared.Config{DatabasePort: "1"}, nil)
	client, proxySide := net.Pipe()
	defer client.Close()
	done := make(chan struct{})
	go func() { p.handleConnection(proxySide); close(done) }()

	go client.Write(binary.BigEndian.AppendUint32(nil, 4))
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("the connection wasn't closed")
	}
}
