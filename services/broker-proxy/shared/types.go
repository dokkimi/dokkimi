package shared

import (
	"time"
)

type Config struct {
	BrokerPort       string
	BrokerType       string // "amqp"
	InstanceItemName string
	InstanceItemID   string
	InstanceID       string
	ControlTowerURL  string
	TestAgentURL     string
	ProxyPort        string
	CheckTimeout     time.Duration
}

type HealthState string

const (
	StateBooting   HealthState = "BOOTING"
	StateHealthy   HealthState = "HEALTHY"
	StateUnhealthy HealthState = "UNHEALTHY"
)

type HealthStatusUpdate struct {
	InstanceID       string              `json:"instanceId"`
	InstanceItemName string              `json:"instanceItemName"`
	InstanceItemID   string              `json:"instanceItemId"`
	Ready            bool                `json:"ready"`
	Timestamp        string              `json:"timestamp"`
	Details          HealthStatusDetails `json:"details,omitempty"`
}

type HealthStatusDetails struct {
	CheckDuration int    `json:"checkDuration,omitempty"`
	Error         string `json:"error,omitempty"`
}
