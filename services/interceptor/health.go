package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"log"
	"net"
	"net/http"
	"sync"
	"time"
)

// HealthState represents the current state of health checking
type HealthState string

const (
	StateBooting   HealthState = "BOOTING"
	StateHealthy   HealthState = "HEALTHY"
	StateUnhealthy HealthState = "UNHEALTHY"
)

// HealthChecker handles periodic health checking and status publishing
type HealthChecker struct {
	config           *HealthConfig
	httpClient       *http.Client
	state            HealthState
	stateMutex       sync.RWMutex
	lastStatus       bool
	consecutiveReady int // Count of consecutive ready checks (for stability)
	stopChan         chan struct{}
	statusChangeChan chan bool
}

// HealthConfig holds health check configuration
type HealthConfig struct {
	HealthCheckEndpoint string
	ServicePort         string
	InstanceItemName    string // Item name (for logging/debugging)
	InstanceItemID      string // Item ID (for test-agent matching)
	InstanceID          string
	ControlTowerURL     string
	TestAgentURL        string // Optional: URL for test-agent
	CheckTimeout        time.Duration
	Origin              string // Service name to health check (e.g., "service-a")
	K8sDNSIP            string // K8s DNS IP for resolving service ClusterIP
	K8sNamespace        string // K8s namespace for service resolution
}

// NewHealthChecker creates a new health checker
func NewHealthChecker(cfg *HealthConfig) *HealthChecker {
	if cfg == nil || cfg.HealthCheckEndpoint == "" || cfg.ServicePort == "" || cfg.InstanceItemName == "" {
		// Health checking is optional - return nil if not configured
		return nil
	}

	checker := &HealthChecker{
		config: cfg,
		httpClient: &http.Client{
			Timeout: cfg.CheckTimeout,
		},
		state:            StateBooting,
		lastStatus:       false,
		consecutiveReady: 0,
		stopChan:         make(chan struct{}),
		statusChangeChan: make(chan bool, 10),
	}

	return checker
}

// Start begins the health checking goroutine
func (h *HealthChecker) Start() {
	if h == nil {
		return
	}

	go h.run()
}

// Stop stops the health checker
func (h *HealthChecker) Stop() {
	if h == nil {
		return
	}

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
		// 1-2 seconds (fast detection)
		return 1500 * time.Millisecond
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
	ready, statusCode, err := h.checkHealth()
	checkDuration := int(time.Since(startTime).Milliseconds())

	// Update state based on result
	h.updateState(ready)

	// Publish status based on current state, not just the check result
	// Only report ready=true when we're actually in HEALTHY state
	h.stateMutex.RLock()
	currentState := h.state
	h.stateMutex.RUnlock()

	// Only publish ready=true if we're in HEALTHY state
	// This ensures we don't report ready on the first check
	shouldReportReady := currentState == StateHealthy
	h.publishStatus(shouldReportReady, checkDuration, statusCode, err)
}

// checkHealth performs the actual HTTP health check
// For per-service interceptors, resolves the service name using K8s DNS and calls it remotely
func (h *HealthChecker) checkHealth() (ready bool, statusCode int, err error) {
	// Resolve service name to ClusterIP using K8s DNS
	serviceName := h.config.Origin
	if serviceName == "" {
		// If ORIGIN is not set, this is the shared interceptor - skip health check
		return false, 0, fmt.Errorf("ORIGIN not set, cannot perform health check")
	}

	// Build service FQDN for DNS resolution. In-cluster, Control Tower sets
	// K8sNamespace and we construct the full DNS name. Outside a cluster (e.g.
	// unit tests pointing at a local server), K8sNamespace is empty and we use
	// the provided Origin as-is.
	var serviceFQDN string
	if h.config.K8sNamespace != "" {
		serviceFQDN = fmt.Sprintf("%s.%s.svc.cluster.local", serviceName, h.config.K8sNamespace)
	} else {
		serviceFQDN = serviceName
	}

	// Resolve service ClusterIP using K8s DNS
	var dialer *net.Dialer
	if h.config.K8sDNSIP != "" {
		dialer = &net.Dialer{
			Resolver: &net.Resolver{
				PreferGo: true,
				Dial: func(ctx context.Context, network, address string) (net.Conn, error) {
					// Use K8s DNS instead of system resolver
					d := net.Dialer{}
					return d.DialContext(ctx, "udp", h.config.K8sDNSIP+":53")
				},
			},
		}
	} else {
		dialer = &net.Dialer{}
	}

	// Resolve service name to IP
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	ips, err := dialer.Resolver.LookupIPAddr(ctx, serviceFQDN)
	if err != nil {
		return false, 0, fmt.Errorf("failed to resolve service %s: %w", serviceFQDN, err)
	}

	if len(ips) == 0 {
		return false, 0, fmt.Errorf("no IP addresses found for service %s", serviceFQDN)
	}

	// Use first IP address (ClusterIP)
	serviceIP := ips[0].IP.String()

	// Build health check URL using resolved ClusterIP and standardized port 80
	url := fmt.Sprintf("http://%s:%s%s", serviceIP, h.config.ServicePort, h.config.HealthCheckEndpoint)

	req, err := http.NewRequest(http.MethodGet, url, nil)
	if err != nil {
		return false, 0, err
	}

	resp, err := h.httpClient.Do(req)
	if err != nil {
		// Connection error, timeout, or other network error
		return false, 0, err
	}
	defer resp.Body.Close()

	statusCode = resp.StatusCode

	// Success: HTTP 200 response (any endpoint that doesn't return 404)
	if statusCode == http.StatusOK {
		return true, statusCode, nil
	}

	// Failure: Non-200 response (including 404)
	return false, statusCode, nil
}

