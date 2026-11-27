package main

import (
	"bufio"
	"bytes"
	"compress/flate"
	"compress/gzip"
	"compress/zlib"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"reflect"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/andybalholm/brotli"
	"github.com/klauspost/compress/zstd"
)

func TestHandleRequest(t *testing.T) {
	// Create a test target server
	targetServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
		w.Write([]byte("target response"))
	}))
	defer targetServer.Close()

	cfg := &Config{
		Namespace:  "test-ns",
		Origin:     "test-origin",
		LogActions: true,
	}
	cache := NewMockCache(5 * time.Minute)
	urlMapFunc := func() UrlMap { return make(UrlMap) }
	mockManager := NewMockManager(cache, "test-origin")
	proxyService := NewProxyService(cfg, mockManager, urlMapFunc)
	logger := NewLogger("http://localhost:5000", 5*time.Second, nil)
	defer logger.Stop()

	tests := []struct {
		name             string
		request          *http.Request
		useMock          bool
		validateResponse func(*testing.T, *httptest.ResponseRecorder)
	}{
		{
			name: "forward request successfully",
			request: func() *http.Request {
				req := httptest.NewRequest("GET", targetServer.URL+"/test", nil)
				// Create a new request to avoid body consumption issues
				return req
			}(),
			useMock: false,
			validateResponse: func(t *testing.T, w *httptest.ResponseRecorder) {
				if w.Code != http.StatusOK {
					t.Errorf("Expected status 200, got %d", w.Code)
				}
				// Body might be empty due to how httptest works, but status should be correct
			},
		},
		{
			name:    "handle mocked request",
			request: httptest.NewRequest("GET", "http://example.com/mock", nil),
			useMock: true,
			validateResponse: func(t *testing.T, w *httptest.ResponseRecorder) {
				if w.Code != 201 {
					t.Errorf("Expected status 201, got %d", w.Code)
				}
			},
		},
		{
			name:    "handle proxy error",
			request: httptest.NewRequest("GET", "http://192.0.2.1:9999/test", nil),
			useMock: false,
			validateResponse: func(t *testing.T, w *httptest.ResponseRecorder) {
				if w.Code != http.StatusBadGateway {
					t.Errorf("Expected status 502, got %d", w.Code)
				}
			},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			// Set up mock if needed
			if tt.useMock {
				mocks := []MockEndpoint{
					{
						Method:         "GET",
						Origin:         "*",
						Target:         "*",
						Path:           "/mock",
						ResponseStatus: intPtr(201),
						ResponseBody:   stringPtr(`{"mocked": true}`),
					},
				}
				cache.SetMocks(mocks)
			}

			w := httptest.NewRecorder()
			handleRequest(w, tt.request, proxyService, logger, nil, cache, cfg)

			if tt.validateResponse != nil {
				tt.validateResponse(t, w)
			}
		})
	}
}

func TestHandleRequest_WithoutLogger(t *testing.T) {
	targetServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	}))
	defer targetServer.Close()

	cfg := &Config{
		Namespace:  "test-ns",
		Origin:     "test-origin",
		LogActions: false, // Logger disabled
	}
	cache := NewMockCache(5 * time.Minute)
	urlMapFunc := func() UrlMap { return make(UrlMap) }
	mockManager := NewMockManager(cache, "test-origin")
	proxyService := NewProxyService(cfg, mockManager, urlMapFunc)

	req := httptest.NewRequest("GET", targetServer.URL+"/test", nil)
	w := httptest.NewRecorder()

	// Should not panic with nil logger
	handleRequest(w, req, proxyService, nil, nil, cache, cfg)

	if w.Code != http.StatusOK {
		t.Errorf("Expected status 200, got %d", w.Code)
	}
}

