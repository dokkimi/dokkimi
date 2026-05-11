package main

import (
	"io"
	"log"
	"net"
	"sync"
	"time"

	shared "dokkimi.com/db-proxy-shared"
)

// pendingQuery tracks a query waiting for its response
type pendingQuery struct {
	sql       string
	startTime time.Time
}

// proxyConnection manages a single client↔upstream MySQL connection pair
type proxyConnection struct {
	clientConn   net.Conn
	upstreamConn net.Conn
	config       *shared.Config
	logger       *shared.QueryLogger

	mu          sync.Mutex
	stmtCache   map[uint32]string // statement ID → SQL
	pending     []pendingQuery
	lastCommand byte // last MySQL command seen from client

	// PREPARE_OK follow-up: param/column def packets to skip
	prepareSkipRemaining int

	// Result accumulation
	columns         []columnDef
	resultRows      []map[string]interface{}
	inResultSet     bool
	binaryResultSet bool // true when result set is from COM_STMT_EXECUTE
	columnCount     int
	columnsRead     int
	eofAfterCols    bool // have we seen the EOF after column defs?
}

func newProxyConnection(client, upstream net.Conn, cfg *shared.Config, logger *shared.QueryLogger) *proxyConnection {
	return &proxyConnection{
		clientConn:   client,
		upstreamConn: upstream,
		config:       cfg,
		logger:       logger,
		stmtCache:    make(map[uint32]string),
	}
}

// relay performs bidirectional message relay
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

// relayClientToUpstream reads from client, extracts queries, forwards to upstream
func (pc *proxyConnection) relayClientToUpstream() {
	for {
		pkt, err := readPacket(pc.clientConn)
		if err != nil {
			if err != io.EOF && !shared.IsConnClosed(err) {
				log.Printf("client read error: %v", err)
			}
			return
		}

		if len(pkt.payload) > 0 {
			cmd := pkt.payload[0]
			switch cmd {
			case comQuery:
				query := extractQueryText(pkt.payload)
				pc.mu.Lock()
				pc.lastCommand = comQuery
				if query != "" {
					pc.pending = append(pc.pending, pendingQuery{sql: query, startTime: time.Now()})
				}
				pc.mu.Unlock()

			case comStmtPrepare:
				query := extractStmtPrepareQuery(pkt.payload)
				pc.mu.Lock()
				pc.lastCommand = comStmtPrepare
				if query != "" {
					pc.pending = append(pc.pending, pendingQuery{sql: query, startTime: time.Now()})
				}
				pc.mu.Unlock()

			case comStmtExecute:
				stmtID := extractStmtID(pkt.payload)
				pc.mu.Lock()
				pc.lastCommand = comStmtExecute
				if query, ok := pc.stmtCache[stmtID]; ok {
					pc.pending = append(pc.pending, pendingQuery{sql: query, startTime: time.Now()})
				}
				pc.mu.Unlock()

			case comQuit:
				if _, err := pc.upstreamConn.Write(pkt.rawBytes()); err != nil {
					log.Printf("upstream write error on quit: %v", err)
				}
				return
			}
		}

		if _, err := pc.upstreamConn.Write(pkt.rawBytes()); err != nil {
			if !shared.IsConnClosed(err) {
				log.Printf("upstream write error: %v", err)
			}
			return
		}
	}
}

// relayUpstreamToClient reads from upstream, extracts results, forwards to client
func (pc *proxyConnection) relayUpstreamToClient() {
	for {
		pkt, err := readPacket(pc.upstreamConn)
		if err != nil {
			if err != io.EOF && !shared.IsConnClosed(err) {
				log.Printf("upstream read error: %v", err)
			}
			return
		}

		pc.processServerPacket(pkt)

		if _, err := pc.clientConn.Write(pkt.rawBytes()); err != nil {
			if !shared.IsConnClosed(err) {
				log.Printf("client write error: %v", err)
			}
			return
		}
	}
}