// updateState updates the state machine based on health check result
func (h *HealthChecker) updateState(ready bool) {
	h.stateMutex.Lock()
	defer h.stateMutex.Unlock()

	// Track consecutive ready checks for stability
	if ready {
		h.consecutiveReady++
	} else {
		h.consecutiveReady = 0
	}

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
		// Require 2 consecutive successful checks before reporting ready
		// This ensures the service is consistently ready, not just passing once
		if ready && h.consecutiveReady >= 2 {
			h.state = StateHealthy
			log.Printf("Health check: Service became healthy (2 consecutive checks passed), transitioning to HEALTHY state")
		}
		// Stay in BOOTING if not ready or not enough consecutive checks
	case StateHealthy:
		if !ready {
			h.state = StateUnhealthy
			log.Printf("Health check: Service became unhealthy, transitioning to UNHEALTHY state")
		}
		// Stay in HEALTHY if ready
	case StateUnhealthy:
		// Require 2 consecutive successful checks before recovering
		if ready && h.consecutiveReady >= 2 {
			h.state = StateHealthy
			log.Printf("Health check: Service recovered (2 consecutive checks passed), transitioning to HEALTHY state")
		}
		// Stay in UNHEALTHY if not ready or not enough consecutive checks
	}
}

// publishStatus publishes health status to LPS and optionally to test-agent
func (h *HealthChecker) publishStatus(ready bool, checkDuration int, statusCode int, checkErr error) {
	statusUpdate := HealthStatusUpdate{
		InstanceID:       h.config.InstanceID,
		InstanceItemName: h.config.InstanceItemName,
		InstanceItemID:   h.config.InstanceItemID, // Use ID for test-agent matching
		Ready:            ready,
		Timestamp:        time.Now().Format(time.RFC3339Nano),
		Details: HealthStatusDetails{
			CheckDuration: checkDuration,
			StatusCode:    statusCode,
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
	req, err := http.NewRequest(http.MethodPost, url, bytes.NewBuffer(body))
	if err != nil {
		log.Printf("Health check: Failed to create request: %v", err)
		return
	}

	req.Header.Set("Content-Type", "application/json")

	// Send with retry logic (exponential backoff)
	maxRetries := 3
	for i := 0; i < maxRetries; i++ {
		resp, err := h.httpClient.Do(req)
		if err == nil {
			resp.Body.Close()
			if resp.StatusCode == http.StatusOK || resp.StatusCode == http.StatusCreated {
				return // Success
			}
		}

		// Retry with exponential backoff
		if i < maxRetries-1 {
			backoff := time.Duration(1<<uint(i)) * time.Second
			time.Sleep(backoff)
		}
	}

	// Log error but don't block health checking
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
	req, err := http.NewRequest(http.MethodPost, url, bytes.NewBuffer(body))
	if err != nil {
		log.Printf("Health check: Failed to create request to test-agent: %v", err)
		return
	}

	req.Header.Set("Content-Type", "application/json")

	// Send with retry logic (exponential backoff)
	maxRetries := 3
	for i := 0; i < maxRetries; i++ {
		resp, err := h.httpClient.Do(req)
		if err == nil {
			resp.Body.Close()
			if resp.StatusCode == http.StatusOK || resp.StatusCode == http.StatusCreated {
				return // Success
			}
		}

		// Retry with exponential backoff
		if i < maxRetries-1 {
			backoff := time.Duration(1<<uint(i)) * time.Second
			time.Sleep(backoff)
		}
	}

	// Log error but don't block health checking
	log.Printf("Health check: Failed to send status update to test-agent after %d retries", maxRetries)
}

// HealthStatusUpdate represents the status update sent to LPS
type HealthStatusUpdate struct {
	InstanceID       string              `json:"instanceId"`
	InstanceItemName string              `json:"instanceItemName"`
	InstanceItemID   string              `json:"instanceItemId"` // ID for test-agent matching
	Ready            bool                `json:"ready"`
	Timestamp        string              `json:"timestamp"`
	Details          HealthStatusDetails `json:"details,omitempty"`
}

// HealthStatusDetails contains additional details about the health check
type HealthStatusDetails struct {
	CheckDuration int    `json:"checkDuration,omitempty"`
	StatusCode    int    `json:"statusCode,omitempty"`
	Error         string `json:"error,omitempty"`
}
