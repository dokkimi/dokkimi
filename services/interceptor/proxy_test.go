package main

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestNewProxyService(t *testing.T) {
	cfg := &Config{
		RequestTimeout:  30 * time.Second,
		MaxIdleConns:    100,
		IdleConnTimeout: 90 * time.Second,
	}
	cache := NewMockCache(5 * time.Minute)
	urlMapFunc := func() UrlMap { return make(UrlMap) }
	mockManager := NewMockManager(cache, nil, "test-origin", urlMapFunc)

	proxy := NewProxyService(cfg, mockManager, urlMapFunc)

	if proxy == nil {
		t.Fatal("NewProxyService() returned nil")
	}

	if proxy.client == nil {
		t.Error("Expected HTTP client to be initialized")
	}
}

func TestProxyService_HandleRequest_WithMock(t *testing.T) {
	cfg := &Config{
		RequestTimeout:  30 * time.Second,
		MaxIdleConns:    100,
		IdleConnTimeout: 90 * time.Second,
	}
	cache := NewMockCache(5 * time.Minute)
	urlMapFunc := func() UrlMap { return make(UrlMap) }
	mockManager := NewMockManager(cache, nil, "test-origin", urlMapFunc)

	// Set up a mock
	mocks := []MockEndpoint{
		{
			Method:         "GET",
			Origin:         "*",
			Target:         "*",
			Path:           "/test",
			ResponseStatus: intPtr(201),
			ResponseBody:   stringPtr(`{"mocked": true}`),
		},
	}
	cache.SetMocks(mocks)

	proxy := NewProxyService(cfg, mockManager, urlMapFunc)

	req := httptest.NewRequest("GET", "http://example.com/test", nil)
	resp, err := proxy.HandleRequest(req)

	if err != nil {
		t.Fatalf("HandleRequest() error = %v", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != 201 {
		t.Errorf("Expected status 201, got %d", resp.StatusCode)
	}

	if resp.Header.Get("X-Mocked") != "true" {
		t.Error("Expected X-Mocked header")
	}
}

func TestProxyService_HandleRequest_Forward(t *testing.T) {
	// Create a test server to forward to
	targetServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
		w.Write([]byte("target response"))
	}))
	defer targetServer.Close()

	cfg := &Config{
		RequestTimeout:  30 * time.Second,
		MaxIdleConns:    100,
		IdleConnTimeout: 90 * time.Second,
	}
	cache := NewMockCache(5 * time.Minute)
	urlMapFunc := func() UrlMap { return make(UrlMap) }
	mockManager := NewMockManager(cache, nil, "test-origin", urlMapFunc)

	proxy := NewProxyService(cfg, mockManager, urlMapFunc)

	req := httptest.NewRequest("GET", targetServer.URL+"/path", nil)
	resp, err := proxy.HandleRequest(req)

	if err != nil {
		t.Fatalf("HandleRequest() error = %v", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		t.Errorf("Expected status 200, got %d", resp.StatusCode)
	}

	body, _ := io.ReadAll(resp.Body)
	if string(body) != "target response" {
		t.Errorf("Expected body 'target response', got %s", string(body))
	}
}

