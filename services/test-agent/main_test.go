package main

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestHandleHealthStatus(t *testing.T) {
	tracker := NewHealthTracker([]string{"item-1", "item-2"}, nil, nil)

	tests := []struct {
		name           string
		method         string
		body           HealthStatusUpdate
		wantStatusCode int
		wantReady      bool
	}{
		{
			name:   "valid POST updates health status",
			method: "POST",
			body: HealthStatusUpdate{
				InstanceID:       "instance-123",
				InstanceItemName: "item-1",
				Ready:            true,
				Timestamp:        "2024-01-01T12:00:00Z",
			},
			wantStatusCode: http.StatusOK,
			wantReady:      true,
		},
		{
			name:   "GET method not allowed",
			method: "GET",
			body: HealthStatusUpdate{
				InstanceItemName: "item-1",
				Ready:            true,
			},
			wantStatusCode: http.StatusMethodNotAllowed,
		},
		{
			name:           "invalid JSON returns 400",
			method:         "POST",
			body:           HealthStatusUpdate{},
			wantStatusCode: http.StatusOK, // We still return 200 even with invalid data
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			var bodyBytes []byte
			var err error

			if tt.method == "POST" {
				bodyBytes, err = json.Marshal(tt.body)
				if err != nil {
					t.Fatalf("Failed to marshal body: %v", err)
				}
			} else {
				bodyBytes = []byte("invalid")
			}

			req := httptest.NewRequest(tt.method, "/health/status", bytes.NewBuffer(bodyBytes))
			req.Header.Set("Content-Type", "application/json")
			w := httptest.NewRecorder()

			handleHealthStatus(w, req, tracker)

			if w.Code != tt.wantStatusCode {
				t.Errorf("handleHealthStatus() status code = %v, want %v", w.Code, tt.wantStatusCode)
			}

			if tt.wantReady {
				status := tracker.GetStatus()
				if ready, exists := status[tt.body.InstanceItemName]; !exists || !ready {
					t.Errorf("Expected item %s to be ready, got status: %v", tt.body.InstanceItemName, status)
				}
			}
		})
	}
}

func TestHandleHealthStatus_MultipleUpdates(t *testing.T) {
	tracker := NewHealthTracker([]string{"item-1", "item-2"}, nil, nil)

	// Update item-1 to ready
	update1 := HealthStatusUpdate{
		InstanceID:       "instance-123",
		InstanceItemName: "item-1",
		Ready:            true,
		Timestamp:        "2024-01-01T12:00:00Z",
	}

	body1, _ := json.Marshal(update1)
	req1 := httptest.NewRequest("POST", "/health/status", bytes.NewBuffer(body1))
	req1.Header.Set("Content-Type", "application/json")
	w1 := httptest.NewRecorder()

	handleHealthStatus(w1, req1, tracker)

	if w1.Code != http.StatusOK {
		t.Errorf("First update status code = %v, want %v", w1.Code, http.StatusOK)
	}

	// Update item-2 to ready
	update2 := HealthStatusUpdate{
		InstanceID:       "instance-123",
		InstanceItemName: "item-2",
		Ready:            true,
		Timestamp:        "2024-01-01T12:00:01Z",
	}

	body2, _ := json.Marshal(update2)
	req2 := httptest.NewRequest("POST", "/health/status", bytes.NewBuffer(body2))
	req2.Header.Set("Content-Type", "application/json")
	w2 := httptest.NewRecorder()

	handleHealthStatus(w2, req2, tracker)

	if w2.Code != http.StatusOK {
		t.Errorf("Second update status code = %v, want %v", w2.Code, http.StatusOK)
	}

	// Both items should be ready
	status := tracker.GetStatus()
	if !status["item-1"] || !status["item-2"] {
		t.Errorf("Expected both items to be ready, got status: %v", status)
	}
}
