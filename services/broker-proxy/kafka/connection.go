package main

import (
	"encoding/binary"
	"encoding/json"
	"log"
	"net"
	"sync"
	"time"

	"github.com/dokkimi/dokkimi/services/broker-proxy/shared"
)

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
		done <- struct{}{}
	}()

	// Upstream → Client: intercept Fetch responses
	go func() {
		c.relayResponses()
		done <- struct{}{}
	}()

	<-done
	c.client.Close()
	c.upstream.Close()
	<-done
}

func (c *kafkaConnection) relayRequests() {
	for {
		raw, payload, err := readMessage(c.client)
		if err != nil {
			return
		}

		if _, err := c.upstream.Write(raw); err != nil {
			return
		}

		c.inspectRequest(payload)
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

func (c *kafkaConnection) inspectRequest(payload []byte) {
	hdr, bodyStart, err := parseRequestHeader(payload)
	if err != nil {
		return
	}

	c.mu.Lock()
	c.pending[hdr.CorrelationID] = pendingRequest{
		apiKey:     hdr.APIKey,
		apiVersion: hdr.APIVersion,
	}
	c.mu.Unlock()

	if hdr.APIKey == apiProduce {
		records, err := parseProduceRequest(payload, bodyStart, hdr.APIVersion)
		if err != nil {
			log.Printf("Kafka produce parse: %v", err)
			return
		}
		for _, rec := range records {
			c.logRecord("produce", rec.Topic, rec.Partition, -1, rec.Key, rec.Value)
		}
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

	if req.apiKey == apiFetch {
		records, err := parseFetchResponse(payload, req.apiVersion)
		if err != nil {
			log.Printf("Kafka fetch parse: %v", err)
			return
		}
		for _, rec := range records {
			c.logRecord("consume", rec.Topic, rec.Partition, rec.Offset, rec.Key, rec.Value)
		}
	}
}

func (c *kafkaConnection) logRecord(operation, topic string, partition int32, offset int64, key, value []byte) {
	var body interface{}
	contentType := ""
	if err := json.Unmarshal(value, &body); err == nil {
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
		if keyObj := tryJSON(key); keyObj != nil {
			metadata["key"] = keyObj
		} else {
			metadata["key"] = string(key)
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

func tryJSON(data []byte) interface{} {
	var v interface{}
	if json.Unmarshal(data, &v) == nil {
		return v
	}
	return nil
}
