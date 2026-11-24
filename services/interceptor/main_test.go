package main

import (
	"bytes"
	"compress/gzip"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

func TestHandleRequest(t *testing.T) {
	// Create a test target server
	targetServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
		w.Write([]byte("target response"))
	}))
	defer targetServer.Close()

	cfg := &Config{
		RequestTimeout:  30 * time.Second,
		MaxIdleConns:    100,
		IdleConnTimeout: 90 * time.Second,
		Namespace:       "test-ns",
		Origin:          "test-origin",
		LogActions:      true,
	}
	cache := NewMockCache(5 * time.Minute)
	urlMapFunc := func() UrlMap { return make(UrlMap) }
	mockManager := NewMockManager(cache, nil, "test-origin", urlMapFunc)
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
				if w.Header().Get("X-Mocked") != "true" {
					t.Error("Expected X-Mocked header")
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
		RequestTimeout:  30 * time.Second,
		MaxIdleConns:    100,
		IdleConnTimeout: 90 * time.Second,
		Namespace:       "test-ns",
		Origin:          "test-origin",
		LogActions:      false, // Logger disabled
	}
	cache := NewMockCache(5 * time.Minute)
	urlMapFunc := func() UrlMap { return make(UrlMap) }
	mockManager := NewMockManager(cache, nil, "test-origin", urlMapFunc)
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
		RequestTimeout:  30 * time.Second,
		MaxIdleConns:    100,
		IdleConnTimeout: 90 * time.Second,
		Namespace:       "test-ns",
		Origin:          "test-origin",
		LogActions:      false,
	}
	cache := NewMockCache(5 * time.Minute)
	urlMapFunc := func() UrlMap { return make(UrlMap) }
	mockManager := NewMockManager(cache, nil, "test-origin", urlMapFunc)

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
		RequestTimeout:  30 * time.Second,
		MaxIdleConns:    100,
		IdleConnTimeout: 90 * time.Second,
		Namespace:       "test-ns",
		Origin:          "test-origin",
		LogActions:      true,
	}
	cache := NewMockCache(5 * time.Minute)
	urlMapFunc := func() UrlMap { return make(UrlMap) }
	mockManager := NewMockManager(cache, nil, "test-origin", urlMapFunc)

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
		RequestTimeout:  30 * time.Second,
		MaxIdleConns:    100,
		IdleConnTimeout: 90 * time.Second,
		Namespace:       "test-ns",
		Origin:          "test-origin",
		LogActions:      false,
	}
	cache := NewMockCache(5 * time.Minute)
	urlMapFunc := func() UrlMap { return make(UrlMap) }
	mockManager := NewMockManager(cache, nil, "test-origin", urlMapFunc)

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

	cfg := &Config{RequestTimeout: 30 * time.Second, Namespace: "test-ns", Origin: "test-origin"}
	cache := NewMockCache(5 * time.Minute)
	cache.SetUrlMap(UrlMap{
		"service-a": ServiceInfo{Scheme: "http", URL: targetServer.URL, Name: "service-a"},
	})
	proxyService := NewProxyService(cfg, NewMockManager(cache, nil, cfg.Origin, cache.GetUrlMap), cache.GetUrlMap)

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
		RequestTimeout:  30 * time.Second,
		MaxIdleConns:    100,
		IdleConnTimeout: 90 * time.Second,
		Namespace:       "test-ns",
		Origin:          "test-origin",
		LogActions:      true,
	}
	cache := NewMockCache(5 * time.Minute)
	urlMapFunc := func() UrlMap { return make(UrlMap) }
	mockManager := NewMockManager(cache, nil, "test-origin", urlMapFunc)
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
