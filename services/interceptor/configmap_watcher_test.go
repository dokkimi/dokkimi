package main

import (
	"encoding/json"
	"testing"
	"time"

	v1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
)

// createTestWatcher creates a ConfigMapWatcher for testing
// Note: We create a watcher without a clientset since we're testing
// methods that don't require direct clientset access (updateCache, IsInitialized, Stop)
func createTestWatcher(namespace string, cache *MockCache) *ConfigMapWatcher {
	return &ConfigMapWatcher{
		namespace: namespace,
		cache:     cache,
		stopCh:    make(chan struct{}),
	}
}

func TestConfigMapWatcher_UpdateCache(t *testing.T) {
	namespace := "test-namespace"
	cache := NewMockCache(5 * time.Minute)

	mocks := []MockEndpoint{
		{Method: "POST", Path: "/api/users", Origin: "service-b"},
		{Method: "GET", Path: "/api/products", Origin: "service-c"},
	}
	mocksJSON, _ := json.Marshal(mocks)

	urlMap := UrlMap{
		"service-b.test.svc.cluster.local": ServiceInfo{
			Scheme: "http",
			URL:    "http://service-b:8080",
			Name:   "service-b",
		},
		"service-c.test.svc.cluster.local": ServiceInfo{
			Scheme: "https",
			URL:    "https://service-c:8443",
			Name:   "service-c",
		},
	}
	urlMapJSON, _ := json.Marshal(urlMap)

	configMap := &v1.ConfigMap{
		ObjectMeta: metav1.ObjectMeta{
			Name:      ConfigMapName,
			Namespace: namespace,
		},
		Data: map[string]string{
			ConfigMapKeyMocks:  string(mocksJSON),
			ConfigMapKeyUrlMap: string(urlMapJSON),
		},
	}

	watcher := createTestWatcher(namespace, cache)

	err := watcher.updateCache(configMap)
	if err != nil {
		t.Fatalf("updateCache() error = %v, want nil", err)
	}

	// Verify mocks were loaded
	loadedMocks := cache.GetMocks()
	if len(loadedMocks) != 2 {
		t.Errorf("Expected 2 mocks, got %d", len(loadedMocks))
	}
	if loadedMocks[0].Method != "POST" {
		t.Errorf("Expected first mock method POST, got %s", loadedMocks[0].Method)
	}

	// Verify URL map was loaded
	loadedUrlMap := cache.GetUrlMap()
	if len(loadedUrlMap) != 2 {
		t.Errorf("Expected 2 URL map entries, got %d", len(loadedUrlMap))
	}
	if loadedUrlMap["service-b.test.svc.cluster.local"].Name != "service-b" {
		t.Errorf("Expected service name service-b, got %s", loadedUrlMap["service-b.test.svc.cluster.local"].Name)
	}

	// Verify initialized flag
	if !watcher.IsInitialized() {
		t.Error("Expected watcher to be initialized after updateCache")
	}
}

func TestConfigMapWatcher_UpdateCache_EmptyMocks(t *testing.T) {
	namespace := "test-namespace"
	cache := NewMockCache(5 * time.Minute)

	urlMap := UrlMap{
		"service-a.test.svc.cluster.local": ServiceInfo{
			Scheme: "http",
			URL:    "http://service-a:8080",
			Name:   "service-a",
		},
	}
	urlMapJSON, _ := json.Marshal(urlMap)

	configMap := &v1.ConfigMap{
		ObjectMeta: metav1.ObjectMeta{
			Name:      ConfigMapName,
			Namespace: namespace,
		},
		Data: map[string]string{
			ConfigMapKeyUrlMap: string(urlMapJSON),
			// No mocks key
		},
	}

	watcher := createTestWatcher(namespace, cache)

	err := watcher.updateCache(configMap)
	if err != nil {
		t.Fatalf("updateCache() error = %v, want nil", err)
	}

	// Verify empty mocks were set
	loadedMocks := cache.GetMocks()
	if len(loadedMocks) != 0 {
		t.Errorf("Expected 0 mocks, got %d", len(loadedMocks))
	}
}

