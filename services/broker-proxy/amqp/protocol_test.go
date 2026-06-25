package main

import (
	"bytes"
	"encoding/binary"
	"testing"
)

func TestReadFrame(t *testing.T) {
	// Build a method frame: type=1, channel=1, payload="hello"
	payload := []byte("hello")
	var buf bytes.Buffer
	buf.WriteByte(frameMethod)
	binary.Write(&buf, binary.BigEndian, uint16(1))
	binary.Write(&buf, binary.BigEndian, uint32(len(payload)))
	buf.Write(payload)
	buf.WriteByte(frameEnd)

	f, raw, err := readFrame(&buf)
	if err != nil {
		t.Fatalf("readFrame: %v", err)
	}
	if f.Type != frameMethod {
		t.Errorf("type = %d, want %d", f.Type, frameMethod)
	}
	if f.Channel != 1 {
		t.Errorf("channel = %d, want 1", f.Channel)
	}
	if string(f.Payload) != "hello" {
		t.Errorf("payload = %q, want %q", f.Payload, "hello")
	}
	if len(raw) != 7+5+1 {
		t.Errorf("raw length = %d, want %d", len(raw), 13)
	}
}

func TestReadFrame_InvalidEnd(t *testing.T) {
	payload := []byte("hi")
	var buf bytes.Buffer
	buf.WriteByte(frameMethod)
	binary.Write(&buf, binary.BigEndian, uint16(0))
	binary.Write(&buf, binary.BigEndian, uint32(len(payload)))
	buf.Write(payload)
	buf.WriteByte(0xFF) // wrong frame-end

	_, _, err := readFrame(&buf)
	if err == nil {
		t.Fatal("expected error for invalid frame end")
	}
}

func TestParseBasicPublish(t *testing.T) {
	var args bytes.Buffer
	binary.Write(&args, binary.BigEndian, uint16(0)) // reserved-1
	exchange := "amq.topic"
	args.WriteByte(byte(len(exchange)))
	args.WriteString(exchange)
	routingKey := "order.created"
	args.WriteByte(byte(len(routingKey)))
	args.WriteString(routingKey)
	args.WriteByte(0) // mandatory=false, immediate=false

	ex, rk, err := parseBasicPublish(args.Bytes())
	if err != nil {
		t.Fatalf("parseBasicPublish: %v", err)
	}
	if ex != exchange {
		t.Errorf("exchange = %q, want %q", ex, exchange)
	}
	if rk != routingKey {
		t.Errorf("routingKey = %q, want %q", rk, routingKey)
	}
}

func TestParseBasicDeliver(t *testing.T) {
	var args bytes.Buffer
	consumerTag := "ctag1"
	args.WriteByte(byte(len(consumerTag)))
	args.WriteString(consumerTag)
	binary.Write(&args, binary.BigEndian, uint64(42)) // delivery-tag
	args.WriteByte(0)                                 // redelivered=false
	exchange := ""
	args.WriteByte(byte(len(exchange)))
	args.WriteString(exchange)
	routingKey := "my-queue"
	args.WriteByte(byte(len(routingKey)))
	args.WriteString(routingKey)

	ct, ex, rk, dt, rd, err := parseBasicDeliver(args.Bytes())
	if err != nil {
		t.Fatalf("parseBasicDeliver: %v", err)
	}
	if ct != consumerTag {
		t.Errorf("consumerTag = %q, want %q", ct, consumerTag)
	}
	if ex != exchange {
		t.Errorf("exchange = %q, want %q", ex, exchange)
	}
	if rk != routingKey {
		t.Errorf("routingKey = %q, want %q", rk, routingKey)
	}
	if dt != 42 {
		t.Errorf("deliveryTag = %d, want 42", dt)
	}
	if rd {
		t.Error("redelivered = true, want false")
	}
}

func TestParseContentHeader(t *testing.T) {
	var buf bytes.Buffer
	binary.Write(&buf, binary.BigEndian, uint16(60))     // class-id (Basic)
	binary.Write(&buf, binary.BigEndian, uint16(0))      // weight
	binary.Write(&buf, binary.BigEndian, uint64(1234))   // body-size
	binary.Write(&buf, binary.BigEndian, uint16(0x8000)) // property-flags: content-type present
	contentType := "application/json"
	buf.WriteByte(byte(len(contentType)))
	buf.WriteString(contentType)

	bodySize, ct, err := parseContentHeader(buf.Bytes())
	if err != nil {
		t.Fatalf("parseContentHeader: %v", err)
	}
	if bodySize != 1234 {
		t.Errorf("bodySize = %d, want 1234", bodySize)
	}
	if ct != "application/json" {
		t.Errorf("contentType = %q, want %q", ct, "application/json")
	}
}

func TestParseContentHeader_NoProperties(t *testing.T) {
	var buf bytes.Buffer
	binary.Write(&buf, binary.BigEndian, uint16(60))
	binary.Write(&buf, binary.BigEndian, uint16(0))
	binary.Write(&buf, binary.BigEndian, uint64(0))
	binary.Write(&buf, binary.BigEndian, uint16(0)) // no properties

	bodySize, ct, err := parseContentHeader(buf.Bytes())
	if err != nil {
		t.Fatalf("parseContentHeader: %v", err)
	}
	if bodySize != 0 {
		t.Errorf("bodySize = %d, want 0", bodySize)
	}
	if ct != "" {
		t.Errorf("contentType = %q, want empty", ct)
	}
}
