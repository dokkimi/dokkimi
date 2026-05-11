package main

import (
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestNewMockManager(t *testing.T) {
	cache := NewMockCache(5 * time.Minute)
	urlMapFunc := func() UrlMap { return make(UrlMap) }

	manager := NewMockManager(cache, nil, "test-origin", urlMapFunc)

	if manager == nil {
		t.Fatal("NewMockManager() returned nil")
	}

	if manager.origin != "test-origin" {
		t.Errorf("Expected origin to be test-origin, got %s", manager.origin)
	}
}

func TestMockManager_pathMatches(t *testing.T) {
	manager := &MockManager{}

	tests := []struct {
		name    string
		pattern string
		path    string
		want    bool
	}{
		{"exact match", "/test", "/test", true},
		{"wildcard match", "*", "/anything", true},
		{"prefix match", "/api/*", "/api/users", true},
		{"prefix match no match", "/api/*", "/other/users", false},
		{"no match", "/test", "/other", false},
		{"empty pattern", "", "/test", false},
		{"empty path", "/test", "", false},
		{"prefix with trailing slash", "/api/*", "/api/", true},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := manager.pathMatches(tt.pattern, tt.path)
			if got != tt.want {
				t.Errorf("pathMatches(%q, %q) = %v, want %v", tt.pattern, tt.path, got, tt.want)
			}
		})
	}
}

func TestMockManager_matches(t *testing.T) {
	cache := NewMockCache(5 * time.Minute)

	urlMap := UrlMap{
		"origin.com": ServiceInfo{Name: "test-origin"},
		"other.com":  ServiceInfo{Name: "other-origin"},
	}

	urlMapFunc := func() UrlMap { return urlMap }
	manager := NewMockManager(cache, nil, "test-origin", urlMapFunc)

	tests := []struct {
		name    string
		mock    MockEndpoint
		request *http.Request
		want    bool
	}{
		{
			name: "wildcard origin and target match",
			mock: MockEndpoint{
				Origin: "*",
				Target: "*",
				Method: "GET",
				Path:   "/test",
			},
			request: httptest.NewRequest("GET", "http://example.com/test", nil),
			want:    true,
		},
		{
			name: "specific origin match",
			mock: MockEndpoint{
				Origin: "origin.com",
				Target: "*",
				Method: "GET",
				Path:   "/test",
			},
			request: httptest.NewRequest("GET", "http://example.com/test", nil),
			want:    true,
		},
		{
			name: "origin mismatch",
			mock: MockEndpoint{
				Origin: "other.com",
				Target: "*",
				Method: "GET",
				Path:   "/test",
			},
			request: httptest.NewRequest("GET", "http://example.com/test", nil),
			want:    false,
		},
		{
			name: "target match",
			mock: MockEndpoint{
				Origin: "*",
				Target: "example.com",
				Method: "GET",
				Path:   "/test",
			},
			request: httptest.NewRequest("GET", "http://example.com/test", nil),
			want:    true,
		},
		{
			name: "target mismatch",
			mock: MockEndpoint{
				Origin: "*",
				Target: "other.com",
				Method: "GET",
				Path:   "/test",
			},
			request: httptest.NewRequest("GET", "http://example.com/test", nil),
			want:    false,
		},
		{
			name: "method match",
			mock: MockEndpoint{
				Origin: "*",
				Target: "*",
				Method: "POST",
				Path:   "/test",
			},
			request: httptest.NewRequest("POST", "http://example.com/test", nil),
			want:    true,
		},
		{
			name: "method mismatch",
			mock: MockEndpoint{
				Origin: "*",
				Target: "*",
				Method: "POST",
				Path:   "/test",
			},
			request: httptest.NewRequest("GET", "http://example.com/test", nil),
			want:    false,
		},
		{
			name: "case insensitive method",
			mock: MockEndpoint{
				Origin: "*",
				Target: "*",
				Method: "get",
				Path:   "/test",
			},
			request: httptest.NewRequest("GET", "http://example.com/test", nil),
			want:    true,
		},
		{
			name: "method wildcard match",
			mock: MockEndpoint{
				Origin: "*",
				Target: "*",
				Method: "*",
				Path:   "/test",
			},
			request: httptest.NewRequest("DELETE", "http://example.com/test", nil),
			want:    true,
		},
		{
			name: "path mismatch",
			mock: MockEndpoint{
				Origin: "*",
				Target: "*",
				Method: "GET",
				Path:   "/other",
			},
			request: httptest.NewRequest("GET", "http://example.com/test", nil),
			want:    false,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := manager.matches(&tt.mock, tt.request, urlMap, nil)
			if got != tt.want {
				t.Errorf("matches() = %v, want %v", got, tt.want)
			}
		})
	}
}

func TestMockManager_FindMatch(t *testing.T) {
	cache := NewMockCache(5 * time.Minute)
	urlMapFunc := func() UrlMap { return make(UrlMap) }
	manager := NewMockManager(cache, nil, "test-origin", urlMapFunc)

	// Set up mocks in cache
	mocks := []MockEndpoint{
		{Method: "GET", Origin: "*", Target: "*", Path: "/test1"},
		{Method: "POST", Origin: "*", Target: "*", Path: "/test2"},
		{Method: "GET", Origin: "*", Target: "*", Path: "/api/*"},
	}
	cache.SetMocks(mocks)

	tests := []struct {
		name    string
		request *http.Request
		want    *MockEndpoint
	}{
		{
			name:    "finds exact match",
			request: httptest.NewRequest("GET", "http://example.com/test1", nil),
			want:    &mocks[0],
		},
		{
			name:    "finds prefix match",
			request: httptest.NewRequest("GET", "http://example.com/api/users", nil),
			want:    &mocks[2],
		},
		{
			name:    "no match",
			request: httptest.NewRequest("DELETE", "http://example.com/test1", nil),
			want:    nil,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := manager.FindMatch(tt.request)
			if (got == nil) != (tt.want == nil) {
				t.Errorf("FindMatch() = %v, want %v", got, tt.want)
			}
			if got != nil && tt.want != nil {
				if got.Path != tt.want.Path {
					t.Errorf("FindMatch() path = %v, want %v", got.Path, tt.want.Path)
				}
			}
		})
	}
}

