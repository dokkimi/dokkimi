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
	TestRunID      string                 `json:"testRunId"`
	TimeoutSeconds int                    `json:"timeoutSeconds"`
	ExecutionMode  string                 `json:"executionMode"` // "auto" | "manual" (default: "auto")
	Tests          []TestDefinition       `json:"tests"`
	Variables      map[string]interface{} `json:"variables,omitempty"`
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
	Name           string                 `json:"name"`
	Description    string                 `json:"description,omitempty"`
	TimeoutSeconds int                    `json:"timeoutSeconds,omitempty"`
	StopOnFailure  *bool                  `json:"stopOnFailure,omitempty"` // pointer to distinguish unset from false
	Variables      map[string]interface{} `json:"variables,omitempty"`
	Steps          []TestStep             `json:"steps"`
	ForEach        *ForEachLoop           `json:"forEach,omitempty"`
	For            *ForLoop               `json:"for,omitempty"`
	Repeat         *RepeatLoop            `json:"repeat,omitempty"`
}

// TestStep represents a single step: action + extract + assertions
type TestStep struct {
	Name          string                 `json:"name,omitempty"`
	Description   string                 `json:"description,omitempty"`
	StopOnFailure *bool                  `json:"stopOnFailure,omitempty"`
	Action        StepAction             `json:"action,omitempty"`
	Extract       map[string]ExtractRule `json:"extract,omitempty"`
	Assertions    []AssertionBlock       `json:"assertions,omitempty"`
	ForEach       *ForEachLoop           `json:"forEach,omitempty"`
	For           *ForLoop               `json:"for,omitempty"`
	Repeat        *RepeatLoop            `json:"repeat,omitempty"`
}

// LoopAssertions holds the "assertions" array inside a loop body.
// At assertion-block level this is []Assertion (flat); at step level it's []AssertionBlock.
// The format is auto-detected during JSON unmarshal.
type LoopAssertions struct {
	Flat   []Assertion
	Blocks []AssertionBlock
}

func (la LoopAssertions) IsEmpty() bool {
	return len(la.Flat) == 0 && len(la.Blocks) == 0
}

func (la LoopAssertions) MarshalJSON() ([]byte, error) {
	if len(la.Blocks) > 0 {
		return json.Marshal(la.Blocks)
	}
	if len(la.Flat) > 0 {
		return json.Marshal(la.Flat)
	}
	return []byte("null"), nil
}

func (la *LoopAssertions) UnmarshalJSON(data []byte) error {
	if len(data) == 0 || string(data) == "null" {
		return nil
	}
	var raw []json.RawMessage
	if err := json.Unmarshal(data, &raw); err != nil {
		return err
	}
	if len(raw) == 0 {
		return nil
	}
	// Detect format by checking first element's keys
	var probe map[string]json.RawMessage
	if err := json.Unmarshal(raw[0], &probe); err != nil {
		return json.Unmarshal(data, &la.Flat)
	}
	// AssertionBlock keys: "assertions", "match", "extract", "forEach", "for", "repeat"
	if _, ok := probe["assertions"]; ok {
		return json.Unmarshal(data, &la.Blocks)
	}
	if _, ok := probe["match"]; ok {
		return json.Unmarshal(data, &la.Blocks)
	}
	if _, ok := probe["extract"]; ok {
		return json.Unmarshal(data, &la.Blocks)
	}
	if _, ok := probe["forEach"]; ok {
		return json.Unmarshal(data, &la.Blocks)
	}
	if _, ok := probe["for"]; ok {
		return json.Unmarshal(data, &la.Blocks)
	}
	if _, ok := probe["repeat"]; ok {
		return json.Unmarshal(data, &la.Blocks)
	}
	// Otherwise it's flat assertions (has "path", "operator", "count", "type", etc.)
	return json.Unmarshal(data, &la.Flat)
}

// ForEachLoop iterates over an array, running the attached object once per item.
type ForEachLoop struct {
	Items   interface{} `json:"items"`          // inline array or "{{varName}}" string
	As      string      `json:"as"`             // variable name for the current item
	Name    string      `json:"name,omitempty"` // optional loop name for metadata (index, items, completed, iterations)
	DelayMs int         `json:"delayMs,omitempty"`

	// Nested body
	Match      *MatchCriteria         `json:"match,omitempty"`
	Assertions LoopAssertions         `json:"assertions,omitempty"`
	Extract    map[string]ExtractRule `json:"extract,omitempty"`
	ForEach    *ForEachLoop           `json:"forEach,omitempty"`
	For        *ForLoop               `json:"for,omitempty"`
	Repeat     *RepeatLoop            `json:"repeat,omitempty"`

	// Step-level body
	Action *StepAction `json:"action,omitempty"`

	// Test-level body
	Steps []TestStep `json:"steps,omitempty"`
}

// ForLoop iterates over a numeric range.
type ForLoop struct {
	From    int    `json:"from"`
	To      int    `json:"to"`
	Step    int    `json:"step,omitempty"` // default 1; can be negative
	As      string `json:"as"`
	Name    string `json:"name,omitempty"`
	DelayMs int    `json:"delayMs,omitempty"`

	// Nested body
	Match      *MatchCriteria         `json:"match,omitempty"`
	Assertions LoopAssertions         `json:"assertions,omitempty"`
	Extract    map[string]ExtractRule `json:"extract,omitempty"`
	ForEach    *ForEachLoop           `json:"forEach,omitempty"`
	For        *ForLoop               `json:"for,omitempty"`
	Repeat     *RepeatLoop            `json:"repeat,omitempty"`

	// Step-level body
	Action *StepAction `json:"action,omitempty"`

	// Test-level body
	Steps []TestStep `json:"steps,omitempty"`
}

