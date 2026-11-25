package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"slices"
	"strings"
	"time"

	"github.com/tsdkv/pathmatch"
)

// MockManager handles mock endpoint matching and response generation
type MockManager struct {
	cache  *MockCache
	origin string
}

// NewMockManager creates a new mock manager
func NewMockManager(cache *MockCache, origin string) *MockManager {
	return &MockManager{
		cache:  cache,
		origin: origin,
	}
}

// FindMatch finds a matching mock endpoint for the request
// Returns the most specific match, or the first of equally specific ones
func (m *MockManager) FindMatch(r *http.Request) *MockEndpoint {
	// Cache is automatically updated by ConfigMap watcher, no need to refresh
	mocks := m.cache.GetMocks()

	// Buffer body once if any mock uses body matching
	var bodyBytes []byte
	needsBody := false
	for _, mock := range mocks {
		if mock.RequestBodyContains != nil || mock.RequestBodyMatches != nil {
			needsBody = true
			break
		}
	}
	if needsBody && r.Body != nil {
		var err error
		bodyBytes, err = io.ReadAll(r.Body)
		if err != nil {
			log.Printf("[MockManager] Error reading request body for matching: %v", err)
			return nil
		}
		r.Body = io.NopCloser(bytes.NewReader(bodyBytes))
	}

	var bestMatch *MockEndpoint
	var best []int

	for i := range mocks {
		mock := &mocks[i]
		if m.matches(mock, r, bodyBytes) {
			if s := m.specificity(mock, r); slices.Compare(s, best) > 0 {
				best = s
				bestMatch = mock
			}
		}
	}

	return bestMatch
}

// specificity ranks a mock among those that match the same request. The values
// are compared in order, so each one only decides between mocks that are equal
// in those before it.
func (m *MockManager) specificity(mock *MockEndpoint, r *http.Request) []int {
	target := 1
	if mock.Target == "*" {
		target = 0
	} else if strings.Contains(mock.Target, ":") {
		target = 2 // host and port
	}

	origin := 0
	if mock.Origin != "*" && mock.Origin != "" {
		origin = 1
	}

	path, detail := 0, 0
	switch {
	case mock.Path == "*":
	case mock.Path == r.URL.Path:
		path = 3
	case strings.HasSuffix(mock.Path, "*"):
		path, detail = 1, len(mock.Path) // longer prefix first
	default:
		path, detail = 2, -strings.Count(m.normalizePathVariableSyntax(mock.Path), "{") // fewer variables first
	}

	method := 0
	if mock.Method != "*" {
		method = 1
	}

	body := 0
	if mock.RequestBodyContains != nil || mock.RequestBodyMatches != nil {
		body = 1
	}

	return []int{target, origin, path, detail, method, body}
}

// matches checks if a mock endpoint matches the request
func (m *MockManager) matches(mock *MockEndpoint, r *http.Request, bodyBytes []byte) bool {
	// Check origin: "*" or "" matches any caller, anything else only the one
	// with that name.
	if mock.Origin != "*" && mock.Origin != "" && mock.Origin != m.origin {
		return false
	}

	// Check target. If the mock's Target includes a port, match the Host header
	// verbatim (including port). Otherwise strip any port from Host so
	// "api.example.com" matches "api.example.com:8080".
	if mock.Target != "*" {
		host := r.Host
		if !strings.Contains(mock.Target, ":") {
			if idx := strings.LastIndex(host, ":"); idx != -1 {
				host = host[:idx]
			}
		}
		if !strings.EqualFold(mock.Target, host) {
			return false
		}
	}

	// Check method (case-insensitive, supports wildcard)
	if mock.Method != "*" && !strings.EqualFold(mock.Method, r.Method) {
		return false
	}

	// Check path (simple prefix match for now, can be enhanced)
	if !m.pathMatches(mock.Path, r.URL.Path) {
		return false
	}

	// Check request body (substring or regex)
	if mock.RequestBodyContains != nil {
		if bodyBytes == nil {
			return false
		}
		if !strings.Contains(strings.ToLower(string(bodyBytes)), strings.ToLower(*mock.RequestBodyContains)) {
			return false
		}
	}
	if mock.RequestBodyMatches != nil {
		if bodyBytes == nil || mock.compiledBodyRegex == nil {
			return false
		}
		if !mock.compiledBodyRegex.Match(bodyBytes) {
			return false
		}
	}

	return true
}