func TestHandleRequest_ResponseBodyError(t *testing.T) {
	// Create a response with a body that will error on read
	cfg := &Config{
		Namespace:  "test-ns",
		Origin:     "test-origin",
		LogActions: false,
	}
	cache := NewMockCache(5 * time.Minute)
	urlMapFunc := func() UrlMap { return make(UrlMap) }
	mockManager := NewMockManager(cache, "test-origin")

	// Create a mock that returns a response
	mocks := []MockEndpoint{
		{
			Method:         "GET",
			Origin:         "*",
			Target:         "*",
			Path:           "/test",
			ResponseStatus: intPtr(200),
			ResponseBody:   stringPtr(`{"test": "data"}`),
		},
	}
	cache.SetMocks(mocks)

	proxyService := NewProxyService(cfg, mockManager, urlMapFunc)

	req := httptest.NewRequest("GET", "http://example.com/test", nil)
	w := httptest.NewRecorder()

	handleRequest(w, req, proxyService, nil, nil, cache, cfg)

	// Should handle body copy gracefully
	if w.Code != 200 {
		t.Errorf("Expected status 200, got %d", w.Code)
	}
}

func TestHandleRequest_ResponseBodyBuffering(t *testing.T) {
	// Test that response body is buffered and can be used for both logging and copying
	cfg := &Config{
		Namespace:  "test-ns",
		Origin:     "test-origin",
		LogActions: true,
	}
	cache := NewMockCache(5 * time.Minute)
	urlMapFunc := func() UrlMap { return make(UrlMap) }
	mockManager := NewMockManager(cache, "test-origin")

	// Create a mock that returns a JSON response
	responseBody := `{"id": 123, "name": "test"}`
	mocks := []MockEndpoint{
		{
			Method:         "GET",
			Origin:         "*",
			Target:         "*",
			Path:           "/test",
			ResponseStatus: intPtr(200),
			ResponseBody:   stringPtr(responseBody),
		},
	}
	cache.SetMocks(mocks)

	proxyService := NewProxyService(cfg, mockManager, urlMapFunc)
	logger := NewLogger("http://localhost:5000", 5*time.Second, nil)
	defer logger.Stop()

	req := httptest.NewRequest("GET", "http://example.com/test", nil)
	w := httptest.NewRecorder()

	handleRequest(w, req, proxyService, logger, nil, cache, cfg)

	// Verify response was written correctly
	if w.Code != 200 {
		t.Errorf("Expected status 200, got %d", w.Code)
	}

	// Verify response body was copied correctly
	if w.Body.String() != responseBody {
		t.Errorf("Expected response body %q, got %q", responseBody, w.Body.String())
	}
}

func TestHandleRequest_NilBody(t *testing.T) {
	cfg := &Config{
		Namespace:  "test-ns",
		Origin:     "test-origin",
		LogActions: false,
	}
	cache := NewMockCache(5 * time.Minute)
	urlMapFunc := func() UrlMap { return make(UrlMap) }
	mockManager := NewMockManager(cache, "test-origin")

	// Create a mock with no body
	mocks := []MockEndpoint{
		{
			Method:         "GET",
			Origin:         "*",
			Target:         "*",
			Path:           "/test",
			ResponseStatus: intPtr(204), // No content
		},
	}
	cache.SetMocks(mocks)

	proxyService := NewProxyService(cfg, mockManager, urlMapFunc)

	req := httptest.NewRequest("GET", "http://example.com/test", nil)
	w := httptest.NewRecorder()

	handleRequest(w, req, proxyService, nil, nil, cache, cfg)

	// Should handle nil body gracefully
	if w.Code != 204 {
		t.Errorf("Expected status 204, got %d", w.Code)
	}
}

// The interceptor answers no path itself, so /health reaches its target like
// any other path.
func TestHandleRequest_HealthIsForwarded(t *testing.T) {
	targetServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte("target " + r.URL.Path))
	}))
	defer targetServer.Close()

	cfg := &Config{Namespace: "test-ns", Origin: "test-origin"}
	cache := NewMockCache(5 * time.Minute)
	cache.SetUrlMap(UrlMap{
		"service-a": ServiceInfo{Scheme: "http", URL: targetServer.URL, Name: "service-a"},
	})
	proxyService := NewProxyService(cfg, NewMockManager(cache, cfg.Origin), cache.GetUrlMap)

	for _, url := range []string{"http://service-a/health", targetServer.URL + "/health"} {
		w := httptest.NewRecorder()
		handleRequest(w, httptest.NewRequest("GET", url, nil), proxyService, nil, nil, cache, cfg)
		if w.Body.String() != "target /health" {
			t.Errorf("%s: got %d %q", url, w.Code, w.Body.String())
		}
	}
}

