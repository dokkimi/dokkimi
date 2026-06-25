package main

import (
	"bytes"
	"encoding/json"
	"io"
	"log"
	"net"
	"sync"
	"time"

	"github.com/dokkimi/dokkimi/services/broker-proxy/shared"
)

// channelState tracks in-progress message assembly on a single AMQP channel.
type channelState struct {
	operation   string // "publish" or "deliver"
	exchange    string
	routingKey  string
	consumerTag string
	contentType string
	bodySize    uint64
	bodyBuf     bytes.Buffer
}

type amqpConnection struct {
	client   net.Conn
	upstream net.Conn
	cfg      *shared.Config
	logger   *shared.MessageLogger

	// Per-channel state for message assembly (AMQP multiplexes channels on one TCP conn)
	channels map[uint16]*channelState
	mu       sync.Mutex
}

func newAmqpConnection(client, upstream net.Conn, cfg *shared.Config, logger *shared.MessageLogger) *amqpConnection {
	return &amqpConnection{
		client:   client,
		upstream: upstream,
		cfg:      cfg,
		logger:   logger,
		channels: make(map[uint16]*channelState),
	}
}

func (c *amqpConnection) relay() {
	done := make(chan struct{}, 2)

	// Client → Upstream (intercept publishes)
	go func() {
		c.relayDirection(c.client, c.upstream, true)
		done <- struct{}{}
	}()

	// Upstream → Client (intercept delivers)
	go func() {
		c.relayDirection(c.upstream, c.client, false)
		done <- struct{}{}
	}()

	// When either direction closes, shut down both
	<-done
	c.client.Close()
	c.upstream.Close()
	<-done
}

func (c *amqpConnection) relayDirection(src, dst net.Conn, isClientToUpstream bool) {
	for {
		f, raw, err := readFrame(src)
		if err != nil {
			if err != io.EOF {
				log.Printf("Frame read error: %v", err)
			}
			return
		}

		// Forward the raw frame unchanged
		if _, err := dst.Write(raw); err != nil {
			log.Printf("Frame write error: %v", err)
			return
		}

		// Inspect interesting frames
		c.inspectFrame(f, isClientToUpstream)
	}
}

func (c *amqpConnection) inspectFrame(f *frame, isClientToUpstream bool) {
	switch f.Type {
	case frameMethod:
		classID, methodID, args, err := parseMethodFrame(f.Payload)
		if err != nil {
			return
		}
		c.handleMethod(f.Channel, classID, methodID, args, isClientToUpstream)

	case frameHeader:
		c.handleContentHeader(f.Channel, f.Payload)

	case frameBody:
		c.handleContentBody(f.Channel, f.Payload)
	}
}

func (c *amqpConnection) handleMethod(channel, classID, methodID uint16, args []byte, isClientToUpstream bool) {
	if classID != classBasic {
		return
	}

	switch methodID {
	case methodPublish:
		if !isClientToUpstream {
			return
		}
		exchange, routingKey, err := parseBasicPublish(args)
		if err != nil {
			log.Printf("Failed to parse Basic.Publish: %v", err)
			return
		}
		c.mu.Lock()
		c.channels[channel] = &channelState{
			operation:  "publish",
			exchange:   exchange,
			routingKey: routingKey,
		}
		c.mu.Unlock()

	case methodDeliver:
		if isClientToUpstream {
			return
		}
		_, exchange, routingKey, _, _, err := parseBasicDeliver(args)
		if err != nil {
			log.Printf("Failed to parse Basic.Deliver: %v", err)
			return
		}
		c.mu.Lock()
		c.channels[channel] = &channelState{
			operation:  "deliver",
			exchange:   exchange,
			routingKey: routingKey,
		}
		c.mu.Unlock()
	}
}

func (c *amqpConnection) handleContentHeader(channel uint16, payload []byte) {
	c.mu.Lock()
	cs, ok := c.channels[channel]
	if !ok {
		c.mu.Unlock()
		return
	}

	bodySize, contentType, err := parseContentHeader(payload)
	if err != nil {
		log.Printf("Failed to parse content header: %v", err)
		delete(c.channels, channel)
		c.mu.Unlock()
		return
	}

	cs.bodySize = bodySize
	cs.contentType = contentType
	cs.bodyBuf.Reset()
	c.mu.Unlock()

	// Zero-length body — log immediately
	if bodySize == 0 {
		c.completeMessage(channel)
	}
}

func (c *amqpConnection) handleContentBody(channel uint16, payload []byte) {
	c.mu.Lock()
	cs, ok := c.channels[channel]
	if !ok {
		c.mu.Unlock()
		return
	}
	cs.bodyBuf.Write(payload)
	received := uint64(cs.bodyBuf.Len())
	expected := cs.bodySize
	c.mu.Unlock()

	if received >= expected {
		c.completeMessage(channel)
	}
}

func (c *amqpConnection) completeMessage(channel uint16) {
	c.mu.Lock()
	cs, ok := c.channels[channel]
	if !ok {
		c.mu.Unlock()
		return
	}
	delete(c.channels, channel)
	c.mu.Unlock()

	bodyBytes := cs.bodyBuf.Bytes()

	var body interface{}
	if err := json.Unmarshal(bodyBytes, &body); err == nil {
		// Valid JSON — use parsed value
	} else if len(bodyBytes) > 0 {
		body = string(bodyBytes)
	}

	c.logger.Log(shared.MessageLogMessage{
		InstanceID:     c.cfg.InstanceID,
		InstanceItemID: c.cfg.InstanceItemID,
		BrokerType:     c.cfg.BrokerType,
		BrokerName:     c.cfg.InstanceItemName,
		Operation:      cs.operation,
		Body:           body,
		ContentType:    cs.contentType,
		Timestamp:      time.Now().Format(time.RFC3339Nano),
		Metadata: map[string]interface{}{
			"exchange":   cs.exchange,
			"routingKey": cs.routingKey,
		},
	})
}
