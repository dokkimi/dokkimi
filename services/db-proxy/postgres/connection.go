package main

import (
	"io"
	"log"
	"net"
	"sync"
	"time"

	"dokkimi.com/db-proxy-shared"
)

// pendingQuery tracks a query waiting for its response from upstream
type pendingQuery struct {
	sql       string
	startTime time.Time
}

// proxyConnection manages a single client↔upstream connection pair
type proxyConnection struct {
	clientConn   net.Conn
	upstreamConn net.Conn
	config       *shared.Config
	logger       *shared.QueryLogger

	mu         sync.Mutex
	stmtCache  map[string]string // statement name → SQL
	activeStmt string            // statement being executed (set by Bind)
	pending    []pendingQuery    // queries awaiting response

	// Result accumulation for the current query
	columns    []columnMeta               // from RowDescription
	resultRows []map[string]interface{}   // accumulated from DataRow messages
}

func newProxyConnection(client, upstream net.Conn, cfg *shared.Config, logger *shared.QueryLogger) *proxyConnection {
	return &proxyConnection{
		clientConn:   client,
		upstreamConn: upstream,
		config:       cfg,
		logger:       logger,
		stmtCache:    make(map[string]string),
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
			if query != "" {
				pc.mu.Lock()
				pc.pending = append(pc.pending, pendingQuery{sql: query, startTime: time.Now()})
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
			pc.mu.Lock()
			pc.activeStmt = stmtName
			pc.mu.Unlock()

		case msgExecute:
			pc.mu.Lock()
			stmtName := pc.activeStmt
			if query, ok := pc.stmtCache[stmtName]; ok {
				pc.pending = append(pc.pending, pendingQuery{sql: query, startTime: time.Now()})
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
		case msgRowDescription:
			pc.mu.Lock()
			pc.columns = extractColumnInfo(frame)
			pc.resultRows = nil
			pc.mu.Unlock()

		case msgDataRow:
			pc.mu.Lock()
			if pc.columns != nil {
				values := extractTypedDataRow(frame, pc.columns)
				row := make(map[string]interface{}, len(pc.columns))
				for i, col := range pc.columns {
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