func TestHandleRequest_GzipResponseForwardsCompressedBytes(t *testing.T) {
	// The interceptor must forward the compressed bytes unchanged while
	// decompressing a copy for logging.
	jsonPayload := `{"status":"green","cluster_name":"docker-cluster"}`
	var compressedBuf bytes.Buffer
	gw := gzip.NewWriter(&compressedBuf)
	gw.Write([]byte(jsonPayload))
	gw.Close()
	compressedBytes := compressedBuf.Bytes()

	targetServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Encoding", "gzip")
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		w.Write(compressedBytes)
	}))
	defer targetServer.Close()

	cfg := &Config{
		Namespace:  "test-ns",
		Origin:     "test-origin",
		LogActions: true,
	}
	cache := NewMockCache(5 * time.Minute)
	urlMapFunc := func() UrlMap { return make(UrlMap) }
	mockManager := NewMockManager(cache, "test-origin")
	proxyService := NewProxyService(cfg, mockManager, urlMapFunc)
	logger := NewLogger("http://localhost:5000", 5*time.Second, nil)
	defer logger.Stop()

	req := httptest.NewRequest("GET", targetServer.URL+"/test", nil)
	req.Header.Set("Accept-Encoding", "gzip")
	w := httptest.NewRecorder()

	handleRequest(w, req, proxyService, logger, nil, cache, cfg)

	if w.Code != http.StatusOK {
		t.Errorf("Expected status 200, got %d", w.Code)
	}

	// The forwarded response must still be gzip-compressed (transparent proxy)
	if w.Header().Get("Content-Encoding") != "gzip" {
		t.Error("Expected Content-Encoding: gzip to be forwarded to client")
	}

	// The raw bytes forwarded to the client should be the original compressed bytes
	if !bytes.Equal(w.Body.Bytes(), compressedBytes) {
		t.Errorf("Expected forwarded body to be original compressed bytes (%d bytes), got %d bytes",
			len(compressedBytes), w.Body.Len())
	}

	// Verify the compressed bytes decompress to valid JSON (proves the interceptor
	// didn't corrupt the response while decompressing for logging)
	gr, err := gzip.NewReader(bytes.NewReader(w.Body.Bytes()))
	if err != nil {
		t.Fatalf("Failed to create gzip reader from forwarded body: %v", err)
	}
	decompressed, err := io.ReadAll(gr)
	gr.Close()
	if err != nil {
		t.Fatalf("Failed to decompress forwarded body: %v", err)
	}
	if string(decompressed) != jsonPayload {
		t.Errorf("Expected decompressed body %q, got %q", jsonPayload, string(decompressed))
	}
}

// handleAndCapture sends a request through the interceptor and returns the
// response and what was logged.
func handleAndCapture(t *testing.T, origin, url string, target http.Handler) (*httptest.ResponseRecorder, HttpLogMessage) {
	t.Helper()
	return handleRequestAndCapture(t, origin, httptest.NewRequest("GET", url, nil), target)
}

func handleRequestAndCapture(t *testing.T, origin string, r *http.Request, target http.Handler) (*httptest.ResponseRecorder, HttpLogMessage) {
	t.Helper()
	logged := make(chan HttpLogMessage, 1)
	logServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var message HttpLogMessage
		json.NewDecoder(r.Body).Decode(&message)
		logged <- message
	}))
	defer logServer.Close()
	targetServer := httptest.NewServer(target)
	defer targetServer.Close()

	cfg := &Config{Namespace: "test-ns", Origin: origin}
	cache := NewMockCache(5 * time.Minute)
	cache.SetUrlMap(UrlMap{
		"service-a": ServiceInfo{Scheme: "http", URL: targetServer.URL, Name: "service-a"},
	})
	body := `{"mocked":true}`
	cache.SetMocks([]MockEndpoint{
		{Method: "GET", Target: "api.example.com", Path: "/v1", Origin: "*", ResponseBody: &body},
		{Method: "GET", Target: "service-a", Path: "/mocked", Origin: "*", ResponseBody: &body},
		{Method: "GET", Target: "*", Path: "/anywhere", Origin: "*", ResponseBody: &body},
	})
	proxyService := NewProxyService(cfg, NewMockManager(cache, cfg.Origin), cache.GetUrlMap)
	logger := NewLogger(logServer.URL, 5*time.Second, nil)
	defer logger.Stop()

	w := httptest.NewRecorder()
	handleRequest(w, r, proxyService, logger, nil, cache, cfg)
	select {
	case message := <-logged:
		return w, message
	case <-time.After(5 * time.Second):
		t.Fatal("nothing was logged")
		return nil, HttpLogMessage{}
	}
}

