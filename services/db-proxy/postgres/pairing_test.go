package main

import (
	"encoding/binary"
	"encoding/json"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"
	"time"

	"github.com/dokkimi/dokkimi/services/db-proxy/shared"
	"github.com/jackc/pgx/v5/pgtype"
)

// pgMsg builds a protocol message: type byte + length + body.
func pgMsg(typ byte, body []byte) []byte {
	m := make([]byte, 5, 5+len(body))
	m[0] = typ
	binary.BigEndian.PutUint32(m[1:], uint32(4+len(body)))
	return append(m, body...)
}

func cstr(s string) []byte { return append([]byte(s), 0) }

func u16(v int) []byte { b := make([]byte, 2); binary.BigEndian.PutUint16(b, uint16(v)); return b }
func u32(v int) []byte { b := make([]byte, 4); binary.BigEndian.PutUint32(b, uint32(v)); return b }

func rowDescription(cols ...struct {
	name string
	oid  int
}) []byte {
	body := u16(len(cols))
	for _, c := range cols {
		body = append(body, cstr(c.name)...)
		body = append(body, u32(0)...)     // table OID
		body = append(body, u16(0)...)     // column number
		body = append(body, u32(c.oid)...) // type OID
		body = append(body, u16(0)...)     // type size
		body = append(body, u32(0)...)     // type modifier
		body = append(body, u16(0)...)     // format (0 when described before Bind)
	}
	return pgMsg(msgRowDescription, body)
}

func dataRow(values ...[]byte) []byte {
	body := u16(len(values))
	for _, v := range values {
		body = append(body, u32(len(v))...)
		body = append(body, v...)
	}
	return pgMsg(msgDataRow, body)
}

func col(name string, oid int) struct {
	name string
	oid  int
} {
	return struct {
		name string
		oid  int
	}{name, oid}
}

func TestExtractBindResultFormats(t *testing.T) {
	body := append(cstr("portal"), cstr("stmt")...)
	body = append(body, u16(1)...)          // one parameter format
	body = append(body, u16(1)...)          // binary
	body = append(body, u16(2)...)          // two parameters
	body = append(body, u32(4)...)          // first: 4 bytes
	body = append(body, 0, 0, 0, 7)         //
	body = append(body, u32(0xFFFFFFFF)...) // second: NULL
	body = append(body, u16(2)...)          // two result formats
	body = append(body, u16(1)...)          // binary
	body = append(body, u16(0)...)          // text
	got := extractBindResultFormats(pgMsg(msgBind, body))
	if len(got) != 2 || got[0] != 1 || got[1] != 0 {
		t.Errorf("got %v, want [1 0]", got)
	}
}

// A binary value is logged the same as the text value the server would send.
func TestExtractTypedDataRow_BinaryMatchesText(t *testing.T) {
	types := pgtype.NewMap()
	cols := []columnMeta{{name: "n", typeOID: 23}, {name: "s", typeOID: 25}, {name: "b", typeOID: 16}, {name: "f", typeOID: 701}, {name: "d", typeOID: 1082}}
	f8 := make([]byte, 8)
	binary.BigEndian.PutUint64(f8, 0x3FF8000000000000) // 1.5
	day := make([]byte, 4)
	binary.BigEndian.PutUint32(day, 8798) // days since 2000-01-01: 2024-02-02
	binary := dataRow([]byte{0, 0, 0, 7}, []byte("hello"), []byte{1}, f8, day)
	got := extractTypedDataRow(binary, cols, []int16{1, 0, 1, 1, 1}, types)
	want := []interface{}{int64(7), "hello", true, 1.5, "2024-02-02"}
	for i := range want {
		if got[i] != want[i] {
			t.Errorf("%s: got %#v, want %#v", cols[i].name, got[i], want[i])
		}
	}
}

// recordingLogger is a QueryLogger posting to a local server, so tests can
// see which query each logged result was paired with.
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

// startRelay connects a fake client and a fake server through a proxyConnection.
func startRelay(t *testing.T, logger *shared.QueryLogger) (client, server net.Conn) {
	t.Helper()
	clientSide, proxyClient := net.Pipe()
	proxyUpstream, serverSide := net.Pipe()
	pc := newProxyConnection(proxyClient, proxyUpstream, &shared.Config{}, logger)
	go pc.relay()
	t.Cleanup(func() { clientSide.Close(); serverSide.Close() })
	go io.Copy(io.Discard, clientSide) // the client reads whatever it is sent
	return clientSide, serverSide
}

// exchange sends a client message, waits for the server to receive it, then
// sends the server's replies.
func exchange(t *testing.T, client, server net.Conn, request []byte, replies ...[]byte) {
	t.Helper()
	go client.Write(request)
	server.SetReadDeadline(time.Now().Add(2 * time.Second))
	if _, _, err := readMessage(server); err != nil {
		t.Fatalf("server didn't receive the request: %v", err)
	}
	for _, r := range replies {
		if _, err := server.Write(r); err != nil {
			t.Fatal(err)
		}
	}
	time.Sleep(50 * time.Millisecond)
}

var (
	ready          = pgMsg(msgReadyForQuery, []byte{'I'})
	emptyQuery     = pgMsg(msgEmptyQuery, nil)
	selectComplete = pgMsg(msgCommandComplete, cstr("SELECT 1"))
)

