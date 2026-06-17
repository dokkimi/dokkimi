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

// TestExecutionLogMessage represents the format expected by Log Processor Service
type TestExecutionLogMessage struct {
	InstanceID     string                 `json:"instanceId"`
	EventType      string                 `json:"eventType"`
	Message        string                 `json:"message"`
	StepIndex      *int                   `json:"stepIndex,omitempty"`
	SubActionIndex *int                   `json:"subActionIndex,omitempty"` // index within a parallel action batch
	SubStepIndex   *int                   `json:"subStepIndex,omitempty"`   // UI sub-step position within action.steps
	ActionType     string                 `json:"actionType,omitempty"`     // UI sub-step kind (visit/click/type/...)
	Selector       string                 `json:"selector,omitempty"`       // UI sub-step CSS selector (when applicable)
	Duration       *int                   `json:"duration,omitempty"`
	Error          string                 `json:"error,omitempty"`
	ErrorType      string                 `json:"errorType,omitempty"`
	Variables      map[string]interface{} `json:"variables"`
	Timestamp      string                 `json:"timestamp,omitempty"`

	// flushDone is an internal sentinel field — when non-nil, the worker closes
	// it instead of sending the message. This guarantees all prior messages in
	// the channel have been fully processed before Flush returns.
	flushDone chan struct{} `json:"-"`
}

// TestExecutionLogger handles async logging to Control Tower's log-processing module
type TestExecutionLogger struct {
	logEndpointURL string
	httpClient     *http.Client
	logChan        chan TestExecutionLogMessage
	stopChan       chan struct{}
	instanceId     string
	varCtx         *VariableContext
}

// NewTestExecutionLogger creates a new async logger
func NewTestExecutionLogger(logEndpointURL string, instanceId string, timeout time.Duration) *TestExecutionLogger {
	logger := &TestExecutionLogger{
		logEndpointURL: logEndpointURL,
		instanceId:     instanceId,
		httpClient: &http.Client{
			Timeout: timeout,
		},
		logChan:  make(chan TestExecutionLogMessage, 1000), // Buffered channel
		stopChan: make(chan struct{}),
	}

	// Start background worker
	go logger.worker()

	return logger
}

// SetVariableContext sets the variable context for automatic snapshots in log events.
func (l *TestExecutionLogger) SetVariableContext(varCtx *VariableContext) {
	l.varCtx = varCtx
}

// LogEvent logs a generic execution event
func (l *TestExecutionLogger) LogEvent(eventType string, message string, stepIndex *int, subActionIndex *int) {
	if l == nil {
		return
	}
	l.logEvent(eventType, message, stepIndex, subActionIndex, nil, "", "")
}

// LogRequestStarted logs a REQUEST_STARTED event with a user-friendly message
func (l *TestExecutionLogger) LogRequestStarted(stepIndex int, method string, url string) {
	if l == nil {
		return
	}
	msg := fmt.Sprintf("%s %s", method, url)
	si := stepIndex
	l.logEvent("REQUEST_STARTED", msg, &si, nil, nil, "", "")
}

// LogRequestCompleted logs a REQUEST_COMPLETED or REQUEST_FAILED event
func (l *TestExecutionLogger) LogRequestCompleted(stepIndex int, subActionIndex int, duration int, err error) {
	if l == nil {
		return
	}
	si := stepIndex
	sai := subActionIndex
	dur := duration

	if err != nil {
		errMsg := err.Error()
		var errType string
		switch {
		case strings.Contains(errMsg, "timeout") || strings.Contains(errMsg, "deadline exceeded"):
			errType = "timeout"
		case strings.Contains(errMsg, "connection refused") || strings.Contains(errMsg, "no such host"):
			errType = "network"
		case strings.Contains(errMsg, "context canceled"):
			errType = "context_canceled"
		default:
			errType = "unknown"
		}
		l.logEvent("REQUEST_FAILED", errMsg, &si, &sai, &dur, errMsg, errType)
	} else {
		l.logEvent("REQUEST_COMPLETED", "Request completed", &si, &sai, &dur, "", "")
	}
}

// logEvent is the internal method to queue an event
func (l *TestExecutionLogger) logEvent(eventType string, message string, stepIndex *int, subActionIndex *int, duration *int, error string, errorType string) {
	l.logEventDetailed(eventType, message, stepIndex, subActionIndex, nil, "", "", duration, error, errorType)
}

// logEventDetailed is the underlying queueing path with the full field set
// (including UI sub-step fields). Kept internal; callers use the typed
// wrappers above and LogUISubStep* below.
func (l *TestExecutionLogger) logEventDetailed(
	eventType string,
	message string,
	stepIndex *int,
	subActionIndex *int,
	subStepIndex *int,
	actionType string,
	selector string,
	duration *int,
	errStr string,
	errorType string,
) {
	variables := map[string]interface{}{}
	if l.varCtx != nil {
		variables = l.varCtx.Snapshot()
	}

	msg := TestExecutionLogMessage{
		InstanceID:     l.instanceId,
		EventType:      eventType,
		Message:        message,
		StepIndex:      stepIndex,
		SubActionIndex: subActionIndex,
		SubStepIndex:   subStepIndex,
		ActionType:     actionType,
		Selector:       selector,
		Duration:       duration,
		Error:          errStr,
		ErrorType:      errorType,
		Variables:      variables,
		Timestamp:      time.Now().UTC().Format(time.RFC3339Nano),
	}

	// Non-blocking send (drop if channel is full)
	select {
	case l.logChan <- msg:
		// Successfully queued
	default:
		log.Printf("[TestExecutionLogger] Warning: log channel full, dropping event: %s", eventType)
	}
}