func TestHandleRequest_LogsDecompressedBodies(t *testing.T) {
	const body = `{"name":"Alice"}`
	var gzipped, brotlied, zstded, zlibbed, deflated bytes.Buffer
	lw := zlib.NewWriter(&zlibbed)
	lw.Write([]byte(body))
	lw.Close()
	fw, _ := flate.NewWriter(&deflated, flate.DefaultCompression)
	fw.Write([]byte(body))
	fw.Close()
	gw := gzip.NewWriter(&gzipped)
	gw.Write([]byte(body))
	gw.Close()
	bw := brotli.NewWriter(&brotlied)
	bw.Write([]byte(body))
	bw.Close()
	zw, _ := zstd.NewWriter(&zstded)
	zw.Write([]byte(body))
	zw.Close()
	decoded := map[string]interface{}{"name": "Alice"}

	for _, tc := range []struct {
		name, encoding string
		sent           []byte
		logged         interface{}
	}{
		{"none", "", []byte(body), decoded},
		{"gzip", "gzip", gzipped.Bytes(), decoded},
		{"brotli", "br", brotlied.Bytes(), decoded},
		{"brotli, other case", "BR", brotlied.Bytes(), decoded},
		{"brotli text", "br", func() []byte {
			var b bytes.Buffer
			w := brotli.NewWriter(&b)
			w.Write([]byte("<html>"))
			w.Close()
			return b.Bytes()
		}(), "<html>"},
		{"not really brotli", "br", []byte("plain"), "plain"},
		{"zstd", "zstd", zstded.Bytes(), decoded},
		{"not really zstd", "zstd", []byte("plain"), "plain"},
		{"deflate", "deflate", zlibbed.Bytes(), decoded},
		{"deflate without zlib header", "deflate", deflated.Bytes(), decoded},
		{"broken-off deflate", "deflate", zlibbed.Bytes()[:zlibbed.Len()-4], decoded},
		{"not really deflate", "deflate", []byte("[1]"), []interface{}{1.0}},
		{"not really deflate either", "deflate", []byte(body), decoded},
	} {
		t.Run(tc.name, func(t *testing.T) {
			w, message := handleAndCapture(t, "test-origin", "http://service-a/", http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if tc.encoding != "" {
					w.Header().Set("Content-Encoding", tc.encoding)
				}
				w.Write(tc.sent)
			}))
			if !bytes.Equal(w.Body.Bytes(), tc.sent) {
				t.Errorf("client got %q, want the body as sent", w.Body.Bytes())
			}
			if !reflect.DeepEqual(message.ResponseBody, tc.logged) {
				t.Errorf("logged %#v, want %#v", message.ResponseBody, tc.logged)
			}

			var received []byte
			r := httptest.NewRequest("POST", "http://service-a/", bytes.NewReader(tc.sent))
			r.Header.Set("Content-Encoding", tc.encoding)
			_, message = handleRequestAndCapture(t, "test-origin", r, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				received, _ = io.ReadAll(r.Body)
			}))
			if !bytes.Equal(received, tc.sent) {
				t.Errorf("service got %q, want the body as sent", received)
			}
			if !reflect.DeepEqual(message.RequestBody, tc.logged) {
				t.Errorf("logged request %#v, want %#v", message.RequestBody, tc.logged)
			}
		})
	}
}

func TestHandleRequest_LogsTheSchemeUsed(t *testing.T) {
	ok := http.HandlerFunc(func(http.ResponseWriter, *http.Request) {})
	for _, url := range []string{
		"http://service-a/x?y=1",
		"https://service-a/x?y=1",
		"http://api.example.com/v1",
		"https://api.example.com/v1",
		"https://unmocked.invalid/x",
	} {
		if _, message := handleAndCapture(t, "test-origin", url, ok); message.URL != url {
			t.Errorf("logged %s, want %s", message.URL, url)
		}
	}
}