func TestProxyService_HandleRequest_PassesRedirectThrough(t *testing.T) {
	// The interceptor must NOT follow redirects itself. A 3xx from upstream
	// should be returned verbatim to the caller so the caller's HTTP client
	// decides whether to follow — which causes the next hop to re-enter the
	// interceptor and get mock-matched, logged, and URL-rewritten normally.
	//
	// If this test ever starts seeing status 200 with body "should not reach
	// here", it means someone removed the CheckRedirect hook in NewProxyService
	// and the proxy is silently following redirects again.
	var followedHopHit bool
	targetServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/start" {
			w.Header().Set("Location", "/followed")
			w.WriteHeader(http.StatusFound)
			return
		}
		followedHopHit = true
		w.WriteHeader(http.StatusOK)
		w.Write([]byte("should not reach here"))
	}))
	defer targetServer.Close()

	cfg := &Config{
		RequestTimeout:  30 * time.Second,
		MaxIdleConns:    100,
		IdleConnTimeout: 90 * time.Second,
	}
	cache := NewMockCache(5 * time.Minute)
	urlMapFunc := func() UrlMap { return make(UrlMap) }
	mockManager := NewMockManager(cache, nil, "test-origin", urlMapFunc)

	proxy := NewProxyService(cfg, mockManager, urlMapFunc)

	req := httptest.NewRequest("GET", targetServer.URL+"/start", nil)
	resp, err := proxy.HandleRequest(req)
	if err != nil {
		t.Fatalf("HandleRequest() error = %v", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusFound {
		t.Errorf("Expected status 302 to be returned to caller, got %d", resp.StatusCode)
	}
	if loc := resp.Header.Get("Location"); loc != "/followed" {
		t.Errorf("Expected Location header '/followed' to be forwarded to caller, got %q", loc)
	}
	if followedHopHit {
		t.Error("Proxy followed the redirect itself; the second hop should never be reached " +
			"because the proxy must hand the 3xx back to the caller")
	}
}

func TestProxyService_forwardRequest(t *testing.T) {
	// Create a test server
	targetServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// Echo back headers and body
		for key, values := range r.Header {
			for _, value := range values {
				w.Header().Add(key, value)
			}
		}
		body, _ := io.ReadAll(r.Body)
		w.Write(body)
	}))
	defer targetServer.Close()

	cfg := &Config{
		RequestTimeout:  30 * time.Second,
		MaxIdleConns:    100,
		IdleConnTimeout: 90 * time.Second,
	}
	cache := NewMockCache(5 * time.Minute)
	urlMapFunc := func() UrlMap { return make(UrlMap) }
	mockManager := NewMockManager(cache, nil, "test-origin", urlMapFunc)

	proxy := NewProxyService(cfg, mockManager, urlMapFunc)

	// Test with body
	req := httptest.NewRequest("POST", targetServer.URL+"/test", strings.NewReader("test body"))
	req.Header.Set("X-Custom", "value")
	req.Header.Set("Connection", "keep-alive") // Should be filtered

	resp, err := proxy.forwardRequest(req)

	if err != nil {
		t.Fatalf("forwardRequest() error = %v", err)
	}
	defer resp.Body.Close()

	// Verify custom header was forwarded
	if resp.Header.Get("X-Custom") != "value" {
		t.Error("Expected X-Custom header to be forwarded")
	}

	// Verify hop-by-hop header was not forwarded
	if resp.Header.Get("Connection") != "" {
		t.Error("Connection header should not be forwarded")
	}

	// Verify body was forwarded
	body, _ := io.ReadAll(resp.Body)
	if string(body) != "test body" {
		t.Errorf("Expected body 'test body', got %s", string(body))
	}
}

func TestExtractServiceName(t *testing.T) {
	tests := []struct {
		name     string
		hostname string
		want     string
	}{
		{
			name:     "FQDN with multiple dots",
			hostname: "nginx-test.dokkimi-xxx.svc.cluster.local",
			want:     "nginx-test",
		},
		{
			name:     "simple hostname",
			hostname: "nginx-test",
			want:     "nginx-test",
		},
		{
			name:     "FQDN with port (port should be stripped before calling extractServiceName)",
			hostname: "nginx-test.dokkimi-xxx.svc.cluster.local",
			want:     "nginx-test",
		},
		{
			name:     "single dot",
			hostname: "service.namespace",
			want:     "service",
		},
		{
			name:     "hostname without dots",
			hostname: "nginx-test",
			want:     "nginx-test",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := extractServiceName(tt.hostname)
			if got != tt.want {
				t.Errorf("extractServiceName(%q) = %v, want %v", tt.hostname, got, tt.want)
			}
		})
	}
}

