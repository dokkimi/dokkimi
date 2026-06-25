package main

import (
	"context"
	"io"
	"log"
	"net"
	"sync"

	"github.com/dokkimi/dokkimi/services/broker-proxy/shared"
)

type Proxy struct {
	listenAddr   string
	upstreamAddr string
	cfg          *shared.Config
	logger       *shared.MessageLogger
	listener     net.Listener
	wg           sync.WaitGroup
}

func NewProxy(cfg *shared.Config, logger *shared.MessageLogger) *Proxy {
	return &Proxy{
		listenAddr:   ":" + cfg.ProxyPort,
		upstreamAddr: "localhost:" + cfg.BrokerPort,
		cfg:          cfg,
		logger:       logger,
	}
}

func (p *Proxy) Listen() error {
	ln, err := net.Listen("tcp", p.listenAddr)
	if err != nil {
		return err
	}
	p.listener = ln
	log.Printf("Proxy listening on %s, forwarding to %s", p.listenAddr, p.upstreamAddr)
	return nil
}

func (p *Proxy) Serve() error {
	for {
		clientConn, err := p.listener.Accept()
		if err != nil {
			return err
		}
		p.wg.Add(1)
		go func() {
			defer p.wg.Done()
			p.handleConnection(clientConn)
		}()
	}
}

func (p *Proxy) handleConnection(clientConn net.Conn) {
	defer clientConn.Close()

	// Read the 8-byte AMQP protocol header from the client
	protoHeader := make([]byte, 8)
	if _, err := io.ReadFull(clientConn, protoHeader); err != nil {
		log.Printf("Failed to read protocol header: %v", err)
		return
	}

	// Connect to upstream broker
	upstreamConn, err := net.Dial("tcp", p.upstreamAddr)
	if err != nil {
		log.Printf("Failed to connect to upstream broker: %v", err)
		return
	}
	defer upstreamConn.Close()

	// Forward the protocol header to upstream
	if _, err := upstreamConn.Write(protoHeader); err != nil {
		log.Printf("Failed to forward protocol header: %v", err)
		return
	}

	// Start bidirectional frame relay with message interception
	conn := newAmqpConnection(clientConn, upstreamConn, p.cfg, p.logger)
	conn.relay()
}

func (p *Proxy) Shutdown(ctx context.Context) {
	if p.listener != nil {
		p.listener.Close()
	}

	done := make(chan struct{})
	go func() {
		p.wg.Wait()
		close(done)
	}()

	select {
	case <-done:
	case <-ctx.Done():
	}
}