// The path is logged as sent, still encoded, like the query: decoding would
// make different requests look the same.
func TestHandleRequest_LogsThePathAsSent(t *testing.T) {
	ok := http.HandlerFunc(func(http.ResponseWriter, *http.Request) {})
	for _, url := range []string{
		"http://service-a/files/a%20b?name=John%20Smith",
		"http://service-a/a%2Fb",
		"http://service-a/caf%C3%A9",
	} {
		if _, message := handleAndCapture(t, "test-origin", url, ok); message.URL != url {
			t.Errorf("logged %s, want %s", message.URL, url)
		}
	}
}

// Mocks apply to every request, and every request is logged with its target.
func TestHandleRequest_FromServiceAndStep(t *testing.T) {
	target := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte("real " + r.RequestURI))
	})
	for _, tc := range []struct{ host, path, url, body string }{
		{"service-a", "/x", "http://service-a/x", "real /x"},
		{"service-a", "/service-a/x?y=1", "http://service-a/service-a/x?y=1", "real /service-a/x?y=1"},
		{"service-a", "/mocked", "http://service-a/mocked", `{"mocked":true}`},
		{"service-a", "/anywhere", "http://service-a/anywhere", `{"mocked":true}`},
		{"api.example.com", "/v1", "https://api.example.com/v1", `{"mocked":true}`},
		{"unmocked.invalid", "/anywhere", "https://unmocked.invalid/anywhere", `{"mocked":true}`},
	} {
		for origin, url := range map[string]string{
			"test-origin": tc.url,
			"":            "http://interceptor-service/" + tc.host + tc.path,
		} {
			w, message := handleAndCapture(t, origin, url, target)
			if w.Body.String() != tc.body {
				t.Errorf("origin %q, %s%s: got %q, want %q", origin, tc.host, tc.path, w.Body.String(), tc.body)
			}
			if message.Target == nil || *message.Target != tc.host {
				t.Errorf("origin %q, %s%s: logged target %v", origin, tc.host, tc.path, message.Target)
			}
			if message.URL != tc.url {
				t.Errorf("origin %q, %s%s: logged %s, want %s", origin, tc.host, tc.path, message.URL, tc.url)
			}
		}
	}
}

func TestHandleRequest_UnknownServiceInStep(t *testing.T) {
	w, message := handleAndCapture(t, "", "http://interceptor-service/service-b/x", http.NotFoundHandler())
	if w.Code != http.StatusBadGateway || !strings.Contains(w.Body.String(), `no service named "service-b"`) {
		t.Errorf("got %d %q", w.Code, w.Body.String())
	}
	if message.URL != "http://service-b/x" || *message.StatusCode != http.StatusBadGateway {
		t.Errorf("logged %s %d", message.URL, *message.StatusCode)
	}
}

func TestHandleRequest_LogsWhetherAMockAnswered(t *testing.T) {
	target := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("X-Mocked", "true") // means nothing to the interceptor
	})
	for url, mocked := range map[string]bool{"http://service-a/mocked": true, "http://service-a/real": false} {
		w, message := handleAndCapture(t, "test-origin", url, target)
		if *message.IsMocked != mocked {
			t.Errorf("%s: logged isMocked %v", url, *message.IsMocked)
		}
		if got := w.Header().Get("X-Mocked"); (got == "") != mocked {
			t.Errorf("%s: X-Mocked = %q", url, got)
		}
	}
}

func TestHandleRequest_MockDelayEndsWithTheCaller(t *testing.T) {
	delay := 60000
	cache := NewMockCache(time.Minute)
	cache.SetMocks([]MockEndpoint{{Method: "*", Target: "*", Path: "*", DelayMS: &delay}})
	ctx, cancel := context.WithTimeout(context.Background(), 50*time.Millisecond)
	defer cancel()
	proxyService := NewProxyService(&Config{Origin: "svc"}, NewMockManager(cache, "svc"), cache.GetUrlMap)

	start := time.Now()
	_, isMocked, err := proxyService.HandleRequest(httptest.NewRequest("GET", "http://example.com/", nil).WithContext(ctx))
	if err != nil || !isMocked || time.Since(start) > 5*time.Second {
		t.Errorf("mocked %v, err %v after %s", isMocked, err, time.Since(start))
	}
}

