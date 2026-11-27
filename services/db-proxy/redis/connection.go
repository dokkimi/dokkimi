package main

import (
	"bufio"
	"io"
	"log"
	"net"
	"strings"
	"time"

	shared "github.com/dokkimi/dokkimi/services/db-proxy/shared"
)

// pendingCommand tracks a command waiting for its response from upstream
type pendingCommand struct {
	command   string
	cmdName   string
	startTime time.Time
	// channels is the number of channels a (P|S)(UN)SUBSCRIBE names: the
	// server confirms each one with its own reply.
	channels int
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
		// Client→upstream finished (QUIT or client disconnected). Pass it on
		// with a half-close, so the server ends the connection (cancelling a
		// blocked BLPOP) while replies already in flight still reach the client.
		if tc, ok := pc.upstreamConn.(*net.TCPConn); ok {
			tc.CloseWrite()
		} else {
			pc.upstreamConn.Close()
		}
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
				channels:  len(val.array) - 1,
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
// relayUpstreamToClient forwards everything the server sends, as it arrives,
// and pairs replies with the commands waiting for them. Not everything is a
// reply: pub/sub messages and the stream after MONITOR arrive on their own,
// and a SUBSCRIBE with several channels gets one confirmation per channel.
func (pc *proxyConnection) relayUpstreamToClient() {
	reader := bufio.NewReaderSize(pc.upstreamConn, 64*1024)
	monitoring := false
	subscribed := false         // RESP2 messages can only be told apart from replies while subscribed
	var current *pendingCommand // a SUBSCRIBE-family command still receiving confirmations
	confirmations := 0

	// The oldest command still waiting, taken from pendingCh without blocking.
	var next *pendingCommand
	peek := func() *pendingCommand {
		if next == nil {
			select {
			case pq, ok := <-pc.pendingCh:
				if ok {
					next = &pq
				}
			default:
			}
		}
		return next
	}

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

		if monitoring || val.typ == respAttribute {
			continue
		}
		if isPubSubMessage(val) && (val.typ == respPush || subscribed) {
			continue
		}

		if isSubscriptionConfirmation(val) {
			if current != nil {
				confirmations++
				subscribed = val.array[2].integer > 0
				if subscriptionDone(current, confirmations, val) {
					current = nil
				}
				continue
			}
			if pq := peek(); pq != nil && isSubscriptionCommand(pq.cmdName) {
				next = nil
				pc.logCommand(*pq, val)
				confirmations = 1
				subscribed = val.array[2].integer > 0
				if !subscriptionDone(pq, confirmations, val) {
					current = pq
				}
				continue
			}
			// Not a confirmation after all: an ordinary reply of the same shape.
		}

		if val.typ == respPush {
			continue // e.g. a client-tracking invalidation
		}

		pq := peek()
		if pq == nil {
			continue // nothing is waiting for it
		}
		next = nil
		if pq.cmdName != "AUTH" && pq.cmdName != "HELLO" && pq.cmdName != "CLIENT" && pq.command != "" {
			pc.logCommand(*pq, val)
		}
		if pq.cmdName == "MONITOR" && val.typ != respError {
			monitoring = true
		}
	}
}

var pubSubMessageKinds = map[string]bool{"message": true, "pmessage": true, "smessage": true}

var subscriptionKinds = map[string]bool{
	"subscribe": true, "unsubscribe": true, "psubscribe": true,
	"punsubscribe": true, "ssubscribe": true, "sunsubscribe": true,
}

// isPubSubMessage reports a message published to a subscribed channel (an
// array or push starting with "message", "pmessage" or "smessage"). It is never a reply.
func isPubSubMessage(v *respValue) bool {
	return (v.typ == respArray || v.typ == respPush) && len(v.array) > 0 && pubSubMessageKinds[strings.ToLower(v.array[0].str)]
}

// isSubscriptionConfirmation reports the server confirming a (P|S)(UN)SUBSCRIBE
// for one channel: an array in RESP2, a push in RESP3.
func isSubscriptionConfirmation(v *respValue) bool {
	return (v.typ == respArray || v.typ == respPush) && len(v.array) == 3 && subscriptionKinds[strings.ToLower(v.array[0].str)]
}

func isSubscriptionCommand(cmdName string) bool {
	return subscriptionKinds[strings.ToLower(cmdName)]
}

// subscriptionDone reports whether a SUBSCRIBE-family command has had all its
// confirmations: one per named channel, or, for an UNSUBSCRIBE of everything,
// until the remaining subscription count reaches 0.
func subscriptionDone(pq *pendingCommand, confirmations int, last *respValue) bool {
	if pq.channels > 0 {
		return confirmations >= pq.channels
	}
	return last.array[2].integer == 0
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
		RowsAffected:   int64(len(data)),
		Duration:       &durationMs,
		Timestamp:      time.Now().Format(time.RFC3339Nano),
	}
	if len(data) > 0 {
		msg.Data = data
	}
	if errMsg != "" {
		msg.Error = errMsg
	}
	pc.logger.Log(msg)
}
