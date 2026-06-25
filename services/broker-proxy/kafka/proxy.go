package main

import (
	"context"
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

	upstreamConn, err := net.Dial("tcp", p.upstreamAddr)
	if err != nil {
		log.Printf("Failed to connect to upstream broker: %v", err)
		return
	}
	defer upstreamConn.Close()

	conn := newKafkaConnection(clientConn, upstreamConn, p.cfg, p.logger)
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
