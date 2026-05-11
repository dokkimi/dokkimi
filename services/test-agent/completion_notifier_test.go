package main

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"
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

	err := notifier.NotifyCompletion("test-run-123", "success", "test message", nil, false)

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

	err := notifier.NotifyCompletion("test-run-123", "failure", "test error", nil, false)

	if err == nil {
		t.Error("Expected error for 500 response, got nil")
	}
}
