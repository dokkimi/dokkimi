package main

import (
	"context"
	"crypto/x509"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"sync"
	"testing"
	"time"
)

func TestNewProxyService(t *testing.T) {
	cfg := &Config{}
	cache := NewMockCache(5 * time.Minute)
	urlMapFunc := func() UrlMap { return make(UrlMap) }
	mockManager := NewMockManager(cache, "test-origin")

	proxy := NewProxyService(cfg, mockManager, urlMapFunc)

	if proxy == nil {
		t.Fatal("NewProxyService() returned nil")
	}

	if proxy.client.Timeout != 0 {
		t.Errorf("Expected no limit on how long a response may take, got %s", proxy.client.Timeout)
	}

	if proxy.client == nil {
		t.Error("Expected HTTP client to be initialized")
	}
}

func TestProxyService_HandleRequest_WithMock(t *testing.T) {
	cfg := &Config{}
	cache := NewMockCache(5 * time.Minute)
	urlMapFunc := func() UrlMap { return make(UrlMap) }
	mockManager := NewMockManager(cache, "test-origin")

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
	resp, isMocked, err := proxy.HandleRequest(req)

	if err != nil {
		t.Fatalf("HandleRequest() error = %v", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != 201 {
		t.Errorf("Expected status 201, got %d", resp.StatusCode)
	}

	if !isMocked {
		t.Error("Expected a mocked response")
	}
}

func TestProxyService_HandleRequest_Forward(t *testing.T) {
	// Create a test server to forward to
	targetServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
		w.Write([]byte("target response"))
	}))
	defer targetServer.Close()

	cfg := &Config{}
	cache := NewMockCache(5 * time.Minute)
	urlMapFunc := func() UrlMap { return make(UrlMap) }
	mockManager := NewMockManager(cache, "test-origin")

	proxy := NewProxyService(cfg, mockManager, urlMapFunc)

	req := httptest.NewRequest("GET", targetServer.URL+"/path", nil)
	resp, _, err := proxy.HandleRequest(req)

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

	cfg := &Config{}
	cache := NewMockCache(5 * time.Minute)
	urlMapFunc := func() UrlMap { return make(UrlMap) }
	mockManager := NewMockManager(cache, "test-origin")

	proxy := NewProxyService(cfg, mockManager, urlMapFunc)

	req := httptest.NewRequest("GET", targetServer.URL+"/start", nil)
	resp, _, err := proxy.HandleRequest(req)
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

	cfg := &Config{}
	cache := NewMockCache(5 * time.Minute)
	urlMapFunc := func() UrlMap { return make(UrlMap) }
	mockManager := NewMockManager(cache, "test-origin")

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

