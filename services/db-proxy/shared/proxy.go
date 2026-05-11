package shared

import (
	"context"
	"fmt"
	"log"
	"net"
	"strings"
	"sync"
)

type ConnectionHandler func(clientConn net.Conn)

type BaseProxy struct {
	ListenAddr   string
	UpstreamAddr string
	Config       *Config
	Logger       *QueryLogger

	Listener net.Listener
	wg       sync.WaitGroup
	mu       sync.Mutex
	conns    map[net.Conn]struct{}
	handler  ConnectionHandler
	done     chan struct{}
}

func NewBaseProxy(cfg *Config, logger *QueryLogger, handler ConnectionHandler) *BaseProxy {
	return &BaseProxy{
		ListenAddr:   ":" + cfg.QueryPort,
		UpstreamAddr: fmt.Sprintf("localhost:%s", cfg.DatabasePort),
		Config:       cfg,
		Logger:       logger,
		conns:        make(map[net.Conn]struct{}),
		handler:      handler,
		done:         make(chan struct{}),
	}
}

func (p *BaseProxy) Listen() error {
	ln, err := net.Listen("tcp", p.ListenAddr)
	if err != nil {
		return fmt.Errorf("listen on %s: %w", p.ListenAddr, err)
	}
	p.Listener = ln
	return nil
}

func (p *BaseProxy) Serve() error {
	for {
		conn, err := p.Listener.Accept()
		if err != nil {
			select {
			case <-p.done:
				return nil
			default:
				log.Printf("accept error: %v", err)
				continue
			}
		}
		p.wg.Add(1)
		go func() {
			defer p.wg.Done()
			p.handler(conn)
		}()
	}
}

func (p *BaseProxy) Shutdown(ctx context.Context) {
	close(p.done)
	if p.Listener != nil {
		p.Listener.Close()
	}

	p.mu.Lock()
	for c := range p.conns {
		c.Close()
	}
	p.mu.Unlock()

	done := make(chan struct{})
	go func() {
		p.wg.Wait()
		close(done)
	}()

	select {
	case <-done:
	case <-ctx.Done():
		log.Printf("shutdown deadline exceeded, forcing close")
	}
}

func (p *BaseProxy) TrackConn(c net.Conn) {
	p.mu.Lock()
	p.conns[c] = struct{}{}
	p.mu.Unlock()
}

func (p *BaseProxy) UntrackConn(c net.Conn) {
	p.mu.Lock()
	delete(p.conns, c)
	p.mu.Unlock()
}

func IsConnClosed(err error) bool {
	if err == nil {
		return false
	}
	s := err.Error()
	return strings.Contains(s, "use of closed network connection") ||
		strings.Contains(s, "connection reset by peer")
}