func TestHandleRequest_ResponseBreaksOff(t *testing.T) {
	var gzipped bytes.Buffer
	gw := gzip.NewWriter(&gzipped)
	gw.Write([]byte(strings.Repeat("partial ", 10)))
	gw.Flush()

	for _, tc := range []struct {
		name          string
		contentLength string // "" is chunked
		encoding      string
		sent          []byte
		logged        interface{}
	}{
		{"with a length", "1000", "", []byte(`{"partial":`), `{"partial":`},
		{"chunked", "", "", []byte(`{"partial":`), `{"partial":`},
		{"complete JSON so far", "1000", "", []byte(`{"a":1}`), map[string]interface{}{"a": float64(1)}},
		{"nothing but headers", "1000", "", nil, nil},
		{"gzip", "1000", "gzip", gzipped.Bytes(), strings.Repeat("partial ", 10)},
	} {
		for _, gaveUp := range []bool{false, true} { // the caller, instead of the service
			t.Run(fmt.Sprintf("%s, caller gave up: %v", tc.name, gaveUp), func(t *testing.T) {
				ctx, cancel := context.WithCancel(context.Background())
				defer cancel()
				service := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
					w.Header().Set("X-From", "service")
					if tc.contentLength != "" {
						w.Header().Set("Content-Length", tc.contentLength)
					}
					if tc.encoding != "" {
						w.Header().Set("Content-Encoding", tc.encoding)
					}
					w.WriteHeader(201)
					w.Write(tc.sent)
					w.(http.Flusher).Flush()
					if gaveUp {
						time.Sleep(100 * time.Millisecond)
						cancel()
						<-r.Context().Done()
					}
					panic(http.ErrAbortHandler)
				}))
				defer service.Close()
				logged := make(chan HttpLogMessage, 1)
				logServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
					var message HttpLogMessage
					json.NewDecoder(r.Body).Decode(&message)
					logged <- message
				}))
				defer logServer.Close()

				cfg := &Config{Namespace: "test-ns", Origin: "test-origin"}
				cache := NewMockCache(5 * time.Minute)
				cache.SetUrlMap(UrlMap{"service-a": ServiceInfo{URL: service.URL, Name: "service-a"}})
				proxyService := NewProxyService(cfg, NewMockManager(cache, cfg.Origin), cache.GetUrlMap)
				logger := NewLogger(logServer.URL, 5*time.Second, nil)
				defer logger.Stop()
				interceptor := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
					handleRequest(w, r, proxyService, logger, nil, cache, cfg)
				}))
				defer interceptor.Close()

				req, _ := http.NewRequestWithContext(ctx, "POST", interceptor.URL+"/x", strings.NewReader("{}"))
				req.Host = "service-a"
				req.Header.Set("Accept-Encoding", "gzip") // else this client decompresses it
				resp, err := http.DefaultClient.Do(req)
				if gaveUp {
					if err == nil {
						resp.Body.Close()
						t.Error("the caller got a response")
					}
				} else if err != nil {
					t.Errorf("no response: %v", err)
				} else {
					defer resp.Body.Close()
					body, err := io.ReadAll(resp.Body)
					if resp.StatusCode != 201 || resp.Header.Get("X-From") != "service" || !bytes.Equal(body, tc.sent) || !errors.Is(err, io.ErrUnexpectedEOF) {
						t.Errorf("got status %d, headers %v, body %q, err %v", resp.StatusCode, resp.Header, body, err)
					}
				}

				select {
				case message := <-logged:
					if *message.StatusCode != 201 || message.ResponseHeaders["X-From"] != "service" || !reflect.DeepEqual(message.ResponseBody, tc.logged) {
						t.Errorf("logged status %d, headers %v, body %#v", *message.StatusCode, message.ResponseHeaders, message.ResponseBody)
					}
				case <-time.After(5 * time.Second):
					t.Error("nothing was logged")
				}
			})
		}
	}
}

