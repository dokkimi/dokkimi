package main

import (
	"bufio"
	"context"
	"fmt"
	"net"
	"strings"
	"sync"
	"testing"
	"time"

	shared "github.com/dokkimi/dokkimi/services/db-proxy/shared"
)

const testPassword = "test-secret-123"

// mockRedisServer is a minimal Redis server that enforces AUTH.
// Each connection tracks its own auth state independently.
type mockRedisServer struct {
	ln       net.Listener
	password string
	wg       sync.WaitGroup
}

func newMockRedisServer(t *testing.T, password string) *mockRedisServer {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("mock redis listen: %v", err)
	}
	s := &mockRedisServer{ln: ln, password: password}
	s.wg.Add(1)
	go func() {
		defer s.wg.Done()
		for {
			conn, err := ln.Accept()
			if err != nil {
				return
			}
			s.wg.Add(1)
			go func() {
				defer s.wg.Done()
				s.handleConn(conn)
			}()
		}
	}()
	return s
}

func (s *mockRedisServer) addr() string { return s.ln.Addr().String() }

func (s *mockRedisServer) close() {
	s.ln.Close()
	s.wg.Wait()
}

func (s *mockRedisServer) handleConn(conn net.Conn) {
	defer conn.Close()
	reader := bufio.NewReaderSize(conn, 4096)
	authed := false

	for {
		val, err := readRESP(reader)
		if err != nil {
			return
		}

		cmd := strings.ToUpper(extractCommandName(val))
		switch cmd {
		case "AUTH":
			pw := extractAuthPassword(val)
			if pw == s.password {
				authed = true
				conn.Write([]byte("+OK\r\n"))
			} else {
				conn.Write([]byte("-ERR invalid password\r\n"))
			}

		case "HELLO":
			if s.handleHello(val, conn, &authed) {
				continue
			}

		case "PING":
			if !authed {
				conn.Write([]byte("-NOAUTH Authentication required.\r\n"))
			} else {
				conn.Write([]byte("+PONG\r\n"))
			}

		case "LPUSH":
			if !authed {
				conn.Write([]byte("-NOAUTH Authentication required.\r\n"))
			} else {
				conn.Write([]byte(":1\r\n"))
			}

		case "GET":
			if !authed {
				conn.Write([]byte("-NOAUTH Authentication required.\r\n"))
			} else {
				conn.Write([]byte("$5\r\nhello\r\n"))
			}

		case "QUIT":
			conn.Write([]byte("+OK\r\n"))
			return

		case "CLIENT":
			conn.Write([]byte("+OK\r\n"))

		default:
			if !authed {
				conn.Write([]byte("-NOAUTH Authentication required.\r\n"))
			} else {
				conn.Write([]byte("+OK\r\n"))
			}
		}
	}
}

// handleHello handles HELLO 3 [AUTH username password] negotiation.
// Returns true if processing should continue (always does).
func (s *mockRedisServer) handleHello(val *respValue, conn net.Conn, authed *bool) bool {
	args := extractArgs(val)
	for i, arg := range args {
		if strings.ToUpper(arg) == "AUTH" && i+2 < len(args) {
			pw := args[i+2]
			if pw == s.password {
				*authed = true
			} else {
				conn.Write([]byte("-ERR invalid password\r\n"))
				return true
			}
			break
		}
	}
	// Respond with a minimal RESP3 map
	conn.Write([]byte("%2\r\n$6\r\nserver\r\n$5\r\nredis\r\n$7\r\nversion\r\n$5\r\n7.0.0\r\n"))
	return true
}

func extractAuthPassword(val *respValue) string {
	args := extractArgs(val)
	if len(args) >= 2 {
		return args[1]
	}
	return ""
}

func extractArgs(val *respValue) []string {
	if val.typ == respArray && len(val.array) > 0 {
		parts := make([]string, len(val.array))
		for i, elem := range val.array {
			parts[i] = elem.str
		}
		return parts
	}
	if val.typ == respSimpleString {
		return strings.Fields(val.str)
	}
	return nil
}