// LogUISubStepStarted emits the boundary event at the start of a UI sub-step.
// downstream HTTP/DB/console logs with timestamps after this event and before
// the next sub-step boundary are attributable to this sub-step.
func (l *TestExecutionLogger) LogUISubStepStarted(
	stepIndex, subStepIndex int,
	actionType, selector, target string,
) {
	if l == nil {
		return
	}
	si, ssi := stepIndex, subStepIndex
	msg := actionType
	if selector != "" {
		msg = fmt.Sprintf("%s %s", actionType, selector)
	}
	if target != "" {
		msg = fmt.Sprintf("%s on %s", msg, target)
	}
	l.logEventDetailed("UI_SUBSTEP_STARTED", msg, &si, nil, &ssi, actionType, selector, nil, "", "")
}

// LogUISubStepCompleted emits either UI_SUBSTEP_COMPLETED (success) or
// UI_SUBSTEP_FAILED (err != nil). Mirror of LogRequestCompleted for UI.
func (l *TestExecutionLogger) LogUISubStepCompleted(
	stepIndex, subStepIndex int,
	actionType, selector string,
	durationMs int,
	err error,
) {
	if l == nil {
		return
	}
	si, ssi := stepIndex, subStepIndex
	dur := durationMs

	if err != nil {
		errMsg := err.Error()
		var errType string
		switch {
		case strings.Contains(errMsg, "timeout") || strings.Contains(errMsg, "deadline exceeded"):
			errType = "timeout"
		case strings.Contains(errMsg, "context canceled"):
			errType = "context_canceled"
		case strings.Contains(errMsg, "no such element") || strings.Contains(errMsg, "not visible"):
			errType = "selector"
		default:
			errType = "unknown"
		}
		l.logEventDetailed("UI_SUBSTEP_FAILED", errMsg, &si, nil, &ssi, actionType, selector, &dur, errMsg, errType)
		return
	}
	l.logEventDetailed("UI_SUBSTEP_COMPLETED", "sub-step completed", &si, nil, &ssi, actionType, selector, &dur, "", "")
}

// worker processes log queue in background
func (l *TestExecutionLogger) worker() {
	for {
		select {
		case msg := <-l.logChan:
			if msg.flushDone != nil {
				close(msg.flushDone)
				continue
			}
			l.sendLog(msg)
		case <-l.stopChan:
			return
		}
	}
}

// sendLog sends a test execution log message to Log Processor Service
func (l *TestExecutionLogger) sendLog(message TestExecutionLogMessage) {
	body, err := json.Marshal(message)
	if err != nil {
		log.Printf("[TestExecutionLogger] Failed to marshal log message for instance %s: %v", message.InstanceID, err)
		return // Drop log on marshal error
	}

	url := l.logEndpointURL + "/logs/test-execution"
	req, err := http.NewRequest(http.MethodPost, url, bytes.NewBuffer(body))
	if err != nil {
		log.Printf("[TestExecutionLogger] Failed to create request to %s for instance %s: %v", url, message.InstanceID, err)
		return
	}

	req.Header.Set("Content-Type", "application/json")

	// Send with timeout, but don't block if it fails
	resp, err := l.httpClient.Do(req)
	if err != nil {
		log.Printf("[TestExecutionLogger] Failed to send log to %s for instance %s (eventType: %s): %v", url, message.InstanceID, message.EventType, err)
		return // Drop log on network error
	}
	defer resp.Body.Close()

	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		log.Printf("[TestExecutionLogger] Control Tower returned non-success status for instance %s (eventType: %s, status: %d)", message.InstanceID, message.EventType, resp.StatusCode)
	}
}

// Flush blocks until all currently queued log messages have been fully sent to Control Tower.
// Pushes a sentinel message onto the channel; the worker closes its done channel
// after processing all preceding messages. Returns after done or a 10-second timeout.
func (l *TestExecutionLogger) Flush() {
	if l == nil {
		return
	}
	done := make(chan struct{})
	// Push sentinel onto the same channel — ordering guarantees all prior messages
	// have been processed by the time the worker reaches this sentinel.
	select {
	case l.logChan <- TestExecutionLogMessage{flushDone: done}:
		// Sentinel queued, wait for worker to process it
	default:
		// Channel full — all 1000 slots occupied. Pod logs may not reach Control Tower.
		log.Printf("[TestExecutionLogger] Warning: Flush failed — channel full, pod logs may be lost")
		return
	}
	select {
	case <-done:
		// All messages before the sentinel have been sent
	case <-time.After(10 * time.Second):
		log.Printf("[TestExecutionLogger] Flush timed out after 10s")
	}
}

// Stop stops the logger worker and drains remaining logs.
// Call Flush() before Stop() if you need delivery guarantees — Stop() kills
// the worker immediately, which will strand any pending Flush() sentinel.
func (l *TestExecutionLogger) Stop() {
	// Signal worker to stop
	select {
	case <-l.stopChan:
		// Already closed
	default:
		close(l.stopChan)
	}

	// Drain remaining logs in channel with timeout
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	drained := 0
	for {
		select {
		case msg := <-l.logChan:
			// Send remaining log
			l.sendLog(msg)
			drained++
		case <-ctx.Done():
			// Timeout reached, stop draining
			if drained > 0 {
				log.Printf("[TestExecutionLogger] Drained %d remaining logs before shutdown", drained)
			}
			return
		default:
			// Channel empty, we're done
			if drained > 0 {
				log.Printf("[TestExecutionLogger] Drained %d remaining logs before shutdown", drained)
			}
			return
		}
	}
}