func TestMockManager_FindMatch_Specificity(t *testing.T) {
	cache := NewMockCache(5 * time.Minute)
	urlMap := UrlMap{
		"payment-service": ServiceInfo{Name: "payment-service"},
		"api.stripe.com":  ServiceInfo{Name: "api.stripe.com"},
	}
	urlMapFunc := func() UrlMap { return urlMap }
	manager := NewMockManager(cache, nil, "payment-service", urlMapFunc)

	tests := []struct {
		name    string
		mocks   []MockEndpoint
		request *http.Request
		want    *MockEndpoint // Expected mock (most specific)
	}{
		{
			name: "specific mock wins over wildcard",
			mocks: []MockEndpoint{
				{Method: "*", Origin: "*", Target: "*", Path: "*", ResponseStatus: intPtr(500)},
				{Method: "POST", Origin: "payment-service", Target: "api.stripe.com", Path: "/api/charges", ResponseStatus: intPtr(200)},
			},
			request: httptest.NewRequest("POST", "http://api.stripe.com/api/charges", nil),
			want:    &MockEndpoint{Method: "POST", Origin: "payment-service", Target: "api.stripe.com", Path: "/api/charges", ResponseStatus: intPtr(200)},
		},
		{
			name: "exact path wins over prefix",
			mocks: []MockEndpoint{
				{Method: "GET", Origin: "*", Target: "*", Path: "/api/*", ResponseStatus: intPtr(404)},
				{Method: "GET", Origin: "*", Target: "*", Path: "/api/users", ResponseStatus: intPtr(200)},
			},
			request: httptest.NewRequest("GET", "http://example.com/api/users", nil),
			want:    &MockEndpoint{Method: "GET", Origin: "*", Target: "*", Path: "/api/users", ResponseStatus: intPtr(200)},
		},
		{
			name: "specific method wins over wildcard",
			mocks: []MockEndpoint{
				{Method: "*", Origin: "*", Target: "*", Path: "/test", ResponseStatus: intPtr(500)},
				{Method: "GET", Origin: "*", Target: "*", Path: "/test", ResponseStatus: intPtr(200)},
			},
			request: httptest.NewRequest("GET", "http://example.com/test", nil),
			want:    &MockEndpoint{Method: "GET", Origin: "*", Target: "*", Path: "/test", ResponseStatus: intPtr(200)},
		},
		{
			name: "specific target wins over wildcard",
			mocks: []MockEndpoint{
				{Method: "GET", Origin: "*", Target: "*", Path: "/test", ResponseStatus: intPtr(500)},
				{Method: "GET", Origin: "*", Target: "api.stripe.com", Path: "/test", ResponseStatus: intPtr(200)},
			},
			request: httptest.NewRequest("GET", "http://api.stripe.com/test", nil),
			want:    &MockEndpoint{Method: "GET", Origin: "*", Target: "api.stripe.com", Path: "/test", ResponseStatus: intPtr(200)},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			cache.SetMocks(tt.mocks)
			got := manager.FindMatch(tt.request)
			if got == nil {
				t.Errorf("FindMatch() = nil, want non-nil")
				return
			}
			if tt.want == nil {
				t.Errorf("FindMatch() = %v, want nil", got)
				return
			}
			// Check that we got the more specific mock
			if got.Path != tt.want.Path {
				t.Errorf("FindMatch() path = %v, want %v", got.Path, tt.want.Path)
			}
			if got.Method != tt.want.Method {
				t.Errorf("FindMatch() method = %v, want %v", got.Method, tt.want.Method)
			}
			if got.Origin != tt.want.Origin {
				t.Errorf("FindMatch() origin = %v, want %v", got.Origin, tt.want.Origin)
			}
			if got.Target != tt.want.Target {
				t.Errorf("FindMatch() target = %v, want %v", got.Target, tt.want.Target)
			}
		})
	}
}

func TestMockManager_ApplyMock(t *testing.T) {
	manager := &MockManager{}

	tests := []struct {
		name     string
		mock     MockEndpoint
		validate func(*testing.T, *http.Response, error)
	}{
		{
			name: "basic mock with status code",
			mock: MockEndpoint{
				ResponseStatus: intPtr(404),
			},
			validate: func(t *testing.T, resp *http.Response, err error) {
				if err != nil {
					t.Errorf("ApplyMock() error = %v", err)
					return
				}
				if resp.StatusCode != 404 {
					t.Errorf("Expected status 404, got %d", resp.StatusCode)
				}
				if resp.Header.Get("X-Mocked") != "true" {
					t.Error("Expected X-Mocked header")
				}
			},
		},
		{
			name: "mock with delay",
			mock: MockEndpoint{
				DelayMS: intPtr(10),
			},
			validate: func(t *testing.T, resp *http.Response, err error) {
				if err != nil {
					t.Errorf("ApplyMock() error = %v", err)
					return
				}
				// Delay should have been applied (we can't easily test timing)
				if resp.StatusCode != 200 {
					t.Errorf("Expected default status 200, got %d", resp.StatusCode)
				}
			},
		},
		{
			name: "mock with response body",
			mock: MockEndpoint{
				ResponseBody: stringPtr(`{"message": "test"}`),
			},
			validate: func(t *testing.T, resp *http.Response, err error) {
				if err != nil {
					t.Errorf("ApplyMock() error = %v", err)
					return
				}
				if resp.Body == nil {
					t.Error("Expected response body")
					return
				}
				if resp.Header.Get("Content-Type") != "application/json" {
					t.Error("Expected Content-Type header")
				}
			},
		},
		{
			name: "mock with response headers",
			mock: MockEndpoint{
				ResponseHeaders: stringPtr(`{"X-Custom": "value"}`),
			},
			validate: func(t *testing.T, resp *http.Response, err error) {
				if err != nil {
					t.Errorf("ApplyMock() error = %v", err)
					return
				}
				if resp.Header.Get("X-Custom") != "value" {
					t.Error("Expected X-Custom header")
				}
			},
		},
		{
			name: "mock with array headers",
			mock: MockEndpoint{
				ResponseHeaders: stringPtr(`{"X-Multi": ["value1", "value2"]}`),
			},
			validate: func(t *testing.T, resp *http.Response, err error) {
				if err != nil {
					t.Errorf("ApplyMock() error = %v", err)
					return
				}
				values := resp.Header.Values("X-Multi")
				if len(values) != 2 {
					t.Errorf("Expected 2 header values, got %d", len(values))
				}
			},
		},
		{
			name: "mock with invalid JSON headers",
			mock: MockEndpoint{
				ResponseHeaders: stringPtr(`invalid json`),
			},
			validate: func(t *testing.T, resp *http.Response, err error) {
				if err != nil {
					t.Errorf("ApplyMock() error = %v", err)
					return
				}
				// Should not panic, just ignore invalid headers
			},
		},
		{
			name: "mock with non-string array header values",
			mock: MockEndpoint{
				ResponseHeaders: stringPtr(`{"X-Multi": [123, 456]}`),
			},
			validate: func(t *testing.T, resp *http.Response, err error) {
				if err != nil {
					t.Errorf("ApplyMock() error = %v", err)
					return
				}
				// Non-string values should be skipped
			},
		},
		{
			name: "mock with numeric header value",
			mock: MockEndpoint{
				ResponseHeaders: stringPtr(`{"X-Number": 123}`),
			},
			validate: func(t *testing.T, resp *http.Response, err error) {
				if err != nil {
					t.Errorf("ApplyMock() error = %v", err)
					return
				}
				if resp.Header.Get("X-Number") != "123" {
					t.Errorf("Expected X-Number to be 123, got %s", resp.Header.Get("X-Number"))
				}
			},
		},
		{
			name: "default status code",
			mock: MockEndpoint{},
			validate: func(t *testing.T, resp *http.Response, err error) {
				if err != nil {
					t.Errorf("ApplyMock() error = %v", err)
					return
				}
				if resp.StatusCode != 200 {
					t.Errorf("Expected default status 200, got %d", resp.StatusCode)
				}
			},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			resp, err := manager.ApplyMock(&tt.mock)
			tt.validate(t, resp, err)
			if resp != nil {
				resp.Body.Close()
			}
		})
	}
}

