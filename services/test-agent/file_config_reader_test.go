package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

func TestFileConfigReader_ReadConfigData(t *testing.T) {
	t.Run("reads valid config file with all fields", func(t *testing.T) {
		dir := t.TempDir()
		configPath := filepath.Join(dir, "config.json")

		data := map[string]string{
			"expectedNamespaceItemIds": `["item-1","item-2"]`,
			"testConfig":               `{"testRunId":"run-1","timeoutSeconds":60,"executionMode":"auto","tests":[]}`,
			"urlMap":                   `{"api-gateway":{"scheme":"http","url":"http://api-gateway","name":"api-gateway","instanceItemId":"item-1"}}`,
			"databaseMap":              `{"postgres-db":{"type":"postgresql","user":"dokkimi","password":"dokkimi","database":"dokkimi","instanceItemId":"item-2"}}`,
		}
		raw, _ := json.Marshal(data)
		os.WriteFile(configPath, raw, 0644)

		reader := NewFileConfigReader(configPath)
		result, err := reader.ReadConfigData()
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}

		if len(result.ExpectedNamespaceItemIds) != 2 {
			t.Errorf("expected 2 namespace item IDs, got %d", len(result.ExpectedNamespaceItemIds))
		}
		if result.TestConfig == nil {
			t.Fatal("expected testConfig to be set")
		}
		if result.TestConfig.TestRunID != "run-1" {
			t.Errorf("expected testRunId=run-1, got %s", result.TestConfig.TestRunID)
		}
		if len(result.URLMap) != 1 {
			t.Errorf("expected 1 URL map entry, got %d", len(result.URLMap))
		}
		if result.URLMap["api-gateway"].Name != "api-gateway" {
			t.Errorf("expected URL map name=api-gateway, got %s", result.URLMap["api-gateway"].Name)
		}
		if len(result.DatabaseMap) != 1 {
			t.Errorf("expected 1 database map entry, got %d", len(result.DatabaseMap))
		}
	})

	t.Run("returns error for missing file", func(t *testing.T) {
		reader := NewFileConfigReader("/nonexistent/config.json")
		_, err := reader.ReadConfigData()
		if err == nil {
			t.Fatal("expected error for missing file")
		}
	})

	t.Run("returns error for missing testConfig", func(t *testing.T) {
		dir := t.TempDir()
		configPath := filepath.Join(dir, "config.json")

		data := map[string]string{
			"urlMap": `{}`,
		}
		raw, _ := json.Marshal(data)
		os.WriteFile(configPath, raw, 0644)

		reader := NewFileConfigReader(configPath)
		_, err := reader.ReadConfigData()
		if err == nil {
			t.Fatal("expected error for missing testConfig")
		}
	})

	t.Run("handles missing optional fields gracefully", func(t *testing.T) {
		dir := t.TempDir()
		configPath := filepath.Join(dir, "config.json")

		data := map[string]string{
			"testConfig": `{"testRunId":"run-1","timeoutSeconds":30,"executionMode":"auto","tests":[]}`,
		}
		raw, _ := json.Marshal(data)
		os.WriteFile(configPath, raw, 0644)

		reader := NewFileConfigReader(configPath)
		result, err := reader.ReadConfigData()
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}

		if result.URLMap == nil {
			t.Error("expected URLMap to be initialized (not nil)")
		}
		if result.DatabaseMap == nil {
			t.Error("expected DatabaseMap to be initialized (not nil)")
		}
	})

	t.Run("returns error for invalid JSON", func(t *testing.T) {
		dir := t.TempDir()
		configPath := filepath.Join(dir, "config.json")
		os.WriteFile(configPath, []byte("not json"), 0644)

		reader := NewFileConfigReader(configPath)
		_, err := reader.ReadConfigData()
		if err == nil {
			t.Fatal("expected error for invalid JSON")
		}
	})
}
