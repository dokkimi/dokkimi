package main

import (
	"fmt"
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
	log.Printf("MySQL proxy listening on %s, forwarding to %s", p.ListenAddr, p.UpstreamAddr)
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

	if err := p.relayHandshake(clientConn, upstreamConn); err != nil {
		log.Printf("handshake relay failed: %v", err)
		return
	}

	pc := newProxyConnection(clientConn, upstreamConn, p.Config, p.Logger)
	pc.relay()
}

// stripDeprecateEOFFromGreeting removes CLIENT_DEPRECATE_EOF (bit 24) from
// the server's advertised capabilities so the driver never enables it locally.
func stripDeprecateEOFFromGreeting(pkt *mysqlPacket) {
	if len(pkt.payload) < 2 || pkt.payload[0] != 0x0a {
		return
	}
	// Find NUL terminator of the server version string (starts at byte 1)
	nulPos := -1
	for i := 1; i < len(pkt.payload); i++ {
		if pkt.payload[i] == 0x00 {
			nulPos = i
			break
		}
	}
	if nulPos < 0 {
		return
	}
	// After NUL: conn_id(4) + auth_data_1(8) + filler(1) + cap_lower(2) +
	// charset(1) + status(2) + cap_upper(2)
	// cap_upper starts at nulPos + 1 + 4 + 8 + 1 + 2 + 1 + 2 = nulPos + 19
	upperCapOff := nulPos + 19
	if upperCapOff+2 > len(pkt.payload) {
		return
	}
	// CLIENT_DEPRECATE_EOF = bit 24 = bit 8 of upper caps = bit 0 of second byte
	pkt.payload[upperCapOff+1] &= 0xFE
}

func (p *Proxy) relayHandshake(client, upstream net.Conn) error {
	serverGreeting, err := readPacket(upstream)
	if err != nil {
		return fmt.Errorf("read server greeting: %w", err)
	}
	if serverGreeting.isERR() {
		client.Write(serverGreeting.rawBytes())
		return fmt.Errorf("server sent error during greeting")
	}
	stripDeprecateEOFFromGreeting(serverGreeting)
	if _, err := client.Write(serverGreeting.rawBytes()); err != nil {
		return fmt.Errorf("forward greeting to client: %w", err)
	}

	clientResponse, err := readPacket(client)
	if err != nil {
		return fmt.Errorf("read client handshake response: %w", err)
	}
	// Strip CLIENT_DEPRECATE_EOF (bit 24 = 0x01000000) so the server uses
	// traditional EOF markers that our result set state machine expects.
	if len(clientResponse.payload) >= 4 {
		clientResponse.payload[3] &= 0xFE
	}
	if _, err := upstream.Write(clientResponse.rawBytes()); err != nil {
		return fmt.Errorf("forward handshake response to upstream: %w", err)
	}

	// Relay auth packets until OK or ERR.
	// MySQL 8+ caching_sha2_password multi-phase exchange:
	//   - AuthMoreData (0x01) with status 0x03 = fast auth success → OK follows
	//   - AuthMoreData (0x01) with status 0x04 = full auth required → client responds
	//   - AuthSwitchRequest (0xFE) → client responds with new auth data
	for {
		serverReply, err := readPacket(upstream)
		if err != nil {
			return fmt.Errorf("read server auth reply: %w", err)
		}

		if _, err := client.Write(serverReply.rawBytes()); err != nil {
			return fmt.Errorf("forward auth reply to client: %w", err)
		}

		if serverReply.isOK() {
			return nil
		}
		if serverReply.isERR() {
			errMsg := extractErrorMessage(serverReply.payload)
			return fmt.Errorf("upstream auth error: %s", errMsg)
		}

		// Fast-auth-success: server will send OK next without client response
		if len(serverReply.payload) >= 2 && serverReply.payload[0] == 0x01 && serverReply.payload[1] == 0x03 {
			continue
		}

		// AuthSwitchRequest or AuthMoreData requiring client action
		clientAuth, err := readPacket(client)
		if err != nil {
			return fmt.Errorf("read client auth continuation: %w", err)
		}
		if _, err := upstream.Write(clientAuth.rawBytes()); err != nil {
			return fmt.Errorf("forward client auth to upstream: %w", err)
		}
	}
}