// TestMockManager_WildcardEdgeCases tests comprehensive wildcard matching scenarios
func TestMockManager_WildcardEdgeCases(t *testing.T) {
	cache := NewMockCache(5 * time.Minute)
	urlMap := UrlMap{
		"payment-service": ServiceInfo{Name: "Payment Service"},
		"user-service":    ServiceInfo{Name: "User Service"},
		"api.stripe.com":  ServiceInfo{Name: "Stripe API"},
	}
	urlMapFunc := func() UrlMap { return urlMap }

	tests := []struct {
		name              string
		interceptorOrigin string
		mocks             []MockEndpoint
		request           *http.Request
		expectedMock      *MockEndpoint
		description       string
	}{
		{
			name:              "all wildcards match everything",
			interceptorOrigin: "Payment Service",
			mocks: []MockEndpoint{
				{Method: "*", Origin: "*", Target: "*", Path: "*", ResponseStatus: intPtr(200)},
			},
			request:      httptest.NewRequest("DELETE", "http://anywhere.com/any/path", nil),
			expectedMock: &MockEndpoint{Method: "*", Origin: "*", Target: "*", Path: "*", ResponseStatus: intPtr(200)},
			description:  "Mock with all wildcards should match any request",
		},
		{
			name:              "wildcard origin matches any service",
			interceptorOrigin: "Payment Service",
			mocks: []MockEndpoint{
				{Method: "GET", Origin: "*", Target: "api.stripe.com", Path: "/charges", ResponseStatus: intPtr(200)},
			},
			request:      httptest.NewRequest("GET", "http://api.stripe.com/charges", nil),
			expectedMock: &MockEndpoint{Method: "GET", Origin: "*", Target: "api.stripe.com", Path: "/charges", ResponseStatus: intPtr(200)},
			description:  "Wildcard origin should match any interceptor origin",
		},
		{
			name:              "wildcard target matches any host",
			interceptorOrigin: "Payment Service",
			mocks: []MockEndpoint{
				{Method: "POST", Origin: "payment-service", Target: "*", Path: "/payments", ResponseStatus: intPtr(201)},
			},
			request:      httptest.NewRequest("POST", "http://any-external-api.com/payments", nil),
			expectedMock: &MockEndpoint{Method: "POST", Origin: "payment-service", Target: "*", Path: "/payments", ResponseStatus: intPtr(201)},
			description:  "Wildcard target should match any request host",
		},
		{
			name:              "wildcard method matches any HTTP method",
			interceptorOrigin: "Payment Service",
			mocks: []MockEndpoint{
				{Method: "*", Origin: "payment-service", Target: "api.stripe.com", Path: "/webhook", ResponseStatus: intPtr(200)},
			},
			request:      httptest.NewRequest("PATCH", "http://api.stripe.com/webhook", nil),
			expectedMock: &MockEndpoint{Method: "*", Origin: "payment-service", Target: "api.stripe.com", Path: "/webhook", ResponseStatus: intPtr(200)},
			description:  "Wildcard method should match any HTTP method",
		},
		{
			name:              "wildcard path matches any path",
			interceptorOrigin: "Payment Service",
			mocks: []MockEndpoint{
				{Method: "GET", Origin: "payment-service", Target: "api.stripe.com", Path: "*", ResponseStatus: intPtr(200)},
			},
			request:      httptest.NewRequest("GET", "http://api.stripe.com/completely/different/path?with=query", nil),
			expectedMock: &MockEndpoint{Method: "GET", Origin: "payment-service", Target: "api.stripe.com", Path: "*", ResponseStatus: intPtr(200)},
			description:  "Wildcard path should match any request path",
		},
		{
			name:              "path prefix wildcard matches nested paths",
			interceptorOrigin: "User Service",
			mocks: []MockEndpoint{
				{Method: "GET", Origin: "*", Target: "*", Path: "/api/users/*", ResponseStatus: intPtr(200)},
			},
			request:      httptest.NewRequest("GET", "http://user-service/api/users/123/profile/settings", nil),
			expectedMock: &MockEndpoint{Method: "GET", Origin: "*", Target: "*", Path: "/api/users/*", ResponseStatus: intPtr(200)},
			description:  "Path prefix wildcard should match deeply nested paths",
		},
		{
			name:              "path prefix wildcard matches root path",
			interceptorOrigin: "Payment Service",
			mocks: []MockEndpoint{
				{Method: "GET", Origin: "*", Target: "*", Path: "/api/*", ResponseStatus: intPtr(200)},
			},
			request:      httptest.NewRequest("GET", "http://api.example.com/api/", nil),
			expectedMock: &MockEndpoint{Method: "GET", Origin: "*", Target: "*", Path: "/api/*", ResponseStatus: intPtr(200)},
			description:  "Path prefix wildcard should match path ending with slash",
		},
		{
			name:              "empty origin interceptor matches empty origin mock",
			interceptorOrigin: "", // Shared interceptor
			mocks: []MockEndpoint{
				{Method: "GET", Origin: "", Target: "*", Path: "/external", ResponseStatus: intPtr(200)},
			},
			request:      httptest.NewRequest("GET", "http://internal-service/external", nil),
			expectedMock: &MockEndpoint{Method: "GET", Origin: "", Target: "*", Path: "/external", ResponseStatus: intPtr(200)},
			description:  "Shared interceptor (empty origin) should match mocks with empty origin",
		},
		{
			name:              "empty origin interceptor does not match service-specific mock",
			interceptorOrigin: "", // Shared interceptor
			mocks: []MockEndpoint{
				{Method: "GET", Origin: "payment-service", Target: "*", Path: "/test", ResponseStatus: intPtr(200)},
				{Method: "GET", Origin: "*", Target: "*", Path: "/test", ResponseStatus: intPtr(201)},
			},
			request:      httptest.NewRequest("GET", "http://anywhere.com/test", nil),
			expectedMock: &MockEndpoint{Method: "GET", Origin: "*", Target: "*", Path: "/test", ResponseStatus: intPtr(201)},
			description:  "Shared interceptor should not match service-specific mocks, but should match wildcard",
		},
		{
			name:              "service-specific interceptor matches empty-origin mock (empty == wildcard)",
			interceptorOrigin: "Payment Service",
			mocks: []MockEndpoint{
				{Method: "GET", Origin: "", Target: "*", Path: "/test", ResponseStatus: intPtr(200)},
			},
			request:      httptest.NewRequest("GET", "http://anywhere.com/test", nil),
			expectedMock: &MockEndpoint{Method: "GET", Origin: "", Target: "*", Path: "/test", ResponseStatus: intPtr(200)},
			description:  "Empty Origin means 'no origin restriction', equivalent to '*'. Service interceptors match it.",
		},
		{
			name:              "target with port number matches",
			interceptorOrigin: "Payment Service",
			mocks: []MockEndpoint{
				{Method: "GET", Origin: "*", Target: "api.example.com:8080", Path: "/test", ResponseStatus: intPtr(200)},
			},
			request:      httptest.NewRequest("GET", "http://api.example.com:8080/test", nil),
			expectedMock: &MockEndpoint{Method: "GET", Origin: "*", Target: "api.example.com:8080", Path: "/test", ResponseStatus: intPtr(200)},
			description:  "Target matching should work with port numbers in Host header",
		},
		{
			name:              "target without port does not match target with port",
			interceptorOrigin: "Payment Service",
			mocks: []MockEndpoint{
				{Method: "GET", Origin: "*", Target: "api.example.com:8080", Path: "/test", ResponseStatus: intPtr(200)},
			},
			request:      httptest.NewRequest("GET", "http://api.example.com/test", nil),
			expectedMock: nil,
			description:  "Target with port should not match request without port",
		},
		{
			name:              "multiple overlapping wildcards - most specific wins",
			interceptorOrigin: "Payment Service",
			mocks: []MockEndpoint{
				{Method: "*", Origin: "*", Target: "*", Path: "*", ResponseStatus: intPtr(500)},                                      // Score: 0
				{Method: "POST", Origin: "*", Target: "*", Path: "*", ResponseStatus: intPtr(400)},                                   // Score: 1
				{Method: "POST", Origin: "payment-service", Target: "*", Path: "*", ResponseStatus: intPtr(300)},                     // Score: 2
				{Method: "POST", Origin: "payment-service", Target: "api.stripe.com", Path: "*", ResponseStatus: intPtr(200)},        // Score: 3
				{Method: "POST", Origin: "payment-service", Target: "api.stripe.com", Path: "/charges", ResponseStatus: intPtr(201)}, // Score: 5
			},
			request:      httptest.NewRequest("POST", "http://api.stripe.com/charges", nil),
			expectedMock: &MockEndpoint{Method: "POST", Origin: "payment-service", Target: "api.stripe.com", Path: "/charges", ResponseStatus: intPtr(201)},
			description:  "Most specific mock (score 5) should win over less specific ones",
		},
		{
			name:              "same specificity - first match wins",
			interceptorOrigin: "Payment Service",
			mocks: []MockEndpoint{
				{Method: "GET", Origin: "*", Target: "api.stripe.com", Path: "/test", ResponseStatus: intPtr(200)},
				{Method: "GET", Origin: "*", Target: "api.stripe.com", Path: "/test", ResponseStatus: intPtr(201)},
			},
			request:      httptest.NewRequest("GET", "http://api.stripe.com/test", nil),
			expectedMock: &MockEndpoint{Method: "GET", Origin: "*", Target: "api.stripe.com", Path: "/test", ResponseStatus: intPtr(200)},
			description:  "When specificity is equal, first matching mock should be selected",
		},
		{
			name:              "path prefix wildcard specificity - exact beats prefix",
			interceptorOrigin: "User Service",
			mocks: []MockEndpoint{
				{Method: "GET", Origin: "*", Target: "*", Path: "/api/users/*", ResponseStatus: intPtr(404)},
				{Method: "GET", Origin: "*", Target: "*", Path: "/api/users/123", ResponseStatus: intPtr(200)},
			},
			request:      httptest.NewRequest("GET", "http://user-service/api/users/123", nil),
			expectedMock: &MockEndpoint{Method: "GET", Origin: "*", Target: "*", Path: "/api/users/123", ResponseStatus: intPtr(200)},
			description:  "Exact path match (score +2) should win over prefix match (score +1)",
		},
		{
			name:              "path variable specificity - exact beats variable, variable beats prefix",
			interceptorOrigin: "User Service",
			mocks: []MockEndpoint{
				{Method: "GET", Origin: "*", Target: "*", Path: "/api/users/*", ResponseStatus: intPtr(404)},        // Prefix wildcard
				{Method: "GET", Origin: "*", Target: "*", Path: "/api/users/{userId}", ResponseStatus: intPtr(300)}, // Variable
				{Method: "GET", Origin: "*", Target: "*", Path: "/api/users/123", ResponseStatus: intPtr(200)},      // Exact
			},
			request:      httptest.NewRequest("GET", "http://user-service/api/users/123", nil),
			expectedMock: &MockEndpoint{Method: "GET", Origin: "*", Target: "*", Path: "/api/users/123", ResponseStatus: intPtr(200)},
			description:  "Exact path (score +2) should win over variable (score +1) which should win over prefix (score +1)",
		},
		{
			name:              "path variable specificity - variable beats prefix wildcard",
			interceptorOrigin: "User Service",
			mocks: []MockEndpoint{
				{Method: "GET", Origin: "*", Target: "*", Path: "/api/users/*", ResponseStatus: intPtr(404)},        // Prefix wildcard (score +1)
				{Method: "GET", Origin: "*", Target: "*", Path: "/api/users/{userId}", ResponseStatus: intPtr(200)}, // Variable (score +2)
			},
			request:      httptest.NewRequest("GET", "http://user-service/api/users/456", nil),
			expectedMock: &MockEndpoint{Method: "GET", Origin: "*", Target: "*", Path: "/api/users/{userId}", ResponseStatus: intPtr(200)},
			description:  "Path variable (score +2) should win over prefix wildcard (score +1)",
		},
		{
			name:              "case insensitive method matching",
			interceptorOrigin: "Payment Service",
			mocks: []MockEndpoint{
				{Method: "post", Origin: "*", Target: "*", Path: "/test", ResponseStatus: intPtr(200)},
				{Method: "PUT", Origin: "*", Target: "*", Path: "/test", ResponseStatus: intPtr(201)},
				{Method: "delete", Origin: "*", Target: "*", Path: "/test", ResponseStatus: intPtr(202)},
			},
			request:      httptest.NewRequest("POST", "http://api.example.com/test", nil),
			expectedMock: &MockEndpoint{Method: "post", Origin: "*", Target: "*", Path: "/test", ResponseStatus: intPtr(200)},
			description:  "Method matching should be case-insensitive",
		},
		{
			name:              "root path matching",
			interceptorOrigin: "Payment Service",
			mocks: []MockEndpoint{
				{Method: "GET", Origin: "*", Target: "*", Path: "/", ResponseStatus: intPtr(200)},
				{Method: "GET", Origin: "*", Target: "*", Path: "/*", ResponseStatus: intPtr(201)},
			},
			request:      httptest.NewRequest("GET", "http://api.example.com/", nil),
			expectedMock: &MockEndpoint{Method: "GET", Origin: "*", Target: "*", Path: "/", ResponseStatus: intPtr(200)},
			description:  "Root path exact match should win over prefix wildcard",
		},
		{
			name:              "empty path edge case",
			interceptorOrigin: "Payment Service",
			mocks: []MockEndpoint{
				{Method: "GET", Origin: "*", Target: "*", Path: "", ResponseStatus: intPtr(200)},
			},
			request:      httptest.NewRequest("GET", "http://api.example.com/", nil),
			expectedMock: nil, // Empty path pattern doesn't match "/"
			description:  "Empty path pattern should not match root path",
		},
		{
			name:              "path with query string - path matching ignores query",
			interceptorOrigin: "Payment Service",
			mocks: []MockEndpoint{
				{Method: "GET", Origin: "*", Target: "*", Path: "/api/users", ResponseStatus: intPtr(200)},
			},
			request:      httptest.NewRequest("GET", "http://api.example.com/api/users?id=123&name=test", nil),
			expectedMock: &MockEndpoint{Method: "GET", Origin: "*", Target: "*", Path: "/api/users", ResponseStatus: intPtr(200)},
			description:  "Path matching should work regardless of query string",
		},
		{
			name:              "origin not in urlMap should not match",
			interceptorOrigin: "Payment Service",
			mocks: []MockEndpoint{
				{Method: "GET", Origin: "non-existent-service", Target: "*", Path: "/test", ResponseStatus: intPtr(200)},
			},
			request:      httptest.NewRequest("GET", "http://api.example.com/test", nil),
			expectedMock: nil,
			description:  "Mock with origin not in urlMap should not match",
		},
		{
			name:              "origin in urlMap but name mismatch should not match",
			interceptorOrigin: "Payment Service",
			mocks: []MockEndpoint{
				{Method: "GET", Origin: "user-service", Target: "*", Path: "/test", ResponseStatus: intPtr(200)},
			},
			request:      httptest.NewRequest("GET", "http://api.example.com/test", nil),
			expectedMock: nil,
			description:  "Mock origin service name must match interceptor origin",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			cache.SetMocks(tt.mocks)
			manager := NewMockManager(cache, nil, tt.interceptorOrigin, urlMapFunc)
			got := manager.FindMatch(tt.request)

			if tt.expectedMock == nil {
				if got != nil {
					t.Errorf("FindMatch() = %v, want nil\nDescription: %s", got, tt.description)
				}
				return
			}

			if got == nil {
				t.Errorf("FindMatch() = nil, want non-nil\nDescription: %s", tt.description)
				return
			}

			// Verify all fields match
			if got.Method != tt.expectedMock.Method {
				t.Errorf("FindMatch() Method = %v, want %v\nDescription: %s", got.Method, tt.expectedMock.Method, tt.description)
			}
			if got.Origin != tt.expectedMock.Origin {
				t.Errorf("FindMatch() Origin = %v, want %v\nDescription: %s", got.Origin, tt.expectedMock.Origin, tt.description)
			}
			if got.Target != tt.expectedMock.Target {
				t.Errorf("FindMatch() Target = %v, want %v\nDescription: %s", got.Target, tt.expectedMock.Target, tt.description)
			}
			if got.Path != tt.expectedMock.Path {
				t.Errorf("FindMatch() Path = %v, want %v\nDescription: %s", got.Path, tt.expectedMock.Path, tt.description)
			}
		})
	}
}

