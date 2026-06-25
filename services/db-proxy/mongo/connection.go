package main

import (
	"io"
	"log"
	"net"
	"sync"
	"time"

	shared "github.com/dokkimi/dokkimi/services/db-proxy/shared"
)

type pendingQuery struct {
	command   commandInfo
	startTime time.Time
}

// cursorAccumulator collects document batches from a find cursor that spans
// multiple getMore round-trips. Data is logged once when the cursor is exhausted.
type cursorAccumulator struct {
	query     string
	startTime time.Time
	data      []map[string]interface{}
}

type proxyConnection struct {
	clientConn   net.Conn
	upstreamConn net.Conn
	config       *shared.Config
	logger       *shared.QueryLogger

	mu      sync.Mutex
	pending map[int32]pendingQuery
	cursors map[int64]*cursorAccumulator

	// helloSeen tracks whether we've already stripped compression from a
	// hello/isMaster response on this connection. Only needed once.
	helloSeen bool
}

func newProxyConnection(client, upstream net.Conn, cfg *shared.Config, logger *shared.QueryLogger) *proxyConnection {
	return &proxyConnection{
		clientConn:   client,
		upstreamConn: upstream,
		config:       cfg,
		logger:       logger,
		pending:      make(map[int32]pendingQuery),
		cursors:      make(map[int64]*cursorAccumulator),
	}
}

func (pc *proxyConnection) relay() {
	clientToUpDone := make(chan struct{})
	upToClientDone := make(chan struct{})

	go func() {
		pc.relayClientToUpstream()
		close(clientToUpDone)
	}()

	go func() {
		pc.relayUpstreamToClient()
		close(upToClientDone)
	}()

	select {
	case <-clientToUpDone:
		<-upToClientDone
	case <-upToClientDone:
		pc.clientConn.Close()
		<-clientToUpDone
	}

	pc.clientConn.Close()
	pc.upstreamConn.Close()
}

func (pc *proxyConnection) relayClientToUpstream() {
	for {
		msg, err := readMessage(pc.clientConn)
		if err != nil {
			if err != io.EOF && !shared.IsConnClosed(err) {
				log.Printf("client read error: %v", err)
			}
			return
		}

		if msg.opCode == opMsg && !msg.moreToCome {
			cmd := extractCommandInfo(msg)
			if !isDriverInternalCommand(cmd.commandName) && cmd.commandName != "" {
				pc.mu.Lock()
				pc.pending[msg.requestID] = pendingQuery{
					command:   cmd,
					startTime: time.Now(),
				}
				pc.mu.Unlock()
			}
		}

		if _, err := pc.upstreamConn.Write(msg.raw); err != nil {
			if !shared.IsConnClosed(err) {
				log.Printf("upstream write error: %v", err)
			}
			return
		}
	}
}

func (pc *proxyConnection) relayUpstreamToClient() {
	for {
		msg, err := readMessage(pc.upstreamConn)
		if err != nil {
			if err != io.EOF && !shared.IsConnClosed(err) {
				log.Printf("upstream read error: %v", err)
			}
			return
		}

		raw := msg.raw

		// Strip compression from the first hello/isMaster response
		if !pc.helloSeen && msg.opCode == opMsg {
			pc.helloSeen = true
			raw = stripCompressionFromHello(raw)
		}

		// Match response to pending request and log
		if msg.opCode == opMsg && msg.responseTo != 0 {
			pc.mu.Lock()
			pq, found := pc.pending[msg.responseTo]
			if found {
				delete(pc.pending, msg.responseTo)
			}
			pc.mu.Unlock()

			if found {
				pc.logQuery(pq, msg)
			}
		}

		if _, err := pc.clientConn.Write(raw); err != nil {
			if !shared.IsConnClosed(err) {
				log.Printf("client write error: %v", err)
			}
			return
		}

		// If moreToCome is set on server response, keep reading without
		// waiting for a client message (exhaust cursor).
		for msg.moreToCome {
			msg, err = readMessage(pc.upstreamConn)
			if err != nil {
				if err != io.EOF && !shared.IsConnClosed(err) {
					log.Printf("upstream read error (moreToCome): %v", err)
				}
				return
			}
			if _, err := pc.clientConn.Write(msg.raw); err != nil {
				if !shared.IsConnClosed(err) {
					log.Printf("client write error (moreToCome): %v", err)
				}
				return
			}
		}
	}
}

func (pc *proxyConnection) logQuery(pq pendingQuery, response *mongoMessage) {
	if pc.logger == nil {
		return
	}

	cmdName := pq.command.commandName
	ri := extractResponseInfo(response, cmdName)
	success := !ri.hasOk || ri.ok == 1

	// For find commands with a live cursor, start accumulating batches
	// instead of logging immediately.
	if cmdName == "find" && ri.cursorID != 0 && ri.data != nil {
		pc.mu.Lock()
		pc.cursors[ri.cursorID] = &cursorAccumulator{
			query:     reconstructQuery(pq.command),
			startTime: pq.startTime,
			data:      ri.data,
		}
		pc.mu.Unlock()
		return
	}

	// For getMore, append batch to the accumulator. If the cursor is
	// exhausted (cursorID == 0), log the accumulated result.
	if cmdName == "getMore" {
		var getCursorID int64
		if pq.command.rawBSONBody != nil {
			getCursorID = extractGetMoreCursorID(pq.command.rawBSONBody)
		}

		pc.mu.Lock()
		acc, found := pc.cursors[getCursorID]
		if found {
			if ri.data != nil {
				acc.data = append(acc.data, ri.data...)
			}
			if ri.cursorID == 0 {
				// Cursor exhausted — log the accumulated result
				delete(pc.cursors, getCursorID)
				pc.mu.Unlock()

				durationMs := int(time.Since(acc.startTime).Milliseconds())
				msg := shared.DatabaseLogMessage{
					InstanceID:     pc.config.InstanceID,
					InstanceItemID: pc.config.InstanceItemID,
					DatabaseType:   pc.config.DatabaseType,
					DatabaseName:   pc.config.InstanceItemName,
					Query:          acc.query,
					Success:        success,
					Data:           acc.data,
					Duration:       &durationMs,
					Timestamp:      time.Now().Format(time.RFC3339Nano),
				}
				if ri.errmsg != "" {
					msg.Error = ri.errmsg
				}
				pc.logger.Log(msg)
				return
			}
			// Update cursor ID in case it changed
			if ri.cursorID != getCursorID {
				pc.cursors[ri.cursorID] = acc
				delete(pc.cursors, getCursorID)
			}
			pc.mu.Unlock()
			return
		}
		pc.mu.Unlock()
		// If no accumulator found, fall through to log normally
	}

	durationMs := int(time.Since(pq.startTime).Milliseconds())
	query := reconstructQuery(pq.command)

	msg := shared.DatabaseLogMessage{
		InstanceID:     pc.config.InstanceID,
		InstanceItemID: pc.config.InstanceItemID,
		DatabaseType:   pc.config.DatabaseType,
		DatabaseName:   pc.config.InstanceItemName,
		Query:          query,
		Success:        success,
		Duration:       &durationMs,
		Timestamp:      time.Now().Format(time.RFC3339Nano),
	}

	if ri.n > 0 {
		msg.RowsAffected = &ri.n
	}
	if ri.errmsg != "" {
		msg.Error = ri.errmsg
	}
	if ri.data != nil {
		msg.Data = ri.data
	}

	pc.logger.Log(msg)
}
