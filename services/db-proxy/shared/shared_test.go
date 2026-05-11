package shared

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestIsConnClosed(t *testing.T) {
	tests := []struct {
		name string
		err  error
		want bool
	}{
		{"nil error", nil, false},
		{"closed conn", errors.New("use of closed network connection"), true},
		{"reset by peer", errors.New("connection reset by peer"), true},
		{"wrapped closed", errors.New("read: use of closed network connection"), true},
		{"wrapped reset", errors.New("write: connection reset by peer"), true},
		{"unrelated error", errors.New("timeout"), false},
		{"EOF", errors.New("EOF"), false},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := IsConnClosed(tt.err)
			if got != tt.want {
				t.Errorf("got %v, want %v", got, tt.want)
			}
		})
	}
}

func TestGetEnvOrDefault(t *testing.T) {
	key := "DOKKIMI_TEST_ENV_KEY_12345"
	os.Unsetenv(key)

	got := getEnvOrDefault(key, "fallback")
	if got != "fallback" {
		t.Errorf("expected fallback, got %q", got)
	}

	os.Setenv(key, "custom")
	defer os.Unsetenv(key)

	got = getEnvOrDefault(key, "fallback")
	if got != "custom" {
		t.Errorf("expected custom, got %q", got)
	}
}

func TestLoadConfig_MissingRequired(t *testing.T) {
	// Clear all required env vars
	for _, key := range []string{"DATABASE_PORT", "INSTANCE_ITEM_NAME", "NAMESPACE", "CONTROL_TOWER_URL", "DATABASE_TYPE", "NAMESPACE_ITEM_ID", "TEST_AGENT_URL", "QUERY_PORT", "DB_CREDENTIALS_PATH", "DB_USER", "DB_PASSWORD", "DB_NAME"} {
		os.Unsetenv(key)
	}

	tests := []struct {
		name    string
		envVars map[string]string
		wantErr string
	}{
		{
			"missing DATABASE_PORT",
			map[string]string{},
			"DATABASE_PORT",
		},
		{
			"missing INSTANCE_ITEM_NAME",
			map[string]string{"DATABASE_PORT": "5432"},
			"INSTANCE_ITEM_NAME",
		},
		{
			"missing NAMESPACE",
			map[string]string{"DATABASE_PORT": "5432", "INSTANCE_ITEM_NAME": "pg"},
			"NAMESPACE",
		},
		{
			"missing CONTROL_TOWER_URL",
			map[string]string{"DATABASE_PORT": "5432", "INSTANCE_ITEM_NAME": "pg", "NAMESPACE": "ns-1"},
			"CONTROL_TOWER_URL",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			for _, key := range []string{"DATABASE_PORT", "INSTANCE_ITEM_NAME", "NAMESPACE", "CONTROL_TOWER_URL"} {
				os.Unsetenv(key)
			}
			for k, v := range tt.envVars {
				os.Setenv(k, v)
			}

			_, err := LoadConfig("postgres")
			if err == nil {
				t.Fatal("expected error")
			}
			if got := err.Error(); !contains(got, tt.wantErr) {
				t.Errorf("error %q should mention %q", got, tt.wantErr)
			}
		})
	}

	// Cleanup
	for _, key := range []string{"DATABASE_PORT", "INSTANCE_ITEM_NAME", "NAMESPACE", "CONTROL_TOWER_URL"} {
		os.Unsetenv(key)
	}
}

