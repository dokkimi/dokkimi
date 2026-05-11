package main

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"sync"
	"time"

	v1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/watch"
	"k8s.io/client-go/kubernetes"
	"k8s.io/client-go/rest"
	"k8s.io/client-go/tools/clientcmd"
)

const (
	// ConfigMapName is the name of the ConfigMap containing interceptor config
	ConfigMapName = "dokkimi-interceptor-config"
	// ConfigMapKeyMocks is the key in the ConfigMap for mock endpoints
	ConfigMapKeyMocks = "httpMocks"
	// ConfigMapKeyUrlMap is the key in the ConfigMap for URL map
	ConfigMapKeyUrlMap = "urlMap"
)

// ConfigMapWatcher watches a Kubernetes ConfigMap for changes
type ConfigMapWatcher struct {
	clientset   *kubernetes.Clientset
	namespace   string
	cache       *MockCache
	mu          sync.RWMutex
	stopCh      chan struct{}
	initialized bool
}

// NewConfigMapWatcher creates a new ConfigMap watcher
func NewConfigMapWatcher(namespace string, cache *MockCache) (*ConfigMapWatcher, error) {
	config, err := getKubernetesConfig()
	if err != nil {
		return nil, fmt.Errorf("failed to get Kubernetes config: %w", err)
	}

	clientset, err := kubernetes.NewForConfig(config)
	if err != nil {
		return nil, fmt.Errorf("failed to create Kubernetes client: %w", err)
	}

	return &ConfigMapWatcher{
		clientset: clientset,
		namespace: namespace,
		cache:     cache,
		stopCh:    make(chan struct{}),
	}, nil
}

// getKubernetesConfig gets Kubernetes client configuration
// Tries in-cluster config first with retries, then falls back to kubeconfig file
func getKubernetesConfig() (*rest.Config, error) {
	maxRetries := 5
	retryDelay := 2 * time.Second

	// Try in-cluster config first (when running in Kubernetes)
	// Retry in case service account token isn't mounted yet
	for attempt := 0; attempt < maxRetries; attempt++ {
		config, err := rest.InClusterConfig()
		if err == nil {
			return config, nil
		}

		if attempt < maxRetries-1 {
			log.Printf("Failed to get Kubernetes in-cluster config (attempt %d/%d): %v, retrying in %v...",
				attempt+1, maxRetries, err, retryDelay)
			time.Sleep(retryDelay)
			continue
		}

		// On last attempt, try fallback to kubeconfig
		log.Printf("In-cluster config failed after %d attempts, trying kubeconfig fallback...", maxRetries)
		kubeconfig := os.Getenv("KUBECONFIG")
		if kubeconfig == "" {
			kubeconfig = filepath.Join(os.Getenv("HOME"), ".kube", "config")
		}

		config, err = clientcmd.BuildConfigFromFlags("", kubeconfig)
		if err != nil {
			return nil, fmt.Errorf("failed to load kubeconfig after %d attempts: %w", maxRetries, err)
		}
		return config, nil
	}

	return nil, fmt.Errorf("failed to get Kubernetes config after %d attempts", maxRetries)
}

// Start starts watching the ConfigMap
func (w *ConfigMapWatcher) Start(ctx context.Context) error {
	// Load initial config
	if err := w.loadConfig(); err != nil {
		log.Printf("Warning: Failed to load initial ConfigMap: %v", err)
		// Don't fail startup, will retry on watch
	}

	// Start watch loop
	go w.watchLoop(ctx)

	return nil
}

// Stop stops watching the ConfigMap
func (w *ConfigMapWatcher) Stop() {
	select {
	case <-w.stopCh:
		// Already closed
	default:
		close(w.stopCh)
	}
}

// loadConfig loads the current ConfigMap content
func (w *ConfigMapWatcher) loadConfig() error {
	cm, err := w.clientset.CoreV1().ConfigMaps(w.namespace).Get(
		context.Background(),
		ConfigMapName,
		metav1.GetOptions{},
	)
	if err != nil {
		return fmt.Errorf("failed to get ConfigMap: %w", err)
	}

	return w.updateCache(cm)
}

// watchLoop watches for ConfigMap changes
func (w *ConfigMapWatcher) watchLoop(ctx context.Context) {
	for {
		watcher, err := w.clientset.CoreV1().ConfigMaps(w.namespace).Watch(
			ctx,
			metav1.SingleObject(metav1.ObjectMeta{
				Name:      ConfigMapName,
				Namespace: w.namespace,
			}),
		)
		if err != nil {
			log.Printf("Error creating ConfigMap watcher: %v", err)
			time.Sleep(5 * time.Second)
			continue
		}

		// Process watch events
		for {
			select {
			case <-w.stopCh:
				watcher.Stop()
				return
			case <-ctx.Done():
				watcher.Stop()
				return
			case event, ok := <-watcher.ResultChan():
				if !ok {
					// Channel closed, reconnect
					log.Printf("ConfigMap watch channel closed, reconnecting...")
					watcher.Stop()
					time.Sleep(2 * time.Second)
					break
				}

				if event.Type == watch.Error {
					log.Printf("ConfigMap watch error: %v", event.Object)
					continue
				}

				cm, ok := event.Object.(*v1.ConfigMap)
				if !ok {
					log.Printf("Unexpected object type in watch event: %T", event.Object)
					continue
				}

				if err := w.updateCache(cm); err != nil {
					log.Printf("Error updating cache from ConfigMap: %v", err)
				} else {
					log.Printf("ConfigMap updated (event: %s)", event.Type)
				}
			}
		}
	}
}

// updateCache updates the cache from ConfigMap data
func (w *ConfigMapWatcher) updateCache(cm *v1.ConfigMap) error {
	// Parse mocks
	if mocksData, ok := cm.Data[ConfigMapKeyMocks]; ok {
		var mocks []MockEndpoint
		if err := json.Unmarshal([]byte(mocksData), &mocks); err != nil {
			return fmt.Errorf("failed to parse mocks: %w", err)
		}
		w.cache.SetMocks(mocks)
		log.Printf("Loaded %d mock endpoints from ConfigMap", len(mocks))
	} else {
		// No mocks key, set empty array
		w.cache.SetMocks([]MockEndpoint{})
	}

	// Parse URL map
	if urlMapData, ok := cm.Data[ConfigMapKeyUrlMap]; ok {
		var urlMap UrlMap
		if err := json.Unmarshal([]byte(urlMapData), &urlMap); err != nil {
			return fmt.Errorf("failed to parse URL map: %w", err)
		}
		w.cache.SetUrlMap(urlMap)
		log.Printf("Loaded URL map with %d entries from ConfigMap", len(urlMap))
	} else {
		// No urlMap key, set empty map
		w.cache.SetUrlMap(make(UrlMap))
	}

	w.mu.Lock()
	w.initialized = true
	w.mu.Unlock()

	return nil
}

// IsInitialized returns whether the watcher has loaded initial config
func (w *ConfigMapWatcher) IsInitialized() bool {
	w.mu.RLock()
	defer w.mu.RUnlock()
	return w.initialized
}