func TestConfigMapWatcher_UpdateCache_EmptyUrlMap(t *testing.T) {
	namespace := "test-namespace"
	cache := NewMockCache(5 * time.Minute)

	mocks := []MockEndpoint{
		{Method: "GET", Path: "/test"},
	}
	mocksJSON, _ := json.Marshal(mocks)

	configMap := &v1.ConfigMap{
		ObjectMeta: metav1.ObjectMeta{
			Name:      ConfigMapName,
			Namespace: namespace,
		},
		Data: map[string]string{
			ConfigMapKeyMocks: string(mocksJSON),
			// No urlMap key
		},
	}

	watcher := createTestWatcher(namespace, cache)

	err := watcher.updateCache(configMap)
	if err != nil {
		t.Fatalf("updateCache() error = %v, want nil", err)
	}

	// Verify empty URL map was set
	loadedUrlMap := cache.GetUrlMap()
	if len(loadedUrlMap) != 0 {
		t.Errorf("Expected 0 URL map entries, got %d", len(loadedUrlMap))
	}
}

func TestConfigMapWatcher_UpdateCache_InvalidMockJSON(t *testing.T) {
	namespace := "test-namespace"
	cache := NewMockCache(5 * time.Minute)

	configMap := &v1.ConfigMap{
		ObjectMeta: metav1.ObjectMeta{
			Name:      ConfigMapName,
			Namespace: namespace,
		},
		Data: map[string]string{
			ConfigMapKeyMocks: "invalid json {",
		},
	}

	watcher := createTestWatcher(namespace, cache)

	err := watcher.updateCache(configMap)
	if err == nil {
		t.Error("Expected error when mock JSON is invalid, got nil")
	}
}

func TestConfigMapWatcher_UpdateCache_InvalidUrlMapJSON(t *testing.T) {
	namespace := "test-namespace"
	cache := NewMockCache(5 * time.Minute)

	mocksJSON, _ := json.Marshal([]MockEndpoint{})

	configMap := &v1.ConfigMap{
		ObjectMeta: metav1.ObjectMeta{
			Name:      ConfigMapName,
			Namespace: namespace,
		},
		Data: map[string]string{
			ConfigMapKeyMocks:  string(mocksJSON),
			ConfigMapKeyUrlMap: "invalid json {",
		},
	}

	watcher := createTestWatcher(namespace, cache)

	err := watcher.updateCache(configMap)
	if err == nil {
		t.Error("Expected error when URL map JSON is invalid, got nil")
	}
}

func TestConfigMapWatcher_IsInitialized(t *testing.T) {
	watcher := createTestWatcher("test-namespace", NewMockCache(5*time.Minute))

	if watcher.IsInitialized() {
		t.Error("Expected IsInitialized() to return false initially")
	}

	// Set initialized using updateCache
	mocksJSON, _ := json.Marshal([]MockEndpoint{})
	urlMapJSON, _ := json.Marshal(UrlMap{})
	configMap := &v1.ConfigMap{
		ObjectMeta: metav1.ObjectMeta{
			Name:      ConfigMapName,
			Namespace: "test-namespace",
		},
		Data: map[string]string{
			ConfigMapKeyMocks:  string(mocksJSON),
			ConfigMapKeyUrlMap: string(urlMapJSON),
		},
	}

	err := watcher.updateCache(configMap)
	if err != nil {
		t.Fatalf("updateCache() error = %v", err)
	}

	if !watcher.IsInitialized() {
		t.Error("Expected IsInitialized() to return true after updateCache")
	}
}

func TestConfigMapWatcher_Stop(t *testing.T) {
	watcher := createTestWatcher("test-namespace", NewMockCache(5*time.Minute))

	// Verify stopCh is open
	select {
	case <-watcher.stopCh:
		t.Error("Expected stopCh to be open before Stop()")
	default:
		// Good, channel is open
	}

	watcher.Stop()

	// Verify stopCh is closed
	select {
	case <-watcher.stopCh:
		// Good, channel is closed
	default:
		t.Error("Expected stopCh to be closed after Stop()")
	}

	// Note: Calling Stop() again will panic because close() on an already closed channel panics
	// This is expected behavior - Stop() should only be called once
}

