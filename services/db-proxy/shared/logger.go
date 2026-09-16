package shared

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"log"
	"net/http"
	"time"
)

// DatabaseLogMessage represents the format expected by LPS POST /logs/database
type DatabaseLogMessage struct {
	LogID          string                   `json:"logId,omitempty"`
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
	message.LogID = newLogID()
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

	// Retry transient failures — this write is the durable record. Runs on the
	// sequential worker, so retries block the queue; the buffered channel
	// absorbs the stall. A 4xx is deterministic (validation) — never retried.
	url := l.logEndpointURL + "/logs/database"
	for attempt, backoff := 0, 250*time.Millisecond; attempt < 3; attempt, backoff = attempt+1, backoff*4 {
		if attempt > 0 {
			time.Sleep(backoff)
		}
		req, err := http.NewRequest(http.MethodPost, url, bytes.NewBuffer(body))
		if err != nil {
			log.Printf("[QueryLogger] Failed to create request to %s: %v", url, err)
			return
		}
		req.Header.Set("Content-Type", "application/json")

		resp, err := l.httpClient.Do(req)
		if err != nil {
			log.Printf("[QueryLogger] Failed to send log to %s (attempt %d/3): %v", url, attempt+1, err)
			continue
		}
		status := resp.StatusCode
		resp.Body.Close()
		if status >= 200 && status < 300 {
			return
		}
		if status >= 500 || status == http.StatusTooManyRequests {
			log.Printf("[QueryLogger] LPS returned status %d for query: %.80s (attempt %d/3)", status, message.Query, attempt+1)
			continue
		}
		log.Printf("[QueryLogger] LPS rejected log with status %d for query: %.80s — not retrying", status, message.Query)
		return
	}
}

// sendToTestAgent sends a copy of the log to the test-agent for inline validation.
// Retries because these logs feed in-flight assertion validation — a dropped
// POST loses the log for the current test window, unlike the LPS path where
// the log is also persisted.
func (l *QueryLogger) sendToTestAgent(body []byte) {
	url := l.testAgentURL + "/logs/database"
	for attempt, backoff := 0, 250*time.Millisecond; attempt < 3; attempt, backoff = attempt+1, backoff*4 {
		if attempt > 0 {
			time.Sleep(backoff)
		}
		req, err := http.NewRequest(http.MethodPost, url, bytes.NewBuffer(body))
		if err != nil {
			return
		}
		req.Header.Set("Content-Type", "application/json")

		resp, err := l.testAgentClient.Do(req)
		if err != nil {
			log.Printf("[QueryLogger] Failed to send log to test-agent (attempt %d/3): %v", attempt+1, err)
			continue
		}
		status := resp.StatusCode
		resp.Body.Close()
		if status >= 200 && status < 300 {
			return
		}
		if status >= 500 || status == http.StatusTooManyRequests {
			log.Printf("[QueryLogger] Test-agent returned status %d (attempt %d/3)", status, attempt+1)
			continue
		}
		log.Printf("[QueryLogger] Test-agent rejected log with status %d — not retrying", status)
		return
	}
}

// newLogID returns a random 128-bit hex id. The test-agent uses it to
// deduplicate retried log deliveries; empty (on entropy failure) just means
// no dedup for that message.
func newLogID() string {
	b := make([]byte, 16)
	if _, err := rand.Read(b); err != nil {
		return ""
	}
	return hex.EncodeToString(b)
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