func TestLoadConfig_Success(t *testing.T) {
	envVars := map[string]string{
		"DATABASE_PORT":      "5432",
		"DATABASE_TYPE":      "postgres",
		"INSTANCE_ITEM_NAME": "pg-db",
		"NAMESPACE":          "ns-123",
		"CONTROL_TOWER_URL":  "http://localhost:19001",
		"NAMESPACE_ITEM_ID":  "item-456",
		"TEST_AGENT_URL":     "http://localhost:8080",
	}
	for k, v := range envVars {
		os.Setenv(k, v)
		defer os.Unsetenv(k)
	}
	os.Unsetenv("QUERY_PORT")
	os.Unsetenv("DB_CREDENTIALS_PATH")

	cfg, err := LoadConfig("postgres")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	if cfg.DatabasePort != "5432" {
		t.Errorf("DatabasePort: got %q, want 5432", cfg.DatabasePort)
	}
	if cfg.DatabaseType != "postgres" {
		t.Errorf("DatabaseType: got %q, want postgres", cfg.DatabaseType)
	}
	if cfg.InstanceID != "ns-123" {
		t.Errorf("InstanceID: got %q, want ns-123", cfg.InstanceID)
	}
	if cfg.ControlTowerURL != "http://localhost:19001" {
		t.Errorf("ControlTowerURL: got %q", cfg.ControlTowerURL)
	}
	if cfg.QueryPort != "8080" {
		t.Errorf("QueryPort default: got %q, want 8080", cfg.QueryPort)
	}
	if cfg.CheckTimeout != 5*time.Second {
		t.Errorf("CheckTimeout: got %v, want 5s", cfg.CheckTimeout)
	}
	if cfg.DatabaseCredentials.DBUser != "postgres" {
		t.Errorf("DBUser default: got %q, want postgres", cfg.DatabaseCredentials.DBUser)
	}
}

func TestLoadConfig_CustomQueryPort(t *testing.T) {
	for k, v := range map[string]string{
		"DATABASE_PORT":      "5432",
		"DATABASE_TYPE":      "postgres",
		"INSTANCE_ITEM_NAME": "pg-db",
		"NAMESPACE":          "ns-1",
		"CONTROL_TOWER_URL":  "http://ct",
		"QUERY_PORT":         "9090",
	} {
		os.Setenv(k, v)
		defer os.Unsetenv(k)
	}
	os.Unsetenv("DB_CREDENTIALS_PATH")

	cfg, err := LoadConfig("postgres")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if cfg.QueryPort != "9090" {
		t.Errorf("QueryPort: got %q, want 9090", cfg.QueryPort)
	}
}

func TestLoadDatabaseCredentials_FromFile(t *testing.T) {
	tmpDir := t.TempDir()
	credFile := filepath.Join(tmpDir, "creds.json")

	creds := map[string]DatabaseCredentials{
		"mydb": {
			DBUser:     "fileuser",
			DBPassword: "filepass",
			DBName:     "filedb",
		},
	}
	data, _ := json.Marshal(creds)
	os.WriteFile(credFile, data, 0644)

	cfg := &Config{}
	os.Setenv("DB_CREDENTIALS_PATH", credFile)
	defer os.Unsetenv("DB_CREDENTIALS_PATH")

	err := cfg.LoadDatabaseCredentials("defaultuser")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if cfg.DatabaseCredentials.DBUser != "fileuser" {
		t.Errorf("DBUser: got %q, want fileuser", cfg.DatabaseCredentials.DBUser)
	}
	if cfg.DatabaseCredentials.DBPassword != "filepass" {
		t.Errorf("DBPassword: got %q, want filepass", cfg.DatabaseCredentials.DBPassword)
	}
	if cfg.DatabaseCredentials.DBName != "filedb" {
		t.Errorf("DBName: got %q, want filedb", cfg.DatabaseCredentials.DBName)
	}
}

func TestLoadDatabaseCredentials_BadFile_FallsBack(t *testing.T) {
	tmpDir := t.TempDir()
	credFile := filepath.Join(tmpDir, "bad.json")
	os.WriteFile(credFile, []byte("not json"), 0644)

	cfg := &Config{}
	os.Setenv("DB_CREDENTIALS_PATH", credFile)
	defer os.Unsetenv("DB_CREDENTIALS_PATH")
	os.Unsetenv("DB_USER")
	os.Unsetenv("DB_PASSWORD")
	os.Unsetenv("DB_NAME")

	err := cfg.LoadDatabaseCredentials("root")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if cfg.DatabaseCredentials.DBUser != "root" {
		t.Errorf("DBUser fallback: got %q, want root", cfg.DatabaseCredentials.DBUser)
	}
	if cfg.DatabaseCredentials.DBPassword != "dokkimi" {
		t.Errorf("DBPassword fallback: got %q, want dokkimi", cfg.DatabaseCredentials.DBPassword)
	}
}

