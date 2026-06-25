package main

import (
	"encoding/binary"
	"fmt"
	"io"
)

// AMQP 0-9-1 frame types
const (
	frameMethod    byte = 1
	frameHeader    byte = 2
	frameBody      byte = 3
	frameHeartbeat byte = 8
	frameEnd       byte = 0xCE
)

// AMQP 0-9-1 class/method IDs
const (
	classBasic    uint16 = 60
	methodPublish uint16 = 40
	methodDeliver uint16 = 60
)

// AMQP protocol header: "AMQP\x00\x00\x09\x01"
var amqpProtocolHeader = []byte{'A', 'M', 'Q', 'P', 0, 0, 9, 1}

type frame struct {
	Type    byte
	Channel uint16
	Payload []byte
}

func readFrame(r io.Reader) (*frame, []byte, error) {
	// Read 7-byte header: type(1) + channel(2) + size(4)
	header := make([]byte, 7)
	if _, err := io.ReadFull(r, header); err != nil {
		return nil, nil, err
	}

	fType := header[0]
	channel := binary.BigEndian.Uint16(header[1:3])
	size := binary.BigEndian.Uint32(header[3:7])

	// Read payload + frame-end byte
	rest := make([]byte, size+1)
	if _, err := io.ReadFull(r, rest); err != nil {
		return nil, nil, err
	}

	if rest[size] != frameEnd {
		return nil, nil, fmt.Errorf("invalid frame end marker: 0x%02x", rest[size])
	}

	// Build raw bytes for forwarding (header + payload + frame-end)
	raw := make([]byte, 7+size+1)
	copy(raw, header)
	copy(raw[7:], rest)

	return &frame{
		Type:    fType,
		Channel: channel,
		Payload: rest[:size],
	}, raw, nil
}

// parseMethodFrame extracts class ID and method ID from a method frame payload.
func parseMethodFrame(payload []byte) (classID, methodID uint16, args []byte, err error) {
	if len(payload) < 4 {
		return 0, 0, nil, fmt.Errorf("method frame too short: %d bytes", len(payload))
	}
	classID = binary.BigEndian.Uint16(payload[0:2])
	methodID = binary.BigEndian.Uint16(payload[2:4])
	return classID, methodID, payload[4:], nil
}

// parseBasicPublish extracts exchange and routing-key from Basic.Publish arguments.
// Format: reserved-1(short) exchange(shortstr) routing-key(shortstr) bits
func parseBasicPublish(args []byte) (exchange, routingKey string, err error) {
	if len(args) < 2 {
		return "", "", fmt.Errorf("Basic.Publish args too short")
	}
	// Skip reserved-1 (2 bytes)
	pos := 2

	exchange, pos, err = readShortStr(args, pos)
	if err != nil {
		return "", "", fmt.Errorf("reading exchange: %w", err)
	}

	routingKey, _, err = readShortStr(args, pos)
	if err != nil {
		return "", "", fmt.Errorf("reading routing-key: %w", err)
	}

	return exchange, routingKey, nil
}

// parseBasicDeliver extracts fields from Basic.Deliver arguments.
// Format: consumer-tag(shortstr) delivery-tag(longlong) redelivered(bit) exchange(shortstr) routing-key(shortstr)
func parseBasicDeliver(args []byte) (consumerTag, exchange, routingKey string, deliveryTag uint64, redelivered bool, err error) {
	pos := 0

	consumerTag, pos, err = readShortStr(args, pos)
	if err != nil {
		return "", "", "", 0, false, fmt.Errorf("reading consumer-tag: %w", err)
	}

	if pos+8 > len(args) {
		return "", "", "", 0, false, fmt.Errorf("args too short for delivery-tag")
	}
	deliveryTag = binary.BigEndian.Uint64(args[pos : pos+8])
	pos += 8

	if pos >= len(args) {
		return "", "", "", 0, false, fmt.Errorf("args too short for redelivered flag")
	}
	redelivered = (args[pos] & 1) != 0
	pos++

	exchange, pos, err = readShortStr(args, pos)
	if err != nil {
		return "", "", "", 0, false, fmt.Errorf("reading exchange: %w", err)
	}

	routingKey, _, err = readShortStr(args, pos)
	if err != nil {
		return "", "", "", 0, false, fmt.Errorf("reading routing-key: %w", err)
	}

	return consumerTag, exchange, routingKey, deliveryTag, redelivered, nil
}

// parseContentHeader extracts body size and content-type from a content header frame.
// Format: class-id(2) weight(2) body-size(8) property-flags(2) [properties...]
// Limitation: only reads the first property-flags word. AMQP 0-9-1 allows
// continuation words (bit 0 = "more flags follow"), but RabbitMQ never uses them.
func parseContentHeader(payload []byte) (bodySize uint64, contentType string, err error) {
	if len(payload) < 14 {
		return 0, "", fmt.Errorf("content header too short: %d bytes", len(payload))
	}
	// Skip class-id (2) and weight (2)
	bodySize = binary.BigEndian.Uint64(payload[4:12])
	propertyFlags := binary.BigEndian.Uint16(payload[12:14])

	// Bit 15 (MSB) = content-type present
	if propertyFlags&0x8000 != 0 && len(payload) > 14 {
		ct, _, readErr := readShortStr(payload, 14)
		if readErr == nil {
			contentType = ct
		}
	}

	return bodySize, contentType, nil
}

func readShortStr(data []byte, pos int) (string, int, error) {
	if pos >= len(data) {
		return "", pos, fmt.Errorf("short string: position %d beyond data length %d", pos, len(data))
	}
	length := int(data[pos])
	pos++
	if pos+length > len(data) {
		return "", pos, fmt.Errorf("short string: need %d bytes at pos %d, have %d", length, pos, len(data))
	}
	s := string(data[pos : pos+length])
	return s, pos + length, nil
}
