package shared

import (
	"fmt"
	"os"
	"time"
)

var Version = "dev"

func LoadConfig() (*Config, error) {
	cfg := &Config{
		BrokerPort:       os.Getenv("BROKER_PORT"),
		BrokerType:       os.Getenv("BROKER_TYPE"),
		InstanceItemName: os.Getenv("INSTANCE_ITEM_NAME"),
		InstanceID:       os.Getenv("NAMESPACE"),
		InstanceItemID:   os.Getenv("NAMESPACE_ITEM_ID"),
		ControlTowerURL:  os.Getenv("CONTROL_TOWER_URL"),
		TestAgentURL:     os.Getenv("TEST_AGENT_URL"),
		ProxyPort:        os.Getenv("PROXY_PORT"),
		CheckTimeout:     5 * time.Second,
	}

	if cfg.BrokerPort == "" {
		return nil, fmt.Errorf("BROKER_PORT is required")
	}
	if cfg.InstanceItemName == "" {
		return nil, fmt.Errorf("INSTANCE_ITEM_NAME is required")
	}
	if cfg.InstanceID == "" {
		return nil, fmt.Errorf("NAMESPACE is required")
	}
	if cfg.ControlTowerURL == "" {
		return nil, fmt.Errorf("CONTROL_TOWER_URL is required")
	}
	if cfg.ProxyPort == "" {
		cfg.ProxyPort = "5672"
	}

	return cfg, nil
}
