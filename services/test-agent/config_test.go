package main

import (
	"os"
	"testing"
	"time"
)

func TestLoadConfig(t *testing.T) {
	// Save original env vars
	originalEnv := map[string]string{
		"K8S_NAMESPACE":     os.Getenv("K8S_NAMESPACE"),
		"CONTROL_TOWER_URL": os.Getenv("CONTROL_TOWER_URL"),
		"PORT":              os.Getenv("PORT"),
		"CONFIG_MAP_NAME":   os.Getenv("CONFIG_MAP_NAME"),
		"CONFIG_SOURCE":     os.Getenv("CONFIG_SOURCE"),
		"CONFIG_FILE_PATH":  os.Getenv("CONFIG_FILE_PATH"),
	}

	// Restore original env vars after test
	defer func() {
		for k, v := range originalEnv {
			if v == "" {
				os.Unsetenv(k)
			} else {
				os.Setenv(k, v)
			}
		}
	}()

	tests := []struct {
		name     string
		env      map[string]string
		wantErr  bool
		validate func(*testing.T, *Config)
	}{
		{
			name: "valid config with all required fields",
			env: map[string]string{
				"K8S_NAMESPACE":     "dokkimi-test-namespace",
				"CONTROL_TOWER_URL": "http://localhost:19001",
				"PORT":              "8080",
			},
			wantErr: false,
			validate: func(t *testing.T, cfg *Config) {
				if cfg.K8sNamespace != "dokkimi-test-namespace" {
					t.Errorf("Expected K8sNamespace to be dokkimi-test-namespace, got %s", cfg.K8sNamespace)
				}
				if cfg.ControlTowerURL != "http://localhost:19001" {
					t.Errorf("Expected ControlTowerURL to be http://localhost:19001, got %s", cfg.ControlTowerURL)
				}
				if cfg.Port != "8080" {
					t.Errorf("Expected Port to be 8080, got %s", cfg.Port)
				}
				if cfg.ConfigMapName != "dokkimi-interceptor-config" {
					t.Errorf("Expected default ConfigMapName to be dokkimi-interceptor-config, got %s", cfg.ConfigMapName)
				}
				if cfg.RequestTimeout != 30*time.Second {
					t.Errorf("Expected RequestTimeout to be 30s, got %v", cfg.RequestTimeout)
				}
			},
		},
		{
			name: "missing K8S_NAMESPACE",
			env: map[string]string{
				"CONTROL_TOWER_URL": "http://localhost:19001",
			},
			wantErr: true,
		},
		{
			name: "missing CONTROL_TOWER_URL",
			env: map[string]string{
				"K8S_NAMESPACE": "dokkimi-test-namespace",
			},
			wantErr: true,
		},
		{
			name: "custom port",
			env: map[string]string{
				"K8S_NAMESPACE":     "dokkimi-test-namespace",
				"CONTROL_TOWER_URL": "http://localhost:19001",
				"PORT":              "9090",
			},
			wantErr: false,
			validate: func(t *testing.T, cfg *Config) {
				if cfg.Port != "9090" {
					t.Errorf("Expected Port to be 9090, got %s", cfg.Port)
				}
			},
		},
		{
			name: "custom config map name",
			env: map[string]string{
				"K8S_NAMESPACE":     "dokkimi-test-namespace",
				"CONTROL_TOWER_URL": "http://localhost:19001",
				"PORT":              "8080",
				"CONFIG_MAP_NAME":   "custom-config",
			},
			wantErr: false,
			validate: func(t *testing.T, cfg *Config) {
				if cfg.ConfigMapName != "custom-config" {
					t.Errorf("Expected ConfigMapName to be custom-config, got %s", cfg.ConfigMapName)
				}
			},
		},
		{
			name: "defaults to configmap source",
			env: map[string]string{
				"K8S_NAMESPACE":     "dokkimi-test-namespace",
				"CONTROL_TOWER_URL": "http://localhost:19001",
				"PORT":              "8080",
			},
			wantErr: false,
			validate: func(t *testing.T, cfg *Config) {
				if cfg.ConfigSource != "configmap" {
					t.Errorf("Expected ConfigSource to default to configmap, got %s", cfg.ConfigSource)
				}
			},
		},
		{
			name: "file config source",
			env: map[string]string{
				"K8S_NAMESPACE":     "dokkimi-test-namespace",
				"CONTROL_TOWER_URL": "http://localhost:19001",
				"PORT":              "8080",
				"CONFIG_SOURCE":     "file",
				"CONFIG_FILE_PATH":  "/etc/dokkimi/config.json",
			},
			wantErr: false,
			validate: func(t *testing.T, cfg *Config) {
				if cfg.ConfigSource != "file" {
					t.Errorf("Expected ConfigSource to be file, got %s", cfg.ConfigSource)
				}
				if cfg.ConfigFilePath != "/etc/dokkimi/config.json" {
					t.Errorf("Expected ConfigFilePath to be /etc/dokkimi/config.json, got %s", cfg.ConfigFilePath)
				}
			},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			// Clear all env vars first
			for k := range originalEnv {
				os.Unsetenv(k)
			}

			// Set test env vars
			for k, v := range tt.env {
				os.Setenv(k, v)
			}

			cfg, err := LoadConfig()

			if tt.wantErr {
				if err == nil {
					t.Errorf("LoadConfig() expected error but got none")
				}
				return
			}

			if err != nil {
				t.Errorf("LoadConfig() unexpected error: %v", err)
				return
			}

			if cfg == nil {
				t.Errorf("LoadConfig() returned nil config")
				return
			}

			if tt.validate != nil {
				tt.validate(t, cfg)
			}
		})
	}
}