// processServerPacket inspects a server response packet and tracks result sets
func (pc *proxyConnection) processServerPacket(pkt *mysqlPacket) {
	pc.mu.Lock()
	defer pc.mu.Unlock()

	// Skip param/column def packets that follow a PREPARE_OK response
	if pc.prepareSkipRemaining > 0 {
		pc.prepareSkipRemaining--
		return
	}

	if pc.inResultSet {
		pc.processResultSetPacket(pkt)
		return
	}

	if len(pkt.payload) == 0 {
		return
	}

	// COM_STMT_PREPARE response — cache the statement and skip follow-up packets
	if pc.lastCommand == comStmtPrepare && pkt.payload[0] == okHeader && len(pkt.payload) >= 10 && len(pc.pending) > 0 {
		stmtID, numCols, numParams := extractPrepareOKStmtID(pkt.payload)
		if stmtID > 0 {
			pq := pc.pending[0]
			pc.pending = pc.pending[1:]
			pc.stmtCache[stmtID] = pq.sql
			// Calculate packets to skip: param defs + EOF + column defs + EOF
			// (we stripped CLIENT_DEPRECATE_EOF so EOF markers are always present)
			skip := int(numParams) + int(numCols)
			if numParams > 0 {
				skip++ // EOF after param defs
			}
			if numCols > 0 {
				skip++ // EOF after column defs
			}
			pc.prepareSkipRemaining = skip
			pc.lastCommand = 0
			return
		}
	}

	if pkt.isOK() {
		rowsAffected := extractOKAffectedRows(pkt.payload)
		pc.completeQueryLocked(true, rowsAffected, "", nil)
		return
	}

	if pkt.isERR() {
		errMsg := extractErrorMessage(pkt.payload)
		pc.completeQueryLocked(false, 0, errMsg, nil)
		return
	}

	if pkt.isResultSet() {
		colCount, _ := readLenEncInt(pkt.payload)
		pc.inResultSet = true
		pc.binaryResultSet = pc.lastCommand == comStmtExecute
		pc.columnCount = int(colCount)
		pc.columnsRead = 0
		pc.eofAfterCols = false
		pc.columns = make([]columnDef, 0, pc.columnCount)
		pc.resultRows = nil
		return
	}
}

// processResultSetPacket handles packets while inside a result set
func (pc *proxyConnection) processResultSetPacket(pkt *mysqlPacket) {
	// Phase 1: reading column definitions
	if pc.columnsRead < pc.columnCount {
		col := parseColumnDef(pkt.payload)
		pc.columns = append(pc.columns, col)
		pc.columnsRead++
		return
	}

	// Phase 2: EOF after column definitions
	if !pc.eofAfterCols {
		if pkt.isEOF() {
			pc.eofAfterCols = true
		}
		return
	}

	// Phase 3: data rows until EOF or ERR
	if pkt.isEOF() {
		data := pc.resultRows
		pc.inResultSet = false
		pc.columns = nil
		pc.resultRows = nil
		pc.completeQueryLocked(true, int64(len(data)), "", data)
		return
	}

	if pkt.isERR() {
		errMsg := extractErrorMessage(pkt.payload)
		pc.inResultSet = false
		pc.columns = nil
		pc.resultRows = nil
		pc.completeQueryLocked(false, 0, errMsg, nil)
		return
	}

	row := make(map[string]interface{}, len(pc.columns))
	if pc.binaryResultSet {
		binValues := parseBinaryRowValues(pkt.payload, pc.columns)
		for i, col := range pc.columns {
			if i < len(binValues) {
				row[col.name] = binValues[i]
			}
		}
	} else {
		rawValues := parseTextRowValues(pkt.payload, pc.columnCount)
		for i, col := range pc.columns {
			if i < len(rawValues) {
				if rawValues[i] == nil {
					row[col.name] = nil
				} else if s, ok := rawValues[i].(string); ok {
					row[col.name] = coerceValue(s, col.fieldType)
				} else {
					row[col.name] = rawValues[i]
				}
			}
		}
	}
	pc.resultRows = append(pc.resultRows, row)
}

// completeQueryLocked pops the oldest pending query and logs it. Caller must hold pc.mu.
func (pc *proxyConnection) completeQueryLocked(success bool, rowsAffected int64, errMsg string, data []map[string]interface{}) {
	if pc.logger == nil {
		return
	}

	if len(pc.pending) == 0 {
		return
	}
	pq := pc.pending[0]
	pc.pending = pc.pending[1:]

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
