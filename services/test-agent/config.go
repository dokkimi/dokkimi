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

	// Config file
	ConfigFilePath string

	// HTTP Client
	RequestTimeout  time.Duration
	MaxIdleConns    int
	IdleConnTimeout time.Duration

	// Interceptor
	InterceptorURL string

	// Control Tower
	ControlTowerURL string

	// BrowserURL points at the co-located chromium sidecar's CDP endpoint.
	// Only required when the test definition contains UI steps.
	BrowserURL string

	// Test execution
	DefaultTimeoutSeconds int

	// Default browser viewport dimensions
	DefaultViewportWidth  int
	DefaultViewportHeight int

	// BaselinesPath is the directory where approved visual baselines are
	// bind-mounted. Empty when no baselines exist for this instance.
	BaselinesPath string
}

// LoadConfig loads configuration from environment variables
func LoadConfig() (*Config, error) {
	cfg := &Config{
		Port:           os.Getenv("PORT"),
		ConfigFilePath: os.Getenv("CONFIG_FILE_PATH"),

		// HTTP client settings
		RequestTimeout:        30 * time.Second,
		MaxIdleConns:          100,
		IdleConnTimeout:       90 * time.Second,
		DefaultTimeoutSeconds: 300,

		// URLs provided by Control Tower
		InterceptorURL:  os.Getenv("INTERCEPTOR_URL"),
		ControlTowerURL: os.Getenv("CONTROL_TOWER_URL"),

		// Optional: browser sidecar CDP endpoint
		BrowserURL: os.Getenv("BROWSER_URL"),

		// Optional: bind-mounted baselines directory for visual matching
		BaselinesPath: os.Getenv("BASELINES_PATH"),
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

	if cfg.Port == "" {
		return nil, fmt.Errorf("PORT is required")
	}
	if cfg.ControlTowerURL == "" {
		return nil, fmt.Errorf("CONTROL_TOWER_URL is required")
	}

	return cfg, nil
}