// TestMockManager_PathMatchingEdgeCases tests path matching edge cases
func TestMockManager_PathMatchingEdgeCases(t *testing.T) {
	manager := &MockManager{}

	tests := []struct {
		name    string
		pattern string
		path    string
		want    bool
	}{
		{"exact match", "/test", "/test", true},
		{"wildcard match", "*", "/anything", true},
		{"wildcard match empty path", "*", "", true},
		{"prefix match", "/api/*", "/api/users", true},
		{"prefix match nested", "/api/*", "/api/v1/users/123", true},
		{"prefix match with trailing slash", "/api/*", "/api/", true},
		{"prefix match root", "/*", "/anything", true},
		{"prefix match root exact", "/*", "/", true},
		{"no match different prefix", "/api/*", "/other/users", false},
		{"no match exact", "/test", "/other", false},
		{"empty pattern", "", "/test", false},
		{"empty path", "/test", "", false},
		{"both empty", "", "", true},                                              // Empty pattern matches empty path (exact match)
		{"pattern with asterisk in middle", "/api/*/users", "/api/*/users", true}, // Exact match, not prefix
		{"pattern ending with double asterisk", "/api/**", "/api/**", true},       // Exact match
		{"single slash", "/", "/", true},
		{"single slash wildcard", "/*", "/", true},
		{"single slash pattern", "/", "/*", false}, // "/" doesn't match "/*"
		{"prefix with special chars", "/api/v1/*", "/api/v1/users?filter=active", true},
		{"long nested path", "/a/b/c/d/e/*", "/a/b/c/d/e/f/g/h/i", true},
		{"single char prefix", "/a/*", "/a/b", true},
		{"single char exact", "/a", "/a", true},
		{"single char no match", "/a", "/b", false},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := manager.pathMatches(tt.pattern, tt.path)
			if got != tt.want {
				t.Errorf("pathMatches(%q, %q) = %v, want %v", tt.pattern, tt.path, got, tt.want)
			}
		})
	}
}

