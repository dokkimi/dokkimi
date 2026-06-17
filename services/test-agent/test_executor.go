package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"strings"
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
}

// NewTestExecutor creates a new test executor
func NewTestExecutor(interceptorURL string, timeout time.Duration, databaseQueryExecutor *DatabaseQueryExecutor, testExecutionLogger *TestExecutionLogger) *TestExecutor {
	// Create HTTP client without proxy (we'll call interceptor directly)
	transport := &http.Transport{
		MaxIdleConns:        100,
		MaxIdleConnsPerHost: 10,
		IdleConnTimeout:     90 * time.Second,
		// Disable HTTP_PROXY to prevent any proxy usage
		Proxy: nil,
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
	testVariables map[string]string // test-level variables to seed when this test starts
}

// label returns a 1-based "Step X.Y" string matching the CLI display.
func (s flatStep) label() string {
	return fmt.Sprintf("Step %d.%d", s.testIndex+1, s.stepIndex+1)
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

// executeStepAt executes a single flat step, emitting STEP_STARTED/COMPLETED/FAILED logs.
// When inline validation is configured, it also waits for quiescence, validates assertions,
// and reports results after each step.
func (e *TestExecutor) executeStepAt(ctx context.Context, fs flatStep) (StepExecution, error) {
	si := fs.globalIndex
	label := fs.label()
	log.Printf("Executing %s", label)
	e.testExecutionLogger.LogEvent("STEP_STARTED",
		fmt.Sprintf("%s started", label), &si, nil)

	stepExec := StepExecution{
		StepIndex: si,
		StartTime: time.Now().Format(time.RFC3339Nano),
	}

	resp, err := e.executeStep(ctx, fs.step, si)
	stepExec.EndTime = time.Now().Format(time.RFC3339Nano)

	if err != nil {
		e.testExecutionLogger.LogEvent("STEP_FAILED",
			fmt.Sprintf("%s failed: %v", label, err), &si, nil)
		return stepExec, err
	}

	// Process extraction after successful execution (legacy path — used when
	// inline validation is not configured, e.g. for extract-only steps without assertions)
	if e.stepValidator == nil && resp != nil && len(fs.step.Extract) > 0 {
		if extractErr := e.varCtx.Extract(fs.step.Extract, resp); extractErr != nil {
			e.testExecutionLogger.LogEvent("STEP_FAILED",
				fmt.Sprintf("%s extraction failed: %v", label, extractErr), &si, nil)
			return stepExec, fmt.Errorf("variable extraction failed: %w", extractErr)
		}
	}

	// Inline validation: try immediately, retry if logs haven't arrived yet
	if e.stepValidator != nil && (len(fs.step.Assertions) > 0 || len(fs.step.Extract) > 0) {
		results, passed := e.stepValidator.ValidateStepWithRetry(fs.step, stepExec, resp)

		if e.validationReporter != nil {
			e.validationReporter.ReportStepResultsAsync(e.instanceID, si, results, passed)
		}

		summary := FormatStepResult(si, fs.label(), results, passed)
		if !passed {
			e.testExecutionLogger.LogEvent("STEP_FAILED", summary, &si, nil)
			return stepExec, fmt.Errorf("assertion validation failed: %s", summary)
		}
		log.Printf("%s", summary)
	}

	log.Printf("%s completed successfully", label)
	e.testExecutionLogger.LogEvent("STEP_COMPLETED",
		fmt.Sprintf("%s completed", label), &si, nil)
	return stepExec, nil
}

// ExecuteTests executes all test steps (or a range) according to the test config.
// startAtStep: first step index to execute (0 = all); stopBefore: stop before this index
// (-1 or >= len means run to end). Returns step executions with timing information.
func (e *TestExecutor) ExecuteTests(ctx context.Context, testConfig *TestConfig, startAtStep, stopBefore int) ([]StepExecution, error) {
	log.Printf("Starting test execution for testRunId: %s (startAt=%d, stopBefore=%d)", testConfig.TestRunID, startAtStep, stopBefore)
	e.testExecutionLogger.LogEvent("TEST_EXECUTION_STARTED", "Starting test execution", nil, nil)

	steps := e.flattenSteps(testConfig, true)
	log.Printf("Executing %d total step(s), running steps [%d, %d)", len(steps), startAtStep, stopBefore)

	if len(steps) == 0 {
		log.Printf("No test steps configured — nothing to run")
		e.testExecutionLogger.LogEvent("TEST_EXECUTION_COMPLETED", "No tests configured for this namespace", nil, nil)
		return nil, nil
	}

	var stepExecutions []StepExecution
	lastTestIndex := -1

	for _, fs := range steps {
		if fs.globalIndex < startAtStep {
			continue
		}
		if stopBefore >= 0 && fs.globalIndex >= stopBefore {
			break
		}

		// Reset and re-seed variables when entering a new test's steps.
		// Without the reset, extracted variables from prior tests leak
		// into subsequent tests — creating hidden cross-test dependencies.
		if fs.testIndex != lastTestIndex {
			lastTestIndex = fs.testIndex
			e.varCtx.Reset()
			if testConfig.Variables != nil {
				for name, value := range testConfig.Variables {
					e.varCtx.Set(name, value)
				}
			}
			if fs.testVariables != nil {
				for name, value := range fs.testVariables {
					e.varCtx.Set(name, value)
				}
			}
		}

		// Safety delay between steps
		if len(stepExecutions) > 0 {
			if fs.step.Action.Type != "wait" {
				const DEFAULT_WAIT_MS = 100
				time.Sleep(DEFAULT_WAIT_MS * time.Millisecond)
			}
		}

		stepExec, err := e.executeStepAt(ctx, fs)
		stepExecutions = append(stepExecutions, stepExec)
		if err != nil {
			return stepExecutions, fmt.Errorf("%s failed: %w", fs.label(), err)
		}
	}

	log.Printf("Test execution complete")
	e.testExecutionLogger.LogEvent("TEST_EXECUTION_COMPLETED", "All tests completed", nil, nil)
	return stepExecutions, nil
}

// ExecuteStep executes exactly one step and returns.
// Used for debug "run-step" mode.
func (e *TestExecutor) ExecuteStep(ctx context.Context, testConfig *TestConfig, stepIndex int) ([]StepExecution, error) {
	log.Printf("Debug: executing single step %d for testRunId: %s", stepIndex, testConfig.TestRunID)
	e.testExecutionLogger.LogEvent("TEST_EXECUTION_STARTED", fmt.Sprintf("Debug: executing step %d", stepIndex), nil, nil)

	steps := e.flattenSteps(testConfig, false)
	if stepIndex < 0 || stepIndex >= len(steps) {
		return nil, fmt.Errorf("stepIndex %d out of range (total steps: %d)", stepIndex, len(steps))
	}

	stepExec, err := e.executeStepAt(ctx, steps[stepIndex])
	executions := []StepExecution{stepExec}
	e.testExecutionLogger.LogEvent("TEST_EXECUTION_COMPLETED", fmt.Sprintf("Debug: step %d complete", stepIndex), nil, nil)
	return executions, err
}

// executeStep executes a single test step based on its action type.
// Returns an extraction document for variable extraction.
func (e *TestExecutor) executeStep(ctx context.Context, step TestStep, stepIndex int) (map[string]interface{}, error) {
	// Resolve variables in step name and description
	if step.Name != "" {
		resolved, err := e.varCtx.Resolve(step.Name)
		if err != nil {
			return nil, fmt.Errorf("variable resolution failed for step name: %w", err)
		}
		step.Name = resolved
	}
	if step.Description != "" {
		resolved, err := e.varCtx.Resolve(step.Description)
		if err != nil {
			return nil, fmt.Errorf("variable resolution failed for step description: %w", err)
		}
		step.Description = resolved
	}

	// Resolve variables in action before execution
	resolvedAction, err := e.varCtx.ResolveAction(step.Action)
	if err != nil {
		return nil, fmt.Errorf("variable resolution failed: %w", err)
	}

	switch resolvedAction.Type {
	case "httpRequest":
		return e.executeAPIStep(ctx, resolvedAction, stepIndex)
	case "dbQuery":
		return e.executeDbQueryStep(ctx, resolvedAction, stepIndex)
	case "wait":
		log.Printf("Executing wait action: %d ms", resolvedAction.DurationMs)
		e.testExecutionLogger.LogEvent("WAIT_STARTED", fmt.Sprintf("Waiting %d ms", resolvedAction.DurationMs), &stepIndex, nil)
		time.Sleep(time.Duration(resolvedAction.DurationMs) * time.Millisecond)
		e.testExecutionLogger.LogEvent("WAIT_COMPLETED", fmt.Sprintf("Wait completed (%d ms)", resolvedAction.DurationMs), &stepIndex, nil)
		return nil, nil
	case "ui":
		if e.uiStepExecutor == nil {
			return nil, fmt.Errorf(
				"ui action encountered but UI executor is not configured (BROWSER_URL may be unset)",
			)
		}
		return e.uiStepExecutor.Execute(ctx, step.Action, step.Name, stepIndex)
	case "parallel":
		return e.executeParallelAction(ctx, resolvedAction, step, stepIndex)
	default:
		return nil, fmt.Errorf("unsupported action type: %s", resolvedAction.Type)
	}
}

// executeParallelAction runs all sub-actions concurrently and collects results.
func (e *TestExecutor) executeParallelAction(ctx context.Context, action StepAction, step TestStep, stepIndex int) (map[string]interface{}, error) {
	if len(action.Actions) == 0 {
		return nil, nil
	}

	log.Printf("Executing parallel action with %d sub-actions", len(action.Actions))

	type result struct {
		subIndex   int
		err        error
		duration   int
		extractDoc map[string]interface{}
	}

	results := make(chan result, len(action.Actions))

	for idx, subAction := range action.Actions {
		go func(subIdx int, sa StepAction) {
			startTime := time.Now()
			var resp map[string]interface{}
			var err error

			switch sa.Type {
			case "httpRequest":
				resp, err = e.executeAPIStep(ctx, sa, stepIndex)
			case "dbQuery":
				resp, err = e.executeDbQueryStep(ctx, sa, stepIndex)
			default:
				err = fmt.Errorf("unsupported action type in parallel block: %s", sa.Type)
			}

			duration := int(time.Since(startTime).Milliseconds())
			results <- result{
				subIndex:   subIdx,
				err:        err,
				duration:   duration,
				extractDoc: resp,
			}
		}(idx, subAction)
	}

	var firstError error
	allResults := make([]result, 0, len(action.Actions))
	for i := 0; i < len(action.Actions); i++ {
		res := <-results
		allResults = append(allResults, res)

		sa := action.Actions[res.subIndex]
		stepLabel := fmt.Sprintf("%s %s", sa.Method, sa.URL)
		if sa.Type == "dbQuery" {
			stepLabel = fmt.Sprintf("dbQuery %s", sa.Database)
		}
		if res.err != nil {
			if firstError == nil {
				firstError = res.err
			}
			log.Printf("Parallel sub-action %d (%s) failed: %v", res.subIndex, stepLabel, res.err)
			e.testExecutionLogger.LogRequestCompleted(stepIndex, res.subIndex, res.duration, res.err)
		} else {
			log.Printf("Parallel sub-action %d (%s) completed successfully", res.subIndex, stepLabel)
			e.testExecutionLogger.LogRequestCompleted(stepIndex, res.subIndex, res.duration, nil)
		}
	}

	return nil, firstError
}

// executeAPIStep executes an HTTP request action with retry logic for transient errors.
// Returns an extraction document: { statusCode, headers, body }.
func (e *TestExecutor) executeAPIStep(ctx context.Context, action StepAction, stepIndex int) (map[string]interface{}, error) {
	strippedURL := stripScheme(action.URL)
	fullURL := e.interceptorURL + "/" + strippedURL

	// Log user-friendly message with the URL
	e.testExecutionLogger.LogRequestStarted(stepIndex, action.Method, action.URL)

	var lastErr error
	var lastStatusCode int
	backoff := initialBackoff

	for attempt := 0; attempt <= maxRetries; attempt++ {
		if attempt > 0 {
			log.Printf("Retrying request (attempt %d/%d) after %v: %s %s", attempt+1, maxRetries+1, backoff, action.Method, fullURL)
			select {
			case <-ctx.Done():
				return nil, fmt.Errorf("context cancelled during retry: %w", ctx.Err())
			case <-time.After(backoff):
			}
			backoff = time.Duration(float64(backoff) * backoffMultiplier)
			if backoff > maxBackoff {
				backoff = maxBackoff
			}
		}

		resp, err := e.doAPIRequest(ctx, action, fullURL)
		if err != nil {
			lastErr = err
			lastStatusCode = 0
			log.Printf("Request failed with error: %v (URL: %s)", err, fullURL)
			continue
		}

		lastStatusCode = resp.StatusCode

		if retryableStatusCodes[resp.StatusCode] {
			lastErr = fmt.Errorf("received retryable status code %d", resp.StatusCode)
			log.Printf("Received retryable status code %d for %s %s", resp.StatusCode, action.Method, fullURL)
			continue
		}

		return apiResponseToExtractDoc(resp), nil
	}

	if lastStatusCode > 0 {
		log.Printf("Request failed after %d retries with status code %d: %s %s", maxRetries+1, lastStatusCode, action.Method, fullURL)
		return nil, fmt.Errorf("%s %s failed with status %d", action.Method, action.URL, lastStatusCode)
	}
	log.Printf("Request failed after %d retries: %v", maxRetries+1, lastErr)
	return nil, fmt.Errorf("%s %s failed: %s", action.Method, action.URL, rootCause(lastErr))
}

// apiResponseToExtractDoc converts an APIResponse to an extraction document: { statusCode, headers, body }.
func apiResponseToExtractDoc(resp *APIResponse) map[string]interface{} {
	doc := map[string]interface{}{
		"statusCode": resp.StatusCode,
	}

	if len(resp.Body) > 0 {
		var parsed interface{}
		if err := json.Unmarshal(resp.Body, &parsed); err != nil {
			doc["body"] = string(resp.Body)
		} else {
			doc["body"] = parsed
		}
	}

	if resp.Headers != nil {
		headers := make(map[string]interface{}, len(resp.Headers))
		for k, vals := range resp.Headers {
			headers[strings.ToLower(k)] = strings.Join(vals, ", ")
		}
		doc["headers"] = headers
	}

	return doc
}

// rootCause unwraps an error chain to return the deepest error message,
// keeping user-facing errors free of internal URLs.
func rootCause(err error) string {
	if err == nil {
		return "unknown error"
	}
	cause := err
	for {
		unwrapped := errors.Unwrap(cause)
		if unwrapped == nil {
			break
		}
		cause = unwrapped
	}
	return cause.Error()
}

// doAPIRequest performs a single HTTP request attempt and returns the full response
func (e *TestExecutor) doAPIRequest(ctx context.Context, action StepAction, fullURL string) (*APIResponse, error) {
	var bodyReader io.Reader
	if action.Body != nil {
		bodyBytes, err := json.Marshal(action.Body)
		if err != nil {
			return nil, fmt.Errorf("failed to marshal request body: %w", err)
		}
		bodyReader = bytes.NewReader(bodyBytes)
	}

	req, err := http.NewRequestWithContext(ctx, action.Method, fullURL, bodyReader)
	if err != nil {
		return nil, fmt.Errorf("failed to create request: %w", err)
	}

	req.Header.Set("Content-Type", "application/json")
	for key, value := range action.Headers {
		req.Header.Set(key, value)
	}

	reqCtx := ctx
	if action.Timeout > 0 {
		var cancel context.CancelFunc
		reqCtx, cancel = context.WithTimeout(ctx, time.Duration(action.Timeout)*time.Millisecond)
		defer cancel()
		req = req.WithContext(reqCtx)
	}

	log.Printf("Executing request: %s %s", action.Method, fullURL)
	resp, err := e.httpClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("request failed: %w", err)
	}
	defer resp.Body.Close()

	bodyBytes, err := io.ReadAll(resp.Body)
	if err != nil {
		log.Printf("Warning: failed to read response body: %v", err)
		bodyBytes = nil
	} else {
		bodyStr := string(bodyBytes)
		if len(bodyStr) > 500 {
			bodyStr = bodyStr[:500] + "... (truncated)"
		}
		log.Printf("Response status: %d, body: %s", resp.StatusCode, bodyStr)
	}

	return &APIResponse{
		StatusCode: resp.StatusCode,
		Body:       bodyBytes,
		Headers:    resp.Header,
	}, nil
}

// executeDbQueryStep executes a database query action and returns the result
// as an extraction document: { success, data, rowsAffected, error, duration }.
func (e *TestExecutor) executeDbQueryStep(ctx context.Context, action StepAction, stepIndex int) (map[string]interface{}, error) {
	if e.databaseQueryExecutor == nil {
		return nil, fmt.Errorf("database query executor not initialized")
	}

	// Look up database type from the database map
	dbInfo, ok := e.databaseQueryExecutor.databaseMap[action.Database]
	if !ok {
		return nil, fmt.Errorf("database '%s' not found in databaseMap", action.Database)
	}

	e.testExecutionLogger.LogEvent("DB_QUERY_STARTED", fmt.Sprintf("Executing query on %s (%s)", action.Database, dbInfo.Type), &stepIndex, nil)

	var result *DBQueryResult
	var err error
	backoff := initialBackoff

	for attempt := 0; attempt <= maxRetries; attempt++ {
		if attempt > 0 {
			log.Printf("Retrying dbQuery (attempt %d/%d) after %v: %s on %s", attempt+1, maxRetries+1, backoff, action.Query, action.Database)
			select {
			case <-ctx.Done():
				return nil, fmt.Errorf("context cancelled during retry: %w", ctx.Err())
			case <-time.After(backoff):
			}
			backoff = time.Duration(float64(backoff) * backoffMultiplier)
			if backoff > maxBackoff {
				backoff = maxBackoff
			}
		}

		result, err = e.databaseQueryExecutor.ExecuteQuery(ctx, dbInfo.Type, action.Database, action.Query, action.Params)
		if err == nil {
			break
		}
		log.Printf("dbQuery failed (attempt %d/%d): %v", attempt+1, maxRetries+1, err)
	}

	if result == nil {
		return nil, err
	}

	// Convert []map[string]interface{} to []interface{} so EvaluateJsonPath
	// type assertions work (it expects []interface{} for array indexing).
	var data []interface{}
	for _, row := range result.Data {
		data = append(data, row)
	}

	doc := map[string]interface{}{
		"success":      result.Success,
		"data":         data,
		"rowsAffected": result.RowsAffected,
		"error":        result.Error,
		"duration":     result.Duration,
	}

	return doc, nil
}

// stripScheme removes http:// or https:// prefix from a URL
func stripScheme(url string) string {
	if strings.HasPrefix(url, "http://") {
		return url[7:]
	}
	if strings.HasPrefix(url, "https://") {
		return url[8:]
	}
	return url
}