func TestProxyService_getTargetURL(t *testing.T) {
	cfg := &Config{Origin: "test-origin"} // a sidecar: these are a service's own calls
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
	mockManager := NewMockManager(cache, "test-origin")
	proxy := NewProxyService(cfg, mockManager, urlMapFunc)

	tests := []struct {
		name    string
		request *http.Request
		want    string
	}{
		{
			name:    "with URL mapping using service name",
			request: httptest.NewRequest("GET", "http://example/path?query=1", nil),
			want:    "https://target.example.com/path?query=1",
		},
		{
			name:    "with URL mapping, empty URL uses host",
			request: httptest.NewRequest("GET", "http://test/path", nil),
			want:    "http://test/path",
		},
		{
			name:    "with URL mapping, empty scheme defaults to http",
			request: httptest.NewRequest("GET", "http://empty/path", nil),
			want:    "http://empty.com/path",
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
			want: "http://other.com/path",
		},
		{
			name: "with URL mapping and port in Host header",
			request: func() *http.Request {
				req := httptest.NewRequest("GET", "http://example:8080/path", nil)
				req.Host = "example:8080"
				return req
			}(),
			want: "https://target.example.com/path",
		},
		{
			name: "with URL mapping, port stripped from hostname",
			request: func() *http.Request {
				req := httptest.NewRequest("GET", "http://test:9090/path", nil)
				req.Host = "test:9090"
				return req
			}(),
			want: "http://test:9090/path", // When URL is empty, uses r.Host which includes port
		},
		{
			name: "with URL mapping and Port field, appends real port for forwarding",
			request: func() *http.Request {
				req := httptest.NewRequest("GET", "http://nextjs-app/login", nil)
				req.Host = "nextjs-app"
				return req
			}(),
			want: "http://nextjs-app:3000/login",
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

// The global interceptor, which gets a test step's requests with the target as
// the first path segment.
func TestProxyService_getTargetURL_FromStep(t *testing.T) {
	urlMap := func() UrlMap {
		return UrlMap{"api": ServiceInfo{Scheme: "http", URL: "http://api", Name: "api", Port: 4000}}
	}
	proxy := NewProxyService(&Config{}, NewMockManager(NewMockCache(time.Minute), ""), urlMap)

	for request, want := range map[string]string{
		"/api":                           "http://api:4000/",
		"/api/":                          "http://api:4000/",
		"/api/orders":                    "http://api:4000/orders",
		"/api/orders?":                   "http://api:4000/orders?",
		"/api/orders?x=1":                "http://api:4000/orders?x=1",
		"/api/a%2Fb/100%25?q=a%20b":      "http://api:4000/a%2Fb/100%25?q=a%20b",
		"/api.stripe.com/v1/a%2Fb":       "https://api.stripe.com/v1/a%2Fb",
		"/api.stripe.com/v1/charges?x=1": "https://api.stripe.com/v1/charges?x=1",
		"/api/api/users":                 "http://api:4000/api/users",
		"/API/users":                     "http://api:4000/users",
		"/example.com/x":                 "https://example.com/x",
		"/api.stripe.com":                "https://api.stripe.com/",
	} {
		r := httptest.NewRequest("GET", "http://interceptor-service"+request, nil)
		takeTargetFromPath(r, urlMap())
		if got := proxy.getTargetURL(r); got != want {
			t.Errorf("%s: got %s, want %s", request, got, want)
		}
	}
}

// A step's URL can ask for a scheme; without one, a service gets its own and
// an external host gets HTTPS. The header is never forwarded.
func TestProxyService_getTargetURL_StepScheme(t *testing.T) {
	urlMap := func() UrlMap {
		return UrlMap{"api": ServiceInfo{Scheme: "http", URL: "http://api", Name: "api", Port: 4000}}
	}
	proxy := NewProxyService(&Config{}, NewMockManager(NewMockCache(time.Minute), ""), urlMap)

	for _, tc := range []struct{ path, scheme, want string }{
		{"/api/orders", "", "http://api:4000/orders"},
		{"/api/orders", "https", "https://api:4000/orders"},
		{"/api/orders", "http", "http://api:4000/orders"},
		{"/api.example.com/v1", "", "https://api.example.com/v1"},
		{"/api.example.com/v1", "http", "http://api.example.com/v1"},
		{"/api.example.com/v1", "ftp", "https://api.example.com/v1"},
	} {
		r := httptest.NewRequest("GET", "http://interceptor-service"+tc.path, nil)
		if tc.scheme != "" {
			r.Header.Set(DokkimiSchemeHeader, tc.scheme)
		}
		takeTargetFromPath(r, urlMap())
		if got := proxy.getTargetURL(r); got != tc.want {
			t.Errorf("%s with scheme %q: got %s, want %s", tc.path, tc.scheme, got, tc.want)
		}
		if r.Header.Get(DokkimiSchemeHeader) != "" {
			t.Errorf("%s: the scheme header would be forwarded", tc.path)
		}
	}
}

// A service's own interceptor, with services whose names also appear in
// external hosts and paths.
func TestProxyService_getTargetURL_FromService(t *testing.T) {
	urlMap := func() UrlMap {
		return UrlMap{
			"web": ServiceInfo{Scheme: "http", URL: "http://web", Name: "web", Port: 3000},
			"api": ServiceInfo{Scheme: "http", URL: "http://api", Name: "api", Port: 4000},
		}
	}
	cfg := &Config{Origin: "web"}
	proxy := NewProxyService(cfg, NewMockManager(NewMockCache(time.Minute), cfg.Origin), urlMap)

	for request, want := range map[string]string{
		"http://example.com/":                  "http://example.com/",
		"https://example.com/":                 "https://example.com/",
		"http://example.com:8080/x?y=1":        "http://example.com:8080/x?y=1",
		"https://example.com/a%2Fb?q=a%20b":    "https://example.com/a%2Fb?q=a%20b",
		"https://api.stripe.com/v1/charges":    "https://api.stripe.com/v1/charges",
		"https://example.com/api/9":            "https://example.com/api/9",
		"https://example.com/pkg-1.2.3.tgz":    "https://example.com/pkg-1.2.3.tgz",
		"http://api/api/users":                 "http://api:4000/api/users",
		"http://api/web/x":                     "http://api:4000/web/x",
		"http://api/namespace-1/interceptor/x": "http://api:4000/namespace-1/interceptor/x",
		"http://api/orders":                    "http://api:4000/orders",
		"http://api/a%2Fb/100%25?q=a%20b":      "http://api:4000/a%2Fb/100%25?q=a%20b",
		"http://web/self":                      "http://web:3000/self",
	} {
		if got := proxy.getTargetURL(httptest.NewRequest("GET", request, nil)); got != want {
			t.Errorf("%s: got %s, want %s", request, got, want)
		}
	}
}

func TestProxyService_forwardRequest_KeepsExternalRedirects(t *testing.T) {
	location := "https://api-docs.example.com/"
	external := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, location, http.StatusFound)
	}))
	defer external.Close()

	urlMap := func() UrlMap {
		return UrlMap{"api": ServiceInfo{Scheme: "http", URL: "http://api", Name: "api"}}
	}
	cfg := &Config{Origin: "web"}
	proxy := NewProxyService(cfg, NewMockManager(NewMockCache(time.Minute), cfg.Origin), urlMap)

	resp, err := proxy.forwardRequest(httptest.NewRequest("GET", external.URL+"/", nil))
	if err != nil {
		t.Fatal(err)
	}
	if got := resp.Header.Get("Location"); got != location {
		t.Errorf("Location = %s, want %s", got, location)
	}
}

