package shared

import (
	"time"
)

// DatabaseCredentials holds credentials for the database
type DatabaseCredentials struct {
	DBName     string
	DBUser     string
	DBPassword string
}

// Config holds all configuration for the db-proxy
type Config struct {
	DatabasePort     string
	DatabaseType     string // e.g., "postgres", "mysql", "mongodb", "redis"
	InstanceItemName string // Item definition name (e.g., "postgres-db", "mysql-db", "mongo-db")
	InstanceItemID   string // Instance item ID
	InstanceID       string // Instance ID
	ControlTowerURL  string
	TestAgentURL     string // Optional: URL for test-agent
	CheckTimeout     time.Duration
	QueryPort        string // Port for query endpoint (default: 8080)

	// Database credentials (loaded from env vars or credentials file)
	DatabaseCredentials DatabaseCredentials
}

// HealthState represents the current state of health checking
type HealthState string

const (
	StateBooting   HealthState = "BOOTING"
	StateHealthy   HealthState = "HEALTHY"
	StateUnhealthy HealthState = "UNHEALTHY"
)

// HealthStatusUpdate represents the status update sent to LPS
type HealthStatusUpdate struct {
	InstanceID       string              `json:"instanceId"`
	InstanceItemName string              `json:"instanceItemName"`
	InstanceItemID   string              `json:"instanceItemId"` // ID for test-agent matching
	Ready            bool                `json:"ready"`
	Timestamp        string              `json:"timestamp"`
	Details          HealthStatusDetails `json:"details,omitempty"`
}

// HealthStatusDetails contains additional details about the health check
type HealthStatusDetails struct {
	CheckDuration int    `json:"checkDuration,omitempty"`
	Error         string `json:"error,omitempty"`
}
