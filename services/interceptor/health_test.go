package main

import (
	"net/http"
	"net/http/httptest"
	"net/url"
	"testing"
	"time"
)

func TestNewHealthChecker(t *testing.T) {
	tests := []struct {
		name   string
		config *HealthConfig
		want   bool
	}{
		{
			name: "valid config returns checker",
			config: &HealthConfig{
				HealthCheckEndpoint: "/health",
				ServicePort:         "8080",
			InstanceItemName:    "item-123",
			InstanceID:           "namespace-123",
				ControlTowerURL:      "http://localhost:3002",
				CheckTimeout:        5 * time.Second,
			},
			want: true,
		},
		{
			name: "missing health check endpoint returns nil",
		config: &HealthConfig{
			ServicePort:      "8080",
			InstanceItemName: "item-123",
			InstanceID:       "namespace-123",
			ControlTowerURL:   "http://localhost:3002",
		},
			want: false,
		},
		{
			name: "missing service port returns nil",
			config: &HealthConfig{
				HealthCheckEndpoint: "/health",
			InstanceItemName:    "item-123",
			InstanceID:           "namespace-123",
				ControlTowerURL:      "http://localhost:3002",
			},
			want: false,
		},
		{
			name: "missing namespace item ID returns nil",
		config: &HealthConfig{
			HealthCheckEndpoint: "/health",
			ServicePort:         "8080",
			InstanceID:          "namespace-123",
			ControlTowerURL:      "http://localhost:3002",
		},
			want: false,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			checker := NewHealthChecker(tt.config)
			if (checker != nil) != tt.want {
				t.Errorf("NewHealthChecker() = %v, want non-nil: %v", checker, tt.want)
			}
		})
	}
}

func TestHealthChecker_getCheckInterval(t *testing.T) {
	cfg := &HealthConfig{
		HealthCheckEndpoint: "/health",
		ServicePort:         "8080",
			InstanceItemName:    "item-123",
			InstanceID:           "namespace-123",
		ControlTowerURL:      "http://localhost:3002",
		CheckTimeout:        5 * time.Second,
	}

	checker := NewHealthChecker(cfg)
	if checker == nil {
		t.Fatal("NewHealthChecker returned nil")
	}

	tests := []struct {
		name  string
		state HealthState
		want  time.Duration
	}{
		{
			name:  "booting state returns 1-2s interval",
			state: StateBooting,
			want:  1500 * time.Millisecond,
		},
		{
			name:  "healthy state returns 10-30s interval",
			state: StateHealthy,
			want:  20 * time.Second,
		},
		{
			name:  "unhealthy state returns 1-2s interval",
			state: StateUnhealthy,
			want:  1500 * time.Millisecond,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			checker.state = tt.state
			got := checker.getCheckInterval()
			if got != tt.want {
				t.Errorf("getCheckInterval() = %v, want %v", got, tt.want)
			}
		})
	}
}

func TestHealthChecker_checkHealth(t *testing.T) {
	tests := []struct {
		name           string
		endpoint       string
		statusCode     int
		wantReady      bool
		wantStatusCode int
		wantErr        bool
	}{
		{
			name:           "200 OK returns ready",
			endpoint:       "/health",
			statusCode:     http.StatusOK,
			wantReady:      true,
			wantStatusCode: http.StatusOK,
			wantErr:        false,
		},
		{
			name:           "404 Not Found returns not ready",
			endpoint:       "/nonexistent",
			statusCode:     http.StatusNotFound,
			wantReady:      false,
			wantStatusCode: http.StatusNotFound,
			wantErr:        false,
		},
		{
			name:           "500 Internal Server Error returns not ready",
			endpoint:       "/error",
			statusCode:     http.StatusInternalServerError,
			wantReady:      false,
			wantStatusCode: http.StatusInternalServerError,
			wantErr:        false,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			// Each subtest gets its own httptest server bound to 127.0.0.1.
			// Leaving K8sNamespace and K8sDNSIP empty makes checkHealth treat
			// Origin as a direct hostname instead of a cluster-local FQDN.
			testServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				w.WriteHeader(tt.statusCode)
			}))
			defer testServer.Close()

			host, port, err := splitHostPort(testServer.URL)
			if err != nil {
				t.Fatalf("failed to parse test server URL %q: %v", testServer.URL, err)
			}

			checker := NewHealthChecker(&HealthConfig{
				HealthCheckEndpoint: tt.endpoint,
				ServicePort:         port,
				InstanceItemName:    "item-123",
				InstanceID:          "namespace-123",
				ControlTowerURL:     "http://localhost:3002",
				CheckTimeout:        5 * time.Second,
				Origin:              host,
			})
			if checker == nil {
				t.Fatal("NewHealthChecker returned nil")
			}

			ready, statusCode, err := checker.checkHealth()

			if (err != nil) != tt.wantErr {
				t.Errorf("checkHealth() error = %v, wantErr %v", err, tt.wantErr)
				return
			}
			if ready != tt.wantReady {
				t.Errorf("checkHealth() ready = %v, want %v", ready, tt.wantReady)
			}
			if statusCode != tt.wantStatusCode {
				t.Errorf("checkHealth() statusCode = %v, want %v", statusCode, tt.wantStatusCode)
			}
		})
	}
}

