package shared

import (
	"encoding/json"
	"fmt"
	"os"
	"time"
)

// Version is set at build time via -ldflags "-X dokkimi.com/db-proxy-shared.Version=..."
var Version = "dev"

// LoadConfig loads configuration from environment variables
// All required env vars must be provided by Control Tower - no defaults!
// defaultDBUser is the default database user if not provided (e.g., "dokkimi" for postgres/mongo, "root" for mysql)
func LoadConfig(defaultDBUser string) (*Config, error) {
	cfg := &Config{
		// Required fields - Control Tower MUST provide these
		DatabasePort:     os.Getenv("DATABASE_PORT"),
		DatabaseType:     os.Getenv("DATABASE_TYPE"),
		InstanceItemName: os.Getenv("INSTANCE_ITEM_NAME"),
		InstanceID:       os.Getenv("NAMESPACE"), // NAMESPACE env var contains instance ID
		ControlTowerURL:   os.Getenv("CONTROL_TOWER_URL"),

		// Optional fields
		InstanceItemID: os.Getenv("NAMESPACE_ITEM_ID"),
		TestAgentURL:   os.Getenv("TEST_AGENT_URL"),
		QueryPort:      os.Getenv("QUERY_PORT"),

		// Hardcoded timeout - not configurable
		CheckTimeout: 5 * time.Second,
	}

	// Validate required fields - fail fast if Control Tower didn't provide them
	if cfg.DatabasePort == "" {
		return nil, fmt.Errorf("DATABASE_PORT is required (must be provided by Control Tower)")
	}
	if cfg.InstanceItemName == "" {
		return nil, fmt.Errorf("INSTANCE_ITEM_NAME is required (must be provided by Control Tower)")
	}
	if cfg.InstanceID == "" {
		return nil, fmt.Errorf("NAMESPACE is required (must be provided by Control Tower)")
	}
	if cfg.ControlTowerURL == "" {
		return nil, fmt.Errorf("CONTROL_TOWER_URL is required (must be provided by Control Tower)")
	}

	// Set default query port
	if cfg.QueryPort == "" {
		cfg.QueryPort = "8080"
	}

	// Load database credentials
	if err := cfg.LoadDatabaseCredentials(defaultDBUser); err != nil {
		return nil, fmt.Errorf("failed to load database credentials: %w", err)
	}

	return cfg, nil
}

// LoadDatabaseCredentials loads credentials from ConfigMap or environment variables
func (c *Config) LoadDatabaseCredentials(defaultDBUser string) error {
	// Try ConfigMap first (if DB_CREDENTIALS_PATH is set)
	credentialsPath := os.Getenv("DB_CREDENTIALS_PATH")
	if credentialsPath != "" {
		data, err := os.ReadFile(credentialsPath)
		if err == nil {
			var credsMap map[string]DatabaseCredentials
			if err := json.Unmarshal(data, &credsMap); err == nil {
				// Use the first (and should be only) database in the map
				// Since this is a sidecar, there's only one database per pod
				for _, creds := range credsMap {
					c.DatabaseCredentials = creds
					return nil
				}
			}
		}
		// If ConfigMap read fails, fall through to env vars
	}

	// Fallback to environment variables
	c.DatabaseCredentials = DatabaseCredentials{
		DBUser:     getEnvOrDefault("DB_USER", defaultDBUser),
		DBPassword: getEnvOrDefault("DB_PASSWORD", "dokkimi"),
		DBName:     getEnvOrDefault("DB_NAME", "dokkimi"),
	}

	return nil
}

// GetDatabaseCredentials returns the database credentials
func (c *Config) GetDatabaseCredentials() DatabaseCredentials {
	return c.DatabaseCredentials
}

// getEnvOrDefault gets an environment variable or returns a default value
func getEnvOrDefault(key, defaultValue string) string {
	if value := os.Getenv(key); value != "" {
		return value
	}
	return defaultValue
}

