package main

import (
	"bufio"
	"io"
	"net"
	"testing"
	"time"

	shared "github.com/dokkimi/dokkimi/services/db-proxy/shared"
)

// startRelay connects a fake client and a fake server through a proxyConnection.
func startRelay(t *testing.T) (client, server net.Conn) {
	t.Helper()
	clientSide, proxyClient := net.Pipe()
	proxyUpstream, serverSide := net.Pipe()
	pc := newProxyConnection(proxyClient, proxyUpstream, &shared.Config{}, nil)
	go pc.relay()
	t.Cleanup(func() { clientSide.Close(); serverSide.Close() })
	return clientSide, serverSide
}

func expectRead(t *testing.T, c net.Conn, want string) {
	t.Helper()
	c.SetReadDeadline(time.Now().Add(2 * time.Second))
	buf := make([]byte, len(want))
	if _, err := io.ReadFull(c, buf); err != nil {
		t.Fatalf("waiting for %q: %v", want, err)
	}
	if string(buf) != want {
		t.Fatalf("got %q, want %q", buf, want)
	}
}

func send(t *testing.T, c net.Conn, s string) {
	t.Helper()
	go func() { c.Write([]byte(s)) }()
}

// RESP2 pub/sub: after the confirmation, published messages arrive with no
// command waiting for them and must still reach the client.
func TestRelay_ForwardsPubSubMessages(t *testing.T) {
	client, server := startRelay(t)
	serverIn := bufio.NewReader(server)

	send(t, client, "*2\r\n$9\r\nSUBSCRIBE\r\n$2\r\nch\r\n")
	if _, err := readRESP(serverIn); err != nil {
		t.Fatal(err)
	}
	confirm := "*3\r\n$9\r\nsubscribe\r\n$2\r\nch\r\n:1\r\n"
	message := "*3\r\n$7\r\nmessage\r\n$2\r\nch\r\n$5\r\nhello\r\n"
	send(t, server, confirm+message+message)
	expectRead(t, client, confirm+message+message)
}

// MONITOR: after +OK the server streams lines with no command waiting.
func TestRelay_ForwardsMonitorStream(t *testing.T) {
	client, server := startRelay(t)
	serverIn := bufio.NewReader(server)

	send(t, client, "*1\r\n$7\r\nMONITOR\r\n")
	if _, err := readRESP(serverIn); err != nil {
		t.Fatal(err)
	}
	stream := "+OK\r\n+1700000000.0 [0 1.2.3.4:5] \"set\" \"k\" \"v\"\r\n"
	send(t, server, stream)
	expectRead(t, client, stream)
}

// A reply with no command waiting (here, a second confirmation the client
// didn't expect) is still forwarded, and the next command's reply too.
func TestRelay_ForwardsUnpairedReplies(t *testing.T) {
	client, server := startRelay(t)
	serverIn := bufio.NewReader(server)

	send(t, client, "*1\r\n$4\r\nPING\r\n")
	if _, err := readRESP(serverIn); err != nil {
		t.Fatal(err)
	}
	send(t, server, "+PONG\r\n+EXTRA\r\n")
	expectRead(t, client, "+PONG\r\n+EXTRA\r\n")
}
