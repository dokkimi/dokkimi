package main

import (
	"bufio"
	"io"
	"log"
	"net"
	"time"

	shared "github.com/dokkimi/dokkimi/services/db-proxy/shared"
)

// pendingCommand tracks a command waiting for its response from upstream
type pendingCommand struct {
	command   string
	cmdName   string
	startTime time.Time
}

// proxyConnection manages a single client↔upstream Redis connection pair.
// Redis uses a synchronous request/response protocol (commands are pipelined
// but responses arrive in order), so we read commands from the client,
// queue them, forward to upstream, then read responses in order.
type proxyConnection struct {
	clientConn   net.Conn
	upstreamConn net.Conn
	config       *shared.Config
	logger       *shared.QueryLogger

	pendingCh chan pendingCommand
}

func newProxyConnection(client, upstream net.Conn, cfg *shared.Config, logger *shared.QueryLogger) *proxyConnection {
	return &proxyConnection{
		clientConn:   client,
		upstreamConn: upstream,
		config:       cfg,
		logger:       logger,
		pendingCh:    make(chan pendingCommand, 1024),
	}
}

// relay performs bidirectional message relay between client and upstream
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
		// Client→upstream finished (QUIT or client disconnected).
		// Wait for upstream→client to drain remaining responses before
		// closing connections — otherwise the client never receives them.
		<-upToClientDone
	case <-upToClientDone:
		// Upstream→client finished first (upstream died).
		// Close client connection to unblock the client→upstream read.
		pc.clientConn.Close()
		<-clientToUpDone
	}

	pc.clientConn.Close()
	pc.upstreamConn.Close()
}

// relayClientToUpstream reads RESP commands from the client, extracts command
// text for logging, and forwards raw bytes to upstream.
func (pc *proxyConnection) relayClientToUpstream() {
	reader := bufio.NewReaderSize(pc.clientConn, 64*1024)

	for {
		val, err := readRESP(reader)
		if err != nil {
			if err != io.EOF && !shared.IsConnClosed(err) {
				log.Printf("client read error: %v", err)
			}
			close(pc.pendingCh)
			return
		}

		cmdName := extractCommandName(val)

		// Don't log AUTH, HELLO, or CLIENT commands — they're internal
		// go-redis init overhead, not user queries.
		isInternal := cmdName == "AUTH" || cmdName == "HELLO" || cmdName == "CLIENT"
		if !isInternal && cmdName != "" {
			command := extractCommand(val)
			pc.pendingCh <- pendingCommand{
				command:   command,
				cmdName:   cmdName,
				startTime: time.Now(),
			}
		} else if isInternal {
			// Still need a placeholder so response ordering stays correct
			pc.pendingCh <- pendingCommand{cmdName: cmdName, startTime: time.Now()}
		}

		if _, err := pc.upstreamConn.Write(val.rawBytes); err != nil {
			if !shared.IsConnClosed(err) {
				log.Printf("upstream write error: %v", err)
			}
			close(pc.pendingCh)
			return
		}

		if cmdName == "QUIT" {
			close(pc.pendingCh)
			return
		}
	}
}

// relayUpstreamToClient reads RESP responses from upstream, logs them with
// the corresponding command, and forwards raw bytes to client.
func (pc *proxyConnection) relayUpstreamToClient() {
	reader := bufio.NewReaderSize(pc.upstreamConn, 64*1024)

	for pq := range pc.pendingCh {
		// Drain any unsolicited RESP3 push messages (>) from the server
		// before reading the actual command response. Push messages arrive
		// asynchronously (pub/sub, client tracking invalidations) and have
		// no corresponding pending command.
		for {
			val, err := readRESP(reader)
			if err != nil {
				if err != io.EOF && !shared.IsConnClosed(err) {
					log.Printf("upstream read error: %v", err)
				}
				return
			}

			if _, err := pc.clientConn.Write(val.rawBytes); err != nil {
				if !shared.IsConnClosed(err) {
					log.Printf("client write error: %v", err)
				}
				return
			}

			if val.typ == respPush || val.typ == respAttribute {
				continue
			}

			// This is the actual response to the pending command
			if pq.cmdName != "AUTH" && pq.cmdName != "HELLO" && pq.cmdName != "CLIENT" && pq.command != "" {
				pc.logCommand(pq, val)
			}
			break
		}
	}
}

func (pc *proxyConnection) logCommand(pq pendingCommand, response *respValue) {
	if pc.logger == nil {
		return
	}

	durationMs := int(time.Since(pq.startTime).Milliseconds())
	success := response.typ != respError
	var errMsg string
	if !success {
		errMsg = response.str
	}

	data := normalizeResponse(pq.cmdName, response)

	msg := shared.DatabaseLogMessage{
		InstanceID:     pc.config.InstanceID,
		InstanceItemID: pc.config.InstanceItemID,
		DatabaseType:   pc.config.DatabaseType,
		DatabaseName:   pc.config.InstanceItemName,
		Query:          pq.command,
		Success:        success,
		Duration:       &durationMs,
		Timestamp:      time.Now().Format(time.RFC3339Nano),
	}
	if len(data) > 0 {
		msg.Data = data
		ra := int64(len(data))
		msg.RowsAffected = &ra
	}
	if errMsg != "" {
		msg.Error = errMsg
	}
	pc.logger.Log(msg)
}
