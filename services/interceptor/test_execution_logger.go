package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"strings"
	"time"
)

// TestExecutionLogMessage matches the format expected by Log Processor Service
type TestExecutionLogMessage struct {
	InstanceID string `json:"instanceId"`
	EventType  string `json:"eventType"`
	Message    string `json:"message"`
	Duration   *int   `json:"duration,omitempty"`
	Error      string `json:"error,omitempty"`
	ErrorType  string `json:"errorType,omitempty"`
	Timestamp  string `json:"timestamp,omitempty"`
}

// TestExecutionLogger sends async test execution logs to LPS
type TestExecutionLogger struct {
	logEndpointURL string
	instanceID     string
	httpClient     *http.Client
	logChan        chan TestExecutionLogMessage
	stopChan       chan struct{}
}

func NewTestExecutionLogger(logEndpointURL, instanceID string) *TestExecutionLogger {
	l := &TestExecutionLogger{
		logEndpointURL: logEndpointURL,
		instanceID:     instanceID,
		httpClient:     &http.Client{Timeout: 10 * time.Second},
		logChan:        make(chan TestExecutionLogMessage, 1000),
		stopChan:       make(chan struct{}),
	}
	go l.worker()
	return l
}

func (l *TestExecutionLogger) LogRequestStarted(method, url, origin string) {
	msg := fmt.Sprintf("%s %s", method, url)
	if origin != "" {
		msg = fmt.Sprintf("[%s] %s %s", origin, method, url)
	}
	l.queue(TestExecutionLogMessage{
		InstanceID: l.instanceID,
		EventType:  "REQUEST_STARTED",
		Message:    msg,
		Timestamp:  time.Now().UTC().Format(time.RFC3339Nano),
	})
}

func (l *TestExecutionLogger) LogRequestCompleted(method, url, origin string, statusCode, durationMs int, err error) {
	dur := durationMs
	msg := fmt.Sprintf("%s %s → %d", method, url, statusCode)
	if origin != "" {
		msg = fmt.Sprintf("[%s] %s %s → %d", origin, method, url, statusCode)
	}

	if err != nil {
		errMsg := err.Error()
		errType := classifyError(errMsg)
		if origin != "" {
			msg = fmt.Sprintf("[%s] %s %s failed", origin, method, url)
		} else {
			msg = fmt.Sprintf("%s %s failed", method, url)
		}
		l.queue(TestExecutionLogMessage{
			InstanceID: l.instanceID,
			EventType:  "REQUEST_FAILED",
			Message:    msg,
			Duration:   &dur,
			Error:      errMsg,
			ErrorType:  errType,
			Timestamp:  time.Now().UTC().Format(time.RFC3339Nano),
		})
		return
	}

	l.queue(TestExecutionLogMessage{
		InstanceID: l.instanceID,
		EventType:  "REQUEST_COMPLETED",
		Message:    msg,
		Duration:   &dur,
		Timestamp:  time.Now().UTC().Format(time.RFC3339Nano),
	})
}

func (l *TestExecutionLogger) queue(msg TestExecutionLogMessage) {
	select {
	case l.logChan <- msg:
	default:
		log.Printf("[TestExecutionLogger] Warning: log channel full, dropping event: %s", msg.EventType)
	}
}

func (l *TestExecutionLogger) worker() {
	for {
		select {
		case msg := <-l.logChan:
			l.send(msg)
		case <-l.stopChan:
			return
		}
	}
}

func (l *TestExecutionLogger) send(msg TestExecutionLogMessage) {
	body, err := json.Marshal(msg)
	if err != nil {
		log.Printf("[TestExecutionLogger] Failed to marshal log: %v", err)
		return
	}

	url := l.logEndpointURL + "/logs/test-execution"
	req, err := http.NewRequest(http.MethodPost, url, bytes.NewBuffer(body))
	if err != nil {
		log.Printf("[TestExecutionLogger] Failed to create request: %v", err)
		return
	}
	req.Header.Set("Content-Type", "application/json")

	resp, err := l.httpClient.Do(req)
	if err != nil {
		log.Printf("[TestExecutionLogger] Failed to send log: %v", err)
		return
	}
	defer resp.Body.Close()
}

func (l *TestExecutionLogger) Stop() {
	select {
	case <-l.stopChan:
	default:
		close(l.stopChan)
	}

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	for {
		select {
		case msg := <-l.logChan:
			l.send(msg)
		case <-ctx.Done():
			return
		default:
			return
		}
	}
}

func classifyError(errMsg string) string {
	switch {
	case strings.Contains(errMsg, "timeout") || strings.Contains(errMsg, "deadline exceeded"):
		return "timeout"
	case strings.Contains(errMsg, "connection refused") || strings.Contains(errMsg, "no such host"):
		return "network"
	case strings.Contains(errMsg, "context canceled"):
		return "context_canceled"
	default:
		return "unknown"
	}
}