func TestLoadDatabaseCredentials_EnvVars(t *testing.T) {
	os.Unsetenv("DB_CREDENTIALS_PATH")
	os.Setenv("DB_USER", "envuser")
	os.Setenv("DB_PASSWORD", "envpass")
	os.Setenv("DB_NAME", "envdb")
	defer func() {
		os.Unsetenv("DB_USER")
		os.Unsetenv("DB_PASSWORD")
		os.Unsetenv("DB_NAME")
	}()

	cfg := &Config{}
	err := cfg.LoadDatabaseCredentials("default")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if cfg.DatabaseCredentials.DBUser != "envuser" {
		t.Errorf("DBUser: got %q, want envuser", cfg.DatabaseCredentials.DBUser)
	}
	if cfg.DatabaseCredentials.DBPassword != "envpass" {
		t.Errorf("DBPassword: got %q, want envpass", cfg.DatabaseCredentials.DBPassword)
	}
	if cfg.DatabaseCredentials.DBName != "envdb" {
		t.Errorf("DBName: got %q, want envdb", cfg.DatabaseCredentials.DBName)
	}
}

func TestLoadDatabaseCredentials_MissingFile_FallsBack(t *testing.T) {
	os.Setenv("DB_CREDENTIALS_PATH", "/nonexistent/path/creds.json")
	defer os.Unsetenv("DB_CREDENTIALS_PATH")
	os.Unsetenv("DB_USER")
	os.Unsetenv("DB_PASSWORD")
	os.Unsetenv("DB_NAME")

	cfg := &Config{}
	err := cfg.LoadDatabaseCredentials("mongo")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if cfg.DatabaseCredentials.DBUser != "mongo" {
		t.Errorf("DBUser fallback: got %q, want mongo", cfg.DatabaseCredentials.DBUser)
	}
}

func TestGetDatabaseCredentials(t *testing.T) {
	cfg := &Config{
		DatabaseCredentials: DatabaseCredentials{
			DBUser:     "u",
			DBPassword: "p",
			DBName:     "d",
		},
	}
	creds := cfg.GetDatabaseCredentials()
	if creds.DBUser != "u" || creds.DBPassword != "p" || creds.DBName != "d" {
		t.Errorf("unexpected credentials: %+v", creds)
	}
}

func TestNewBaseProxy(t *testing.T) {
	cfg := &Config{
		QueryPort:    "9090",
		DatabasePort: "5432",
	}
	logger := &QueryLogger{}
	handler := func(conn interface{}) {}
	_ = handler

	proxy := NewBaseProxy(cfg, logger, nil)
	if proxy.ListenAddr != ":9090" {
		t.Errorf("ListenAddr: got %q, want :9090", proxy.ListenAddr)
	}
	if proxy.UpstreamAddr != "localhost:5432" {
		t.Errorf("UpstreamAddr: got %q, want localhost:5432", proxy.UpstreamAddr)
	}
	if proxy.Config != cfg {
		t.Error("Config mismatch")
	}
	if proxy.Logger != logger {
		t.Error("Logger mismatch")
	}
}

func contains(s, substr string) bool {
	return len(s) >= len(substr) && (s == substr || len(s) > 0 && containsHelper(s, substr))
}

func containsHelper(s, substr string) bool {
	for i := 0; i <= len(s)-len(substr); i++ {
		if s[i:i+len(substr)] == substr {
			return true
		}
	}
	return false
}
