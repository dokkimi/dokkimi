package main

import (
	"fmt"
	"net/http"
	"time"
)

// Retry configuration for transient errors
const (
	maxRetries        = 3
	initialBackoff    = 500 * time.Millisecond
	maxBackoff        = 5 * time.Second
	backoffMultiplier = 2.0
)

// retryableStatusCodes are HTTP status codes that indicate transient errors worth retrying
var retryableStatusCodes = map[int]bool{
	502: true, // Bad Gateway - upstream not ready
	503: true, // Service Unavailable
	504: true, // Gateway Timeout
}

// APIResponse holds the result of an HTTP request
type APIResponse struct {
	StatusCode int
	Body       []byte
	Headers    http.Header
}

// TestExecutor executes test requests
type TestExecutor struct {
	httpClient            *http.Client
	interceptorURL        string
	databaseQueryExecutor *DatabaseQueryExecutor
	testExecutionLogger   *TestExecutionLogger
	varCtx                *VariableContext
	uiStepExecutor        *UIStepExecutor // nil when no UI steps configured; executeStep fails loudly if a ui action arrives
	stepValidator         *StepValidator
	validationReporter    *ValidationReporter
	instanceID            string
	lastStepResponse      map[string]interface{} // last response from executeStep, for test-level until
}

// NewTestExecutor creates a new test executor
func NewTestExecutor(interceptorURL string, timeout time.Duration, databaseQueryExecutor *DatabaseQueryExecutor, testExecutionLogger *TestExecutionLogger) *TestExecutor {
	transport := &http.Transport{
		MaxIdleConns:        100,
		MaxIdleConnsPerHost: 10,
		IdleConnTimeout:     90 * time.Second,
		Proxy:               nil,
		DisableCompression:  true,
	}

	varCtx := NewVariableContext()
	if testExecutionLogger != nil {
		testExecutionLogger.SetVariableContext(varCtx)
	}

	return &TestExecutor{
		httpClient: &http.Client{
			Timeout:   timeout,
			Transport: transport,
			CheckRedirect: func(req *http.Request, via []*http.Request) error {
				return http.ErrUseLastResponse
			},
		},
		interceptorURL:        interceptorURL,
		databaseQueryExecutor: databaseQueryExecutor,
		testExecutionLogger:   testExecutionLogger,
		varCtx:                varCtx,
	}
}

// SetUIStepExecutor attaches a UI step executor so that `action.type == "ui"`
// steps can be dispatched. Leave unset for API/DB-only runs.
func (e *TestExecutor) SetUIStepExecutor(ui *UIStepExecutor) {
	e.uiStepExecutor = ui
}

// VisualFailures returns any visual match failure messages collected during
// UI step execution. Empty when no visual matching ran or all matched.
func (e *TestExecutor) VisualFailures() []string {
	if e.uiStepExecutor == nil {
		return nil
	}
	return e.uiStepExecutor.VisualFailures()
}

// SetInlineValidation configures inline assertion validation for each step.
func (e *TestExecutor) SetInlineValidation(sv *StepValidator, vr *ValidationReporter, instanceID string) {
	e.stepValidator = sv
	e.validationReporter = vr
	e.instanceID = instanceID
}

// CloseUI tears down the browser session after an execution completes.
// Safe to call when no UI executor is configured.
func (e *TestExecutor) CloseUI() {
	if e.uiStepExecutor != nil {
		e.uiStepExecutor.Close()
	}
}

// VarContext exposes the shared variable context so callers that construct a
// UIStepExecutor after NewTestExecutor can hand the same context in.
func (e *TestExecutor) VarContext() *VariableContext {
	return e.varCtx
}

// flatStep is a single step with its resolved global index.
type flatStep struct {
	globalIndex   int
	testIndex     int // 0-based index of the parent test (suite)
	stepIndex     int // 0-based index of the step within the parent test
	step          TestStep
	testVariables map[string]interface{} // test-level variables to seed when this test starts
	loopLabel     string                 // optional loop context for display (e.g., "[user=Alice]")
	nextIsWait    bool                   // true when the following step is a wait action; skip flush so the wait inherits this step's logs
}

// label returns a 1-based "Step X.Y" string matching the CLI display.
func (s flatStep) label() string {
	base := fmt.Sprintf("Step %d.%d", s.testIndex+1, s.stepIndex+1)
	if s.loopLabel != "" {
		return base + " " + s.loopLabel
	}
	return base
}

// flattenSteps flattens all steps across all test definitions into a sequential list.
// When resetVars is true (full runs), the variable context is reset first.
// When false (debug re-runs), existing extracted variables are preserved.
func (e *TestExecutor) flattenSteps(testConfig *TestConfig, resetVars bool) []flatStep {
	if resetVars {
		e.varCtx.Reset()
	}
	if testConfig.Variables != nil {
		for name, value := range testConfig.Variables {
			e.varCtx.Set(name, value)
		}
	}
	var steps []flatStep
	globalIndex := 0
	for ti, testDef := range testConfig.Tests {
		for si, step := range testDef.Steps {
			steps = append(steps, flatStep{
				globalIndex:   globalIndex,
				testIndex:     ti,
				stepIndex:     si,
				step:          step,
				testVariables: testDef.Variables,
			})
			globalIndex++
		}
	}
	return steps
}
