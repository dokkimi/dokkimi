package main

import (
	"github.com/jackc/pgx/v5/pgtype"
	"io"
	"log"
	"net"
	"sync"
	"time"

	"github.com/dokkimi/dokkimi/services/db-proxy/shared"
)

// pendingQuery tracks a query waiting for its response from upstream
type pendingQuery struct {
	sql       string
	startTime time.Time
	formats   []int16 // result format codes from Bind (extended protocol)
	group     int     // number of sync points (Query or Sync) sent before it
	stmt      string  // prepared statement it executes (extended protocol)
}

// describeRequest is a Describe the client sent, waiting for its
// RowDescription or NoData: of a prepared statement ('S') or a portal ('P').
type describeRequest struct {
	kind  byte
	name  string
	group int
}

// proxyConnection manages a single client↔upstream connection pair
type proxyConnection struct {
	clientConn   net.Conn
	upstreamConn net.Conn
	config       *shared.Config
	logger       *shared.QueryLogger

	mu            sync.Mutex
	stmtCache     map[string]string // statement name → SQL
	activeStmt    string            // statement being executed (set by Bind)
	activeFormats []int16           // result formats of that execution (set by Bind)
	pending       []pendingQuery    // queries awaiting response
	syncSent      int               // sync points (Query or Sync) sent by the client
	readySeen     int               // ReadyForQuery messages received from the server

	describes   []describeRequest       // Describes waiting for their reply
	stmtColumns map[string][]columnMeta // prepared statement → its result columns

	types *pgtype.Map // decodes binary result values; one per connection, not shared

	// Result accumulation for the current query
	columns    []columnMeta             // from RowDescription
	resultRows []map[string]interface{} // accumulated from DataRow messages
}

func newProxyConnection(client, upstream net.Conn, cfg *shared.Config, logger *shared.QueryLogger) *proxyConnection {
	return &proxyConnection{
		clientConn:   client,
		upstreamConn: upstream,
		config:       cfg,
		logger:       logger,
		stmtCache:    make(map[string]string),
		stmtColumns:  make(map[string][]columnMeta),
		types:        pgtype.NewMap(),
	}
}

// relay performs bidirectional message relay between client and upstream.
func (pc *proxyConnection) relay() {
	done := make(chan struct{}, 2)

	go func() {
		pc.relayClientToUpstream()
		done <- struct{}{}
	}()

	go func() {
		pc.relayUpstreamToClient()
		done <- struct{}{}
	}()

	<-done
	pc.clientConn.Close()
	pc.upstreamConn.Close()
	<-done
}

// relayClientToUpstream reads messages from the client, tracks queries, and forwards to upstream
func (pc *proxyConnection) relayClientToUpstream() {
	for {
		msgType, frame, err := readMessage(pc.clientConn)
		if err != nil {
			if err != io.EOF && !shared.IsConnClosed(err) {
				log.Printf("client read error: %v", err)
			}
			return
		}

		switch msgType {
		case msgQuery:
			query := extractSimpleQuery(frame)
			pc.mu.Lock()
			if query != "" {
				pc.pending = append(pc.pending, pendingQuery{sql: query, startTime: time.Now(), group: pc.syncSent})
			}
			pc.syncSent++ // a simple query is its own sync point
			pc.mu.Unlock()

		case msgSync:
			pc.mu.Lock()
			pc.syncSent++
			pc.mu.Unlock()

		case msgDescribe:
			if len(frame) >= 6 {
				name := ""
				if end := indexOf(frame[6:], 0); end >= 0 {
					name = string(frame[6 : 6+end])
				}
				pc.mu.Lock()
				pc.describes = append(pc.describes, describeRequest{kind: frame[5], name: name, group: pc.syncSent})
				pc.mu.Unlock()
			}

		case msgParse:
			stmtName, query := extractParseQuery(frame)
			if query != "" {
				pc.mu.Lock()
				pc.stmtCache[stmtName] = query
				pc.mu.Unlock()
			}

		case msgBind:
			stmtName := extractBindStmtName(frame)
			formats := extractBindResultFormats(frame)
			pc.mu.Lock()
			pc.activeStmt = stmtName
			pc.activeFormats = formats
			pc.mu.Unlock()

		case msgExecute:
			pc.mu.Lock()
			stmtName := pc.activeStmt
			if query, ok := pc.stmtCache[stmtName]; ok {
				pc.pending = append(pc.pending, pendingQuery{sql: query, startTime: time.Now(), formats: pc.activeFormats, group: pc.syncSent, stmt: stmtName})
			}
			pc.mu.Unlock()

		case msgTerminate:
			if _, err := pc.upstreamConn.Write(frame); err != nil {
				log.Printf("upstream write error on terminate: %v", err)
			}
			return
		}

		if _, err := pc.upstreamConn.Write(frame); err != nil {
			if !shared.IsConnClosed(err) {
				log.Printf("upstream write error: %v", err)
			}
			return
		}
	}
}

