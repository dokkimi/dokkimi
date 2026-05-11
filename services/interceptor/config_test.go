package main

import (
	"os"
	"testing"
	"time"
)

func TestLoadConfig(t *testing.T) {
	// Save original env vars
	originalEnv := map[string]string{
		"CONTROL_TOWER_URL": os.Getenv("CONTROL_TOWER_URL"),
		"API_KEY":           os.Getenv("API_KEY"),
		"K8S_NAMESPACE":     os.Getenv("K8S_NAMESPACE"),
		"NAMESPACE":         os.Getenv("NAMESPACE"),
		"PORT":              os.Getenv("PORT"),
		"ORIGIN":            os.Getenv("ORIGIN"),
		"LOG_ACTIONS":       os.Getenv("LOG_ACTIONS"),
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
				"CONTROL_TOWER_URL": "http://localhost:5000",
				"API_KEY":           "test-key",
				"K8S_NAMESPACE":     "dokkimi-test-namespace",
				"NAMESPACE":         "test-namespace",
				"PORT":              "80",
			},
			wantErr: false,
			validate: func(t *testing.T, cfg *Config) {
				if cfg.APIKey != "test-key" {
					t.Errorf("Expected APIKey to be test-key, got %s", cfg.APIKey)
				}
				if cfg.K8sNamespace != "dokkimi-test-namespace" {
					t.Errorf("Expected K8sNamespace to be dokkimi-test-namespace, got %s", cfg.K8sNamespace)
				}
				if cfg.Namespace != "test-namespace" {
					t.Errorf("Expected Namespace to be test-namespace, got %s", cfg.Namespace)
				}
				if cfg.Port != "80" {
					t.Errorf("Expected Port to be 80, got %s", cfg.Port)
				}
				if cfg.RequestTimeout != 30*time.Second {
					t.Errorf("Expected RequestTimeout to be 30s, got %v", cfg.RequestTimeout)
				}
			},
		},
		{
			name: "missing PORT",
			env: map[string]string{
				"CONTROL_TOWER_URL": "http://localhost:5000",
				"API_KEY":           "test-key",
				"K8S_NAMESPACE":     "dokkimi-test-namespace",
				"NAMESPACE":         "test-namespace",
			},
			wantErr: true,
		},
		{
			name: "missing CONTROL_TOWER_URL",
			env: map[string]string{
				"API_KEY":       "test-key",
				"K8S_NAMESPACE": "dokkimi-test-namespace",
				"NAMESPACE":     "test-namespace",
				"PORT":          "80",
			},
			wantErr: true,
		},
		{
			name: "missing API_KEY",
			env: map[string]string{
				"CONTROL_TOWER_URL": "http://localhost:5000",
				"K8S_NAMESPACE":     "dokkimi-test-namespace",
				"NAMESPACE":         "test-namespace",
				"PORT":              "80",
			},
			wantErr: true,
		},
		{
			name: "missing K8S_NAMESPACE",
			env: map[string]string{
				"CONTROL_TOWER_URL": "http://localhost:5000",
				"API_KEY":           "test-key",
				"NAMESPACE":         "test-namespace",
				"PORT":              "80",
			},
			wantErr: true,
		},
		{
			name: "missing NAMESPACE",
			env: map[string]string{
				"CONTROL_TOWER_URL": "http://localhost:5000",
				"API_KEY":           "test-key",
				"K8S_NAMESPACE":     "dokkimi-test-namespace",
				"PORT":              "80",
			},
			wantErr: true,
		},
		{
			name: "custom port",
			env: map[string]string{
				"CONTROL_TOWER_URL": "http://localhost:5000",
				"API_KEY":           "test-key",
				"K8S_NAMESPACE":     "dokkimi-test-namespace",
				"NAMESPACE":         "test-namespace",
				"PORT":              "8080",
			},
			wantErr: false,
			validate: func(t *testing.T, cfg *Config) {
				if cfg.Port != "8080" {
					t.Errorf("Expected Port to be 8080, got %s", cfg.Port)
				}
			},
		},
		{
			name: "LOG_ACTIONS false",
			env: map[string]string{
				"CONTROL_TOWER_URL": "http://localhost:5000",
				"API_KEY":           "test-key",
				"K8S_NAMESPACE":     "dokkimi-test-namespace",
				"NAMESPACE":         "test-namespace",
				"PORT":              "80",
				"LOG_ACTIONS":       "false",
			},
			wantErr: false,
			validate: func(t *testing.T, cfg *Config) {
				if cfg.LogActions != false {
					t.Errorf("Expected LogActions to be false, got %v", cfg.LogActions)
				}
			},
		},
		{
			name: "LOG_ACTIONS true by default",
			env: map[string]string{
				"CONTROL_TOWER_URL": "http://localhost:5000",
				"API_KEY":           "test-key",
				"K8S_NAMESPACE":     "dokkimi-test-namespace",
				"NAMESPACE":         "test-namespace",
				"PORT":              "80",
			},
			wantErr: false,
			validate: func(t *testing.T, cfg *Config) {
				if cfg.LogActions != true {
					t.Errorf("Expected LogActions to be true by default, got %v", cfg.LogActions)
				}
			},
		},
		{
			name: "optional fields",
			env: map[string]string{
				"CONTROL_TOWER_URL": "http://localhost:5000",
				"API_KEY":           "test-key",
				"K8S_NAMESPACE":     "dokkimi-test-namespace",
				"NAMESPACE":         "test-namespace",
				"PORT":              "80",
				"ORIGIN":            "test-origin",
			},
			wantErr: false,
			validate: func(t *testing.T, cfg *Config) {
				if cfg.Origin != "test-origin" {
					t.Errorf("Expected Origin to be test-origin, got %s", cfg.Origin)
				}
			},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			// Clear all env vars first
			os.Clearenv()

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
