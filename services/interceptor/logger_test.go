package main

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestNewLogger(t *testing.T) {
	logger := NewLogger("http://localhost:5000", 5*time.Second)

	if logger == nil {
		t.Fatal("NewLogger() returned nil")
	}

	if logger.logEndpointURL != "http://localhost:5000" {
		t.Errorf("Expected logEndpointURL to be http://localhost:5000, got %s", logger.logEndpointURL)
	}

	// Stop logger
	logger.Stop()
	time.Sleep(10 * time.Millisecond) // Give worker time to stop
}

func TestLogger_LogResponse(t *testing.T) {
	var receivedMessage HttpLogMessage
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/logs/http" {
			body, _ := io.ReadAll(r.Body)
			json.Unmarshal(body, &receivedMessage)
			w.WriteHeader(http.StatusOK)
		}
	}))
	defer server.Close()

	logger := NewLogger(server.URL, 5*time.Second)
	defer logger.Stop()

	urlMap := UrlMap{
		"example.com": ServiceInfo{Name: "example-service"},
	}

	req := httptest.NewRequest("POST", "http://example.com/api/users", nil)
	resp := &http.Response{
		StatusCode: 201,
		Header:     http.Header{"X-Response": []string{"value"}},
		Body:       io.NopCloser(strings.NewReader(`{"id": 123}`)),
	}

	requestBody := map[string]interface{}{"name": "test"}
	logger.LogResponse(req, "action-456", resp, true, urlMap, "test-ns", "test-origin", "origin-id-123", "", requestBody, nil, nil, nil)

	// Wait for async log to be sent
	time.Sleep(100 * time.Millisecond)

	if receivedMessage.InstanceID != "test-ns" {
		t.Errorf("Expected InstanceID to be test-ns, got %s", receivedMessage.InstanceID)
	}

	if receivedMessage.Method != "POST" {
		t.Errorf("Expected Method to be POST, got %s", receivedMessage.Method)
	}

	if receivedMessage.StatusCode == nil || *receivedMessage.StatusCode != 201 {
		t.Errorf("Expected StatusCode to be 201, got %v", receivedMessage.StatusCode)
	}

	if receivedMessage.IsMocked == nil || *receivedMessage.IsMocked != true {
		t.Errorf("Expected IsMocked to be true, got %v", receivedMessage.IsMocked)
	}
}

func TestLogger_LogResponse_ChannelFull(t *testing.T) {
	logger := NewLogger("http://localhost:5000", 5*time.Second)
	defer logger.Stop()

	// Fill up the channel with LogResponse calls
	for i := 0; i < 1001; i++ {
		req := httptest.NewRequest("GET", "http://example.com/test", nil)
		resp := &http.Response{
			StatusCode: 200,
			Body:       io.NopCloser(strings.NewReader("")),
		}
		logger.LogResponse(req, "action", resp, false, make(UrlMap), "ns", "origin", "origin-id", "", nil, nil, nil, nil)
	}

	// Should not block (logs will be dropped)
	// This test just ensures it doesn't panic
}

func TestLogger_Stop(t *testing.T) {
	logger := NewLogger("http://localhost:5000", 5*time.Second)

	// Stop should not panic
	logger.Stop()

	// Wait a bit
	time.Sleep(10 * time.Millisecond)

	// Try to stop again (should be safe)
	logger.Stop()
}

func TestLogger_Stop_DrainsChannel(t *testing.T) {
	// Create a test server to receive logs
	var receivedCount int
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/logs/http" {
			receivedCount++
			w.WriteHeader(http.StatusOK)
		}
	}))
	defer server.Close()

	logger := NewLogger(server.URL, 5*time.Second)

	// Fill the channel with logs
	for i := 0; i < 10; i++ {
		req := httptest.NewRequest("GET", "http://example.com/test", nil)
		resp := &http.Response{
			StatusCode: 200,
			Body:       io.NopCloser(strings.NewReader("")),
		}
		logger.LogResponse(req, "action-123", resp, false, make(UrlMap), "test-ns", "test-origin", "origin-id", "", nil, nil, nil, nil)
	}

	// Stop should drain the channel
	logger.Stop()

	// Give it time to process
	time.Sleep(100 * time.Millisecond)

	// All logs should have been sent (or at least attempted)
	// Note: Some may fail due to timing, but we should see attempts
	if receivedCount == 0 {
		t.Error("Expected at least some logs to be drained, got 0")
	}
}

