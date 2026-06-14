package main

import (
	"sync"
	"time"
)

// HttpLogMessage represents an HTTP traffic log from interceptors.
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
	Origin             *string                `json:"origin,omitempty"`
	OriginID           *string                `json:"instanceItemId,omitempty"`
	Target             *string                `json:"target,omitempty"`
	TargetID           *string                `json:"targetId,omitempty"`
	RequestSentAt      *string                `json:"requestSentAt,omitempty"`
	ResponseReceivedAt *string                `json:"responseReceivedAt,omitempty"`
}

// DatabaseLogMessage represents a database query log from db-proxies.
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

// ConsoleLogMessage represents a console log line from a service container (via GELF).
type ConsoleLogMessage struct {
	Service   string  `json:"service"`
	Source    string  `json:"source"` // "stdout" or "stderr"
	Message   string  `json:"message"`
	Timestamp float64 `json:"timestamp"`
	Level     string  `json:"level,omitempty"`
}

// StepLogBuffer holds logs in memory, scoped to the current step.
type StepLogBuffer struct {
	httpLogs    []HttpLogMessage
	dbLogs      []DatabaseLogMessage
	consoleLogs []ConsoleLogMessage
	mu          sync.Mutex
	lastLogTime time.Time
}

// NewStepLogBuffer creates a new empty step log buffer.
func NewStepLogBuffer() *StepLogBuffer {
	return &StepLogBuffer{}
}

// AddHttpLog appends an HTTP log to the buffer.
func (b *StepLogBuffer) AddHttpLog(log HttpLogMessage) {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.httpLogs = append(b.httpLogs, log)
	b.lastLogTime = time.Now()
}

// AddDbLog appends a database log to the buffer.
func (b *StepLogBuffer) AddDbLog(log DatabaseLogMessage) {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.dbLogs = append(b.dbLogs, log)
	b.lastLogTime = time.Now()
}

// AddConsoleLog appends a console log to the buffer.
func (b *StepLogBuffer) AddConsoleLog(log ConsoleLogMessage) {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.consoleLogs = append(b.consoleLogs, log)
	b.lastLogTime = time.Now()
}

// Flush clears all logs from the buffer.
func (b *StepLogBuffer) Flush() {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.httpLogs = nil
	b.dbLogs = nil
	b.consoleLogs = nil
	b.lastLogTime = time.Time{}
}

// Snapshot returns copies of the current log buffers.
func (b *StepLogBuffer) Snapshot() ([]HttpLogMessage, []DatabaseLogMessage, []ConsoleLogMessage) {
	b.mu.Lock()
	defer b.mu.Unlock()
	httpCopy := make([]HttpLogMessage, len(b.httpLogs))
	copy(httpCopy, b.httpLogs)
	dbCopy := make([]DatabaseLogMessage, len(b.dbLogs))
	copy(dbCopy, b.dbLogs)
	consoleCopy := make([]ConsoleLogMessage, len(b.consoleLogs))
	copy(consoleCopy, b.consoleLogs)
	return httpCopy, dbCopy, consoleCopy
}

// LogCount returns the total number of logs in the buffer.
func (b *StepLogBuffer) LogCount() int {
	b.mu.Lock()
	defer b.mu.Unlock()
	return len(b.httpLogs) + len(b.dbLogs) + len(b.consoleLogs)
}

// LastLogTime returns the time the most recent log was added.
func (b *StepLogBuffer) LastLogTime() time.Time {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.lastLogTime
}