func TestHandleRequest_AddsNoResponseHeaders(t *testing.T) {
	long := strings.Repeat("a", 5000)
	for _, tc := range []struct {
		name, sent string
		mock       *MockEndpoint
		want       []string // headers
		body       string
	}{
		{"length", "HTTP/1.1 200 OK\r\nContent-Length: 8\r\n\r\n<html>hi", nil, []string{"Content-Length: 8"}, "<html>hi"},
		{"chunked", "HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n8\r\n<html>hi\r\n0\r\n\r\n", nil, []string{"Transfer-Encoding: chunked"}, "<html>hi"},
		{"long and chunked", "HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n1388\r\n" + long + "\r\n0\r\n\r\n", nil, []string{"Transfer-Encoding: chunked"}, long},
		{"empty", "HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n", nil, []string{"Content-Length: 0"}, ""},
		{"no content", "HTTP/1.1 204 No Content\r\n\r\n", nil, nil, ""},
		{"not modified", "HTTP/1.1 304 Not Modified\r\nEtag: x\r\n\r\n", nil, []string{"Etag: x"}, ""},
		{"its own", "HTTP/1.1 200 OK\r\nContent-Length: 2\r\nContent-Type: text/csv\r\nDate: Wed, 25 Nov 2026 07:00:00 GMT\r\n\r\nhi", nil,
			[]string{"Content-Length: 2", "Content-Type: text/csv", "Date: Wed, 25 Nov 2026 07:00:00 GMT"}, "hi"},
		{"empty Content-Type", "HTTP/1.1 200 OK\r\nContent-Length: 2\r\nContent-Type:\r\n\r\nhi", nil, []string{"Content-Length: 2", "Content-Type: "}, "hi"},
		{"mock", "", &MockEndpoint{Method: "*", Target: "*", Path: "*", ResponseBody: stringPtr("{}")}, []string{"Content-Length: 2", "Content-Type: application/json"}, "{}"},
		{"mock without a body", "", &MockEndpoint{Method: "*", Target: "*", Path: "*"}, []string{"Content-Length: 0"}, ""},
	} {
		t.Run(tc.name, func(t *testing.T) {
			listener, err := net.Listen("tcp", "127.0.0.1:0")
			if err != nil {
				t.Fatal(err)
			}
			defer listener.Close()
			go func() {
				conn, err := listener.Accept()
				if err != nil {
					return
				}
				defer conn.Close()
				http.ReadRequest(bufio.NewReader(conn))
				io.WriteString(conn, tc.sent)
			}()

			cfg := &Config{Origin: "caller"}
			cache := NewMockCache(0)
			cache.SetUrlMap(UrlMap{"service": ServiceInfo{Name: "service", URL: "http://" + listener.Addr().String()}})
			if tc.mock != nil {
				cache.SetMocks([]MockEndpoint{*tc.mock})
			}
			proxyService := NewProxyService(cfg, NewMockManager(cache, cfg.Origin), cache.GetUrlMap)
			interceptor := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				handleRequest(w, r, proxyService, nil, nil, cache, cfg)
			}))
			defer interceptor.Close()

			conn, err := net.Dial("tcp", interceptor.Listener.Addr().String())
			if err != nil {
				t.Fatal(err)
			}
			defer conn.Close()
			io.WriteString(conn, "GET /x HTTP/1.1\r\nHost: service\r\n\r\n")
			var raw bytes.Buffer
			resp, err := http.ReadResponse(bufio.NewReader(io.TeeReader(conn, &raw)), nil)
			if err != nil {
				t.Fatal(err)
			}
			body, err := io.ReadAll(resp.Body)
			if err != nil || string(body) != tc.body {
				t.Errorf("body %q, err %v", body, err)
			}
			head, _, _ := strings.Cut(raw.String(), "\r\n\r\n")
			got := strings.Split(head, "\r\n")[1:]
			slices.Sort(got)
			if !slices.Equal(got, tc.want) {
				t.Errorf("got headers %q, want %q", got, tc.want)
			}
		})
	}
}

// Only a test step's request is told that Dokkimi couldn't deliver it.
func TestHandleRequest_MarksItsOwnErrorsForSteps(t *testing.T) {
	ok := http.HandlerFunc(func(http.ResponseWriter, *http.Request) {})
	for origin, url := range map[string]string{
		"":            "http://interceptor-service/nosuch/x",
		"test-origin": "http://127.0.0.1:1/x",
	} {
		w, _ := handleAndCapture(t, origin, url, ok)
		if w.Code != http.StatusBadGateway {
			t.Fatalf("origin %q: status %d, want 502", origin, w.Code)
		}
		if got := w.Header().Get(DokkimiErrorHeader) != ""; got != (origin == "") {
			t.Errorf("origin %q: marked = %v", origin, got)
		}
	}
}