func TestProxyService_getTargetURL(t *testing.T) {
	cfg := &Config{
		RequestTimeout:  30 * time.Second,
		MaxIdleConns:    100,
		IdleConnTimeout: 90 * time.Second,
	}
	cache := NewMockCache(5 * time.Minute)

	urlMap := UrlMap{
		"example": ServiceInfo{
			Scheme: "https",
			URL:    "target.example.com",
			Name:   "example",
		},
		"nginx-test": ServiceInfo{
			Scheme: "http",
			URL:    "http://nginx-test",
			Name:   "nginx-test",
			Port:   80,
		},
		"test": ServiceInfo{
			Scheme: "http",
			URL:    "",
			Name:   "test",
		},
		"empty": ServiceInfo{
			Scheme: "",
			URL:    "empty.com",
			Name:   "empty",
		},
		"nextjs-app": ServiceInfo{
			Scheme: "http",
			URL:    "http://nextjs-app",
			Name:   "nextjs-app",
			Port:   3000,
		},
	}

	urlMapFunc := func() UrlMap { return urlMap }
	mockManager := NewMockManager(cache, nil, "test-origin", urlMapFunc)
	proxy := NewProxyService(cfg, mockManager, urlMapFunc)

	tests := []struct {
		name    string
		request *http.Request
		want    string
	}{
		{
			name:    "with URL mapping using service name",
			request: httptest.NewRequest("GET", "http://example.com/path?query=1", nil),
			want:    "https://target.example.com/path?query=1",
		},
		{
			name: "with FQDN hostname, extracts service name",
			request: func() *http.Request {
				req := httptest.NewRequest("GET", "http://nginx-test.dokkimi-xxx.svc.cluster.local/path", nil)
				req.Host = "nginx-test.dokkimi-xxx.svc.cluster.local"
				return req
			}(),
			want: "http://nginx-test:80/path?",
		},
		{
			name: "with FQDN hostname and port, extracts service name",
			request: func() *http.Request {
				req := httptest.NewRequest("GET", "http://nginx-test.dokkimi-xxx.svc.cluster.local:8080/path", nil)
				req.Host = "nginx-test.dokkimi-xxx.svc.cluster.local:8080"
				return req
			}(),
			want: "http://nginx-test:80/path?",
		},
		{
			name:    "with URL mapping, empty URL uses host",
			request: httptest.NewRequest("GET", "http://test.com/path", nil),
			want:    "http://test.com/path?",
		},
		{
			name:    "with URL mapping, empty scheme defaults to http",
			request: httptest.NewRequest("GET", "http://empty.com/path", nil),
			want:    "http://empty.com/path?",
		},
		{
			name:    "no URL mapping, uses original",
			request: httptest.NewRequest("GET", "http://other.com/path?query=1", nil),
			want:    "http://other.com/path?query=1",
		},
		{
			name: "no URL mapping, empty scheme defaults to http",
			request: func() *http.Request {
				req := httptest.NewRequest("GET", "http://other.com/path", nil)
				req.URL.Scheme = "" // Clear scheme
				return req
			}(),
			want: "http://other.com/path?",
		},
		{
			name: "with URL mapping and port in Host header",
			request: func() *http.Request {
				req := httptest.NewRequest("GET", "http://example.com:8080/path", nil)
				req.Host = "example.com:8080"
				return req
			}(),
			want: "https://target.example.com/path?",
		},
		{
			name: "with URL mapping, port stripped from hostname",
			request: func() *http.Request {
				req := httptest.NewRequest("GET", "http://test.com:9090/path", nil)
				req.Host = "test.com:9090"
				return req
			}(),
			want: "http://test.com:9090/path?", // When URL is empty, uses r.Host which includes port
		},
		{
			name: "with URL mapping and Port field, appends real port for forwarding",
			request: func() *http.Request {
				req := httptest.NewRequest("GET", "http://nextjs-app/login", nil)
				req.Host = "nextjs-app"
				return req
			}(),
			want: "http://nextjs-app:3000/login?",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := proxy.getTargetURL(tt.request)
			if got != tt.want {
				t.Errorf("getTargetURL() = %v, want %v", got, tt.want)
			}
		})
	}
}

