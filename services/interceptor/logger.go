package main

import (
	"bytes"
	"context"
	"encoding/json"
	"log"
	"net/http"
	"strings"
	"time"
)

// HttpLogMessage represents the format expected by Log Processor Service
type HttpLogMessage struct {
	InstanceID         string                 `json:"instanceId"`
	Method             string                 `json:"method"`
	URL                string                 `json:"url"`
	StatusCode         *int                   `json:"statusCode,omitempty"`
	RequestBody        interface{}            `json:"requestBody,omitempty"`
	ResponseBody       interface{}            `json:"responseBody,omitempty"`
	RequestHeaders     map[string]interface{} `json:"requestHeaders,omitempty"`
	ResponseHeaders    map[string]interface{} `json:"responseHeaders,omitempty"`
	IsMocked           *bool                  `json:"isMocked,omitempty"`
	Timestamp          string                 `json:"timestamp,omitempty"`
	Origin             *string                `json:"origin,omitempty"`             // Origin service name
	OriginID           *string                `json:"instanceItemId,omitempty"`     // Origin's instanceItemId
	Target             *string                `json:"target,omitempty"`             // Target service name
	TargetID           *string                `json:"targetId,omitempty"`           // Target's instanceItemId
	RequestSentAt      *string                `json:"requestSentAt,omitempty"`      // ISO timestamp when request was sent
	ResponseReceivedAt *string                `json:"responseReceivedAt,omitempty"` // ISO timestamp when response was received
}

// Logger handles async logging to Log Processor Service (LPS)
type Logger struct {
	logEndpointURL    string
	testAgentURL      string
	httpClient        *http.Client
	testAgentClient   *http.Client
	logChan           chan HttpLogMessage
	stopChan          chan struct{}
}

// NewLogger creates a new async logger
func NewLogger(logEndpointURL string, timeout time.Duration, client *http.Client) *Logger {
	if client == nil {
		client = &http.Client{Timeout: timeout}
	} else {
		client.Timeout = timeout
	}
	logger := &Logger{
		logEndpointURL:  logEndpointURL,
		httpClient:      client,
		testAgentClient: &http.Client{Timeout: timeout},
		logChan:         make(chan HttpLogMessage, 1000), // Buffered channel
		stopChan:        make(chan struct{}),
	}

	// Start background worker
	go logger.worker()

	return logger
}

// SetTestAgentURL enables dual-write to the test-agent for inline validation.
func (l *Logger) SetTestAgentURL(url string) {
	l.testAgentURL = url
}

// LogResponse logs a complete HTTP request/response pair to LPS with timing information
func (l *Logger) LogResponse(r *http.Request, actionID string, resp *http.Response, isMocked bool, urlMap UrlMap, namespace, origin, originID, targetServiceName string, requestBody, responseBody interface{}, requestSentAt, responseReceivedAt *time.Time) {
	// Capture response headers
	respHeaders := make(map[string]interface{})
	if resp != nil {
		for key, values := range resp.Header {
			if len(values) == 1 {
				respHeaders[key] = values[0]
			} else {
				respHeaders[key] = values
			}
		}
	}
	l.logResponseInternal(r, resp.StatusCode, isMocked, respHeaders, urlMap, namespace, origin, originID, targetServiceName, requestBody, responseBody, requestSentAt, responseReceivedAt)
}

// LogError logs an error response (e.g., 502 Bad Gateway) when proxy fails
func (l *Logger) LogError(r *http.Request, statusCode int, urlMap UrlMap, namespace, origin, originID, targetServiceName string, requestBody, responseBody interface{}, requestSentAt, responseReceivedAt *time.Time) {
	l.logResponseInternal(r, statusCode, false, nil, urlMap, namespace, origin, originID, targetServiceName, requestBody, responseBody, requestSentAt, responseReceivedAt)
}

