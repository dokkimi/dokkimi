package main

import (
	"bytes"
	"encoding/binary"
	"encoding/json"
	"log"
	"net"
	"sync"
	"time"

	"github.com/dokkimi/dokkimi/services/broker-proxy/shared"
)

// halfCloseWrite closes the write side of a TCP connection, sending FIN while
// leaving the read side open for in-flight frames.
func halfCloseWrite(conn net.Conn) {
	type closeWriter interface{ CloseWrite() error }
	if cw, ok := conn.(closeWriter); ok {
		cw.CloseWrite()
	}
}

// pendingRequest tracks an in-flight request so we can match it to its response.
type pendingRequest struct {
	apiKey     int16
	apiVersion int16
}

type kafkaConnection struct {
	client   net.Conn
	upstream net.Conn
	cfg      *shared.Config
	logger   *shared.MessageLogger

	pending map[int32]pendingRequest // correlationID → request info
	mu      sync.Mutex
}

func newKafkaConnection(client, upstream net.Conn, cfg *shared.Config, logger *shared.MessageLogger) *kafkaConnection {
	return &kafkaConnection{
		client:   client,
		upstream: upstream,
		cfg:      cfg,
		logger:   logger,
		pending:  make(map[int32]pendingRequest),
	}
}

func (c *kafkaConnection) relay() {
	done := make(chan struct{}, 2)

	// Client → Upstream: intercept Produce requests
	go func() {
		c.relayRequests()
		// Propagate EOF via TCP half-close so the peer winds down naturally.
		halfCloseWrite(c.upstream)
		done <- struct{}{}
	}()

	// Upstream → Client: intercept Fetch responses
	go func() {
		c.relayResponses()
		halfCloseWrite(c.client)
		done <- struct{}{}
	}()

	// Wait for BOTH directions to drain. Closing both sockets as soon as one
	// direction ended (previous behavior) destroyed frames the other reader
	// hadn't processed yet — produce logs vanished when a client produced
	// and disconnected quickly. The deadline bounds the drain in case the
	// remaining peer never closes.
	<-done
	deadline := time.Now().Add(30 * time.Second)
	c.client.SetReadDeadline(deadline)
	c.upstream.SetReadDeadline(deadline)
	<-done
	c.client.Close()
	c.upstream.Close()
}

func (c *kafkaConnection) relayRequests() {
	for {
		raw, payload, err := readMessage(c.client)
		if err != nil {
			return
		}

		// Note the request before forwarding it: the broker can answer before
		// this goroutine runs again, and the reply must find its request.
		hdr, bodyStart, hdrErr := parseRequestHeader(payload)
		if hdrErr == nil {
			c.mu.Lock()
			c.pending[hdr.CorrelationID] = pendingRequest{apiKey: hdr.APIKey, apiVersion: hdr.APIVersion}
			c.mu.Unlock()
		}

		if _, err := c.upstream.Write(raw); err != nil {
			return
		}

		if hdrErr == nil {
			c.inspectRequest(hdr, payload[bodyStart:])
		}
	}
}

func (c *kafkaConnection) relayResponses() {
	for {
		raw, payload, err := readMessage(c.upstream)
		if err != nil {
			return
		}

		if _, err := c.client.Write(raw); err != nil {
			return
		}

		c.inspectResponse(payload)
	}
}

func (c *kafkaConnection) inspectRequest(hdr requestHeader, body []byte) {
	if hdr.APIKey != apiProduce {
		return
	}
	records, err := parseProduceRequest(body, hdr.APIVersion)
	if err != nil {
		log.Printf("Kafka produce v%d parse: %v", hdr.APIVersion, err)
	}
	for _, rec := range records {
		c.logRecord("produce", rec.Topic, rec.Partition, -1, rec.Key, rec.Value)
	}
}

func (c *kafkaConnection) inspectResponse(payload []byte) {
	if len(payload) < 4 {
		return
	}

	corrID := int32(binary.BigEndian.Uint32(payload[0:4]))

	c.mu.Lock()
	req, ok := c.pending[corrID]
	delete(c.pending, corrID)
	c.mu.Unlock()

	if !ok {
		return
	}

	if req.apiKey != apiFetch && req.apiKey != apiMetadata {
		return
	}
	body, err := responseBody(payload, req.apiKey, req.apiVersion)
	if err != nil {
		return
	}
	switch req.apiKey {
	case apiMetadata:
		if err := recordTopicNames(body, req.apiVersion); err != nil {
			log.Printf("Kafka metadata v%d parse: %v", req.apiVersion, err)
		}
	case apiFetch:
		records, err := parseFetchResponse(body, req.apiVersion)
		if err != nil {
			log.Printf("Kafka fetch v%d parse: %v", req.apiVersion, err)
		}
		for _, rec := range records {
			c.logRecord("consume", rec.Topic, rec.Partition, rec.Offset, rec.Key, rec.Value)
		}
	}
}

func (c *kafkaConnection) logRecord(operation, topic string, partition int32, offset int64, key, value []byte) {
	var body interface{}
	contentType := ""
	if v, ok := decodeJSON(value); ok {
		body = v
		contentType = "application/json"
	} else if len(value) > 0 {
		body = string(value)
		contentType = "text/plain"
	}

	metadata := map[string]interface{}{
		"topic":     topic,
		"partition": partition,
	}
	if key != nil {
		// A key is an identifier: keep it as the exact text it was, so
		// 1234567890123456789 doesn't become a rounded number. Only a JSON
		// object or array key is shown parsed.
		metadata["key"] = string(key)
		if k, ok := decodeJSON(key); ok {
			switch k.(type) {
			case map[string]interface{}, []interface{}:
				metadata["key"] = k
			}
		}
	}
	if offset >= 0 {
		metadata["offset"] = offset
	}

	c.logger.Log(shared.MessageLogMessage{
		InstanceID:     c.cfg.InstanceID,
		InstanceItemID: c.cfg.InstanceItemID,
		BrokerType:     c.cfg.BrokerType,
		BrokerName:     c.cfg.InstanceItemName,
		Operation:      operation,
		Body:           body,
		ContentType:    contentType,
		Timestamp:      time.Now().Format(time.RFC3339Nano),
		Metadata:       metadata,
	})
}

// decodeJSON parses data as JSON, keeping numbers exact (as json.Number), so
// a large integer is logged as it was sent rather than rounded to a float.
func decodeJSON(data []byte) (interface{}, bool) {
	dec := json.NewDecoder(bytes.NewReader(data))
	dec.UseNumber()
	var v interface{}
	if dec.Decode(&v) != nil || dec.More() {
		return nil, false
	}
	return v, true
}
