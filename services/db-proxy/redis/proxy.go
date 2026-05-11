package main

import (
	"log"
	"net"
	"time"

	shared "dokkimi.com/db-proxy-shared"
)

type Proxy struct {
	*shared.BaseProxy
}

func NewProxy(cfg *shared.Config, logger *shared.QueryLogger) *Proxy {
	p := &Proxy{}
	p.BaseProxy = shared.NewBaseProxy(cfg, logger, p.handleConnection)
	return p
}

func (p *Proxy) Listen() error {
	if err := p.BaseProxy.Listen(); err != nil {
		return err
	}
	log.Printf("Redis proxy listening on %s, forwarding to %s", p.ListenAddr, p.UpstreamAddr)
	return nil
}

func (p *Proxy) handleConnection(clientConn net.Conn) {
	p.TrackConn(clientConn)
	defer func() {
		clientConn.Close()
		p.UntrackConn(clientConn)
	}()

	upstreamConn, err := net.DialTimeout("tcp", p.UpstreamAddr, 10*time.Second)
	if err != nil {
		log.Printf("failed to connect to upstream %s: %v", p.UpstreamAddr, err)
		return
	}
	p.TrackConn(upstreamConn)
	defer func() {
		upstreamConn.Close()
		p.UntrackConn(upstreamConn)
	}()

	pc := newProxyConnection(clientConn, upstreamConn, p.Config, p.Logger)
	pc.relay()
}
