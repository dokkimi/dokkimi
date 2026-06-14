package main

import (
	"encoding/json"
	"fmt"
)

// HealthStatusUpdate represents the health status update from interceptors/sidecars
type HealthStatusUpdate struct {
	InstanceID       string              `json:"instanceId"`
	InstanceItemName string              `json:"instanceItemName"`
	InstanceItemID   string              `json:"instanceItemId"` // ID for matching (preferred over name)
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

// TestConfig represents the top-level test configuration from ConfigMap
type TestConfig struct {
	TestRunID      string            `json:"testRunId"`
	TimeoutSeconds int               `json:"timeoutSeconds"`
	ExecutionMode  string            `json:"executionMode"` // "auto" | "manual" (default: "auto")
	Tests          []TestDefinition  `json:"tests"`
	Variables      map[string]string `json:"variables,omitempty"`
}

// ExecuteRequest is the body for POST /execute
type ExecuteRequest struct {
	TestRunID   string `json:"testRunId"`             // Required: scopes this execution run
	Mode        string `json:"mode"`                  // "all" | "run-step"
	StartAtStep *int   `json:"startAtStep,omitempty"` // "all" mode: start from this step index (skip earlier)
	StopBefore  *int   `json:"stopBefore,omitempty"`  // "all" mode: stop before this step index (exclusive)
	StepIndex   *int   `json:"stepIndex,omitempty"`   // "run-step" mode
}

// TestDefinition represents a named test with sequential steps
type TestDefinition struct {
	Name           string            `json:"name"`
	Description    string            `json:"description,omitempty"`
	TimeoutSeconds int               `json:"timeoutSeconds,omitempty"`
	StopOnFailure  *bool             `json:"stopOnFailure,omitempty"` // pointer to distinguish unset from false
	Variables      map[string]string `json:"variables,omitempty"`
	Steps          []TestStep        `json:"steps"`
}

// TestStep represents a single step: action + extract + assertions
type TestStep struct {
	Name          string                 `json:"name,omitempty"`
	Description   string                 `json:"description,omitempty"`
	StopOnFailure *bool                  `json:"stopOnFailure,omitempty"`
	Action        StepAction             `json:"action"`
	Extract       map[string]ExtractRule `json:"extract,omitempty"`
	Assertions    []AssertionBlock       `json:"assertions,omitempty"`
}

// AssertionBlock represents a block of assertions for a test step.
type AssertionBlock struct {
	Extract           map[string]ExtractRule `json:"extract,omitempty"`
	Match             *MatchCriteria         `json:"match,omitempty"`
	Count             *CountAssertion        `json:"count,omitempty"`
	AssertionScope    string                 `json:"assertionScope,omitempty"` // "all", "first", "last", "any"
	Assertions        []Assertion            `json:"assertions,omitempty"`
	Service           string                 `json:"service,omitempty"`
	ConsoleAssertions []ConsoleLogAssertion  `json:"consoleAssertions,omitempty"`
}

// MatchCriteria specifies which HTTP logs to validate against.
type MatchCriteria struct {
	Origin string `json:"origin,omitempty"`
	Method string `json:"method,omitempty"`
	URL    string `json:"url,omitempty"`
}

// ConsoleLogAssertion validates console log output from a service.
type ConsoleLogAssertion struct {
	Level    string         `json:"level,omitempty"`
	Message  *MessageFilter `json:"message,omitempty"`
	Count    CountAssertion `json:"count"`
	Disabled bool           `json:"disabled,omitempty"`
}

// MessageFilter specifies how to match console log messages.
type MessageFilter struct {
	Operator string `json:"operator"` // "eq", "contains", "containsIgnoreCase", "matches"
	Value    string `json:"value"`
}

// ExtractRule defines how to extract a variable from a response.
// Simple form: just a JSONPath string (e.g., "$.body.id").
// Regex form: a JSONPath + regex pattern + capture group index.
type ExtractRule struct {
	Path    string `json:"path"`
	Pattern string `json:"pattern,omitempty"`
	Group   *int   `json:"group,omitempty"` // defaults to 1 when pattern is set
}

// UnmarshalJSON allows ExtractRule to be unmarshalled from a plain string or an object.
func (r *ExtractRule) UnmarshalJSON(data []byte) error {
	// Try string first (simple JSONPath)
	var s string
	if err := json.Unmarshal(data, &s); err == nil {
		r.Path = s
		return nil
	}

	// Otherwise parse as object
	type extractRuleAlias ExtractRule
	var obj extractRuleAlias
	if err := json.Unmarshal(data, &obj); err != nil {
		return fmt.Errorf("extract rule must be a string or object: %w", err)
	}
	*r = ExtractRule(obj)
	return nil
}

// StepAction represents an HTTP request, database query, wait, UI action, or parallel batch.
type StepAction struct {
	Type       string                 `json:"type"`                 // "httpRequest", "dbQuery", "wait", "ui", or "parallel"
	Method     string                 `json:"method,omitempty"`     // httpRequest only
	URL        string                 `json:"url,omitempty"`        // httpRequest only
	Headers    map[string]string      `json:"headers,omitempty"`    // httpRequest only
	Body       interface{}            `json:"body,omitempty"`       // httpRequest only
	Timeout    int                    `json:"timeout,omitempty"`    // httpRequest or dbQuery (ms)
	DurationMs int                    `json:"durationMs,omitempty"` // wait only
	Database   string                 `json:"database,omitempty"`   // dbQuery only
	Query      string                 `json:"query,omitempty"`      // dbQuery only
	Params     map[string]interface{} `json:"params,omitempty"`     // dbQuery only
	Target     string                 `json:"target,omitempty"`     // ui only (service name)
	Steps      []UISubStep            `json:"steps,omitempty"`      // ui only
	Actions    []StepAction           `json:"actions,omitempty"`    // parallel only — sub-actions to run concurrently
}

// StepExecution represents the execution of a single step with timing information
type StepExecution struct {
	StepIndex int    `json:"stepIndex"`
	StartTime string `json:"startTime"` // ISO timestamp
	EndTime   string `json:"endTime"`   // ISO timestamp
}

// TestCompletionNotification represents the notification sent to Control Tower's /test-complete endpoint
type TestCompletionNotification struct {
	TestRunID      string          `json:"testRunId"`
	Status         string          `json:"status"` // "success" or "failure"
	Message        string          `json:"message,omitempty"`
	StepExecutions []StepExecution `json:"stepExecutions,omitempty"`
	Partial        bool            `json:"partial,omitempty"` // true for debug partial runs
}

// ConfigMapData represents the data structure in the ConfigMap
type ConfigMapData struct {
	ExpectedNamespaceItemIds []string                `json:"expectedNamespaceItemIds"`
	TestConfig               *TestConfig             `json:"testConfig"`
	URLMap                   map[string]URLMapEntry  `json:"urlMap"`
	DatabaseMap              map[string]DatabaseInfo `json:"databaseMap,omitempty"`
}

// URLMapEntry represents an entry in the URL map
type URLMapEntry struct {
	Scheme         string `json:"scheme"`
	URL            string `json:"url"`
	Name           string `json:"name"`
	Port           int    `json:"port,omitempty"`
	InstanceItemID string `json:"instanceItemId"`
}
