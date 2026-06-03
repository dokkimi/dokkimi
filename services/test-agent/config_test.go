package main

import (
	"os"
	"testing"
	"time"
)

func TestLoadConfig(t *testing.T) {
	originalEnv := map[string]string{
		"CONTROL_TOWER_URL": os.Getenv("CONTROL_TOWER_URL"),
		"PORT":              os.Getenv("PORT"),
		"CONFIG_FILE_PATH":  os.Getenv("CONFIG_FILE_PATH"),
	}

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
				"CONTROL_TOWER_URL": "http://localhost:19001",
				"PORT":              "8080",
			},
			wantErr: false,
			validate: func(t *testing.T, cfg *Config) {
				if cfg.ControlTowerURL != "http://localhost:19001" {
					t.Errorf("Expected ControlTowerURL to be http://localhost:19001, got %s", cfg.ControlTowerURL)
				}
				if cfg.Port != "8080" {
					t.Errorf("Expected Port to be 8080, got %s", cfg.Port)
				}
				if cfg.RequestTimeout != 30*time.Second {
					t.Errorf("Expected RequestTimeout to be 30s, got %v", cfg.RequestTimeout)
				}
			},
		},
		{
			name: "missing CONTROL_TOWER_URL",
			env: map[string]string{
				"PORT": "8080",
			},
			wantErr: true,
		},
		{
			name: "missing PORT",
			env: map[string]string{
				"CONTROL_TOWER_URL": "http://localhost:19001",
			},
			wantErr: true,
		},
		{
			name: "config file path",
			env: map[string]string{
				"CONTROL_TOWER_URL": "http://localhost:19001",
				"PORT":              "8080",
				"CONFIG_FILE_PATH":  "/etc/dokkimi/config.json",
			},
			wantErr: false,
			validate: func(t *testing.T, cfg *Config) {
				if cfg.ConfigFilePath != "/etc/dokkimi/config.json" {
					t.Errorf("Expected ConfigFilePath to be /etc/dokkimi/config.json, got %s", cfg.ConfigFilePath)
				}
			},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			for k := range originalEnv {
				os.Unsetenv(k)
			}

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
