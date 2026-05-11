package main

import (
	"log"
	"regexp"
	"sync"
	"time"
)

// MockCache manages cached mock endpoints
type MockCache struct {
	mu          sync.RWMutex
	mocks       []MockEndpoint
	urlMap      UrlMap
	lastUpdated time.Time
	ttl         time.Duration
}

// NewMockCache creates a new mock cache
func NewMockCache(ttl time.Duration) *MockCache {
	return &MockCache{
		mocks:  make([]MockEndpoint, 0),
		urlMap: make(UrlMap),
		ttl:    ttl,
	}
}

// GetMocks returns cached mock endpoints
func (c *MockCache) GetMocks() []MockEndpoint {
	c.mu.RLock()
	defer c.mu.RUnlock()
	return c.mocks
}

// SetMocks updates cached mock endpoints and compiles body-match regexes
func (c *MockCache) SetMocks(mocks []MockEndpoint) {
	for i := range mocks {
		if mocks[i].RequestBodyMatches != nil {
			compiled, err := regexp.Compile(*mocks[i].RequestBodyMatches)
			if err != nil {
				log.Printf("[MockCache] Invalid regex in mock %q %s: %v — body regex disabled for this mock",
					mocks[i].Method, mocks[i].Path, err)
				mocks[i].RequestBodyMatches = nil
				continue
			}
			mocks[i].compiledBodyRegex = compiled
		}
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	c.mocks = mocks
	c.lastUpdated = time.Now()
}

// GetUrlMap returns cached URL map
func (c *MockCache) GetUrlMap() UrlMap {
	c.mu.RLock()
	defer c.mu.RUnlock()
	return c.urlMap
}

// SetUrlMap updates cached URL map
func (c *MockCache) SetUrlMap(urlMap UrlMap) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.urlMap = urlMap
	c.lastUpdated = time.Now()
}

// IsStale checks if cache needs refresh
// Note: With ConfigMap watching, this is no longer used for refresh logic,
// but kept for backward compatibility and potential future use
func (c *MockCache) IsStale() bool {
	c.mu.RLock()
	defer c.mu.RUnlock()
	return time.Since(c.lastUpdated) > c.ttl
}