// startProxy creates and starts a proxy pointing at the given upstream address.
// Returns the proxy and its listen address.
func startProxy(t *testing.T, upstreamAddr string) (*Proxy, string) {
	_, upstreamPort, _ := net.SplitHostPort(upstreamAddr)

	cfg := &shared.Config{
		DatabasePort:     upstreamPort,
		DatabaseType:     "Redis",
		InstanceItemName: "test-redis",
		InstanceID:       "test-instance",
		ControlTowerURL:  "http://localhost:19001",
		QueryPort:        "0", // let OS pick a free port
	}

	proxy := NewProxy(cfg, nil)
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("proxy listen: %v", err)
	}
	proxy.Listener = ln
	proxy.ListenAddr = ln.Addr().String()
	proxy.UpstreamAddr = fmt.Sprintf("127.0.0.1:%s", upstreamPort)

	go proxy.Serve()

	return proxy, ln.Addr().String()
}

func respArray2(args ...string) []byte {
	var b strings.Builder
	fmt.Fprintf(&b, "*%d\r\n", len(args))
	for _, arg := range args {
		fmt.Fprintf(&b, "$%d\r\n%s\r\n", len(arg), arg)
	}
	return []byte(b.String())
}

func readResponse(t *testing.T, reader *bufio.Reader) *respValue {
	t.Helper()
	val, err := readRESP(reader)
	if err != nil {
		t.Fatalf("read response: %v", err)
	}
	return val
}

func dial(t *testing.T, addr string) (net.Conn, *bufio.Reader) {
	t.Helper()
	conn, err := net.DialTimeout("tcp", addr, 2*time.Second)
	if err != nil {
		t.Fatalf("dial proxy: %v", err)
	}
	return conn, bufio.NewReader(conn)
}

// --- Tests ---

func TestAuthHappyPath(t *testing.T) {
	srv := newMockRedisServer(t, testPassword)
	defer srv.close()

	proxy, proxyAddr := startProxy(t, srv.addr())
	defer proxy.Shutdown(context.Background())

	conn, reader := dial(t, proxyAddr)
	defer conn.Close()

	conn.Write(respArray2("AUTH", testPassword))
	resp := readResponse(t, reader)
	if resp.typ != respSimpleString || resp.str != "OK" {
		t.Fatalf("AUTH: expected +OK, got type=%c str=%q", resp.typ, resp.str)
	}

	conn.Write(respArray2("PING"))
	resp = readResponse(t, reader)
	if resp.typ != respSimpleString || resp.str != "PONG" {
		t.Fatalf("PING: expected +PONG, got type=%c str=%q", resp.typ, resp.str)
	}
}

func TestAuthWrongPassword(t *testing.T) {
	srv := newMockRedisServer(t, testPassword)
	defer srv.close()

	proxy, proxyAddr := startProxy(t, srv.addr())
	defer proxy.Shutdown(context.Background())

	conn, reader := dial(t, proxyAddr)
	defer conn.Close()

	conn.Write(respArray2("AUTH", "wrong-password"))
	resp := readResponse(t, reader)
	if resp.typ != respError {
		t.Fatalf("expected error response, got type=%c", resp.typ)
	}
	if !strings.Contains(resp.str, "invalid password") {
		t.Fatalf("expected 'invalid password' error, got %q", resp.str)
	}
}

func TestNoAuthReturnsNoauth(t *testing.T) {
	srv := newMockRedisServer(t, testPassword)
	defer srv.close()

	proxy, proxyAddr := startProxy(t, srv.addr())
	defer proxy.Shutdown(context.Background())

	conn, reader := dial(t, proxyAddr)
	defer conn.Close()

	conn.Write(respArray2("PING"))
	resp := readResponse(t, reader)
	if resp.typ != respError {
		t.Fatalf("expected error response, got type=%c", resp.typ)
	}
	if !strings.Contains(resp.str, "NOAUTH") {
		t.Fatalf("expected NOAUTH error, got %q", resp.str)
	}
}

