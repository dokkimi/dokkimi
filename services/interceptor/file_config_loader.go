package main

import (
	"encoding/json"
	"fmt"
	"log"
	"os"
	"sync"
)

// FileConfigLoader loads interceptor config from a JSON file (Docker mode).
type FileConfigLoader struct {
	filePath    string
	cache       *MockCache
	mu          sync.RWMutex
	initialized bool
}

// NewFileConfigLoader creates a loader that reads config from the given path.
func NewFileConfigLoader(filePath string, cache *MockCache) *FileConfigLoader {
	return &FileConfigLoader{
		filePath: filePath,
		cache:    cache,
	}
}

// Load reads the config file and populates the cache.
func (f *FileConfigLoader) Load() error {
	data, err := os.ReadFile(f.filePath)
	if err != nil {
		return fmt.Errorf("failed to read config file %s: %w", f.filePath, err)
	}

	var configData map[string]string
	if err := json.Unmarshal(data, &configData); err != nil {
		return fmt.Errorf("failed to parse config file: %w", err)
	}

	if mocksData, ok := configData[ConfigMapKeyMocks]; ok {
		var mocks []MockEndpoint
		if err := json.Unmarshal([]byte(mocksData), &mocks); err != nil {
			return fmt.Errorf("failed to parse mocks: %w", err)
		}
		f.cache.SetMocks(mocks)
		log.Printf("Loaded %d mock endpoints from config file", len(mocks))
	} else {
		f.cache.SetMocks([]MockEndpoint{})
	}

	if urlMapData, ok := configData[ConfigMapKeyUrlMap]; ok {
		var urlMap UrlMap
		if err := json.Unmarshal([]byte(urlMapData), &urlMap); err != nil {
			return fmt.Errorf("failed to parse URL map: %w", err)
		}
		f.cache.SetUrlMap(urlMap)
		log.Printf("Loaded URL map with %d entries from config file", len(urlMap))
	} else {
		f.cache.SetUrlMap(make(UrlMap))
	}

	f.mu.Lock()
	f.initialized = true
	f.mu.Unlock()

	return nil
}

// IsInitialized returns whether config has been loaded.
func (f *FileConfigLoader) IsInitialized() bool {
	f.mu.RLock()
	defer f.mu.RUnlock()
	return f.initialized
}

// Stop is a no-op (satisfies the same pattern as ConfigMapWatcher).
func (f *FileConfigLoader) Stop() {}
