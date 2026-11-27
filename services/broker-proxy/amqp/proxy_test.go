package main

import (
	"context"
	"testing"
	"time"

	"github.com/dokkimi/dokkimi/services/broker-proxy/shared"
)

// Before, Serve returned the closed listener's error on shutdown, and main
// exited on it before the logger sent what it still had queued
func TestServeReturnsNilOnShutdown(t *testing.T) {
	p := NewProxy(&shared.Config{ProxyPort: "0", BrokerPort: "1"}, nil)
	if err := p.Listen(); err != nil {
		t.Fatalf("Listen: %v", err)
	}
	served := make(chan error, 1)
	go func() { served <- p.Serve() }()

	p.Shutdown(context.Background())

	select {
	case err := <-served:
		if err != nil {
			t.Errorf("Serve() = %v, want nil", err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("Serve did not return after Shutdown")
	}
}