// After an empty query (";", a common connection check), each later query was
// logged with the next query's result.
func TestRelay_EmptyQueryKeepsResultsPaired(t *testing.T) {
	logger, logs := recordingLogger(t)
	client, server := startRelay(t, logger)

	exchange(t, client, server, pgMsg(msgQuery, cstr(";")), emptyQuery, ready)
	exchange(t, client, server, pgMsg(msgQuery, cstr("SELECT 1 AS a")),
		rowDescription(col("a", 23)), dataRow([]byte("1")), selectComplete, ready)
	exchange(t, client, server, pgMsg(msgQuery, cstr("SELECT 2 AS b")),
		rowDescription(col("b", 23)), dataRow([]byte("2")), selectComplete, ready)

	byQuery := map[string]string{}
	for _, l := range logs() {
		data, _ := json.Marshal(l.Data)
		byQuery[l.Query] = string(data)
	}
	if byQuery["SELECT 1 AS a"] != `[{"a":1}]` || byQuery["SELECT 2 AS b"] != `[{"b":2}]` {
		t.Errorf("results paired with the wrong query: %v", byQuery)
	}
}

// After an error, the server skips the rest of the group until Sync; the
// skipped Execute must not take the next query's result.
func TestRelay_ErrorThenSyncKeepsResultsPaired(t *testing.T) {
	logger, logs := recordingLogger(t)
	client, server := startRelay(t, logger)

	parse := func(name, sql string) []byte {
		return pgMsg(msgParse, append(append(cstr(name), cstr(sql)...), u16(0)...))
	}
	bind := func(stmt string) []byte {
		return pgMsg(msgBind, append(append(cstr(""), cstr(stmt)...), append(u16(0), append(u16(0), u16(0)...)...)...))
	}
	execute := pgMsg(msgExecute, append(cstr(""), u32(0)...))
	sync := pgMsg(msgSync, nil)
	errResp := pgMsg(msgErrorResponse, append([]byte("Msyntax error"), 0, 0))

	// Two statements in one group; the first fails, so the second is skipped.
	batch := append(append(append(parse("s1", "SELEC 1"), bind("s1")...), execute...),
		append(append(append(parse("s2", "SELECT 9"), bind("s2")...), execute...), sync...)...)
	go client.Write(batch)
	server.SetReadDeadline(time.Now().Add(2 * time.Second))
	for i := 0; i < 7; i++ {
		if _, _, err := readMessage(server); err != nil {
			t.Fatalf("server read %d: %v", i, err)
		}
	}
	server.Write(append(errResp, ready...))
	time.Sleep(50 * time.Millisecond)

	exchange(t, client, server, pgMsg(msgQuery, cstr("SELECT 3 AS c")),
		rowDescription(col("c", 23)), dataRow([]byte("3")), selectComplete, ready)

	byQuery := map[string]string{}
	for _, l := range logs() {
		data, _ := json.Marshal(l.Data)
		byQuery[l.Query] = string(data)
	}
	if byQuery["SELECT 3 AS c"] != `[{"c":3}]` {
		t.Errorf("SELECT 3 was not paired with its own result: %v", byQuery)
	}
	if _, ok := byQuery["SELECT 9"]; ok {
		t.Errorf("the skipped statement was logged with another query's result: %v", byQuery)
	}
}

// pgx prepares a statement (Parse, Describe, Sync) and runs it later, possibly
// after describing others, without describing it again. Its rows must be
// decoded with its own columns.
func TestRelay_PreparedStatementUsesItsOwnColumns(t *testing.T) {
	logger, logs := recordingLogger(t)
	client, server := startRelay(t, logger)

	parse := func(name, sql string) []byte {
		return pgMsg(msgParse, append(append(cstr(name), cstr(sql)...), u16(0)...))
	}
	describe := func(name string) []byte { return pgMsg(msgDescribe, append([]byte{'S'}, cstr(name)...)) }
	sync := pgMsg(msgSync, nil)
	paramDesc := pgMsg('t', u16(0))
	parseComplete := pgMsg(msgParseComplete, nil)
	readN := func(n int) {
		server.SetReadDeadline(time.Now().Add(2 * time.Second))
		for i := 0; i < n; i++ {
			if _, _, err := readMessage(server); err != nil {
				t.Fatalf("server read: %v", err)
			}
		}
	}

	for _, s := range []struct{ name, sql, column string }{{"s1", "SELECT 1 AS a", "a"}, {"s2", "SELECT 'x' AS b", "b"}} {
		go client.Write(append(append(parse(s.name, s.sql), describe(s.name)...), sync...))
		readN(3)
		oid := 23
		if s.column == "b" {
			oid = 25
		}
		server.Write(append(append(append(parseComplete, paramDesc...), rowDescription(col(s.column, oid))...), ready...))
		time.Sleep(50 * time.Millisecond)
	}

	// Run s1, binary results, without describing it again.
	bind := pgMsg(msgBind, append(append(cstr(""), cstr("s1")...), append(u16(0), append(u16(0), append(u16(1), u16(1)...)...)...)...))
	execute := pgMsg(msgExecute, append(cstr(""), u32(0)...))
	go client.Write(append(append(bind, execute...), sync...))
	readN(3)
	server.Write(append(append(append(pgMsg(msgBindComplete, nil), dataRow([]byte{0, 0, 0, 1})...), selectComplete...), ready...))

	for _, l := range logs() {
		if l.Query == "SELECT 1 AS a" {
			data, _ := json.Marshal(l.Data)
			if string(data) != `[{"a":1}]` {
				t.Errorf("s1 logged %s, want [{\"a\":1}]", data)
			}
			return
		}
	}
	t.Error("s1 was not logged")
}
