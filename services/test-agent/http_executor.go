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

// executeAPIStep executes an HTTP request action. Only a request that never
// reached the interceptor (a connection error) is sent again. Any response from
// the service, 5xx included, is the step's result. When the interceptor answers
// with X-Dokkimi-Error the step fails without a retry: the service may already
// have received the request.
// Returns an extraction document: { statusCode, headers, body }.
func (e *TestExecutor) executeAPIStep(ctx context.Context, action StepAction, stepIndex int) (map[string]interface{}, error) {
	strippedURL := encodeURLChars(stripScheme(action.URL))
	fullURL := e.interceptorURL + "/" + strippedURL

	// Log user-friendly message with the URL
	e.testExecutionLogger.LogRequestStarted(stepIndex, action.Method, action.URL)

	var lastErr error
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
		if err != nil && resp != nil {
			// The request arrived and was being answered, so don't send it again
			return nil, fmt.Errorf("%s %s failed: %w", action.Method, action.URL, err)
		}
		if err != nil {
			lastErr = err
			log.Printf("Request failed with error: %v (URL: %s)", err, fullURL)
			continue
		}

		if resp.Headers.Get(dokkimiErrorHeader) != "" {
			// The interceptor got no response from the service, so there is none
			return nil, fmt.Errorf("%s %s failed: %s", action.Method, action.URL, strings.TrimSpace(string(resp.Body)))
		}

		return apiResponseToExtractDoc(resp), nil
	}

	log.Printf("Request failed after %d retries: %v", maxRetries+1, lastErr)
	return nil, fmt.Errorf("%s %s failed: %s", action.Method, action.URL, rootCause(lastErr))
}

// dokkimiErrorHeader marks a response the interceptor made because it couldn't
// deliver the request. Keep in sync with the interceptor's DokkimiErrorHeader.
const dokkimiErrorHeader = "X-Dokkimi-Error"

// dokkimiSchemeHeader tells the interceptor which scheme a step's URL asked
// for; the interceptor strips it before forwarding. Keep in sync with the
// interceptor's DokkimiSchemeHeader.
const dokkimiSchemeHeader = "X-Dokkimi-Scheme"

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

// doAPIRequest performs a single HTTP request attempt and returns the full
// response, or an error and what arrived of it if it broke off.
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

	req, err := http.NewRequestWithContext(ctx, action.Method, fullURL, bodyReader)
	if err != nil {
		return nil, fmt.Errorf("failed to create request: %w", err)
	}

	if contentType != "" {
		req.Header.Set("Content-Type", contentType)
	}
	if scheme := requestedScheme(action.URL); scheme != "" {
		req.Header.Set(dokkimiSchemeHeader, scheme)
	}
	for key, value := range action.Headers {
		if action.FormData != nil && strings.EqualFold(key, "Content-Type") {
			continue
		}
		req.Header.Set(key, value)
	}

	timeout := e.requestTimeout
	if action.Timeout > 0 {
		timeout = time.Duration(action.Timeout) * time.Millisecond
	}
	reqCtx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	req = req.WithContext(reqCtx)

	log.Printf("Executing request: %s %s", action.Method, fullURL)
	resp, err := e.httpClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("request failed: %w", err)
	}
	defer resp.Body.Close()

	bodyBytes, err := io.ReadAll(resp.Body)
	if err != nil {
		err = fmt.Errorf("the response broke off after status %d: %w", resp.StatusCode, err)
	}
	bodyStr := string(bodyBytes)
	if len(bodyStr) > 500 {
		bodyStr = bodyStr[:500] + "... (truncated)"
	}
	log.Printf("Response status: %d, body: %s", resp.StatusCode, bodyStr)

	return &APIResponse{
		StatusCode: resp.StatusCode,
		Body:       bodyBytes,
		Headers:    resp.Header,
	}, err
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
// requestedScheme returns "http" or "https" when a step's URL starts with one,
// else "" (the interceptor then uses its default for the target).
func requestedScheme(url string) string {
	switch {
	case strings.HasPrefix(url, "http://"):
		return "http"
	case strings.HasPrefix(url, "https://"):
		return "https"
	default:
		return ""
	}
}

// encodeURLChars percent-encodes the characters a URL can't contain as they
// are (spaces, quotes, <>, control characters, non-ASCII), as a browser does
// with a typed URL. Everything else is kept as written, including %, +, & and
// =, so an already-encoded URL doesn't change.
func encodeURLChars(s string) string {
	var b strings.Builder
	for i := 0; i < len(s); i++ {
		c := s[i]
		if c <= 0x20 || c >= 0x7f || strings.IndexByte(`"<>\^`+"`"+`{|}`, c) >= 0 {
			fmt.Fprintf(&b, "%%%02X", c)
		} else {
			b.WriteByte(c)
		}
	}
	return b.String()
}

func stripScheme(url string) string {
	if strings.HasPrefix(url, "http://") {
		return url[7:]
	}
	if strings.HasPrefix(url, "https://") {
		return url[8:]
	}
	return url
}