func TestConfigMapWatcher_Concurrency(t *testing.T) {
	namespace := "test-namespace"
	cache := NewMockCache(5 * time.Minute)

	mocks := []MockEndpoint{{Method: "GET", Path: "/test"}}
	mocksJSON, _ := json.Marshal(mocks)
	urlMapJSON, _ := json.Marshal(UrlMap{})

	configMap := &v1.ConfigMap{
		ObjectMeta: metav1.ObjectMeta{
			Name:      ConfigMapName,
			Namespace: namespace,
		},
		Data: map[string]string{
			ConfigMapKeyMocks:  string(mocksJSON),
			ConfigMapKeyUrlMap: string(urlMapJSON),
		},
	}

	watcher := createTestWatcher(namespace, cache)

	// Test concurrent access to IsInitialized
	done := make(chan bool, 10)
	for i := 0; i < 10; i++ {
		go func() {
			for j := 0; j < 100; j++ {
				_ = watcher.IsInitialized()
			}
			done <- true
		}()
	}

	// Concurrently update cache
	go func() {
		for i := 0; i < 50; i++ {
			_ = watcher.updateCache(configMap)
		}
		done <- true
	}()

	// Wait for all goroutines
	for i := 0; i < 11; i++ {
		<-done
	}

	// Verify final state
	if !watcher.IsInitialized() {
		t.Error("Expected watcher to be initialized after concurrent access")
	}
}

func TestConfigMapWatcher_UpdateCache_MultipleUpdates(t *testing.T) {
	namespace := "test-namespace"
	cache := NewMockCache(5 * time.Minute)

	watcher := createTestWatcher(namespace, cache)

	// First update
	mocks1 := []MockEndpoint{{Method: "GET", Path: "/first"}}
	mocks1JSON, _ := json.Marshal(mocks1)
	configMap1 := &v1.ConfigMap{
		ObjectMeta: metav1.ObjectMeta{
			Name:      ConfigMapName,
			Namespace: namespace,
		},
		Data: map[string]string{
			ConfigMapKeyMocks:  string(mocks1JSON),
			ConfigMapKeyUrlMap: "{}",
		},
	}

	err := watcher.updateCache(configMap1)
	if err != nil {
		t.Fatalf("First updateCache() error = %v", err)
	}

	if len(cache.GetMocks()) != 1 {
		t.Errorf("Expected 1 mock after first update, got %d", len(cache.GetMocks()))
	}

	// Second update
	mocks2 := []MockEndpoint{
		{Method: "POST", Path: "/second"},
		{Method: "PUT", Path: "/third"},
	}
	mocks2JSON, _ := json.Marshal(mocks2)
	configMap2 := &v1.ConfigMap{
		ObjectMeta: metav1.ObjectMeta{
			Name:      ConfigMapName,
			Namespace: namespace,
		},
		Data: map[string]string{
			ConfigMapKeyMocks:  string(mocks2JSON),
			ConfigMapKeyUrlMap: "{}",
		},
	}

	err = watcher.updateCache(configMap2)
	if err != nil {
		t.Fatalf("Second updateCache() error = %v", err)
	}

	// Verify cache was updated
	loadedMocks := cache.GetMocks()
	if len(loadedMocks) != 2 {
		t.Errorf("Expected 2 mocks after second update, got %d", len(loadedMocks))
	}
	if loadedMocks[0].Method != "POST" {
		t.Errorf("Expected first mock method POST, got %s", loadedMocks[0].Method)
	}
}

func TestConfigMapWatcher_UpdateCache_EmptyConfigMap(t *testing.T) {
	namespace := "test-namespace"
	cache := NewMockCache(5 * time.Minute)

	configMap := &v1.ConfigMap{
		ObjectMeta: metav1.ObjectMeta{
			Name:      ConfigMapName,
			Namespace: namespace,
		},
		Data: map[string]string{},
	}

	watcher := createTestWatcher(namespace, cache)

	err := watcher.updateCache(configMap)
	if err != nil {
		t.Fatalf("updateCache() error = %v, want nil", err)
	}

	// Verify empty mocks and URL map were set
	loadedMocks := cache.GetMocks()
	if len(loadedMocks) != 0 {
		t.Errorf("Expected 0 mocks, got %d", len(loadedMocks))
	}

	loadedUrlMap := cache.GetUrlMap()
	if len(loadedUrlMap) != 0 {
		t.Errorf("Expected 0 URL map entries, got %d", len(loadedUrlMap))
	}
}