// A host's certificate is checked as the service itself would have done.
func TestProxyService_forwardRequest_ChecksExternalCertificates(t *testing.T) {
	external := httptest.NewTLSServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {}))
	defer external.Close()
	urlMap := func() UrlMap { return UrlMap{} }
	cfg := &Config{Origin: "web"}
	proxy := NewProxyService(cfg, NewMockManager(NewMockCache(time.Minute), cfg.Origin), urlMap)

	_, err := proxy.forwardRequest(httptest.NewRequest("GET", external.URL+"/", nil))
	var unknownAuthority x509.UnknownAuthorityError
	if !errors.As(err, &unknownAuthority) {
		t.Errorf("got %v, want an unknown authority error", err)
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
	cfg := &Config{}
	cache := NewMockCache(5 * time.Minute)
	urlMapFunc := func() UrlMap { return make(UrlMap) }
	mockManager := NewMockManager(cache, "test-origin")

	proxy := NewProxyService(cfg, mockManager, urlMapFunc)

	// Request to non-existent server, from a caller that gives up
	ctx, cancel := context.WithTimeout(context.Background(), time.Millisecond)
	defer cancel()
	req := httptest.NewRequest("GET", "http://192.0.2.1:9999/test", nil).WithContext(ctx)
	_, err := proxy.forwardRequest(req)

	if err == nil {
		t.Error("Expected error for unreachable server")
	}
}

func TestProxyService_forwardRequest_BodyReadError(t *testing.T) {
	cfg := &Config{}
	cache := NewMockCache(5 * time.Minute)
	urlMapFunc := func() UrlMap { return make(UrlMap) }
	mockManager := NewMockManager(cache, "test-origin")

	proxy := NewProxyService(cfg, mockManager, urlMapFunc)

	// Create request with error reader
	req := httptest.NewRequest("GET", "http://example.com/test", &errorReader{})

	_, err := proxy.forwardRequest(req)
	if err == nil {
		t.Error("Expected error when reading body fails")
	}
}

func TestProxyService_forwardRequest_InvalidURL(t *testing.T) {
	cfg := &Config{}
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
	mockManager := NewMockManager(cache, "test-origin")

	proxy := NewProxyService(cfg, mockManager, urlMapFunc)

	req := httptest.NewRequest("GET", "http://example.com/test", nil)
	_, err := proxy.forwardRequest(req)

	// Should handle gracefully (may or may not error depending on URL parsing)
	_ = err // We're just testing it doesn't panic
}