// TestMockManager_PathVariables tests path variable matching (e.g., /api/users/:id, /api/users/{userId})
// Path variables are NOW SUPPORTED using the pathmatch library
func TestMockManager_PathVariables(t *testing.T) {
	cache := NewMockCache(5 * time.Minute)
	urlMapFunc := func() UrlMap { return make(UrlMap) }
	manager := NewMockManager(cache, nil, "test-origin", urlMapFunc)

	tests := []struct {
		name        string
		mockPath    string
		requestPath string
		shouldMatch bool
		description string
	}{
		{
			name:        "colon syntax now supported",
			mockPath:    "/api/users/:id",
			requestPath: "/api/users/123",
			shouldMatch: true, // Now matches - :id is treated as variable
			description: "Path with :id syntax is now supported and matches variable values",
		},
		{
			name:        "colon syntax exact match still works",
			mockPath:    "/api/users/:id",
			requestPath: "/api/users/:id",
			shouldMatch: true, // Exact match works
			description: "Exact match with :id still works (literal string)",
		},
		{
			name:        "curly brace syntax now supported",
			mockPath:    "/api/users/{userId}",
			requestPath: "/api/users/123",
			shouldMatch: true, // Now matches - {userId} is treated as variable
			description: "Path with {userId} syntax is now supported and matches variable values",
		},
		{
			name:        "curly brace exact match still works",
			mockPath:    "/api/users/{userId}",
			requestPath: "/api/users/{userId}",
			shouldMatch: true, // Exact match works
			description: "Exact match with {userId} still works (literal string)",
		},
		{
			name:        "multiple path variables now supported",
			mockPath:    "/api/users/{userId}/posts/{postId}",
			requestPath: "/api/users/123/posts/456",
			shouldMatch: true,
			description: "Multiple path variables are now supported",
		},
		{
			name:        "path variable with prefix wildcard works",
			mockPath:    "/api/users/*",
			requestPath: "/api/users/123",
			shouldMatch: true, // Prefix wildcard works
			description: "Prefix wildcard /api/users/* still matches /api/users/123",
		},
		{
			name:        "path variable with nested prefix wildcard NOT supported",
			mockPath:    "/api/users/*/posts",
			requestPath: "/api/users/123/posts",
			shouldMatch: false, // Wildcard in middle doesn't work - only at end
			description: "Wildcard in middle of path (/api/users/*/posts) is NOT supported - only trailing wildcards work",
		},
		{
			name:        "path variable with full wildcard",
			mockPath:    "*",
			requestPath: "/api/users/123/posts/456",
			shouldMatch: true, // Full wildcard works
			description: "Full wildcard * matches any path including with variables",
		},
		{
			name:        "colon syntax matches variable values",
			mockPath:    "/api/users/:id",
			requestPath: "/api/users/123",
			shouldMatch: true,
			description: "Colon syntax in path now matches variable values",
		},
		{
			name:        "curly brace syntax matches variable values",
			mockPath:    "/api/users/{id}",
			requestPath: "/api/users/123",
			shouldMatch: true,
			description: "Curly brace syntax now matches variable values",
		},
		{
			name:        "path variable preferred over prefix wildcard",
			mockPath:    "/api/users/{id}",
			requestPath: "/api/users/123",
			shouldMatch: true,
			description: "Path variable /api/users/{id} matches /api/users/123 (more specific than wildcard)",
		},
		{
			name:        "nested wildcards in middle NOT supported",
			mockPath:    "/api/users/*/posts/*",
			requestPath: "/api/users/123/posts/456",
			shouldMatch: false, // Wildcards in middle don't work
			description: "Wildcards in middle of path are NOT supported - only trailing wildcard works",
		},
		{
			name:        "workaround with single trailing wildcard for nested paths",
			mockPath:    "/api/users/*",
			requestPath: "/api/users/123/posts/456",
			shouldMatch: true,
			description: "Use single trailing wildcard /api/users/* to match all nested paths",
		},
		{
			name:        "colon at start of segment now supported",
			mockPath:    "/api/:resource",
			requestPath: "/api/users",
			shouldMatch: true,
			description: ":resource syntax now supported",
		},
		{
			name:        "curly brace at start of segment now supported",
			mockPath:    "/api/{resource}",
			requestPath: "/api/users",
			shouldMatch: true,
			description: "{resource} syntax now supported",
		},
		{
			name:        "mixed colon and literal now supported",
			mockPath:    "/api/users/:id/profile",
			requestPath: "/api/users/123/profile",
			shouldMatch: true,
			description: "Mixed colon variable and literal path now supported",
		},
		{
			name:        "mixed curly and literal now supported",
			mockPath:    "/api/users/{id}/profile",
			requestPath: "/api/users/123/profile",
			shouldMatch: true,
			description: "Mixed curly brace variable and literal path now supported",
		},
		{
			name:        "colon syntax with multiple variables",
			mockPath:    "/api/users/:userId/posts/:postId",
			requestPath: "/api/users/123/posts/456",
			shouldMatch: true,
			description: "Multiple colon variables now supported",
		},
		{
			name:        "variable with alphanumeric values",
			mockPath:    "/api/users/{userId}",
			requestPath: "/api/users/abc123",
			shouldMatch: true,
			description: "Path variables match alphanumeric values",
		},
		{
			name:        "variable does not match empty segment",
			mockPath:    "/api/users/{userId}",
			requestPath: "/api/users/",
			shouldMatch: false,
			description: "Path variable does not match empty segment",
		},
		{
			name:        "variable does not match different path",
			mockPath:    "/api/users/{userId}",
			requestPath: "/api/posts/123",
			shouldMatch: false,
			description: "Path variable pattern does not match completely different paths",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			mocks := []MockEndpoint{
				{Method: "GET", Origin: "*", Target: "*", Path: tt.mockPath, ResponseStatus: intPtr(200)},
			}
			cache.SetMocks(mocks)

			request := httptest.NewRequest("GET", "http://api.example.com"+tt.requestPath, nil)
			got := manager.FindMatch(request)

			if tt.shouldMatch {
				if got == nil {
					t.Errorf("FindMatch() = nil, want match\nMock path: %q\nRequest path: %q\nDescription: %s",
						tt.mockPath, tt.requestPath, tt.description)
				} else if got.Path != tt.mockPath {
					t.Errorf("FindMatch() path = %q, want %q\nDescription: %s",
						got.Path, tt.mockPath, tt.description)
				}
			} else {
				if got != nil {
					t.Errorf("FindMatch() = %v, want nil\nMock path: %q\nRequest path: %q\nDescription: %s",
						got, tt.mockPath, tt.requestPath, tt.description)
				}
			}
		})
	}
}

