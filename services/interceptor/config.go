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

	// Kubernetes
	K8sNamespace string // Kubernetes namespace name (e.g., "dokkimi-abc123")
	K8sDNSIP     string // Kubernetes DNS IP (e.g., "10.96.0.10") - used to bypass dnsmasq

	// Environment
	Namespace string // Namespace ID (e.g., "abc123")
	Origin    string

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
		K8sNamespace:    os.Getenv("K8S_NAMESPACE"),
		Namespace:       os.Getenv("NAMESPACE"),
		K8sDNSIP:        os.Getenv("K8S_DNS_IP"), // Used to bypass dnsmasq for outbound connections

		// Optional fields
		Origin:     os.Getenv("ORIGIN"),
		LogActions: os.Getenv("LOG_ACTIONS") != "false", // Default to true if not set

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
	if cfg.K8sNamespace == "" {
		return nil, fmt.Errorf("K8S_NAMESPACE is required (must be provided by Control Tower)")
	}
	if cfg.Namespace == "" {
		return nil, fmt.Errorf("NAMESPACE is required (must be provided by Control Tower)")
	}

	return cfg, nil
}