func TestProxyService_rewriteLocationHeader(t *testing.T) {
	cfg := &Config{}
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
	mockManager := NewMockManager(cache, "test-origin")
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

	cfg := &Config{}
	cache := NewMockCache(5 * time.Minute)
	urlMap := UrlMap{
		"my-app": ServiceInfo{
			Scheme: "http",
			URL:    targetServer.URL,
			Name:   "my-app",
		},
	}
	urlMapFunc := func() UrlMap { return urlMap }
	mockManager := NewMockManager(cache, "test-origin")
	proxy := NewProxyService(cfg, mockManager, urlMapFunc)

	req := httptest.NewRequest("GET", "http://my-app/login", nil)
	resp, _, err := proxy.HandleRequest(req)
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
	cfg := &Config{}
	cache := NewMockCache(5 * time.Minute)
	urlMapFunc := func() UrlMap { return make(UrlMap) }
	mockManager := NewMockManager(cache, "test-origin")

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

func TestProxyService_NewConnectionForEveryRequest(t *testing.T) {
	// Like a service that closes an idle connection as a request arrives
	used := make(map[string]bool)
	var mu sync.Mutex
	var connectionHeaders []string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		reused := used[r.RemoteAddr]
		used[r.RemoteAddr] = true
		connectionHeaders = append(connectionHeaders, r.Header["Connection"]...)
		mu.Unlock()
		if reused {
			panic(http.ErrAbortHandler)
		}
		w.Header().Set("Connection", "keep-alive")
		w.Write([]byte("ok"))
	}))
	defer server.Close()

	target := strings.TrimPrefix(server.URL, "http://")
	urlMap := UrlMap{"service": ServiceInfo{Name: "service", URL: server.URL}}
	proxy := NewProxyService(&Config{Origin: "caller"}, NewMockManager(NewMockCache(0), "caller"), func() UrlMap { return urlMap })

	send := func(host string) {
		resp, _, err := proxy.HandleRequest(httptest.NewRequest("POST", "http://"+host+"/x", strings.NewReader("{}")))
		if err != nil {
			t.Errorf("%s: %v", host, err)
			return
		}
		defer resp.Body.Close()
		if body, err := io.ReadAll(resp.Body); err != nil || string(body) != "ok" {
			t.Errorf("%s: body %q, err %v", host, body, err)
		}
		if got := resp.Header.Get("Connection"); got != "keep-alive" {
			t.Errorf("%s: the service's Connection header became %q", host, got)
		}
	}

	for i := 0; i < 5; i++ {
		send("service")
		send(target) // not a service
	}
	var wg sync.WaitGroup
	for i := 0; i < 50; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			send("service")
		}()
	}
	wg.Wait()

	if len(connectionHeaders) > 0 {
		t.Errorf("Connection headers were added to requests: %v", connectionHeaders)
	}
}

func TestProxyService_AddsNoRequestHeaders(t *testing.T) {
	var received http.Header
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		received = r.Header
		if strings.Contains(r.Header.Get("Accept-Encoding"), "gzip") {
			w.Header().Set("Content-Encoding", "gzip")
		}
		w.Write([]byte("as sent"))
	}))
	defer server.Close()

	urlMap := UrlMap{"service": ServiceInfo{Name: "service", URL: server.URL}}
	for _, sent := range []http.Header{
		{},
		{"X-A": {"1", "2"}},
		{"User-Agent": {"test"}},
		{"Accept-Encoding": {"gzip"}},
		{"Accept-Encoding": {"identity"}},
		{"Accept-Encoding": {"br"}, "User-Agent": {"curl/8.0"}, "X-A": {"1"}},
	} {
		for _, origin := range []string{"caller", ""} {
			proxy := NewProxyService(&Config{Origin: origin}, NewMockManager(NewMockCache(0), origin), func() UrlMap { return urlMap })
			r := httptest.NewRequest("GET", "http://service/x", nil)
			r.Header = sent.Clone()
			resp, _, err := proxy.HandleRequest(r)
			if err != nil {
				t.Fatal(err)
			}
			body, err := io.ReadAll(resp.Body)
			resp.Body.Close()
			if !reflect.DeepEqual(received, sent) {
				t.Errorf("sent %v, the service received %v", sent, received)
			}
			if err != nil || string(body) != "as sent" || resp.Header.Get("Content-Length") != "7" {
				t.Errorf("sent %v: body %q, err %v, headers %v", sent, body, err, resp.Header)
			}
		}
	}
}
