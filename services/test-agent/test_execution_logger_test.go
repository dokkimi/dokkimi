package main

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

func TestNewTestExecutionLogger(t *testing.T) {
	logger := NewTestExecutionLogger("http://localhost:19002", "instance-123", 30*time.Second)

	if logger == nil {
		t.Fatal("NewTestExecutionLogger returned nil")
	}

	if logger.logEndpointURL != "http://localhost:19002" {
		t.Errorf("Expected logEndpointURL to be http://localhost:19002, got %s", logger.logEndpointURL)
	}

	if logger.instanceId != "instance-123" {
		t.Errorf("Expected instanceId to be instance-123, got %s", logger.instanceId)
	}

	// Clean up
	logger.Stop()
}

func TestTestExecutionLogger_LogEvent(t *testing.T) {
	var receivedMessage TestExecutionLogMessage
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != "POST" {
			w.WriteHeader(http.StatusMethodNotAllowed)
			return
		}

		body, err := io.ReadAll(r.Body)
		if err != nil {
			t.Errorf("Failed to read request body: %v", err)
			w.WriteHeader(http.StatusBadRequest)
			return
		}

		if err := json.Unmarshal(body, &receivedMessage); err != nil {
			t.Errorf("Failed to parse message: %v", err)
			w.WriteHeader(http.StatusBadRequest)
			return
		}

		w.WriteHeader(http.StatusOK)
	}))
	defer server.Close()

	logger := NewTestExecutionLogger(server.URL+"/logs/test-execution", "instance-123", 5*time.Second)
	defer logger.Stop()

	// Log an event
	logger.LogEvent("STARTED", "Starting test-agent...", nil, nil)

	// Give the async worker time to send
	time.Sleep(100 * time.Millisecond)

	if receivedMessage.InstanceID != "instance-123" {
		t.Errorf("Expected InstanceID to be instance-123, got %s", receivedMessage.InstanceID)
	}

	if receivedMessage.EventType != "STARTED" {
		t.Errorf("Expected EventType to be STARTED, got %s", receivedMessage.EventType)
	}

	if receivedMessage.Message != "Starting test-agent..." {
		t.Errorf("Expected Message to be 'Starting test-agent...', got %s", receivedMessage.Message)
	}
}

func TestTestExecutionLogger_LogRequestStarted(t *testing.T) {
	var receivedMessage TestExecutionLogMessage
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		json.Unmarshal(body, &receivedMessage)
		w.WriteHeader(http.StatusOK)
	}))
	defer server.Close()

	logger := NewTestExecutionLogger(server.URL+"/logs/test-execution", "instance-123", 5*time.Second)
	defer logger.Stop()

	logger.LogRequestStarted(1, "GET", "/api/users")

	time.Sleep(100 * time.Millisecond)

	if receivedMessage.EventType != "REQUEST_STARTED" {
		t.Errorf("Expected EventType to be REQUEST_STARTED, got %s", receivedMessage.EventType)
	}

	if receivedMessage.StepIndex == nil || *receivedMessage.StepIndex != 1 {
		t.Errorf("Expected StepIndex to be 1, got %v", receivedMessage.StepIndex)
	}
}

func TestTestExecutionLogger_LogRequestCompleted(t *testing.T) {
	var receivedMessage TestExecutionLogMessage
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		json.Unmarshal(body, &receivedMessage)
		w.WriteHeader(http.StatusOK)
	}))
	defer server.Close()

	logger := NewTestExecutionLogger(server.URL+"/logs/test-execution", "instance-123", 5*time.Second)
	defer logger.Stop()

	// Test successful completion
	logger.LogRequestCompleted(0, 1, 45, nil)

	time.Sleep(100 * time.Millisecond)

	if receivedMessage.EventType != "REQUEST_COMPLETED" {
		t.Errorf("Expected EventType to be REQUEST_COMPLETED, got %s", receivedMessage.EventType)
	}

	if receivedMessage.Duration == nil || *receivedMessage.Duration != 45 {
		t.Errorf("Expected Duration to be 45, got %v", receivedMessage.Duration)
	}

	if receivedMessage.Error != "" {
		t.Errorf("Expected Error to be empty, got %s", receivedMessage.Error)
	}

	// Test error completion
	logger.LogRequestCompleted(0, 2, 100, &connectionError{message: "connection refused"})

	time.Sleep(100 * time.Millisecond)

	if receivedMessage.Error == "" {
		t.Error("Expected Error to be set, but it was empty")
	}

	if receivedMessage.ErrorType == "" {
		t.Error("Expected ErrorType to be set, but it was empty")
	}
}

func TestTestExecutionLogger_Flush(t *testing.T) {
	var received []TestExecutionLogMessage
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		var msg TestExecutionLogMessage
		json.Unmarshal(body, &msg)
		received = append(received, msg)
		w.WriteHeader(http.StatusOK)
	}))
	defer server.Close()

	logger := NewTestExecutionLogger(server.URL+"/logs/test-execution", "instance-123", 5*time.Second)
	defer logger.Stop()

	// Queue multiple messages
	for i := 0; i < 5; i++ {
		logger.LogEvent("TEST_STARTED", "msg", nil, nil)
	}

	// Flush should block until all 5 are sent
	logger.Flush()

	if len(received) != 5 {
		t.Errorf("Expected 5 messages after Flush, got %d", len(received))
	}

	// Queue more after flush, flush again
	logger.LogEvent("TEST_COMPLETED", "done", nil, nil)
	logger.Flush()

	if len(received) != 6 {
		t.Errorf("Expected 6 messages after second Flush, got %d", len(received))
	}
}

func TestTestExecutionLogger_FlushSkipsSentinelInOutput(t *testing.T) {
	var received []TestExecutionLogMessage
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		var msg TestExecutionLogMessage
		json.Unmarshal(body, &msg)
		received = append(received, msg)
		w.WriteHeader(http.StatusOK)
	}))
	defer server.Close()

	logger := NewTestExecutionLogger(server.URL+"/logs/test-execution", "instance-123", 5*time.Second)
	defer logger.Stop()

	logger.LogEvent("STARTED", "test", nil, nil)
	logger.Flush()

	// Sentinel should not be sent to Control Tower — only real messages
	for _, msg := range received {
		if msg.EventType == "" && msg.InstanceID == "" {
			t.Error("Sentinel message was sent to Control Tower — should have been intercepted by worker")
		}
	}

	if len(received) != 1 {
		t.Errorf("Expected exactly 1 message sent to Control Tower, got %d", len(received))
	}
}

func TestTestExecutionLogger_FlushOnNilLogger(t *testing.T) {
	var logger *TestExecutionLogger
	// Should not panic
	logger.Flush()
}

func TestTestExecutionLogger_Stop(t *testing.T) {
	logger := NewTestExecutionLogger("http://localhost:19002", "instance-123", 5*time.Second)

	// Log some events
	logger.LogEvent("STARTED", "Test", nil, nil)
	logger.LogEvent("HEALTH_WAIT_STARTED", "Test", nil, nil)

	// Stop should not panic
	logger.Stop()

	// Stop again should be safe
	logger.Stop()
}

// Helper type for testing errors
type connectionError struct {
	message string
}

func (e *connectionError) Error() string {
	return e.message
}

