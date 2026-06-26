package shared

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

// BuildHealthCheckFunc returns a check function based on the config's
// HealthCheckEndpoint. Empty or "tcp" → TCP dial; otherwise HTTP GET.
func BuildHealthCheckFunc(cfg *Config) func(ctx context.Context) error {
	if cfg.HealthCheckEndpoint == "" || cfg.HealthCheckEndpoint == "tcp" {
		return func(ctx context.Context) error {
			addr := net.JoinHostPort("localhost", cfg.BrokerPort)
			conn, err := net.DialTimeout("tcp", addr, cfg.CheckTimeout)
			if err != nil {
				return err
			}
			conn.Close()
			return nil
		}
	}
	client := &http.Client{Timeout: cfg.CheckTimeout}
	url := fmt.Sprintf("http://localhost:%s%s", cfg.BrokerPort, cfg.HealthCheckEndpoint)
	return func(ctx context.Context) error {
		req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
		if err != nil {
			return err
		}
		resp, err := client.Do(req)
		if err != nil {
			return err
		}
		resp.Body.Close()
		if resp.StatusCode < 200 || resp.StatusCode >= 300 {
			return fmt.Errorf("health check returned status %d", resp.StatusCode)
		}
		return nil
	}
}

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

func (h *HealthChecker) Start() {
	go h.run()
}

func (h *HealthChecker) Stop() {
	select {
	case <-h.stopChan:
	default:
		close(h.stopChan)
	}
}

func (h *HealthChecker) run() {
	ticker := time.NewTicker(h.getCheckInterval())
	defer ticker.Stop()

	h.performCheck()

	for {
		select {
		case <-ticker.C:
			h.performCheck()
			ticker.Reset(h.getCheckInterval())
		case <-h.stopChan:
			return
		}
	}
}

func (h *HealthChecker) getCheckInterval() time.Duration {
	h.stateMutex.RLock()
	defer h.stateMutex.RUnlock()

	switch h.state {
	case StateBooting:
		return 500 * time.Millisecond
	case StateHealthy:
		return 20 * time.Second
	case StateUnhealthy:
		return 1500 * time.Millisecond
	default:
		return 5 * time.Second
	}
}

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

func (h *HealthChecker) updateState(ready bool) {
	h.stateMutex.Lock()
	defer h.stateMutex.Unlock()

	statusChanged := h.lastStatus != ready
	h.lastStatus = ready

	if statusChanged {
		select {
		case h.statusChangeChan <- ready:
		default:
		}
	}

	switch h.state {
	case StateBooting:
		if ready {
			h.state = StateHealthy
			log.Printf("Health check: Broker became healthy, transitioning to HEALTHY state")
		}
	case StateHealthy:
		if !ready {
			h.state = StateUnhealthy
			log.Printf("Health check: Broker became unhealthy, transitioning to UNHEALTHY state")
		}
	case StateUnhealthy:
		if ready {
			h.state = StateHealthy
			log.Printf("Health check: Broker recovered, transitioning to HEALTHY state")
		}
	}
}

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

	go h.sendStatusUpdate(statusUpdate)

	if h.config.TestAgentURL != "" {
		go h.sendStatusUpdateToTestAgent(statusUpdate)
	}
}

func (h *HealthChecker) postWithRetry(url string, body []byte) error {
	maxRetries := 3
	for i := 0; i < maxRetries; i++ {
		req, err := http.NewRequest(http.MethodPost, url, bytes.NewBuffer(body))
		if err != nil {
			return err
		}
		req.Header.Set("Content-Type", "application/json")

		resp, err := h.httpClient.Do(req)
		if err == nil {
			resp.Body.Close()
			if resp.StatusCode == http.StatusOK || resp.StatusCode == http.StatusCreated {
				return nil
			}
		}

		if i < maxRetries-1 {
			backoff := time.Duration(1<<uint(i)) * time.Second
			time.Sleep(backoff)
		}
	}

	return fmt.Errorf("failed after %d retries", maxRetries)
}

func (h *HealthChecker) sendStatusUpdate(update HealthStatusUpdate) {
	body, err := json.Marshal(update)
	if err != nil {
		log.Printf("Health check: Failed to marshal status update: %v", err)
		return
	}

	url := h.config.ControlTowerURL + "/health/status"
	if err := h.postWithRetry(url, body); err != nil {
		log.Printf("Health check: Failed to publish status update: %v", err)
	}
}

func (h *HealthChecker) sendStatusUpdateToTestAgent(update HealthStatusUpdate) {
	body, err := json.Marshal(update)
	if err != nil {
		return
	}

	url := h.config.TestAgentURL + "/health/status"
	h.postWithRetry(url, body)
}
