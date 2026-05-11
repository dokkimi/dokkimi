package main

import (
	"fmt"
	"log"
	"net"
	"time"

	shared "github.com/dokkimi/dokkimi/services/db-proxy/shared"
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
	log.Printf("PostgreSQL proxy listening on %s, forwarding to %s", p.ListenAddr, p.UpstreamAddr)
	return nil
}

func (p *Proxy) handleConnection(clientConn net.Conn) {
	p.TrackConn(clientConn)
	defer func() {
		clientConn.Close()
		p.UntrackConn(clientConn)
	}()

	for {
		_, raw, err := readStartupMessage(clientConn)
		if err != nil {
			log.Printf("failed to read startup message: %v", err)
			return
		}

		if isSSLRequest(raw) {
			if _, err := clientConn.Write([]byte{'N'}); err != nil {
				log.Printf("failed to deny SSL: %v", err)
				return
			}
			continue
		}

		if isCancelRequest(raw) {
			upConn, err := net.DialTimeout("tcp", p.UpstreamAddr, 5*time.Second)
			if err != nil {
				log.Printf("failed to connect upstream for cancel: %v", err)
				return
			}
			upConn.Write(raw)
			upConn.Close()
			return
		}

		params := parseStartupParams(raw)
		log.Printf("new connection: user=%s database=%s", params["user"], params["database"])

		upstreamConn, err := net.DialTimeout("tcp", p.UpstreamAddr, 10*time.Second)
		if err != nil {
			log.Printf("failed to connect to upstream %s: %v", p.UpstreamAddr, err)
			sendErrorToClient(clientConn, "failed to connect to database server")
			return
		}
		p.TrackConn(upstreamConn)
		defer func() {
			upstreamConn.Close()
			p.UntrackConn(upstreamConn)
		}()

		if _, err := upstreamConn.Write(raw); err != nil {
			log.Printf("failed to forward startup to upstream: %v", err)
			return
		}

		if err := p.relayAuth(clientConn, upstreamConn); err != nil {
			log.Printf("auth handshake failed: %v", err)
			return
		}

		pc := newProxyConnection(clientConn, upstreamConn, p.Config, p.Logger)
		pc.relay()
		return
	}
}

func (p *Proxy) relayAuth(client, upstream net.Conn) error {
	for {
		msgType, frame, err := readMessage(upstream)
		if err != nil {
			return fmt.Errorf("read from upstream during auth: %w", err)
		}

		if _, err := client.Write(frame); err != nil {
			return fmt.Errorf("write to client during auth: %w", err)
		}

		switch msgType {
		case msgReadyForQuery:
			return nil

		case msgErrorResponse:
			errMsg := extractErrorMessage(frame)
			return fmt.Errorf("upstream auth error: %s", errMsg)

		case msgAuthRequest:
			if len(frame) < 9 {
				continue
			}
			authType := uint32(frame[5])<<24 | uint32(frame[6])<<16 | uint32(frame[7])<<8 | uint32(frame[8])

			switch authType {
			case 0:
				// AuthenticationOk
			case 12:
				// AuthenticationSASLFinal — no client response
			default:
				_, clientFrame, err := readMessage(client)
				if err != nil {
					return fmt.Errorf("read client auth response: %w", err)
				}
				if _, err := upstream.Write(clientFrame); err != nil {
					return fmt.Errorf("write client auth to upstream: %w", err)
				}
			}
		}
	}
}

func sendErrorToClient(conn net.Conn, msg string) {
	severity := "SFATAL\x00"
	message := "M" + msg + "\x00"
	body := severity + message + "\x00"
	bodyLen := len(body) + 4

	frame := make([]byte, 1+4+len(body))
	frame[0] = msgErrorResponse
	frame[1] = byte(bodyLen >> 24)
	frame[2] = byte(bodyLen >> 16)
	frame[3] = byte(bodyLen >> 8)
	frame[4] = byte(bodyLen)
	copy(frame[5:], body)

	conn.Write(frame)
}