// relayUpstreamToClient reads messages from upstream, enriches query logs, and forwards to client
func (pc *proxyConnection) relayUpstreamToClient() {
	for {
		msgType, frame, err := readMessage(pc.upstreamConn)
		if err != nil {
			if err != io.EOF && !shared.IsConnClosed(err) {
				log.Printf("upstream read error: %v", err)
			}
			return
		}

		switch msgType {
		case msgRowDescription, msgNoData:
			// The reply to a Describe, or (simple query) the start of a result.
			var cols []columnMeta
			if msgType == msgRowDescription {
				cols = extractColumnInfo(frame)
			}
			pc.mu.Lock()
			if len(pc.describes) > 0 {
				d := pc.describes[0]
				pc.describes = pc.describes[1:]
				if d.kind == 'S' {
					// A statement can be described once and run many times
					pc.stmtColumns[d.name] = cols
				} else {
					pc.columns = cols
				}
			} else if msgType == msgRowDescription {
				pc.columns = cols
			}
			pc.resultRows = nil
			pc.mu.Unlock()

		case msgDataRow:
			pc.mu.Lock()
			cols := pc.columns
			var formats []int16
			if len(pc.pending) > 0 {
				formats = pc.pending[0].formats
				if cols == nil {
					cols = pc.stmtColumns[pc.pending[0].stmt]
				}
			}
			if cols != nil {
				values := extractTypedDataRow(frame, cols, formats, pc.types)
				row := make(map[string]interface{}, len(cols))
				for i, col := range cols {
					if i < len(values) {
						row[col.name] = values[i]
					}
				}
				pc.resultRows = append(pc.resultRows, row)
			}
			pc.mu.Unlock()

		case msgCommandComplete:
			_, rowsAffected := extractCommandTag(frame)
			pc.mu.Lock()
			data := pc.resultRows
			pc.resultRows = nil
			pc.columns = nil
			pc.mu.Unlock()
			pc.completeQuery(true, rowsAffected, "", data)

		case msgErrorResponse:
			errMsg := extractErrorMessage(frame)
			pc.mu.Lock()
			pc.resultRows = nil
			pc.columns = nil
			pc.mu.Unlock()
			pc.completeQuery(false, 0, errMsg, nil)

		case msgEmptyQuery:
			// The reply to an empty query (";" or ""), e.g. a connection check
			pc.completeQuery(true, 0, "", nil)

		case msgPortalSuspended:
			// Execute with a row limit (a cursor or fetch size) returned its rows;
			// the next Execute continues it as a new entry.
			pc.mu.Lock()
			data := pc.resultRows
			pc.resultRows = nil
			pc.mu.Unlock()
			pc.completeQuery(true, int64(len(data)), "", data)

		case msgReadyForQuery:
			// Everything sent before this sync point is done. After an error the
			// server skips the rest of the group, so drop what it never answered,
			// or every later query would be paired with the wrong reply.
			pc.mu.Lock()
			pc.readySeen++
			kept := pc.pending[:0]
			for _, pq := range pc.pending {
				if pq.group >= pc.readySeen {
					kept = append(kept, pq)
				}
			}
			pc.pending = kept
			keptDescribes := pc.describes[:0]
			for _, d := range pc.describes {
				if d.group >= pc.readySeen {
					keptDescribes = append(keptDescribes, d)
				}
			}
			pc.describes = keptDescribes
			pc.columns = nil
			pc.resultRows = nil
			pc.mu.Unlock()
		}

		if _, err := pc.clientConn.Write(frame); err != nil {
			if !shared.IsConnClosed(err) {
				log.Printf("client write error: %v", err)
			}
			return
		}
	}
}

// completeQuery pops the oldest pending query and logs it with response details
func (pc *proxyConnection) completeQuery(success bool, rowsAffected int64, errMsg string, data []map[string]interface{}) {
	if pc.logger == nil {
		return
	}

	pc.mu.Lock()
	if len(pc.pending) == 0 {
		pc.mu.Unlock()
		return
	}
	pq := pc.pending[0]
	pc.pending = pc.pending[1:]
	pc.mu.Unlock()

	durationMs := int(time.Since(pq.startTime).Milliseconds())
	msg := shared.DatabaseLogMessage{
		InstanceID:     pc.config.InstanceID,
		InstanceItemID: pc.config.InstanceItemID,
		DatabaseType:   pc.config.DatabaseType,
		DatabaseName:   pc.config.InstanceItemName,
		Query:          pq.sql,
		Success:        success,
		Duration:       &durationMs,
		Timestamp:      time.Now().Format(time.RFC3339Nano),
	}
	if rowsAffected > 0 {
		msg.RowsAffected = &rowsAffected
	}
	if errMsg != "" {
		msg.Error = errMsg
	}
	if len(data) > 0 {
		msg.Data = data
	}
	pc.logger.Log(msg)
}

// extractBindStmtName extracts the source prepared statement name from a Bind ('B') frame
func extractBindStmtName(frame []byte) string {
	if len(frame) < 6 {
		return ""
	}
	body := frame[5:]
	// Bind: destination portal name (null-terminated) + source statement name (null-terminated) + ...
	portalEnd := indexOf(body, 0)
	if portalEnd < 0 {
		return ""
	}
	body = body[portalEnd+1:]
	stmtEnd := indexOf(body, 0)
	if stmtEnd < 0 {
		return ""
	}
	return string(body[:stmtEnd])
}