func TestAuthErrorPropagationUnchanged(t *testing.T) {
	srv := newMockRedisServer(t, testPassword)
	defer srv.close()

	proxy, proxyAddr := startProxy(t, srv.addr())
	defer proxy.Shutdown(context.Background())

	conn, reader := dial(t, proxyAddr)
	defer conn.Close()

	conn.Write(respArray2("AUTH", "bad"))
	resp := readResponse(t, reader)
	expected := "ERR invalid password"
	if resp.str != expected {
		t.Fatalf("error not propagated byte-for-byte: expected %q, got %q", expected, resp.str)
	}

	conn.Write(respArray2("PING"))
	resp = readResponse(t, reader)
	expected = "NOAUTH Authentication required."
	if resp.str != expected {
		t.Fatalf("NOAUTH not propagated byte-for-byte: expected %q, got %q", expected, resp.str)
	}
}

func TestConcurrentConnections(t *testing.T) {
	srv := newMockRedisServer(t, testPassword)
	defer srv.close()

	proxy, proxyAddr := startProxy(t, srv.addr())
	defer proxy.Shutdown(context.Background())

	var wg sync.WaitGroup
	errors := make(chan error, 10)

	for i := 0; i < 10; i++ {
		wg.Add(1)
		go func(id int) {
			defer wg.Done()

			conn, err := net.DialTimeout("tcp", proxyAddr, 2*time.Second)
			if err != nil {
				errors <- fmt.Errorf("goroutine %d: dial: %v", id, err)
				return
			}
			defer conn.Close()
			reader := bufio.NewReader(conn)

			conn.Write(respArray2("AUTH", testPassword))
			resp, err := readRESP(reader)
			if err != nil {
				errors <- fmt.Errorf("goroutine %d: read AUTH resp: %v", id, err)
				return
			}
			if resp.typ != respSimpleString || resp.str != "OK" {
				errors <- fmt.Errorf("goroutine %d: AUTH expected +OK, got %c %q", id, resp.typ, resp.str)
				return
			}

			conn.Write(respArray2("LPUSH", "myqueue", fmt.Sprintf("job-%d", id)))
			resp, err = readRESP(reader)
			if err != nil {
				errors <- fmt.Errorf("goroutine %d: read LPUSH resp: %v", id, err)
				return
			}
			if resp.typ != respInteger || resp.integer != 1 {
				errors <- fmt.Errorf("goroutine %d: LPUSH expected :1, got %c %d", id, resp.typ, resp.integer)
				return
			}
		}(i)
	}

	wg.Wait()
	close(errors)

	for err := range errors {
		t.Error(err)
	}
}

func TestHello3WithAuth(t *testing.T) {
	srv := newMockRedisServer(t, testPassword)
	defer srv.close()

	proxy, proxyAddr := startProxy(t, srv.addr())
	defer proxy.Shutdown(context.Background())

	conn, reader := dial(t, proxyAddr)
	defer conn.Close()

	conn.Write(respArray2("HELLO", "3", "AUTH", "default", testPassword))
	resp := readResponse(t, reader)
	if resp.typ != respMap {
		t.Fatalf("HELLO 3: expected map response, got type=%c", resp.typ)
	}

	conn.Write(respArray2("PING"))
	resp = readResponse(t, reader)
	if resp.typ != respSimpleString || resp.str != "PONG" {
		t.Fatalf("PING after HELLO 3: expected +PONG, got type=%c str=%q", resp.typ, resp.str)
	}
}

func TestInlineAuth(t *testing.T) {
	srv := newMockRedisServer(t, testPassword)
	defer srv.close()

	proxy, proxyAddr := startProxy(t, srv.addr())
	defer proxy.Shutdown(context.Background())

	conn, reader := dial(t, proxyAddr)
	defer conn.Close()

	conn.Write([]byte(fmt.Sprintf("AUTH %s\r\n", testPassword)))
	resp := readResponse(t, reader)
	if resp.typ != respSimpleString || resp.str != "OK" {
		t.Fatalf("inline AUTH: expected +OK, got type=%c str=%q", resp.typ, resp.str)
	}

	conn.Write([]byte("PING\r\n"))
	resp = readResponse(t, reader)
	if resp.typ != respSimpleString || resp.str != "PONG" {
		t.Fatalf("inline PING: expected +PONG, got type=%c str=%q", resp.typ, resp.str)
	}
}
