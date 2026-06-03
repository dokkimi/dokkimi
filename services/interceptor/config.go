package main

import (
	"fmt"
	"os"
	"time"
)

// Config holds all configuration for the interceptor
type Config struct {
	// Server
	Port string

	APIKey string

	// Control Tower — the monolith NestJS service. Log ingestion and
	// health/readiness updates go here.
	ControlTowerURL string

	// DNS
	DNSIP string // DNS IP for resolving service names (bypasses dnsmasq)

	// Environment
	ConfigFilePath string // Path to config JSON file
	Namespace      string // Namespace ID (e.g., "abc123")
	Origin         string

	// Logging
	LogActions bool

	// HTTP Client
	RequestTimeout  time.Duration
	LoggingTimeout  time.Duration
	MaxIdleConns    int
	IdleConnTimeout time.Duration

	// Cache
	MockCacheTTL      time.Duration
	MockRefreshPeriod time.Duration

	// Health Check (optional)
	HealthCheckEndpoint string
	ServicePort         string
	NamespaceItemID     string

	// Test Agent (optional - only set when namespace has tests)
	TestAgentURL string

	// TLS/HTTPS MITM (optional - only if CA is mounted)
	CACertPath string
	CAKeyPath  string
}

// LoadConfig loads configuration from environment variables
// All required env vars must be provided by Control Tower - no defaults!
func LoadConfig() (*Config, error) {
	cfg := &Config{
		// Required fields - Control Tower MUST provide these
		Port:            os.Getenv("PORT"),
		APIKey:          os.Getenv("API_KEY"),
		ControlTowerURL: os.Getenv("CONTROL_TOWER_URL"),
		Namespace:       os.Getenv("NAMESPACE"),
		DNSIP:           os.Getenv("DNS_IP"),

		// Optional fields
		ConfigFilePath: os.Getenv("CONFIG_FILE_PATH"),
		Origin:         os.Getenv("ORIGIN"),
		LogActions:     os.Getenv("LOG_ACTIONS") != "false", // Default to true if not set

		// HTTP client settings (hardcoded constants - not configurable)
		RequestTimeout:    30 * time.Second,
		LoggingTimeout:    5 * time.Second,
		MaxIdleConns:      100,
		IdleConnTimeout:   90 * time.Second,
		MockCacheTTL:      5 * time.Minute,
		MockRefreshPeriod: 1 * time.Minute,

		// Optional health check configuration
		HealthCheckEndpoint: os.Getenv("HEALTH_CHECK_ENDPOINT"),
		ServicePort:         os.Getenv("SERVICE_PORT"),
		NamespaceItemID:     os.Getenv("NAMESPACE_ITEM_ID"),

		// Optional test agent URL (only set when namespace has tests)
		TestAgentURL: os.Getenv("TEST_AGENT_URL"),

		// Optional TLS/HTTPS MITM CA paths
		CACertPath: os.Getenv("DOKKIMI_CA_CERT_PATH"),
		CAKeyPath:  os.Getenv("DOKKIMI_CA_KEY_PATH"),
	}

	// Validate required fields - fail fast if Control Tower didn't provide them
	if cfg.Port == "" {
		return nil, fmt.Errorf("PORT is required (must be provided by Control Tower)")
	}
	if cfg.APIKey == "" {
		return nil, fmt.Errorf("API_KEY is required (must be provided by Control Tower)")
	}
	if cfg.ControlTowerURL == "" {
		return nil, fmt.Errorf("CONTROL_TOWER_URL is required (must be provided by Control Tower)")
	}
	if cfg.Namespace == "" {
		return nil, fmt.Errorf("NAMESPACE is required (must be provided by Control Tower)")
	}

	return cfg, nil
}
