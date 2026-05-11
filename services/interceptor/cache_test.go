package main

import (
	"testing"
	"time"
)

func TestNewMockCache(t *testing.T) {
	ttl := 5 * time.Minute
	cache := NewMockCache(ttl)

	if cache == nil {
		t.Fatal("NewMockCache() returned nil")
	}

	if cache.ttl != ttl {
		t.Errorf("Expected TTL to be %v, got %v", ttl, cache.ttl)
	}

	if cache.mocks == nil {
		t.Error("Expected mocks to be initialized")
	}

	if cache.urlMap == nil {
		t.Error("Expected urlMap to be initialized")
	}
}

func TestMockCache_GetMocks(t *testing.T) {
	cache := NewMockCache(5 * time.Minute)

	// Initially empty
	mocks := cache.GetMocks()
	if len(mocks) != 0 {
		t.Errorf("Expected empty mocks, got %d", len(mocks))
	}

	// Set mocks
	testMocks := []MockEndpoint{
		{Method: "GET", Path: "/test"},
		{Method: "POST", Path: "/test2"},
	}
	cache.SetMocks(testMocks)

	// Get mocks
	mocks = cache.GetMocks()
	if len(mocks) != 2 {
		t.Errorf("Expected 2 mocks, got %d", len(mocks))
	}

	if mocks[0].Method != "GET" {
		t.Errorf("Expected first mock method to be GET, got %s", mocks[0].Method)
	}
}

func TestMockCache_SetMocks(t *testing.T) {
	cache := NewMockCache(5 * time.Minute)

	testMocks := []MockEndpoint{
		{Method: "GET", Path: "/test"},
	}

	cache.SetMocks(testMocks)

	// Verify it was set
	mocks := cache.GetMocks()
	if len(mocks) != 1 {
		t.Errorf("Expected 1 mock, got %d", len(mocks))
	}

	// Verify lastUpdated was set
	if cache.lastUpdated.IsZero() {
		t.Error("Expected lastUpdated to be set")
	}
}

func TestMockCache_GetUrlMap(t *testing.T) {
	cache := NewMockCache(5 * time.Minute)

	// Initially empty
	urlMap := cache.GetUrlMap()
	if len(urlMap) != 0 {
		t.Errorf("Expected empty urlMap, got %d entries", len(urlMap))
	}

	// Set URL map
	testUrlMap := UrlMap{
		"example.com": ServiceInfo{
			Scheme: "https",
			URL:    "example.com",
			Name:   "example",
		},
	}
	cache.SetUrlMap(testUrlMap)

	// Get URL map
	urlMap = cache.GetUrlMap()
	if len(urlMap) != 1 {
		t.Errorf("Expected 1 URL map entry, got %d", len(urlMap))
	}

	if urlMap["example.com"].Name != "example" {
		t.Errorf("Expected service name to be example, got %s", urlMap["example.com"].Name)
	}
}

func TestMockCache_SetUrlMap(t *testing.T) {
	cache := NewMockCache(5 * time.Minute)

	testUrlMap := UrlMap{
		"test.com": ServiceInfo{
			Scheme: "https",
			URL:    "test.com",
			Name:   "test",
		},
	}

	cache.SetUrlMap(testUrlMap)

	// Verify it was set
	urlMap := cache.GetUrlMap()
	if len(urlMap) != 1 {
		t.Errorf("Expected 1 URL map entry, got %d", len(urlMap))
	}

	// Verify lastUpdated was set
	if cache.lastUpdated.IsZero() {
		t.Error("Expected lastUpdated to be set")
	}
}

func TestMockCache_IsStale(t *testing.T) {
	ttl := 100 * time.Millisecond
	cache := NewMockCache(ttl)

	// Initially stale (never updated)
	if !cache.IsStale() {
		t.Error("Expected cache to be stale initially")
	}

	// Set something to update lastUpdated
	cache.SetMocks([]MockEndpoint{{Method: "GET"}})

	// Should not be stale immediately
	if cache.IsStale() {
		t.Error("Expected cache to not be stale immediately after update")
	}

	// Wait for TTL to expire
	time.Sleep(ttl + 50*time.Millisecond)

	// Should be stale now
	if !cache.IsStale() {
		t.Error("Expected cache to be stale after TTL expired")
	}
}

func TestMockCache_Concurrency(t *testing.T) {
	cache := NewMockCache(5 * time.Minute)

	// Test concurrent access
	done := make(chan bool)

	// Writer goroutine
	go func() {
		for i := 0; i < 100; i++ {
			cache.SetMocks([]MockEndpoint{{Method: "GET", Path: "/test"}})
		}
		done <- true
	}()

	// Reader goroutines
	for i := 0; i < 10; i++ {
		go func() {
			for j := 0; j < 100; j++ {
				_ = cache.GetMocks()
				_ = cache.GetUrlMap()
				_ = cache.IsStale()
			}
			done <- true
		}()
	}

	// Wait for all goroutines
	for i := 0; i < 11; i++ {
		<-done
	}

	// Verify final state
	mocks := cache.GetMocks()
	if len(mocks) != 1 {
		t.Errorf("Expected 1 mock after concurrent access, got %d", len(mocks))
	}
}