// pathMatches checks if path matches the pattern
// Supports:
//   - Exact matches: "/api/users" == "/api/users"
//   - Full wildcard: "*" matches anything
//   - Prefix wildcard: "/api/*" matches "/api/users", "/api/users/123", etc.
//   - Path variables: "/api/users/{userId}" matches "/api/users/123"
//   - Path variables (colon syntax): "/api/users/:id" matches "/api/users/123"
func (m *MockManager) pathMatches(pattern, path string) bool {
	// Full wildcard matches everything
	if pattern == "*" {
		return true
	}

	// Exact match
	if pattern == path {
		return true
	}

	// Prefix wildcard match (e.g., "/api/*")
	if strings.HasSuffix(pattern, "*") {
		prefix := strings.TrimSuffix(pattern, "*")
		return strings.HasPrefix(path, prefix)
	}

	// Path variable matching using pathmatch library
	// First, normalize :variable syntax to {variable} syntax
	normalizedPattern := m.normalizePathVariableSyntax(pattern)

	// Check if the normalized pattern contains variables
	if m.hasPathVariables(normalizedPattern) {
		matched, _, err := pathmatch.CompileAndMatch(normalizedPattern, path)
		if err == nil && matched {
			return true
		}
	}

	return false
}

// normalizePathVariableSyntax converts :variable syntax to {variable} syntax
// Example: "/api/users/:id" -> "/api/users/{id}"
func (m *MockManager) normalizePathVariableSyntax(pattern string) string {
	// Split by "/" and process each segment
	parts := strings.Split(pattern, "/")
	normalized := make([]string, 0, len(parts))

	for _, part := range parts {
		if strings.HasPrefix(part, ":") && len(part) > 1 {
			// Convert :variable to {variable}
			variableName := part[1:] // Remove the ":"
			normalized = append(normalized, "{"+variableName+"}")
		} else {
			normalized = append(normalized, part)
		}
	}

	return strings.Join(normalized, "/")
}

// hasPathVariables checks if a path pattern contains variable syntax
func (m *MockManager) hasPathVariables(pattern string) bool {
	// Check for {variable} syntax
	if strings.Contains(pattern, "{") && strings.Contains(pattern, "}") {
		return true
	}
	// Check for :variable syntax (colon at start of segment)
	parts := strings.Split(pattern, "/")
	for _, part := range parts {
		if strings.HasPrefix(part, ":") && len(part) > 1 {
			return true
		}
	}
	return false
}

// ApplyMock applies mock configuration to response. The delay ends early if ctx
// does, because the caller is gone.
func (m *MockManager) ApplyMock(ctx context.Context, mock *MockEndpoint) (*http.Response, error) {
	if mock.DelayMS != nil {
		select {
		case <-time.After(time.Duration(*mock.DelayMS) * time.Millisecond):
		case <-ctx.Done():
		}
	}

	// Create mock response
	statusCode := 200
	if mock.ResponseStatus != nil {
		statusCode = *mock.ResponseStatus
	}

	response := &http.Response{
		StatusCode: statusCode,
		Header:     make(http.Header),
		Body:       http.NoBody,
	}

	// Set response body
	if mock.ResponseBody != nil {
		bodyBytes := []byte(*mock.ResponseBody)
		response.Body = io.NopCloser(bytes.NewReader(bodyBytes))
		response.ContentLength = int64(len(bodyBytes))
		response.Header.Set("Content-Type", "application/json")
	}

	// Set response headers
	if mock.ResponseHeaders != nil {
		var headers map[string]interface{}
		if err := json.Unmarshal([]byte(*mock.ResponseHeaders), &headers); err == nil {
			for key, value := range headers {
				switch v := value.(type) {
				case string:
					response.Header.Set(key, v)
				case []interface{}:
					for _, val := range v {
						if valStr, ok := val.(string); ok {
							response.Header.Add(key, valStr)
						}
					}
				default:
					response.Header.Set(key, fmt.Sprintf("%v", v))
				}
			}
		}
	}

	return response, nil
}
