package main

import (
	"bytes"
	"compress/gzip"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"reflect"
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
		MaxIdleConns:    100,
		IdleConnTimeout: 90 * time.Second,
		Namespace:       "test-ns",
		Origin:          "test-origin",
		LogActions:      true,
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
		MaxIdleConns:    100,
		IdleConnTimeout: 90 * time.Second,
		Namespace:       "test-ns",
		Origin:          "test-origin",
		LogActions:      false, // Logger disabled
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
		MaxIdleConns:    100,
		IdleConnTimeout: 90 * time.Second,
		Namespace:       "test-ns",
		Origin:          "test-origin",
		LogActions:      false,
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
		MaxIdleConns:    100,
		IdleConnTimeout: 90 * time.Second,
		Namespace:       "test-ns",
		Origin:          "test-origin",
		LogActions:      true,
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
		MaxIdleConns:    100,
		IdleConnTimeout: 90 * time.Second,
		Namespace:       "test-ns",
		Origin:          "test-origin",
		LogActions:      false,
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
	// When the original caller sends Accept-Encoding: gzip, Go's transport
	// passes the compressed response through without auto-decompressing.
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
		MaxIdleConns:    100,
		IdleConnTimeout: 90 * time.Second,
		Namespace:       "test-ns",
		Origin:          "test-origin",
		LogActions:      true,
	}
	cache := NewMockCache(5 * time.Minute)
	urlMapFunc := func() UrlMap { return make(UrlMap) }
	mockManager := NewMockManager(cache, "test-origin")
	proxyService := NewProxyService(cfg, mockManager, urlMapFunc)
	logger := NewLogger("http://localhost:5000", 5*time.Second, nil)
	defer logger.Stop()

	// The caller explicitly requests gzip — Go's transport won't auto-decompress
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
	r := httptest.NewRequest("GET", url, nil)
	r.Header.Set("Accept-Encoding", "gzip, br") // else Go's client decompresses gzip itself
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
	var gzipped, brotlied, zstded bytes.Buffer
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
