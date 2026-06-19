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

// normalizeResponseForUntil converts the raw response map returned by
// executeStep into the same shape as AssembleHttpDocument's response section,
// so until conditions can reference $.response.status consistently.
func normalizeResponseForUntil(raw map[string]interface{}) map[string]interface{} {
	if raw == nil {
		return map[string]interface{}{
			"status":  nil,
			"headers": map[string]interface{}{},
			"body":    map[string]interface{}{},
		}
	}
	normalized := make(map[string]interface{}, len(raw))
	for k, v := range raw {
		normalized[k] = v
	}
	if sc, ok := normalized["statusCode"]; ok {
		if _, already := normalized["status"]; !already {
			if f, ok := toFloat(sc); ok {
				normalized["status"] = f
			}
		}
		delete(normalized, "statusCode")
	}
	if _, ok := normalized["headers"]; !ok {
		normalized["headers"] = map[string]interface{}{}
	}
	if _, ok := normalized["body"]; !ok {
		normalized["body"] = map[string]interface{}{}
	}
	return normalized
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
		if err == nil || result != nil {
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
