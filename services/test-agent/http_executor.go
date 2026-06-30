package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"mime/multipart"
	"net/http"
	"net/textproto"
	"net/url"
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
	var lastResp *APIResponse
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
			lastResp = nil
			log.Printf("Request failed with error: %v (URL: %s)", err, fullURL)
			continue
		}

		if retryableStatusCodes[resp.StatusCode] {
			lastErr = fmt.Errorf("received retryable status code %d", resp.StatusCode)
			lastResp = resp
			log.Printf("Received retryable status code %d for %s %s", resp.StatusCode, action.Method, fullURL)
			continue
		}

		return apiResponseToExtractDoc(resp), nil
	}

	if lastResp != nil {
		log.Printf("Request returned status %d after %d retries: %s %s", lastResp.StatusCode, maxRetries+1, action.Method, fullURL)
		return apiResponseToExtractDoc(lastResp), nil
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

// buildRequestBody converts an action body value into a reader.
// String values are sent as-is (for application/x-www-form-urlencoded or plain text).
// All other types are JSON-encoded.
func buildRequestBody(body interface{}) (io.Reader, error) {
	if str, ok := body.(string); ok {
		return strings.NewReader(str), nil
	}
	bodyBytes, err := json.Marshal(body)
	if err != nil {
		return nil, fmt.Errorf("failed to marshal request body: %w", err)
	}
	return bytes.NewReader(bodyBytes), nil
}

// buildFormDataBody builds a multipart/form-data request body from the action's FormData map.
// String values become plain form fields. Objects with "filename" + "content" become file parts.
func buildFormDataBody(formData map[string]interface{}) (io.Reader, string, error) {
	var buf bytes.Buffer
	writer := multipart.NewWriter(&buf)

	for key, value := range formData {
		switch v := value.(type) {
		case map[string]interface{}:
			filename, hasFilename := v["filename"].(string)
			content, hasContent := v["content"].(string)
			if hasFilename && hasContent {
				contentType, _ := v["contentType"].(string)
				if contentType == "" {
					contentType = "application/octet-stream"
				}
				h := make(textproto.MIMEHeader)
				escapedKey := strings.NewReplacer("\\", "\\\\", `"`, "\\\"").Replace(key)
				escapedFilename := strings.NewReplacer("\\", "\\\\", `"`, "\\\"").Replace(filename)
				h.Set("Content-Disposition", fmt.Sprintf(`form-data; name="%s"; filename="%s"`, escapedKey, escapedFilename))
				h.Set("Content-Type", contentType)
				part, err := writer.CreatePart(h)
				if err != nil {
					return nil, "", fmt.Errorf("failed to create file part %q: %w", key, err)
				}
				if _, err := part.Write([]byte(content)); err != nil {
					return nil, "", fmt.Errorf("failed to write file part %q: %w", key, err)
				}
			} else {
				jsonBytes, err := json.Marshal(v)
				if err != nil {
					return nil, "", fmt.Errorf("failed to marshal form field %q: %w", key, err)
				}
				if err := writer.WriteField(key, string(jsonBytes)); err != nil {
					return nil, "", fmt.Errorf("failed to write form field %q: %w", key, err)
				}
			}
		case []interface{}:
			arrayKey := key
			if !strings.HasSuffix(key, "[]") {
				arrayKey = key + "[]"
			}
			for _, item := range v {
				if err := writer.WriteField(arrayKey, fmt.Sprintf("%v", item)); err != nil {
					return nil, "", fmt.Errorf("failed to write array form field %q: %w", key, err)
				}
			}
		default:
			strVal := fmt.Sprintf("%v", v)
			if err := writer.WriteField(key, strVal); err != nil {
				return nil, "", fmt.Errorf("failed to write form field %q: %w", key, err)
			}
		}
	}

	if err := writer.Close(); err != nil {
		return nil, "", fmt.Errorf("failed to close multipart writer: %w", err)
	}
	return &buf, writer.FormDataContentType(), nil
}

// doAPIRequest performs a single HTTP request attempt and returns the full response
func (e *TestExecutor) doAPIRequest(ctx context.Context, action StepAction, fullURL string) (*APIResponse, error) {
	var bodyReader io.Reader
	var contentType string

	if action.FormData != nil {
		reader, ct, err := buildFormDataBody(action.FormData)
		if err != nil {
			return nil, fmt.Errorf("failed to build form data: %w", err)
		}
		bodyReader = reader
		contentType = ct
	} else if action.Body != nil {
		reader, err := buildRequestBody(action.Body)
		if err != nil {
			return nil, err
		}
		bodyReader = reader
		if _, isString := action.Body.(string); !isString {
			contentType = "application/json"
		}
	}

	if len(action.QueryParams) > 0 {
		encoded, encErr := appendQueryParams(fullURL, action.QueryParams)
		if encErr != nil {
			return nil, encErr
		}
		fullURL = encoded
	}

	if len(action.QueryParams) > 0 {
		encoded, encErr := appendQueryParams(fullURL, action.QueryParams)
		if encErr != nil {
			return nil, encErr
		}
		fullURL = encoded
	}

	req, err := http.NewRequestWithContext(ctx, action.Method, fullURL, bodyReader)
	if err != nil {
		return nil, fmt.Errorf("failed to create request: %w", err)
	}

	if contentType != "" {
		req.Header.Set("Content-Type", contentType)
	}
	for key, value := range action.Headers {
		if action.FormData != nil && strings.EqualFold(key, "Content-Type") {
			continue
		}
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

	// Convert []map[string]interface{} to []interface{} so EvaluateDocPath
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

func appendQueryParams(rawURL string, params map[string]interface{}) (string, error) {
	parsedURL, err := url.Parse(rawURL)
	if err != nil {
		return "", fmt.Errorf("failed to parse URL for queryParams: %w", err)
	}
	q := parsedURL.Query()
	for key, val := range params {
		switch v := val.(type) {
		case []interface{}:
			for _, item := range v {
				q.Add(key, fmt.Sprintf("%v", item))
			}
		default:
			q.Add(key, fmt.Sprintf("%v", v))
		}
	}
	parsedURL.RawQuery = q.Encode()
	return parsedURL.String(), nil
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