func TestLogger_sendLog_ErrorHandling(t *testing.T) {
	// Test with invalid server (will fail)
	logger := NewLogger("http://invalid-server:9999", 100*time.Millisecond)
	defer logger.Stop()

	// Send a log (should not panic even if it fails)
	message := HttpLogMessage{
		InstanceID: "test-ns",
		Method:      "GET",
		URL:         "/test",
		Timestamp:   time.Now().Format(time.RFC3339),
	}

	// Manually call sendLog (normally called by worker)
	logger.sendLog(message)

	// Should not panic
}

func TestLogger_sendLog_InvalidJSON(t *testing.T) {
	// Create a logger with a channel that will receive the message
	logger := &Logger{
		logEndpointURL: "http://localhost:5000",
		httpClient:      &http.Client{Timeout: 5 * time.Second},
		logChan:         make(chan HttpLogMessage, 1),
		stopChan:        make(chan struct{}),
	}

	// Create a message that should always be marshallable
	message := HttpLogMessage{
		InstanceID: "test-ns",
		Method:      "GET",
		URL:         "/test",
		Timestamp:   time.Now().Format(time.RFC3339),
	}

	// This should not panic
	logger.sendLog(message)
}

func TestLogger_sendLog_Success(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/logs/http" {
			w.WriteHeader(http.StatusOK)
		}
	}))
	defer server.Close()

	logger := &Logger{
		logEndpointURL: server.URL,
		httpClient:      &http.Client{Timeout: 5 * time.Second},
		logChan:         make(chan HttpLogMessage, 1),
		stopChan:        make(chan struct{}),
	}

	message := HttpLogMessage{
		InstanceID: "test-ns",
		Method:      "GET",
		URL:         "/test",
		Timestamp:   time.Now().Format(time.RFC3339),
	}

	// Should send successfully
	logger.sendLog(message)
}

func TestLogger_sendLog_RequestCreationError(t *testing.T) {
	logger := &Logger{
		logEndpointURL: "http://[::1]:namedport", // Invalid URL
		httpClient:      &http.Client{Timeout: 5 * time.Second},
		logChan:         make(chan HttpLogMessage, 1),
		stopChan:        make(chan struct{}),
	}

	message := HttpLogMessage{
		InstanceID: "test-ns",
		Method:      "GET",
		URL:         "/test",
		Timestamp:   time.Now().Format(time.RFC3339),
	}

	// Should not panic even with invalid URL
	logger.sendLog(message)
}

func TestLogger_sendLog_NetworkError(t *testing.T) {
	// Use unreachable address
	logger := &Logger{
		logEndpointURL: "http://192.0.2.1:9999",
		httpClient:      &http.Client{Timeout: 100 * time.Millisecond},
		logChan:         make(chan HttpLogMessage, 1),
		stopChan:        make(chan struct{}),
	}

	message := HttpLogMessage{
		InstanceID: "test-ns",
		Method:      "GET",
		URL:         "/test",
		Timestamp:   time.Now().Format(time.RFC3339),
	}

	// Should not panic on network error
	logger.sendLog(message)
}

func TestLogger_sendLog_Non200Response(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
	}))
	defer server.Close()

	logger := &Logger{
		logEndpointURL: server.URL,
		httpClient:      &http.Client{Timeout: 5 * time.Second},
		logChan:         make(chan HttpLogMessage, 1),
		stopChan:        make(chan struct{}),
	}

	message := HttpLogMessage{
		InstanceID: "test-ns",
		Method:      "GET",
		URL:         "/test",
		Timestamp:   time.Now().Format(time.RFC3339),
	}

	// Should handle non-200 response gracefully
	logger.sendLog(message)
}

