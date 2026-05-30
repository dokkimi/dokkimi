package main

import (
	"fmt"
	"os"
	"strconv"
	"time"
)

// Config holds all configuration for the test-agent
type Config struct {
	// Server
	Port string

	// Config source: "configmap" (K8s, default) or "file" (Docker)
	ConfigSource   string
	ConfigFilePath string // Path to config JSON file (when ConfigSource=file)

	// Kubernetes
	K8sNamespace  string // Kubernetes namespace name (e.g., "dokkimi-abc123")
	ConfigMapName string // Name of the ConfigMap to read from

	// HTTP Client
	RequestTimeout  time.Duration
	MaxIdleConns    int
	IdleConnTimeout time.Duration

	// Interceptor
	InterceptorURL string // URL to global interceptor service (e.g., "http://interceptor-service.{namespace}.svc.cluster.local")

	// Control Tower — the monolith NestJS service. All log ingestion and
	// test-completion notifications go to this single URL.
	ControlTowerURL string

	// BrowserURL points at the co-located chromium sidecar's CDP endpoint
	// (e.g., "ws://localhost:9222" or "http://localhost:9222" for auto-discovery).
	// Only required when the test definition contains UI steps; empty is fine
	// otherwise. A UI step executed with an unset BrowserURL fails fast.
	BrowserURL string

	// Test execution
	DefaultTimeoutSeconds int

	// Default browser viewport dimensions (used when no viewport step is set)
	DefaultViewportWidth  int
	DefaultViewportHeight int
}

// LoadConfig loads configuration from environment variables
// All required env vars must be provided by Control Tower - no defaults!
func LoadConfig() (*Config, error) {
	k8sNamespace := os.Getenv("K8S_NAMESPACE")

	// Get URLs - Control Tower should always provide these
	interceptorURL := os.Getenv("INTERCEPTOR_URL")
	controlTowerURL := os.Getenv("CONTROL_TOWER_URL")

	configSource := os.Getenv("CONFIG_SOURCE")
	if configSource == "" {
		configSource = "configmap"
	}

	cfg := &Config{
		// Required fields - Control Tower MUST provide these
		Port:         os.Getenv("PORT"),
		K8sNamespace: k8sNamespace,

		// Config source
		ConfigSource:   configSource,
		ConfigFilePath: os.Getenv("CONFIG_FILE_PATH"),

		// Optional fields with reasonable defaults
		ConfigMapName: os.Getenv("CONFIG_MAP_NAME"),

		// HTTP client settings (hardcoded constants - not configurable)
		RequestTimeout:        30 * time.Second,
		MaxIdleConns:          100,
		IdleConnTimeout:       90 * time.Second,
		DefaultTimeoutSeconds: 300,

		// URLs provided by Control Tower
		InterceptorURL:  interceptorURL,
		ControlTowerURL: controlTowerURL,

		// Optional: browser sidecar CDP endpoint (required only when UI steps run)
		BrowserURL: os.Getenv("BROWSER_URL"),
	}

	// Apply defaults for optional fields if not set
	if cfg.ConfigMapName == "" {
		cfg.ConfigMapName = "dokkimi-interceptor-config"
	}

	cfg.DefaultViewportWidth = 1280
	cfg.DefaultViewportHeight = 720
	if w := os.Getenv("DEFAULT_VIEWPORT_WIDTH"); w != "" {
		if v, err := strconv.Atoi(w); err == nil && v > 0 {
			cfg.DefaultViewportWidth = v
		}
	}
	if h := os.Getenv("DEFAULT_VIEWPORT_HEIGHT"); h != "" {
		if v, err := strconv.Atoi(h); err == nil && v > 0 {
			cfg.DefaultViewportHeight = v
		}
	}

	// Validate required fields - fail fast if Control Tower didn't provide them
	if cfg.Port == "" {
		return nil, fmt.Errorf("PORT is required (must be provided by Control Tower)")
	}
	if cfg.K8sNamespace == "" {
		return nil, fmt.Errorf("K8S_NAMESPACE is required (must be provided by Control Tower)")
	}
	if cfg.ControlTowerURL == "" {
		return nil, fmt.Errorf("CONTROL_TOWER_URL is required (must be provided by Control Tower)")
	}

	return cfg, nil
}
