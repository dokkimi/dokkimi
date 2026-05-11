package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"time"
)

// CompletionNotifier notifies Control Tower's /test-complete endpoint when a
// test run finishes.
type CompletionNotifier struct {
	url                 string
	httpClient          *http.Client
	testExecutionLogger *TestExecutionLogger
}

// NewCompletionNotifier creates a notifier that POSTs to the given URL
// (typically Control Tower's /test-complete endpoint).
func NewCompletionNotifier(url string, testExecutionLogger *TestExecutionLogger) *CompletionNotifier {
	return &CompletionNotifier{
		url: url,
		httpClient: &http.Client{
			Timeout: 30 * time.Second,
		},
		testExecutionLogger: testExecutionLogger,
	}
}

// NotifyCompletion notifies Control Tower that tests have completed via HTTP POST.
// partial=true signals a debug partial run; Control Tower will skip unexecuted steps.
func (n *CompletionNotifier) NotifyCompletion(testRunID string, status string, message string, stepExecutions []StepExecution, partial bool) error {
	notification := TestCompletionNotification{
		TestRunID:      testRunID,
		Status:         status,
		Message:        message,
		StepExecutions: stepExecutions,
		Partial:        partial,
	}

	body, err := json.Marshal(notification)
	if err != nil {
		return fmt.Errorf("failed to marshal notification: %w", err)
	}

	req, err := http.NewRequest(http.MethodPost, n.url, bytes.NewBuffer(body))
	if err != nil {
		return fmt.Errorf("failed to create request: %w", err)
	}

	req.Header.Set("Content-Type", "application/json")

	resp, err := n.httpClient.Do(req)
	if err != nil {
		log.Printf("Failed to send completion notification: %v", err)
		return fmt.Errorf("failed to send notification: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		log.Printf("Control Tower returned non-2xx status: %d", resp.StatusCode)
		return fmt.Errorf("control tower returned non-2xx status: %d", resp.StatusCode)
	}

	log.Printf("Successfully notified Control Tower of test completion: %s", notification.Status)
	return nil
}