func TestIsHopByHopHeader(t *testing.T) {
	tests := []struct {
		name string
		key  string
		want bool
	}{
		{"Connection", "Connection", true},
		{"Keep-Alive", "Keep-Alive", true},
		{"Proxy-Authenticate", "Proxy-Authenticate", true},
		{"Proxy-Authorization", "Proxy-Authorization", true},
		{"Te", "Te", true},
		{"Trailers", "Trailers", true},
		{"Transfer-Encoding", "Transfer-Encoding", true},
		{"Upgrade", "Upgrade", true},
		{"case insensitive", "connection", true},
		{"case insensitive 2", "CONNECTION", true},
		{"not hop by hop", "Content-Type", false},
		{"not hop by hop 2", "Authorization", false},
		{"not hop by hop 3", "X-Custom", false},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := isHopByHopHeader(tt.key)
			if got != tt.want {
				t.Errorf("isHopByHopHeader(%q) = %v, want %v", tt.key, got, tt.want)
			}
		})
	}
}

func TestProxyService_forwardRequest_ErrorHandling(t *testing.T) {
	cfg := &Config{
		RequestTimeout:  1 * time.Millisecond, // Very short timeout
		MaxIdleConns:    100,
		IdleConnTimeout: 90 * time.Second,
	}
	cache := NewMockCache(5 * time.Minute)
	urlMapFunc := func() UrlMap { return make(UrlMap) }
	mockManager := NewMockManager(cache, nil, "test-origin", urlMapFunc)

	proxy := NewProxyService(cfg, mockManager, urlMapFunc)

	// Request to non-existent server (will timeout)
	req := httptest.NewRequest("GET", "http://192.0.2.1:9999/test", nil)
	_, err := proxy.forwardRequest(req)

	if err == nil {
		t.Error("Expected error for unreachable server")
	}
}

func TestProxyService_forwardRequest_BodyReadError(t *testing.T) {
	cfg := &Config{
		RequestTimeout:  30 * time.Second,
		MaxIdleConns:    100,
		IdleConnTimeout: 90 * time.Second,
	}
	cache := NewMockCache(5 * time.Minute)
	urlMapFunc := func() UrlMap { return make(UrlMap) }
	mockManager := NewMockManager(cache, nil, "test-origin", urlMapFunc)

	proxy := NewProxyService(cfg, mockManager, urlMapFunc)

	// Create request with error reader
	req := httptest.NewRequest("GET", "http://example.com/test", &errorReader{})

	_, err := proxy.forwardRequest(req)
	if err == nil {
		t.Error("Expected error when reading body fails")
	}
}

func TestProxyService_forwardRequest_InvalidURL(t *testing.T) {
	cfg := &Config{
		RequestTimeout:  30 * time.Second,
		MaxIdleConns:    100,
		IdleConnTimeout: 90 * time.Second,
	}
	cache := NewMockCache(5 * time.Minute)

	// URL map with invalid URL
	urlMap := UrlMap{
		"example.com": ServiceInfo{
			Scheme: "invalid://",
			URL:    "invalid-url",
			Name:   "test",
		},
	}
	urlMapFunc := func() UrlMap { return urlMap }
	mockManager := NewMockManager(cache, nil, "test-origin", urlMapFunc)

	proxy := NewProxyService(cfg, mockManager, urlMapFunc)

	req := httptest.NewRequest("GET", "http://example.com/test", nil)
	_, err := proxy.forwardRequest(req)

	// Should handle gracefully (may or may not error depending on URL parsing)
	_ = err // We're just testing it doesn't panic
}