// RepeatLoop repeats up to Count times, optionally stopping early when Until passes.
type RepeatLoop struct {
	Count   int         `json:"count"`
	As      string      `json:"as"`
	Name    string      `json:"name,omitempty"`
	DelayMs int         `json:"delayMs,omitempty"`
	Until   []Assertion `json:"until,omitempty"`

	// Nested body
	Match      *MatchCriteria         `json:"match,omitempty"`
	Assertions LoopAssertions         `json:"assertions,omitempty"`
	Extract    map[string]ExtractRule `json:"extract,omitempty"`
	ForEach    *ForEachLoop           `json:"forEach,omitempty"`
	For        *ForLoop               `json:"for,omitempty"`
	Repeat     *RepeatLoop            `json:"repeat,omitempty"`

	// Step-level body
	Action *StepAction `json:"action,omitempty"`

	// Test-level body
	Steps []TestStep `json:"steps,omitempty"`
}

// AssertionBlock represents a block of assertions for a test step.
type AssertionBlock struct {
	Extract    map[string]ExtractRule `json:"extract,omitempty"`
	Match      *MatchCriteria         `json:"match,omitempty"`
	Assertions []Assertion            `json:"assertions,omitempty"`
	ForEach    *ForEachLoop           `json:"forEach,omitempty"`
	For        *ForLoop               `json:"for,omitempty"`
	Repeat     *RepeatLoop            `json:"repeat,omitempty"`
}

// MatchCriteria specifies which array elements to select for assertion.
type MatchCriteria struct {
	Path  string       `json:"path"`
	Where []WhereEntry `json:"where,omitempty"`
	Count interface{}  `json:"count,omitempty"` // int or CountAssertion
	As    string       `json:"as,omitempty"`
}

// WhereEntry is a discriminated union: either an assertion (Path+Operator),
// a boolean combinator (Or or And), or a negation (Not).
type WhereEntry struct {
	Path     string      `json:"path,omitempty"`
	Operator string      `json:"operator,omitempty"`
	Value    interface{} `json:"value,omitempty"`

	Or  []WhereEntry `json:"or,omitempty"`
	And []WhereEntry `json:"and,omitempty"`
	Not *WhereEntry  `json:"not,omitempty"`
}

// ExtractRule defines how to extract a variable from a response.
// Simple form: just a JSONPath string (e.g., "$.response.body.id").
// Regex form: a JSONPath + regex pattern + capture group index.
// Transform form: path + transform (or from + transform) to convert objects to arrays.
type ExtractRule struct {
	Path      string `json:"path"`
	Pattern   string `json:"pattern,omitempty"`
	Group     *int   `json:"group,omitempty"`     // defaults to 1 when pattern is set
	Transform string `json:"transform,omitempty"` // "keys", "values", or "entries"
	From      string `json:"from,omitempty"`      // variable reference for transform (e.g. "{{varName}}")
}

// UnmarshalJSON allows ExtractRule to be unmarshalled from a plain string or an object.
func (r *ExtractRule) UnmarshalJSON(data []byte) error {
	// Try string first (simple JSONPath)
	var s string
	if err := json.Unmarshal(data, &s); err == nil {
		r.Path = s
		return nil
	}

	// Otherwise parse as object (supports path+pattern, path+transform, or from+transform)
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
	FormData   map[string]interface{} `json:"formData,omitempty"`   // httpRequest only — multipart/form-data fields
	Timeout    int                    `json:"timeout,omitempty"`    // httpRequest or dbQuery (ms)
	DurationMs int                    `json:"durationMs,omitempty"` // wait only
	Database   string                 `json:"database,omitempty"`   // dbQuery only
	Query      string                 `json:"query,omitempty"`      // dbQuery only
	Params     map[string]interface{} `json:"params,omitempty"`     // dbQuery only
	Target     string                 `json:"target,omitempty"`     // ui only (service name)
	Steps      []UISubStep            `json:"steps,omitempty"`      // ui only
	Actions    []StepAction           `json:"actions,omitempty"`    // parallel only — sub-actions to run concurrently
	ForEach    *ForEachLoop           `json:"forEach,omitempty"`
	For        *ForLoop               `json:"for,omitempty"`
	Repeat     *RepeatLoop            `json:"repeat,omitempty"`
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
}

// ConfigMapData represents the data structure in the ConfigMap
type ConfigMapData struct {
	ExpectedItemStages [][]string              `json:"expectedItemStages"`
	TestConfig         *TestConfig             `json:"testConfig"`
	URLMap             map[string]URLMapEntry  `json:"urlMap"`
	DatabaseMap        map[string]DatabaseInfo `json:"databaseMap,omitempty"`
	BrokerMap          map[string]BrokerInfo   `json:"brokerMap,omitempty"`
}

// BrokerInfo represents a broker entry in the config map
type BrokerInfo struct {
	Type           string `json:"type"`
	Port           int    `json:"port"`
	InstanceItemID string `json:"instanceItemId"`
}

// URLMapEntry represents an entry in the URL map
type URLMapEntry struct {
	Scheme         string `json:"scheme"`
	URL            string `json:"url"`
	Name           string `json:"name"`
	Port           int    `json:"port,omitempty"`
	InstanceItemID string `json:"instanceItemId"`
}
