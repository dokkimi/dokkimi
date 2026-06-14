package shared

import (
	"bytes"
	"context"
	"encoding/json"
	"log"
	"net/http"
	"time"
)

// DatabaseLogMessage represents the format expected by LPS POST /logs/database
type DatabaseLogMessage struct {
	InstanceID     string                   `json:"instanceId"`
	InstanceItemID string                   `json:"instanceItemId,omitempty"`
	DatabaseType   string                   `json:"databaseType"`
	DatabaseName   string                   `json:"databaseName"`
	Query          string                   `json:"query"`
	Params         map[string]interface{}   `json:"params,omitempty"`
	Success        bool                     `json:"success"`
	Data           []map[string]interface{} `json:"data,omitempty"`
	RowsAffected   *int64                   `json:"rowsAffected,omitempty"`
	Error          string                   `json:"error,omitempty"`
	Duration       *int                     `json:"duration,omitempty"`
	Timestamp      string                   `json:"timestamp,omitempty"`
}

// QueryLogger handles async logging of database queries to LPS
type QueryLogger struct {
	logEndpointURL  string
	testAgentURL    string
	httpClient      *http.Client
	testAgentClient *http.Client
	logChan         chan DatabaseLogMessage
	stopChan        chan struct{}
}

// NewQueryLogger creates a new async database query logger
func NewQueryLogger(logEndpointURL string, timeout time.Duration) *QueryLogger {
	logger := &QueryLogger{
		logEndpointURL:  logEndpointURL,
		httpClient:      &http.Client{Timeout: timeout},
		testAgentClient: &http.Client{Timeout: timeout},
		logChan:         make(chan DatabaseLogMessage, 1000),
		stopChan:        make(chan struct{}),
	}

	go logger.worker()

	return logger
}

// SetTestAgentURL enables dual-write to the test-agent for inline validation.
func (l *QueryLogger) SetTestAgentURL(url string) {
	l.testAgentURL = url
}

// Log queues a database log message for async delivery to LPS
func (l *QueryLogger) Log(message DatabaseLogMessage) {
	select {
	case l.logChan <- message:
		// Successfully queued
	default:
		log.Printf("[QueryLogger] WARNING: Log channel full, dropping log for query: %.80s", message.Query)
	}
}

// worker processes the log queue in background
func (l *QueryLogger) worker() {
	for {
		select {
		case message := <-l.logChan:
			l.sendLog(message)
		case <-l.stopChan:
			return
		}
	}
}

// sendLog sends a database log message to LPS
func (l *QueryLogger) sendLog(message DatabaseLogMessage) {
	body, err := json.Marshal(message)
	if err != nil {
		log.Printf("[QueryLogger] Failed to marshal log message: %v", err)
		return
	}

	// Dual-write: send to test-agent in a separate goroutine (independent, fire-and-forget)
	if l.testAgentURL != "" {
		go l.sendToTestAgent(body)
	}

	url := l.logEndpointURL + "/logs/database"
	req, err := http.NewRequest(http.MethodPost, url, bytes.NewBuffer(body))
	if err != nil {
		log.Printf("[QueryLogger] Failed to create request to %s: %v", url, err)
		return
	}

	req.Header.Set("Content-Type", "application/json")

	resp, err := l.httpClient.Do(req)
	if err != nil {
		log.Printf("[QueryLogger] Failed to send log to %s: %v", url, err)
		return
	}
	defer resp.Body.Close()

	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		log.Printf("[QueryLogger] LPS returned non-success status %d for query: %.80s", resp.StatusCode, message.Query)
	}
}

// sendToTestAgent sends a copy of the log to the test-agent for inline validation.
func (l *QueryLogger) sendToTestAgent(body []byte) {
	url := l.testAgentURL + "/logs/database"
	req, err := http.NewRequest(http.MethodPost, url, bytes.NewBuffer(body))
	if err != nil {
		return
	}
	req.Header.Set("Content-Type", "application/json")

	resp, err := l.testAgentClient.Do(req)
	if err != nil {
		log.Printf("[QueryLogger] Failed to send log to test-agent: %v", err)
		return
	}
	resp.Body.Close()
}

// Stop stops the logger worker and drains remaining logs
func (l *QueryLogger) Stop() {
	select {
	case <-l.stopChan:
		// Already closed
	default:
		close(l.stopChan)
	}

	// Drain remaining logs with timeout
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	for {
		select {
		case message := <-l.logChan:
			l.sendLog(message)
		case <-ctx.Done():
			return
		default:
			return
		}
	}
}
