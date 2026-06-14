package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"time"
)

// ValidationReport is the payload sent to CT's POST /logs/test-validation.
type ValidationReport struct {
	InstanceID string                   `json:"instanceId"`
	StepIndex  int                      `json:"stepIndex"`
	Passed     bool                     `json:"passed"`
	Assertions []ValidationReportResult `json:"assertions"`
}

// ValidationReportResult is a single assertion result in the report.
type ValidationReportResult struct {
	Path       string      `json:"path"`
	Operator   string      `json:"operator"`
	Passed     bool        `json:"passed"`
	Expected   interface{} `json:"expected,omitempty"`
	Actual     interface{} `json:"actual,omitempty"`
	Error      string      `json:"error,omitempty"`
	BlockIndex int         `json:"blockIndex"`
	ResultKind string      `json:"resultKind"`
}

// ValidationReporter sends step validation results to Control Tower.
type ValidationReporter struct {
	controlTowerURL string
	httpClient      *http.Client
}

// NewValidationReporter creates a new validation reporter.
func NewValidationReporter(controlTowerURL string) *ValidationReporter {
	return &ValidationReporter{
		controlTowerURL: controlTowerURL,
		httpClient:      &http.Client{Timeout: 30 * time.Second},
	}
}

// ReportStepResults sends validation results for a step to CT.
func (vr *ValidationReporter) ReportStepResults(instanceID string, stepIndex int, results []AssertionResult, passed bool) {
	reportResults := make([]ValidationReportResult, len(results))
	for i, r := range results {
		bi := 0
		if r.BlockIndex != nil {
			bi = *r.BlockIndex
		}
		reportResults[i] = ValidationReportResult{
			Path:       r.Path,
			Operator:   r.Operator,
			Passed:     r.Passed,
			Expected:   r.Expected,
			Actual:     r.Actual,
			Error:      r.Error,
			BlockIndex: bi,
			ResultKind: r.ResultKind,
		}
	}

	report := ValidationReport{
		InstanceID: instanceID,
		StepIndex:  stepIndex,
		Passed:     passed,
		Assertions: reportResults,
	}

	body, err := json.Marshal(report)
	if err != nil {
		log.Printf("[ValidationReporter] Failed to marshal report: %v", err)
		return
	}

	url := vr.controlTowerURL + "/logs/test-validation"
	req, err := http.NewRequest(http.MethodPost, url, bytes.NewBuffer(body))
	if err != nil {
		log.Printf("[ValidationReporter] Failed to create request: %v", err)
		return
	}
	req.Header.Set("Content-Type", "application/json")

	resp, err := vr.httpClient.Do(req)
	if err != nil {
		log.Printf("[ValidationReporter] Failed to send report to %s: %v", url, err)
		return
	}
	resp.Body.Close()

	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		log.Printf("[ValidationReporter] CT returned status %d for step %d", resp.StatusCode, stepIndex)
	} else {
		log.Printf("[ValidationReporter] Reported %d assertion results for step %d (passed=%t)",
			len(results), stepIndex, passed)
	}
}

// ReportStepResultsAsync sends validation results in a background goroutine (fire-and-forget).
func (vr *ValidationReporter) ReportStepResultsAsync(instanceID string, stepIndex int, results []AssertionResult, passed bool) {
	go vr.ReportStepResults(instanceID, stepIndex, results, passed)
}

// FormatStepResult returns a human-readable summary of step validation.
func FormatStepResult(stepIndex int, stepName string, results []AssertionResult, passed bool) string {
	total := len(results)
	failCount := 0
	for _, r := range results {
		if !r.Passed {
			failCount++
		}
	}

	if passed {
		return fmt.Sprintf("Step %d (%s): PASSED (%d assertions)", stepIndex, stepName, total)
	}
	return fmt.Sprintf("Step %d (%s): FAILED (%d/%d assertions failed)", stepIndex, stepName, failCount, total)
}