// TestMockManager_BodyMatching tests request body substring and regex matching
func TestMockManager_BodyMatching(t *testing.T) {
	cache := NewMockCache(5 * time.Minute)
	urlMapFunc := func() UrlMap { return make(UrlMap) }
	manager := NewMockManager(cache, nil, "test-origin", urlMapFunc)

	t.Run("substring match", func(t *testing.T) {
		cache.SetMocks([]MockEndpoint{
			{Method: "POST", Origin: "*", Target: "*", Path: "/api", RequestBodyContains: stringPtr("classify this ticket"), ResponseStatus: intPtr(200)},
		})
		req := httptest.NewRequest("POST", "http://example.com/api", strings.NewReader(`{"prompt": "classify this ticket"}`))
		got := manager.FindMatch(req)
		if got == nil {
			t.Fatal("expected match for body containing substring")
		}
	})

	t.Run("substring no match", func(t *testing.T) {
		cache.SetMocks([]MockEndpoint{
			{Method: "POST", Origin: "*", Target: "*", Path: "/api", RequestBodyContains: stringPtr("classify this ticket"), ResponseStatus: intPtr(200)},
		})
		req := httptest.NewRequest("POST", "http://example.com/api", strings.NewReader(`{"prompt": "extract entities"}`))
		got := manager.FindMatch(req)
		if got != nil {
			t.Fatal("expected no match for body not containing substring")
		}
	})

	t.Run("substring case insensitive", func(t *testing.T) {
		cache.SetMocks([]MockEndpoint{
			{Method: "POST", Origin: "*", Target: "*", Path: "/api", RequestBodyContains: stringPtr("CLASSIFY THIS TICKET"), ResponseStatus: intPtr(200)},
		})
		req := httptest.NewRequest("POST", "http://example.com/api", strings.NewReader(`{"prompt": "classify this ticket"}`))
		got := manager.FindMatch(req)
		if got == nil {
			t.Fatal("expected case-insensitive substring match")
		}
	})

	t.Run("substring nil body", func(t *testing.T) {
		cache.SetMocks([]MockEndpoint{
			{Method: "GET", Origin: "*", Target: "*", Path: "/api", RequestBodyContains: stringPtr("test"), ResponseStatus: intPtr(200)},
		})
		req := httptest.NewRequest("GET", "http://example.com/api", nil)
		got := manager.FindMatch(req)
		if got != nil {
			t.Fatal("expected no match when request has no body")
		}
	})

	t.Run("regex match", func(t *testing.T) {
		cache.SetMocks([]MockEndpoint{
			{Method: "POST", Origin: "*", Target: "*", Path: "/api", RequestBodyMatches: stringPtr(`"name":\s*"search_database"`), ResponseStatus: intPtr(200)},
		})
		req := httptest.NewRequest("POST", "http://example.com/api", strings.NewReader(`{"name": "search_database"}`))
		got := manager.FindMatch(req)
		if got == nil {
			t.Fatal("expected regex match")
		}
	})

	t.Run("regex no match", func(t *testing.T) {
		cache.SetMocks([]MockEndpoint{
			{Method: "POST", Origin: "*", Target: "*", Path: "/api", RequestBodyMatches: stringPtr(`"name":\s*"search_database"`), ResponseStatus: intPtr(200)},
		})
		req := httptest.NewRequest("POST", "http://example.com/api", strings.NewReader(`{"name": "other_tool"}`))
		got := manager.FindMatch(req)
		if got != nil {
			t.Fatal("expected no regex match")
		}
	})

	t.Run("regex nil body", func(t *testing.T) {
		cache.SetMocks([]MockEndpoint{
			{Method: "GET", Origin: "*", Target: "*", Path: "/api", RequestBodyMatches: stringPtr(`test`), ResponseStatus: intPtr(200)},
		})
		req := httptest.NewRequest("GET", "http://example.com/api", nil)
		got := manager.FindMatch(req)
		if got != nil {
			t.Fatal("expected no match when request has no body")
		}
	})

	t.Run("invalid regex disabled at load time", func(t *testing.T) {
		cache.SetMocks([]MockEndpoint{
			{Method: "POST", Origin: "*", Target: "*", Path: "/api", RequestBodyMatches: stringPtr(`[invalid`), ResponseStatus: intPtr(200)},
		})
		// SetMocks should have cleared the invalid regex
		mocks := cache.GetMocks()
		if mocks[0].RequestBodyMatches != nil {
			t.Fatal("expected invalid regex to be cleared by SetMocks")
		}
	})
}