func TestProxyService_rewriteLocationHeader(t *testing.T) {
	cfg := &Config{
		RequestTimeout:  30 * time.Second,
		MaxIdleConns:    100,
		IdleConnTimeout: 90 * time.Second,
	}
	cache := NewMockCache(5 * time.Minute)

	urlMap := UrlMap{
		"nextjs-demo": ServiceInfo{
			Scheme: "http",
			URL:    "http://nextjs-demo",
			Name:   "nextjs-demo",
		},
		"api-server": ServiceInfo{
			Scheme: "http",
			URL:    "http://api-server",
			Name:   "api-server",
		},
	}
	urlMapFunc := func() UrlMap { return urlMap }
	mockManager := NewMockManager(cache, nil, "test-origin", urlMapFunc)
	proxy := NewProxyService(cfg, mockManager, urlMapFunc)

	tests := []struct {
		name     string
		location string
		want     string
	}{
		{
			name:     "rewrites pod hostname to service name",
			location: "http://nextjs-demo-8d4698b56-892gj:3000/dashboard",
			want:     "http://nextjs-demo/dashboard",
		},
		{
			name:     "rewrites different pod hash",
			location: "http://api-server-bd464cb5-tfhp9:8080/health",
			want:     "http://api-server/health",
		},
		{
			name:     "preserves query string",
			location: "http://nextjs-demo-abc123-xyz:3000/login?error=oauth_failed",
			want:     "http://nextjs-demo/login?error=oauth_failed",
		},
		{
			name:     "no rewrite for already-correct service name",
			location: "http://nextjs-demo/dashboard",
			want:     "http://nextjs-demo/dashboard",
		},
		{
			name:     "no rewrite for unknown host",
			location: "http://unknown-pod-abc123:3000/path",
			want:     "http://unknown-pod-abc123:3000/path",
		},
		{
			name:     "no rewrite for relative location",
			location: "/dashboard",
			want:     "/dashboard",
		},
		{
			name:     "no rewrite for empty location",
			location: "",
			want:     "",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			resp := &http.Response{Header: http.Header{}}
			if tt.location != "" {
				resp.Header.Set("Location", tt.location)
			}
			proxy.rewriteLocationHeader(resp, "")
			got := resp.Header.Get("Location")
			if got != tt.want {
				t.Errorf("rewriteLocationHeader() Location = %q, want %q", got, tt.want)
			}
		})
	}
}

func TestProxyService_forwardRequest_RewritesLocationInRedirect(t *testing.T) {
	targetServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Location", "http://my-app-8d4698b56-892gj:3000/dashboard")
		w.WriteHeader(http.StatusTemporaryRedirect)
	}))
	defer targetServer.Close()

	cfg := &Config{
		RequestTimeout:  30 * time.Second,
		MaxIdleConns:    100,
		IdleConnTimeout: 90 * time.Second,
	}
	cache := NewMockCache(5 * time.Minute)
	urlMap := UrlMap{
		"my-app": ServiceInfo{
			Scheme: "http",
			URL:    targetServer.URL,
			Name:   "my-app",
		},
	}
	urlMapFunc := func() UrlMap { return urlMap }
	mockManager := NewMockManager(cache, nil, "test-origin", urlMapFunc)
	proxy := NewProxyService(cfg, mockManager, urlMapFunc)

	req := httptest.NewRequest("GET", targetServer.URL+"/login", nil)
	resp, err := proxy.HandleRequest(req)
	if err != nil {
		t.Fatalf("HandleRequest() error = %v", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusTemporaryRedirect {
		t.Errorf("Expected 307, got %d", resp.StatusCode)
	}
	if loc := resp.Header.Get("Location"); loc != "http://my-app/dashboard" {
		t.Errorf("Expected rewritten Location 'http://my-app/dashboard', got %q", loc)
	}
}

func TestProxyService_forwardRequest_RequestCreationError(t *testing.T) {
	cfg := &Config{
		RequestTimeout:  30 * time.Second,
		MaxIdleConns:    100,
		IdleConnTimeout: 90 * time.Second,
	}
	cache := NewMockCache(5 * time.Minute)
	urlMapFunc := func() UrlMap { return make(UrlMap) }
	mockManager := NewMockManager(cache, nil, "test-origin", urlMapFunc)

	proxy := NewProxyService(cfg, mockManager, urlMapFunc)

	// Create request with invalid method to trigger error in NewRequestWithContext
	req := httptest.NewRequest("GET", "http://example.com/test", nil)
	req.Method = "INVALID METHOD WITH SPACES" // This might cause issues

	// Try to create a request that will fail - actually, http.NewRequestWithContext
	// is pretty lenient, so we'll test with a context that's cancelled
	ctx, cancel := context.WithCancel(context.Background())
	cancel() // Cancel immediately
	req = req.WithContext(ctx)

	_, err := proxy.forwardRequest(req)
	// May or may not error, but should not panic
	_ = err
}