// splitHostPort extracts host and port from a URL like "http://127.0.0.1:12345".
func splitHostPort(rawURL string) (string, string, error) {
	u, err := url.Parse(rawURL)
	if err != nil {
		return "", "", err
	}
	return u.Hostname(), u.Port(), nil
}

func TestHealthChecker_updateState(t *testing.T) {
	cfg := &HealthConfig{
		HealthCheckEndpoint: "/health",
		ServicePort:         "8080",
			InstanceItemName:    "item-123",
			InstanceID:           "namespace-123",
		ControlTowerURL:      "http://localhost:3002",
		CheckTimeout:        5 * time.Second,
	}

	checker := NewHealthChecker(cfg)
	if checker == nil {
		t.Fatal("NewHealthChecker returned nil")
	}

	// Each case specifies the sequence of ready values to feed to updateState
	// and the expected final state. BOOTING→HEALTHY and UNHEALTHY→HEALTHY
	// require 2 consecutive ready checks per the state machine's stability rule.
	tests := []struct {
		name         string
		initialState HealthState
		readySeq     []bool
		wantState    HealthState
	}{
		{
			name:         "booting to healthy after 2 consecutive ready",
			initialState: StateBooting,
			readySeq:     []bool{true, true},
			wantState:    StateHealthy,
		},
		{
			name:         "booting stays booting after 1 ready check",
			initialState: StateBooting,
			readySeq:     []bool{true},
			wantState:    StateBooting,
		},
		{
			name:         "booting stays booting when not ready",
			initialState: StateBooting,
			readySeq:     []bool{false},
			wantState:    StateBooting,
		},
		{
			name:         "healthy to unhealthy",
			initialState: StateHealthy,
			readySeq:     []bool{false},
			wantState:    StateUnhealthy,
		},
		{
			name:         "healthy stays healthy when ready",
			initialState: StateHealthy,
			readySeq:     []bool{true},
			wantState:    StateHealthy,
		},
		{
			name:         "unhealthy to healthy after 2 consecutive ready",
			initialState: StateUnhealthy,
			readySeq:     []bool{true, true},
			wantState:    StateHealthy,
		},
		{
			name:         "unhealthy stays unhealthy after 1 ready check",
			initialState: StateUnhealthy,
			readySeq:     []bool{true},
			wantState:    StateUnhealthy,
		},
		{
			name:         "unhealthy stays unhealthy when not ready",
			initialState: StateUnhealthy,
			readySeq:     []bool{false},
			wantState:    StateUnhealthy,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			// Reset shared state so subtests don't leak consecutiveReady into each other.
			checker.state = tt.initialState
			checker.consecutiveReady = 0
			checker.lastStatus = !tt.readySeq[0]

			for _, ready := range tt.readySeq {
				checker.updateState(ready)
			}

			if checker.state != tt.wantState {
				t.Errorf("updateState() state = %v, want %v", checker.state, tt.wantState)
			}
			finalReady := tt.readySeq[len(tt.readySeq)-1]
			if checker.lastStatus != finalReady {
				t.Errorf("updateState() lastStatus = %v, want %v", checker.lastStatus, finalReady)
			}
		})
	}
}