// TestMockManager_BodyMatchingSpecificity tests that body-matching mocks score higher
func TestMockManager_BodyMatchingSpecificity(t *testing.T) {
	cache := NewMockCache(5 * time.Minute)
	urlMapFunc := func() UrlMap { return make(UrlMap) }
	manager := NewMockManager(cache, nil, "test-origin", urlMapFunc)

	t.Run("body match wins over no body match", func(t *testing.T) {
		cache.SetMocks([]MockEndpoint{
			{Method: "POST", Origin: "*", Target: "*", Path: "/api", ResponseStatus: intPtr(500)},
			{Method: "POST", Origin: "*", Target: "*", Path: "/api", RequestBodyContains: stringPtr("classify"), ResponseStatus: intPtr(200)},
		})
		req := httptest.NewRequest("POST", "http://example.com/api", strings.NewReader(`classify this`))
		got := manager.FindMatch(req)
		if got == nil || *got.ResponseStatus != 200 {
			t.Fatal("expected body-matching mock (200) to win over fallback (500)")
		}
	})

	t.Run("fallback when body does not match", func(t *testing.T) {
		cache.SetMocks([]MockEndpoint{
			{Method: "POST", Origin: "*", Target: "*", Path: "/api", ResponseStatus: intPtr(500)},
			{Method: "POST", Origin: "*", Target: "*", Path: "/api", RequestBodyContains: stringPtr("classify"), ResponseStatus: intPtr(200)},
		})
		req := httptest.NewRequest("POST", "http://example.com/api", strings.NewReader(`something else`))
		got := manager.FindMatch(req)
		if got == nil || *got.ResponseStatus != 500 {
			t.Fatal("expected fallback mock (500) when body doesn't match")
		}
	})

	t.Run("different body matches route to different mocks", func(t *testing.T) {
		cache.SetMocks([]MockEndpoint{
			{Method: "POST", Origin: "*", Target: "*", Path: "/api", RequestBodyContains: stringPtr("classify"), ResponseStatus: intPtr(200)},
			{Method: "POST", Origin: "*", Target: "*", Path: "/api", RequestBodyContains: stringPtr("extract"), ResponseStatus: intPtr(201)},
			{Method: "POST", Origin: "*", Target: "*", Path: "/api", ResponseStatus: intPtr(500)},
		})

		req1 := httptest.NewRequest("POST", "http://example.com/api", strings.NewReader(`classify this ticket`))
		got1 := manager.FindMatch(req1)
		if got1 == nil || *got1.ResponseStatus != 200 {
			t.Fatal("expected classify mock (200)")
		}

		req2 := httptest.NewRequest("POST", "http://example.com/api", strings.NewReader(`extract entities`))
		got2 := manager.FindMatch(req2)
		if got2 == nil || *got2.ResponseStatus != 201 {
			t.Fatal("expected extract mock (201)")
		}

		req3 := httptest.NewRequest("POST", "http://example.com/api", strings.NewReader(`unknown request`))
		got3 := manager.FindMatch(req3)
		if got3 == nil || *got3.ResponseStatus != 500 {
			t.Fatal("expected fallback mock (500)")
		}
	})

	t.Run("max specificity score is 7", func(t *testing.T) {
		urlMap := UrlMap{"svc": ServiceInfo{Name: "test-origin"}}
		manager := NewMockManager(cache, nil, "test-origin", func() UrlMap { return urlMap })
		mock := MockEndpoint{
			Method: "POST", Origin: "svc", Target: "api.example.com",
			Path: "/exact", RequestBodyContains: stringPtr("test"),
		}
		req := httptest.NewRequest("POST", "http://api.example.com/exact", nil)
		score := manager.calculateSpecificity(&mock, req, urlMap)
		if score != 6 {
			t.Errorf("expected max specificity 6, got %d", score)
		}
	})
}

