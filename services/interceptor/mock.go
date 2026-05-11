package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"strings"
	"time"

	"github.com/tsdkv/pathmatch"
)

// MockManager handles mock endpoint matching and response generation
type MockManager struct {
	cache  *MockCache
	origin string
	urlMap func() UrlMap
}

// NewMockManager creates a new mock manager
func NewMockManager(cache *MockCache, _ interface{}, origin string, urlMap func() UrlMap) *MockManager {
	return &MockManager{
		cache:  cache,
		origin:  origin,
		urlMap:  urlMap,
	}
}

// FindMatch finds a matching mock endpoint for the request
// Returns the most specific match (specificity-based priority)
// When scores are equal, exact path matches are preferred over path variable matches
func (m *MockManager) FindMatch(r *http.Request) *MockEndpoint {
	// Cache is automatically updated by ConfigMap watcher, no need to refresh
	mocks := m.cache.GetMocks()
	urlMap := m.urlMap()

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
		// Cap matching input at 1MB to avoid excessive memory use
		const maxMatchBytes = 1 << 20
		if len(bodyBytes) > maxMatchBytes {
			bodyBytes = bodyBytes[:maxMatchBytes]
		}
	}

	var bestMatch *MockEndpoint
	bestScore := -1

	for i := range mocks {
		mock := &mocks[i]
		if m.matches(mock, r, urlMap, bodyBytes) {
			score := m.calculateSpecificity(mock, r, urlMap)
			// If scores are equal, prefer exact matches over path variable matches
			if score > bestScore || (score == bestScore && bestMatch != nil && mock.Path == r.URL.Path && bestMatch.Path != r.URL.Path) {
				bestScore = score
				bestMatch = mock
			}
		}
	}

	return bestMatch
}

// calculateSpecificity calculates a specificity score for a mock match
// Higher score = more specific match
// Scoring:
//   - Origin: specific (1) vs wildcard (0)
//   - Target: specific (1) vs wildcard (0)
//   - Method: specific (1) vs wildcard (0)
//   - Path: exact (2) vs variable (2) vs prefix (1) vs wildcard (0)
// Note: Path variables score 2 (same as exact) but exact matches are checked first in pathMatches
// Total possible score: 6 (was 5 before body matching)
func (m *MockManager) calculateSpecificity(mock *MockEndpoint, r *http.Request, _ UrlMap) int {
	score := 0

	// Origin specificity (0 or 1)
	if mock.Origin != "*" {
		score += 1
	}

	// Target specificity (0 or 1)
	if mock.Target != "*" {
		score += 1
	}

	// Method specificity (0 or 1)
	if mock.Method != "*" {
		score += 1
	}

	// Path specificity (0, 1, or 2)
	// Exact match = 2, Path variable = 2 (treated as equally specific), Prefix wildcard = 1, Full wildcard = 0
	if mock.Path == "*" {
		score += 0 // Full wildcard
	} else if mock.Path == r.URL.Path {
		score += 2 // Exact match
	} else if m.hasPathVariables(mock.Path) && m.pathMatches(mock.Path, r.URL.Path) {
		// Path variable match (e.g., /api/users/{id} matches /api/users/123)
		// Score: 2 (treated as equally specific as exact match for simplicity)
		// In practice, exact matches will be checked first, so exact > variable
		score += 2
	} else if strings.HasSuffix(mock.Path, "*") && m.pathMatches(mock.Path, r.URL.Path) {
		score += 1 // Prefix match
	}

	// Body specificity (0 or 1)
	if mock.RequestBodyContains != nil || mock.RequestBodyMatches != nil {
		score += 1
	}

	return score
}

// matches checks if a mock endpoint matches the request
func (m *MockManager) matches(mock *MockEndpoint, r *http.Request, urlMap UrlMap, bodyBytes []byte) bool {
	// Check origin:
	//   mock.Origin == "*" or "" → matches any interceptor (no origin restriction)
	//   mock.Origin == "service-key" → matches only that service's interceptor (via urlMap)
	if mock.Origin != "*" && mock.Origin != "" {
		if m.origin == "" {
			// Shared interceptor doesn't match service-specific mocks
			return false
		}
		serviceInfo, exists := urlMap[mock.Origin]
		if !exists || serviceInfo.Name != m.origin {
			return false
		}
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
		if mock.Target != host {
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
	if mock.compiledBodyRegex != nil {
		if bodyBytes == nil {
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

// ApplyMock applies mock configuration to response
func (m *MockManager) ApplyMock(mock *MockEndpoint) (*http.Response, error) {
	// Apply delay if specified
	if mock.DelayMS != nil {
		time.Sleep(time.Duration(*mock.DelayMS) * time.Millisecond)
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
	
	// Mark as mocked
	response.Header.Set("X-Mocked", "true")

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

