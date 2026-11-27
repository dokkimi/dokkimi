package main

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"
)

func TestNewCompletionNotifier(t *testing.T) {
	notifier := NewCompletionNotifier("http://localhost:19001/test-complete", nil)

	if notifier == nil {
		t.Fatal("NewCompletionNotifier returned nil")
	}

	if notifier.url != "http://localhost:19001/test-complete" {
		t.Errorf("Expected url to be http://localhost:19001/test-complete, got %s", notifier.url)
	}
}

func TestCompletionNotifier_NotifyCompletion(t *testing.T) {
	var receivedNotification TestCompletionNotification
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

		if err := json.Unmarshal(body, &receivedNotification); err != nil {
			t.Errorf("Failed to parse notification: %v", err)
			w.WriteHeader(http.StatusBadRequest)
			return
		}

		w.WriteHeader(http.StatusOK)
		w.Write([]byte(`{"status": "ok"}`))
	}))
	defer server.Close()

	notifier := NewCompletionNotifier(server.URL, nil)

	err := notifier.NotifyCompletion("test-run-123", "success", "test message", nil)

	if err != nil {
		t.Errorf("NotifyCompletion() error = %v", err)
	}

	if receivedNotification.TestRunID != "test-run-123" {
		t.Errorf("Expected TestRunID to be test-run-123, got %s", receivedNotification.TestRunID)
	}

	if receivedNotification.Status != "success" {
		t.Errorf("Expected Status to be success, got %s", receivedNotification.Status)
	}

	if receivedNotification.Message != "test message" {
		t.Errorf("Expected Message to be 'test message', got %s", receivedNotification.Message)
	}
}

func TestCompletionNotifier_NotifyCompletion_Failure(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
		w.Write([]byte(`{"error": "internal error"}`))
	}))
	defer server.Close()

	notifier := NewCompletionNotifier(server.URL, nil)

	err := notifier.NotifyCompletion("test-run-123", "failure", "test error", nil)

	if err == nil {
		t.Error("Expected error for 500 response, got nil")
	}
}

// Before, completion was reported with events still queued; Control Tower
// then tore the run down and they were lost
func TestCompletionNotifier_SendsQueuedEventsFirst(t *testing.T) {
	var mu sync.Mutex
	var order []string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/logs/test-execution" {
			time.Sleep(20 * time.Millisecond) // a slow Control Tower
		}
		mu.Lock()
		order = append(order, r.URL.Path)
		mu.Unlock()
		w.WriteHeader(http.StatusOK)
	}))
	defer server.Close()

	logger := NewTestExecutionLogger(server.URL, "inst", 5*time.Second)
	defer logger.Stop()
	for i := 0; i < 5; i++ {
		logger.LogEvent("STEP_COMPLETED", "step", nil, nil)
	}

	notifier := NewCompletionNotifier(server.URL+"/test-complete", logger)
	if err := notifier.NotifyCompletion("inst", "success", "", nil); err != nil {
		t.Fatalf("NotifyCompletion() error = %v", err)
	}

	mu.Lock()
	defer mu.Unlock()
	want := []string{"/logs/test-execution", "/logs/test-execution", "/logs/test-execution", "/logs/test-execution", "/logs/test-execution", "/test-complete"}
	if strings.Join(order, ",") != strings.Join(want, ",") {
		t.Errorf("requests = %v, want %v", order, want)
	}
}
