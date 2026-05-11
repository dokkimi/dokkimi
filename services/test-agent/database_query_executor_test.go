package main

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

func TestNewDatabaseQueryExecutor(t *testing.T) {
	databaseMap := map[string]DatabaseInfo{
		"postgres-db": {
			Type:           "postgresql",
			User:           "testuser",
			Password:       "testpass",
			Database:       "testdb",
			InstanceItemID: "item-123",
		},
	}

	executor := NewDatabaseQueryExecutor("http://log-processor:19002", databaseMap, "instance-123")

	if executor == nil {
		t.Fatal("NewDatabaseQueryExecutor returned nil")
	}

	if executor.logEndpointURL != "http://log-processor:19002" {
		t.Errorf("Expected logEndpointURL to be 'http://log-processor:19002', got '%s'", executor.logEndpointURL)
	}

	if executor.instanceId != "instance-123" {
		t.Errorf("Expected instanceId to be 'instance-123', got '%s'", executor.instanceId)
	}

	if len(executor.databaseMap) != 1 {
		t.Errorf("Expected databaseMap to have 1 entry, got %d", len(executor.databaseMap))
	}
}

func TestDatabaseQueryExecutor_ExecuteQuery_DatabaseNotFound(t *testing.T) {
	// Create a mock log processor server
	logServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != "POST" || r.URL.Path != "/logs/database" {
			t.Errorf("Unexpected request: %s %s", r.Method, r.URL.Path)
			w.WriteHeader(http.StatusBadRequest)
			return
		}

		var logMessage map[string]interface{}
		if err := json.NewDecoder(r.Body).Decode(&logMessage); err != nil {
			t.Errorf("Failed to decode log message: %v", err)
			w.WriteHeader(http.StatusBadRequest)
			return
		}

		// Verify log message structure
		if logMessage["success"] != false {
			t.Error("Expected success to be false")
		}
		if logMessage["databaseName"] != "nonexistent-db" {
			t.Errorf("Expected databaseName to be 'nonexistent-db', got '%v'", logMessage["databaseName"])
		}

		w.WriteHeader(http.StatusOK)
	}))
	defer logServer.Close()

	databaseMap := map[string]DatabaseInfo{
		"postgres-db": {
			Type:           "postgresql",
			User:           "testuser",
			Password:       "testpass",
			Database:       "testdb",
			InstanceItemID: "item-123",
		},
	}

	executor := NewDatabaseQueryExecutor(logServer.URL, databaseMap, "instance-123")
	executor.httpClient.Timeout = 5 * time.Second

	ctx := context.Background()
	result, err := executor.ExecuteQuery(ctx, "postgresql", "nonexistent-db", "SELECT 1", nil)

	if err == nil {
		t.Error("Expected error when database not found in databaseMap")
	}

	if result != nil {
		t.Error("Expected nil result when database not found")
	}

	if err.Error() != "database 'nonexistent-db' not found in databaseMap" {
		t.Errorf("Expected specific error message, got: %v", err)
	}
}

func TestDatabaseQueryExecutor_ExecuteQuery_UnsupportedDatabaseType(t *testing.T) {
	// Create a mock log processor server
	logServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var logMessage map[string]interface{}
		json.NewDecoder(r.Body).Decode(&logMessage)

		if logMessage["success"] != false {
			t.Error("Expected success to be false for unsupported database type")
		}

		w.WriteHeader(http.StatusOK)
	}))
	defer logServer.Close()

	databaseMap := map[string]DatabaseInfo{
		"test-db": {
			Type:           "postgresql",
			User:           "testuser",
			Password:       "testpass",
			Database:       "testdb",
			InstanceItemID: "item-123",
		},
	}

	executor := NewDatabaseQueryExecutor(logServer.URL, databaseMap, "instance-123")
	executor.httpClient.Timeout = 5 * time.Second

	ctx := context.Background()
	_, err := executor.ExecuteQuery(ctx, "unsupported-db", "test-db", "SELECT 1", nil)

	if err == nil {
		t.Error("Expected error for unsupported database type")
	}
}