// logResponseInternal is the internal implementation for logging
func (l *Logger) logResponseInternal(r *http.Request, statusCode int, isMocked bool, responseHeaders map[string]interface{}, urlMap UrlMap, namespace, origin, originID, targetServiceName string, requestBody, responseBody interface{}, requestSentAt, responseReceivedAt *time.Time) {
	// Build user-facing URL using the target service name (not the interceptor host).
	// By this point, the proxy has already stripped the service prefix from r.URL.Path,
	// so the path is the actual endpoint path (e.g., "/health" not "/service-name/health").
	scheme := "http"
	host := targetServiceName
	if host == "" {
		// Fallback for external/unknown targets
		host = r.Host
		if host == "" {
			host = r.URL.Host
		}
	}
	fullURL := scheme + "://" + host + r.URL.Path
	if r.URL.RawQuery != "" {
		fullURL += "?" + r.URL.RawQuery
	}

	// Convert request headers to map[string]interface{} for JSON serialization
	reqHeaders := make(map[string]interface{})
	for key, values := range r.Header {
		if len(values) == 1 {
			reqHeaders[key] = values[0]
		} else {
			reqHeaders[key] = values
		}
	}

	// Extract target information from urlMap
	var targetName *string
	var targetID *string

	// Use provided targetServiceName if available (extracted before proxy modified path)
	// Otherwise, try to extract from request (fallback for cases where targetServiceName wasn't set)
	var serviceName string
	if targetServiceName != "" {
		serviceName = targetServiceName
	} else {
		serviceName = extractServiceNameFromRequest(r, urlMap)
	}

	// Check urlMap - if service is in map, it's an internal service
	if serviceName != "" {
		if serviceInfo, exists := urlMap[serviceName]; exists {
			// Internal service - use service name and ID
			targetName = &serviceInfo.Name
			if serviceInfo.InstanceItemID != "" {
				targetID = &serviceInfo.InstanceItemID
			}
		} else {
			// Service name found in path but not in urlMap - use the service name anyway
			// This shouldn't happen for internal services, but better than using "localhost"
			targetName = &serviceName
		}
	}

	// If still no target, it's an external service - use hostname (but never "localhost")
	if targetName == nil {
		host := r.Host
		if host == "" {
			host = r.URL.Host
		}
		// Strip port for cleaner logging
		if idx := strings.LastIndex(host, ":"); idx != -1 {
			host = host[:idx]
		}
		// Never use "localhost" - if host is localhost, it means we couldn't determine the target
		// This could happen for malformed requests or edge cases
		if host != "" && host != "localhost" {
			targetName = &host
		}
	}

	// Set origin information
	var originName *string
	var originIDPtr *string
	if origin != "" {
		originName = &origin
	}
	if originID != "" {
		originIDPtr = &originID
	}

	// Format timing fields if provided (use RFC3339Nano for millisecond precision)
	var requestSentAtStr *string
	var responseReceivedAtStr *string
	if requestSentAt != nil {
		formatted := requestSentAt.Format(time.RFC3339Nano)
		requestSentAtStr = &formatted
	}
	if responseReceivedAt != nil {
		formatted := responseReceivedAt.Format(time.RFC3339Nano)
		responseReceivedAtStr = &formatted
	}

	// Create HTTP log message for LPS
	logMessage := HttpLogMessage{
		InstanceID:         namespace,
		Method:             r.Method,
		URL:                fullURL,
		StatusCode:         &statusCode,
		RequestBody:        requestBody,
		ResponseBody:       responseBody,
		RequestHeaders:     reqHeaders,
		ResponseHeaders:    responseHeaders,
		IsMocked:           &isMocked,
		Timestamp:          time.Now().Format(time.RFC3339Nano),
		Origin:             originName,
		OriginID:           originIDPtr,
		Target:             targetName,
		TargetID:           targetID,
		RequestSentAt:      requestSentAtStr,
		ResponseReceivedAt: responseReceivedAtStr,
	}

	select {
	case l.logChan <- logMessage:
		// Successfully queued
	default:
		// Channel full, drop log (prevent blocking)
		log.Printf("[Logger] WARNING: Log channel full, dropping log for instance %s, method %s, url %s", namespace, logMessage.Method, logMessage.URL)
	}
}

// worker processes log queue in background
func (l *Logger) worker() {
	for {
		select {
		case action := <-l.logChan:
			l.sendLog(action)
		case <-l.stopChan:
			return
		}
	}
}

// sendLog sends an HTTP log message to Log Processor Service
func (l *Logger) sendLog(message HttpLogMessage) {
	body, err := json.Marshal(message)
	if err != nil {
		log.Printf("[Logger] Failed to marshal log message for instance %s: %v", message.InstanceID, err)
		return // Drop log on marshal error
	}

	// Dual-write: send to test-agent in a separate goroutine (independent, fire-and-forget)
	if l.testAgentURL != "" {
		go l.sendToTestAgent(body, message.InstanceID)
	}

	url := l.logEndpointURL + "/logs/http"
	req, err := http.NewRequest(http.MethodPost, url, bytes.NewBuffer(body))
	if err != nil {
		log.Printf("[Logger] Failed to create request to %s for instance %s: %v", url, message.InstanceID, err)
		return
	}

	req.Header.Set("Content-Type", "application/json")

	// Send with timeout, but don't block if it fails
	resp, err := l.httpClient.Do(req)
	if err != nil {
		log.Printf("[Logger] Failed to send log to %s for instance %s (method: %s, url: %s): %v", url, message.InstanceID, message.Method, message.URL, err)
		return // Drop log on network error
	}
	defer resp.Body.Close()

	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		log.Printf("[Logger] LPS returned non-success status for instance %s (method: %s, url: %s, status: %d)", message.InstanceID, message.Method, message.URL, resp.StatusCode)
	}
}

// sendToTestAgent sends a copy of the log to the test-agent for inline validation.
func (l *Logger) sendToTestAgent(body []byte, instanceID string) {
	url := l.testAgentURL + "/logs/http"
	req, err := http.NewRequest(http.MethodPost, url, bytes.NewBuffer(body))
	if err != nil {
		return
	}
	req.Header.Set("Content-Type", "application/json")

	resp, err := l.testAgentClient.Do(req)
	if err != nil {
		log.Printf("[Logger] Failed to send log to test-agent for instance %s: %v", instanceID, err)
		return
	}
	resp.Body.Close()
}

// Stop stops the logger worker and drains remaining logs
func (l *Logger) Stop() {
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
		case message := <-l.logChan:
			// Send remaining log
			l.sendLog(message)
			drained++
		case <-ctx.Done():
			// Timeout reached, stop draining
			return
		default:
			// Channel empty, we're done
			return
		}
	}
}
