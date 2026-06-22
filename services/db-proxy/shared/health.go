package shared

import (
	"bytes"
	"context"
	"encoding/json"
	"log"
	"net/http"
	"sync"
	"time"
)

// HealthChecker handles periodic health checking and status publishing
type HealthChecker struct {
	config           *Config
	checkFn          func(ctx context.Context) error
	httpClient       *http.Client
	state            HealthState
	stateMutex       sync.RWMutex
	lastStatus       bool
	stopChan         chan struct{}
	statusChangeChan chan bool
}

// NewHealthCheckerWithFunc creates a new health checker with a custom check function
func NewHealthCheckerWithFunc(cfg *Config, checkFn func(ctx context.Context) error) *HealthChecker {
	return &HealthChecker{
		config:  cfg,
		checkFn: checkFn,
		httpClient: &http.Client{
			Timeout: cfg.CheckTimeout,
		},
		state:            StateBooting,
		lastStatus:       false,
		stopChan:         make(chan struct{}),
		statusChangeChan: make(chan bool, 10),
	}
}

// Start begins the health checking goroutine
func (h *HealthChecker) Start() {
	go h.run()
}

// Stop stops the health checker
func (h *HealthChecker) Stop() {
	select {
	case <-h.stopChan:
		// Already closed
	default:
		close(h.stopChan)
	}
}

// run executes the adaptive frequency health checking loop
func (h *HealthChecker) run() {
	ticker := time.NewTicker(h.getCheckInterval())
	defer ticker.Stop()

	// Perform initial check immediately
	h.performCheck()

	for {
		select {
		case <-ticker.C:
			h.performCheck()
			// Update ticker interval based on current state
			ticker.Reset(h.getCheckInterval())
		case <-h.stopChan:
			return
		}
	}
}

// getCheckInterval returns the check interval based on current state
func (h *HealthChecker) getCheckInterval() time.Duration {
	h.stateMutex.RLock()
	defer h.stateMutex.RUnlock()

	switch h.state {
	case StateBooting:
		return 500 * time.Millisecond
	case StateHealthy:
		// 10-30 seconds (efficient monitoring)
		return 20 * time.Second
	case StateUnhealthy:
		// 1-2 seconds (fast failure detection)
		return 1500 * time.Millisecond
	default:
		return 5 * time.Second
	}
}

// performCheck performs a health check and publishes status
func (h *HealthChecker) performCheck() {
	startTime := time.Now()

	ctx, cancel := context.WithTimeout(context.Background(), h.config.CheckTimeout)
	defer cancel()

	err := h.checkFn(ctx)
	ready := err == nil
	checkDuration := int(time.Since(startTime).Milliseconds())

	h.updateState(ready)
	h.publishStatus(ready, checkDuration, err)
}

// updateState updates the state machine based on health check result
func (h *HealthChecker) updateState(ready bool) {
	h.stateMutex.Lock()
	defer h.stateMutex.Unlock()

	statusChanged := h.lastStatus != ready
	h.lastStatus = ready

	if statusChanged {
		// Notify of status change
		select {
		case h.statusChangeChan <- ready:
		default:
			// Channel full, skip
		}
	}

	// State transitions
	switch h.state {
	case StateBooting:
		if ready {
			h.state = StateHealthy
			log.Printf("Health check: Database became healthy, transitioning to HEALTHY state")
		}
		// Stay in BOOTING if not ready
	case StateHealthy:
		if !ready {
			h.state = StateUnhealthy
			log.Printf("Health check: Database became unhealthy, transitioning to UNHEALTHY state")
		}
		// Stay in HEALTHY if ready
	case StateUnhealthy:
		if ready {
			h.state = StateHealthy
			log.Printf("Health check: Database became healthy, transitioning to HEALTHY state")
		}
		// Stay in UNHEALTHY if not ready
	}
}

// publishStatus publishes health status to LPS and optionally to test-agent
func (h *HealthChecker) publishStatus(ready bool, checkDuration int, checkErr error) {
	statusUpdate := HealthStatusUpdate{
		InstanceID:       h.config.InstanceID,
		InstanceItemName: h.config.InstanceItemName,
		InstanceItemID:   h.config.InstanceItemID,
		Ready:            ready,
		Timestamp:        time.Now().Format(time.RFC3339),
		Details: HealthStatusDetails{
			CheckDuration: checkDuration,
		},
	}

	if checkErr != nil {
		statusUpdate.Details.Error = checkErr.Error()
	}

	// Publish to LPS asynchronously (non-blocking)
	go h.sendStatusUpdate(statusUpdate)

	// Also send to test-agent if configured (non-blocking)
	if h.config.TestAgentURL != "" {
		go h.sendStatusUpdateToTestAgent(statusUpdate)
	}
}

// sendStatusUpdate sends the status update to LPS
func (h *HealthChecker) sendStatusUpdate(update HealthStatusUpdate) {
	body, err := json.Marshal(update)
	if err != nil {
		log.Printf("Health check: Failed to marshal status update: %v", err)
		return
	}

	url := h.config.ControlTowerURL + "/health/status"

	maxRetries := 3
	for i := 0; i < maxRetries; i++ {
		req, err := http.NewRequest(http.MethodPost, url, bytes.NewBuffer(body))
		if err != nil {
			log.Printf("Health check: Failed to create request: %v", err)
			return
		}
		req.Header.Set("Content-Type", "application/json")

		resp, err := h.httpClient.Do(req)
		if err == nil {
			resp.Body.Close()
			if resp.StatusCode == http.StatusOK || resp.StatusCode == http.StatusCreated {
				return
			}
		}

		if i < maxRetries-1 {
			backoff := time.Duration(1<<uint(i)) * time.Second
			time.Sleep(backoff)
		}
	}

	log.Printf("Health check: Failed to publish status update after %d retries", maxRetries)
}

// sendStatusUpdateToTestAgent sends the status update to test-agent
func (h *HealthChecker) sendStatusUpdateToTestAgent(update HealthStatusUpdate) {
	body, err := json.Marshal(update)
	if err != nil {
		log.Printf("Health check: Failed to marshal status update for test-agent: %v", err)
		return
	}

	url := h.config.TestAgentURL + "/health/status"

	maxRetries := 3
	for i := 0; i < maxRetries; i++ {
		req, err := http.NewRequest(http.MethodPost, url, bytes.NewBuffer(body))
		if err != nil {
			log.Printf("Health check: Failed to create request to test-agent: %v", err)
			return
		}
		req.Header.Set("Content-Type", "application/json")

		resp, err := h.httpClient.Do(req)
		if err == nil {
			resp.Body.Close()
			if resp.StatusCode == http.StatusOK || resp.StatusCode == http.StatusCreated {
				return
			}
		}

		if i < maxRetries-1 {
			backoff := time.Duration(1<<uint(i)) * time.Second
			time.Sleep(backoff)
		}
	}

	log.Printf("Health check: Failed to send status update to test-agent after %d retries", maxRetries)
}
