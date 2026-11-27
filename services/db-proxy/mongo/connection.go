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

type proxyConnection struct {
	clientConn   net.Conn
	upstreamConn net.Conn
	config       *shared.Config
	logger       *shared.QueryLogger

	mu      sync.Mutex
	pending map[int32]pendingQuery
	cursors *cursorRegistry
}

func newProxyConnection(client, upstream net.Conn, cfg *shared.Config, logger *shared.QueryLogger, cursors *cursorRegistry) *proxyConnection {
	return &proxyConnection{
		clientConn:   client,
		upstreamConn: upstream,
		config:       cfg,
		logger:       logger,
		pending:      make(map[int32]pendingQuery),
		cursors:      cursors,
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
		// The client is gone: pass it on with a half-close, so the server ends
		// the connection while replies in flight still reach the client.
		if tc, ok := pc.upstreamConn.(*net.TCPConn); ok {
			tc.CloseWrite()
		} else {
			pc.upstreamConn.Close()
		}
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

		if _, err := pc.upstreamConn.Write(msg.wire); err != nil {
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

		if _, err := pc.clientConn.Write(msg.wire); err != nil {
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
			if _, err := pc.clientConn.Write(msg.wire); err != nil {
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
	success := (!ri.hasOk || ri.ok == 1) && ri.writeError == ""
	if ri.writeError != "" && ri.errmsg == "" {
		ri.errmsg = ri.writeError
	}

	// A find or aggregate with a live cursor: gather its batches, and log
	// it once the cursor ends
	if (cmdName == "find" || cmdName == "aggregate") && ri.cursorID != 0 && ri.data != nil {
		pc.cursors.start(ri.cursorID, &cursorAccumulator{
			query:     reconstructQuery(pq.command),
			startTime: pq.startTime,
			data:      ri.data,
		})
		return
	}

	if cmdName == "getMore" && pq.command.rawBSONBody != nil {
		id := extractGetMoreCursorID(pq.command.rawBSONBody)
		if acc, ended := pc.cursors.next(id, ri.data, ri.cursorID); acc != nil {
			if ended || !success {
				pc.cursors.take([]int64{ri.cursorID})
				logCursor(pc.logger, pc.config, acc, success, ri.errmsg)
			}
			return
		}
		// A cursor opened before the proxy saw it: log the batch on its own
	}

	// The client closed cursors before reading them all: log what it read.
	// The killCursors itself is driver plumbing, like a getMore.
	if cmdName == "killCursors" && pq.command.rawBSONBody != nil {
		for _, acc := range pc.cursors.take(extractKillCursorsIDs(pq.command.rawBSONBody)) {
			logCursor(pc.logger, pc.config, acc, true, "")
		}
		return
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

	// Rows changed by a write, or returned by a read
	switch cmdName {
	case "find", "getMore", "aggregate", "findAndModify":
		msg.RowsAffected = int64(len(ri.data))
	case "update":
		msg.RowsAffected = ri.nModified
	default:
		msg.RowsAffected = ri.n
	}
	if ri.errmsg != "" {
		msg.Error = ri.errmsg
	}
	if ri.data != nil {
		msg.Data = ri.data
	}

	pc.logger.Log(msg)
}

// logCursor logs a find or aggregate with every batch its cursor returned
func logCursor(logger *shared.QueryLogger, cfg *shared.Config, acc *cursorAccumulator, success bool, errmsg string) {
	if logger == nil {
		return
	}
	durationMs := int(time.Since(acc.startTime).Milliseconds())
	logger.Log(shared.DatabaseLogMessage{
		InstanceID:     cfg.InstanceID,
		InstanceItemID: cfg.InstanceItemID,
		DatabaseType:   cfg.DatabaseType,
		DatabaseName:   cfg.InstanceItemName,
		Query:          acc.query,
		Success:        success,
		Data:           acc.data,
		RowsAffected:   int64(len(acc.data)),
		Error:          errmsg,
		Duration:       &durationMs,
		Timestamp:      time.Now().Format(time.RFC3339Nano),
	})
}