func TestDatabaseQueryExecutor_LogQueryResult(t *testing.T) {
	var receivedLogMessage map[string]interface{}

	// Create a mock log processor server
	logServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != "POST" || r.URL.Path != "/logs/database" {
			w.WriteHeader(http.StatusBadRequest)
			return
		}

		if err := json.NewDecoder(r.Body).Decode(&receivedLogMessage); err != nil {
			t.Errorf("Failed to decode log message: %v", err)
			w.WriteHeader(http.StatusBadRequest)
			return
		}

		w.WriteHeader(http.StatusOK)
	}))
	defer logServer.Close()

	databaseMap := map[string]DatabaseInfo{
		"test-db": {
			Type:           "postgresql",
			User:           "testuser",
			Password:       "testpass",
			Database:       "testdb",
			InstanceItemID: "item-123",
		},
	}

	executor := NewDatabaseQueryExecutor(logServer.URL, databaseMap, "instance-123")
	executor.httpClient.Timeout = 5 * time.Second

	ctx := context.Background()
	params := map[string]interface{}{
		"email": "test@example.com",
	}

	// Test successful query logging
	data := []map[string]interface{}{
		{"id": 1, "name": "Test User", "email": "test@example.com"},
	}

	executor.logQueryResult(ctx, "postgresql", "test-db", "SELECT * FROM users WHERE email = $1", params, true, data, 1, "", 150)

	// Verify log message was sent correctly
	if receivedLogMessage == nil {
		t.Fatal("No log message was received")
	}

	if receivedLogMessage["instanceId"] != "instance-123" {
		t.Errorf("Expected instanceId to be 'instance-123', got '%v'", receivedLogMessage["instanceId"])
	}

	if receivedLogMessage["instanceItemId"] != "item-123" {
		t.Errorf("Expected instanceItemId to be 'item-123', got '%v'", receivedLogMessage["instanceItemId"])
	}

	if receivedLogMessage["databaseType"] != "postgresql" {
		t.Errorf("Expected databaseType to be 'postgresql', got '%v'", receivedLogMessage["databaseType"])
	}

	if receivedLogMessage["databaseName"] != "test-db" {
		t.Errorf("Expected databaseName to be 'test-db', got '%v'", receivedLogMessage["databaseName"])
	}

	if receivedLogMessage["success"] != true {
		t.Error("Expected success to be true")
	}

	// Duration might be a number or float64, check both
	duration, ok := receivedLogMessage["duration"].(float64)
	if !ok {
		durationInt, okInt := receivedLogMessage["duration"].(int)
		if !okInt {
			t.Errorf("Expected duration to be a number, got '%v' (type: %T)", receivedLogMessage["duration"], receivedLogMessage["duration"])
		} else if durationInt != 150 {
			t.Errorf("Expected duration to be 150, got %d", durationInt)
		}
	} else if duration != 150 {
		t.Errorf("Expected duration to be 150, got %f", duration)
	}

	// Verify data was included
	if dataArray, ok := receivedLogMessage["data"].([]interface{}); !ok || len(dataArray) != 1 {
		t.Error("Expected data array with 1 element")
	}
}

func TestDatabaseQueryExecutor_LogQueryResult_Error(t *testing.T) {
	var receivedLogMessage map[string]interface{}

	logServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		json.NewDecoder(r.Body).Decode(&receivedLogMessage)
		w.WriteHeader(http.StatusOK)
	}))
	defer logServer.Close()

	databaseMap := map[string]DatabaseInfo{
		"test-db": {
			Type:           "postgresql",
			User:           "testuser",
			Password:       "testpass",
			Database:       "testdb",
			InstanceItemID: "item-123",
		},
	}

	executor := NewDatabaseQueryExecutor(logServer.URL, databaseMap, "instance-123")
	executor.httpClient.Timeout = 5 * time.Second

	ctx := context.Background()
	executor.logQueryResult(ctx, "postgresql", "test-db", "SELECT * FROM users", nil, false, nil, 0, "connection failed", 50)

	if receivedLogMessage["success"] != false {
		t.Error("Expected success to be false for error case")
	}

	if receivedLogMessage["error"] != "connection failed" {
		t.Errorf("Expected error message 'connection failed', got '%v'", receivedLogMessage["error"])
	}

	// Error case should not have data
	if receivedLogMessage["data"] != nil {
		t.Error("Expected data to be nil for error case")
	}
}

func TestDatabaseQueryExecutor_LogQueryResult_LogProcessorUnavailable(t *testing.T) {
	// Create executor with invalid URL to simulate log processor unavailable
	executor := NewDatabaseQueryExecutor("http://invalid-host:19002", map[string]DatabaseInfo{}, "instance-123")
	executor.httpClient.Timeout = 1 * time.Second // Short timeout for test

	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()

	// This should not panic or return error - should just log warning
	executor.logQueryResult(ctx, "postgresql", "test-db", "SELECT 1", nil, true, nil, 0, "", 100)

	// Test passes if no panic occurs
}

func TestConvertPostgresParams_Positional(t *testing.T) {
	query := "SELECT * FROM users WHERE id = $1::int"
	params := map[string]interface{}{"1": "1"}

	newQuery, args := convertPostgresParams(query, params)
	if newQuery != query {
		t.Errorf("expected query unchanged, got %q", newQuery)
	}
	if len(args) != 1 || args[0] != "1" {
		t.Errorf("expected args [1], got %v", args)
	}
}

func TestConvertPostgresParams_TwoPositional(t *testing.T) {
	query := "SELECT name FROM users WHERE id >= $1::int AND id <= $2::int"
	params := map[string]interface{}{"1": "1", "2": "5"}

	newQuery, args := convertPostgresParams(query, params)
	if newQuery != query {
		t.Errorf("expected query unchanged, got %q", newQuery)
	}
	if len(args) != 2 || args[0] != "1" || args[1] != "5" {
		t.Errorf("expected args [1 5], got %v", args)
	}
}

func TestConvertPostgresParams_NoParams(t *testing.T) {
	query := "SELECT * FROM users"
	newQuery, args := convertPostgresParams(query, nil)
	if newQuery != query {
		t.Errorf("expected query unchanged, got %q", newQuery)
	}
	if args != nil {
		t.Errorf("expected nil args, got %v", args)
	}
}

func TestConvertPostgresParams_IgnoresNonNumericKeys(t *testing.T) {
	query := "SELECT * FROM users"
	params := map[string]interface{}{"email": "bob@example.com"}

	newQuery, args := convertPostgresParams(query, params)
	if newQuery != query {
		t.Errorf("expected query unchanged, got %q", newQuery)
	}
	if args != nil {
		t.Errorf("expected nil args for non-numeric keys, got %v", args)
	}
}