// TestMockManager_BodyBuffering tests that request body remains readable after FindMatch
func TestMockManager_BodyBuffering(t *testing.T) {
	cache := NewMockCache(5 * time.Minute)
	urlMapFunc := func() UrlMap { return make(UrlMap) }
	manager := NewMockManager(cache, nil, "test-origin", urlMapFunc)

	t.Run("body readable after FindMatch", func(t *testing.T) {
		cache.SetMocks([]MockEndpoint{
			{Method: "POST", Origin: "*", Target: "*", Path: "/api", RequestBodyContains: stringPtr("hello"), ResponseStatus: intPtr(200)},
		})
		body := `{"message": "hello world"}`
		req := httptest.NewRequest("POST", "http://example.com/api", strings.NewReader(body))
		manager.FindMatch(req)
		// Body should still be readable
		remaining, err := io.ReadAll(req.Body)
		if err != nil {
			t.Fatalf("error reading body after FindMatch: %v", err)
		}
		if string(remaining) != body {
			t.Errorf("body after FindMatch = %q, want %q", string(remaining), body)
		}
	})

	t.Run("body not read when no mocks use body matching", func(t *testing.T) {
		cache.SetMocks([]MockEndpoint{
			{Method: "POST", Origin: "*", Target: "*", Path: "/api", ResponseStatus: intPtr(200)},
		})
		body := `{"message": "hello"}`
		req := httptest.NewRequest("POST", "http://example.com/api", strings.NewReader(body))
		manager.FindMatch(req)
		// Body should still be the original (not re-wrapped)
		remaining, err := io.ReadAll(req.Body)
		if err != nil {
			t.Fatalf("error reading body: %v", err)
		}
		if string(remaining) != body {
			t.Errorf("body = %q, want %q", string(remaining), body)
		}
	})
}
