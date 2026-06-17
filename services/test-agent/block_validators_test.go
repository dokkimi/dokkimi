package main

import (
	"strings"
	"testing"
	"time"
)

func TestValidateSelfBlock(t *testing.T) {
	t.Run("returns failures for empty doc", func(t *testing.T) {
		block := AssertionBlock{
			Assertions: []Assertion{
				{Path: "response.status", Operator: "eq", Value: float64(200)},
			},
		}
		results := ValidateSelfBlock(block, map[string]interface{}{})
		if len(results) != 1 {
			t.Fatalf("expected 1 result, got %d", len(results))
		}
		if results[0].Passed {
			t.Error("expected fail")
		}
		if results[0].Error != "Step log not found" {
			t.Errorf("expected 'Step log not found', got %s", results[0].Error)
		}
	})

	t.Run("validates assertions against doc", func(t *testing.T) {
		doc := map[string]interface{}{
			"response": map[string]interface{}{"status": float64(200)},
		}
		block := AssertionBlock{
			Assertions: []Assertion{
				{Path: "response.status", Operator: "eq", Value: float64(200)},
			},
		}
		results := ValidateSelfBlock(block, doc)
		if len(results) != 1 {
			t.Fatalf("expected 1 result, got %d", len(results))
		}
		if !results[0].Passed {
			t.Error("expected pass")
		}
		if results[0].ResultKind != "field" {
			t.Errorf("expected resultKind 'field', got %s", results[0].ResultKind)
		}
	})

	t.Run("skips disabled assertions", func(t *testing.T) {
		doc := map[string]interface{}{
			"response": map[string]interface{}{"status": float64(200)},
		}
		block := AssertionBlock{
			Assertions: []Assertion{
				{Path: "response.status", Operator: "eq", Value: float64(200)},
				{Path: "response.missing", Operator: "eq", Value: "x", Disabled: true},
			},
		}
		results := ValidateSelfBlock(block, doc)
		if len(results) != 1 {
			t.Fatalf("expected 1 result (disabled skipped), got %d", len(results))
		}
	})
}

func TestValidateHttpCallBlock(t *testing.T) {
	now := time.Now()
	ts := now.Format(time.RFC3339Nano)
	start := now.Add(-100 * time.Millisecond).Format(time.RFC3339Nano)
	end := now.Add(100 * time.Millisecond).Format(time.RFC3339Nano)
	stepExec := StepExecution{StartTime: start, EndTime: end}

	origin := "test-agent"
	target := "user-service"
	status := 200

	httpLogs := []HttpLogMessage{
		{
			Method:          "GET",
			URL:             "/users",
			StatusCode:      &status,
			Timestamp:       ts,
			Origin:          &origin,
			Target:          &target,
			RequestHeaders:  map[string]interface{}{},
			ResponseHeaders: map[string]interface{}{},
			ResponseBody:    map[string]interface{}{"id": float64(1)},
		},
	}

	t.Run("validates count and field assertions", func(t *testing.T) {
		block := AssertionBlock{
			Match: &MatchCriteria{Origin: "test-agent", Method: "GET", URL: "user-service/users"},
			Assertions: []Assertion{
				{Path: "response.body.id", Operator: "eq", Value: float64(1)},
			},
		}
		results := ValidateHttpCallBlock(block, stepExec, httpLogs)
		if len(results) != 2 {
			t.Fatalf("expected 2 results (count + field), got %d", len(results))
		}
		if !results[0].Passed || results[0].ResultKind != "count" {
			t.Error("expected count pass")
		}
		if !results[1].Passed || results[1].ResultKind != "field" {
			t.Error("expected field pass")
		}
	})

	t.Run("short-circuits on count failure", func(t *testing.T) {
		block := AssertionBlock{
			Match: &MatchCriteria{Origin: "nonexistent"},
			Count: &CountAssertion{Operator: "eq", Value: 1},
			Assertions: []Assertion{
				{Path: "response.status", Operator: "eq", Value: float64(200)},
			},
		}
		results := ValidateHttpCallBlock(block, stepExec, httpLogs)
		if len(results) != 1 {
			t.Fatalf("expected 1 result (count only), got %d", len(results))
		}
		if results[0].Passed {
			t.Error("expected count fail")
		}
	})

	t.Run("returns only count when no active assertions", func(t *testing.T) {
		block := AssertionBlock{
			Match:      &MatchCriteria{Origin: "test-agent"},
			Assertions: []Assertion{},
		}
		results := ValidateHttpCallBlock(block, stepExec, httpLogs)
		if len(results) != 1 {
			t.Fatalf("expected 1 result, got %d", len(results))
		}
	})
}

func TestValidateConsoleLogBlock(t *testing.T) {
	consoleLogs := []ConsoleLogMessage{
		{Service: "api", Level: "INFO", Message: "Server started on port 8080"},
		{Service: "api", Level: "ERROR", Message: "Connection refused"},
		{Service: "worker", Level: "INFO", Message: "Processing job"},
	}

	t.Run("filters by service and level", func(t *testing.T) {
		block := AssertionBlock{
			Service: "api",
			ConsoleAssertions: []ConsoleLogAssertion{
				{Level: "INFO", Count: CountAssertion{Operator: "eq", Value: 1}},
			},
		}
		results := ValidateConsoleLogBlock(block, consoleLogs, "api")
		if len(results) != 1 {
			t.Fatalf("expected 1 result, got %d", len(results))
		}
		if !results[0].Passed {
			t.Error("expected pass")
		}
	})

	t.Run("filters by message contains", func(t *testing.T) {
		block := AssertionBlock{
			Service: "api",
			ConsoleAssertions: []ConsoleLogAssertion{
				{
					Message: &MessageFilter{Operator: "contains", Value: "port"},
					Count:   CountAssertion{Operator: "gte", Value: 1},
				},
			},
		}
		results := ValidateConsoleLogBlock(block, consoleLogs, "api")
		if !results[0].Passed {
			t.Error("expected pass")
		}
	})

	t.Run("filters by message matches regex", func(t *testing.T) {
		block := AssertionBlock{
			Service: "api",
			ConsoleAssertions: []ConsoleLogAssertion{
				{
					Message: &MessageFilter{Operator: "matches", Value: `port \d+`},
					Count:   CountAssertion{Operator: "eq", Value: 1},
				},
			},
		}
		results := ValidateConsoleLogBlock(block, consoleLogs, "api")
		if !results[0].Passed {
			t.Error("expected pass")
		}
	})

	t.Run("builds descriptive path", func(t *testing.T) {
		block := AssertionBlock{
			Service: "api",
			ConsoleAssertions: []ConsoleLogAssertion{
				{
					Level:   "error",
					Message: &MessageFilter{Operator: "contains", Value: "refused"},
					Count:   CountAssertion{Operator: "eq", Value: 1},
				},
			},
		}
		results := ValidateConsoleLogBlock(block, consoleLogs, "api")
		if !strings.Contains(results[0].Path, "ERROR") {
			t.Errorf("expected path to contain ERROR, got %s", results[0].Path)
		}
		if !strings.Contains(results[0].Path, `contains "refused"`) {
			t.Errorf("expected path to contain filter, got %s", results[0].Path)
		}
	})

	t.Run("skips disabled assertions", func(t *testing.T) {
		block := AssertionBlock{
			Service: "api",
			ConsoleAssertions: []ConsoleLogAssertion{
				{Level: "INFO", Count: CountAssertion{Operator: "eq", Value: 1}, Disabled: true},
				{Level: "ERROR", Count: CountAssertion{Operator: "eq", Value: 1}},
			},
		}
		results := ValidateConsoleLogBlock(block, consoleLogs, "api")
		if len(results) != 1 {
			t.Fatalf("expected 1 result (disabled skipped), got %d", len(results))
		}
	})
}

func TestValidateSelfBlock_nonResponsePathsEvaluateWithEmptyResponse(t *testing.T) {
	doc := map[string]interface{}{
		"response":  map[string]interface{}{},
		"variables": map[string]interface{}{"count": float64(5)},
		"traffic":   []interface{}{},
	}
	block := AssertionBlock{
		Assertions: []Assertion{
			{Path: "response.status", Operator: "eq", Value: float64(200)},
			{Path: "variables.count", Operator: "eq", Value: float64(5)},
		},
	}
	results := ValidateSelfBlock(block, doc)
	if len(results) != 2 {
		t.Fatalf("expected 2 results, got %d", len(results))
	}
	if results[0].Passed {
		t.Error("response.status should fail with 'Step log not found'")
	}
	if results[0].Error != "Step log not found" {
		t.Errorf("expected 'Step log not found', got %s", results[0].Error)
	}
	if !results[1].Passed {
		t.Error("variables.count should pass even with empty response")
	}
}

func TestValidateSelfBlock_skipsDisabledOnEmptyDoc(t *testing.T) {
	block := AssertionBlock{
		Assertions: []Assertion{
			{Path: "response.status", Operator: "eq", Value: float64(200)},
			{Path: "response.body", Operator: "eq", Value: "x", Disabled: true},
		},
	}
	results := ValidateSelfBlock(block, map[string]interface{}{})
	if len(results) != 1 {
		t.Fatalf("expected 1 result (disabled skipped on empty doc), got %d", len(results))
	}
	if results[0].Passed {
		t.Error("expected fail for non-disabled assertion")
	}
}

func TestValidateHttpCallBlock_assertionScopes(t *testing.T) {
	now := time.Now()
	start := now.Add(-200 * time.Millisecond).Format(time.RFC3339Nano)
	end := now.Add(200 * time.Millisecond).Format(time.RFC3339Nano)
	stepExec := StepExecution{StartTime: start, EndTime: end}

	origin := "test-agent"
	target := "api"
	status1 := 200
	status2 := 201
	status3 := 404

	httpLogs := []HttpLogMessage{
		{
			Method: "GET", URL: "/items", StatusCode: &status1,
			Timestamp: now.Add(-50 * time.Millisecond).Format(time.RFC3339Nano),
			Origin:    &origin, Target: &target,
			RequestHeaders: map[string]interface{}{}, ResponseHeaders: map[string]interface{}{},
		},
		{
			Method: "GET", URL: "/items", StatusCode: &status2,
			Timestamp: now.Format(time.RFC3339Nano),
			Origin:    &origin, Target: &target,
			RequestHeaders: map[string]interface{}{}, ResponseHeaders: map[string]interface{}{},
		},
		{
			Method: "GET", URL: "/items", StatusCode: &status3,
			Timestamp: now.Add(50 * time.Millisecond).Format(time.RFC3339Nano),
			Origin:    &origin, Target: &target,
			RequestHeaders: map[string]interface{}{}, ResponseHeaders: map[string]interface{}{},
		},
	}

	t.Run("first scope validates only first log", func(t *testing.T) {
		block := AssertionBlock{
			Match:          &MatchCriteria{Origin: "test-agent", Method: "GET"},
			AssertionScope: "first",
			Assertions: []Assertion{
				{Path: "response.status", Operator: "eq", Value: float64(200)},
			},
		}
		results := ValidateHttpCallBlock(block, stepExec, httpLogs)
		fieldResults := filterByKind(results, "field")
		if len(fieldResults) != 1 || !fieldResults[0].Passed {
			t.Error("expected first scope to validate first log (200) and pass")
		}
	})

	t.Run("last scope validates only last log", func(t *testing.T) {
		block := AssertionBlock{
			Match:          &MatchCriteria{Origin: "test-agent", Method: "GET"},
			AssertionScope: "last",
			Assertions: []Assertion{
				{Path: "response.status", Operator: "eq", Value: float64(404)},
			},
		}
		results := ValidateHttpCallBlock(block, stepExec, httpLogs)
		fieldResults := filterByKind(results, "field")
		if len(fieldResults) != 1 || !fieldResults[0].Passed {
			t.Error("expected last scope to validate last log (404) and pass")
		}
	})

	t.Run("any scope passes if any log matches", func(t *testing.T) {
		block := AssertionBlock{
			Match:          &MatchCriteria{Origin: "test-agent", Method: "GET"},
			AssertionScope: "any",
			Assertions: []Assertion{
				{Path: "response.status", Operator: "eq", Value: float64(201)},
			},
		}
		results := ValidateHttpCallBlock(block, stepExec, httpLogs)
		fieldResults := filterByKind(results, "field")
		if len(fieldResults) != 1 || !fieldResults[0].Passed {
			t.Error("expected any scope to find 201 and pass")
		}
	})

	t.Run("any scope fails if no log matches", func(t *testing.T) {
		block := AssertionBlock{
			Match:          &MatchCriteria{Origin: "test-agent", Method: "GET"},
			AssertionScope: "any",
			Assertions: []Assertion{
				{Path: "response.status", Operator: "eq", Value: float64(500)},
			},
		}
		results := ValidateHttpCallBlock(block, stepExec, httpLogs)
		fieldResults := filterByKind(results, "field")
		if len(fieldResults) != 1 || fieldResults[0].Passed {
			t.Error("expected any scope to fail when no log has status 500")
		}
	})
}

func filterByKind(results []AssertionResult, kind string) []AssertionResult {
	var out []AssertionResult
	for _, r := range results {
		if r.ResultKind == kind {
			out = append(out, r)
		}
	}
	return out
}

func TestValidateStepWithRetry(t *testing.T) {
	t.Run("passes immediately when logs are present", func(t *testing.T) {
		buf := NewStepLogBuffer()
		status := 200
		now := time.Now()
		buf.AddHttpLog(HttpLogMessage{
			Method: "GET", URL: "/test", StatusCode: &status,
			Timestamp:       now.Format(time.RFC3339Nano),
			RequestHeaders:  map[string]interface{}{},
			ResponseHeaders: map[string]interface{}{},
			ResponseBody:    map[string]interface{}{"ok": true},
		})

		sv := NewStepValidator(buf, NewVariableContext())
		step := TestStep{
			Action: StepAction{Type: "httpRequest", Method: "GET", URL: "/test"},
			Assertions: []AssertionBlock{{
				Assertions: []Assertion{
					{Path: "response.status", Operator: "eq", Value: float64(200)},
				},
			}},
		}
		stepExec := StepExecution{
			StartTime: now.Add(-200 * time.Millisecond).Format(time.RFC3339Nano),
			EndTime:   now.Add(200 * time.Millisecond).Format(time.RFC3339Nano),
		}

		results, passed := sv.ValidateStepWithRetry(step, stepExec, nil)
		if !passed {
			t.Error("expected pass")
		}
		if len(results) != 1 {
			t.Errorf("expected 1 result, got %d", len(results))
		}
	})

	t.Run("retries and passes when logs arrive late", func(t *testing.T) {
		buf := NewStepLogBuffer()
		now := time.Now()

		sv := NewStepValidator(buf, NewVariableContext())
		step := TestStep{
			Action: StepAction{Type: "httpRequest", Method: "GET", URL: "/test"},
			Assertions: []AssertionBlock{{
				Assertions: []Assertion{
					{Path: "response.status", Operator: "eq", Value: float64(200)},
				},
			}},
		}
		stepExec := StepExecution{
			StartTime: now.Add(-200 * time.Millisecond).Format(time.RFC3339Nano),
			EndTime:   now.Add(200 * time.Millisecond).Format(time.RFC3339Nano),
		}

		status := 200
		go func() {
			time.Sleep(150 * time.Millisecond)
			buf.AddHttpLog(HttpLogMessage{
				Method: "GET", URL: "/test", StatusCode: &status,
				Timestamp:       now.Format(time.RFC3339Nano),
				RequestHeaders:  map[string]interface{}{},
				ResponseHeaders: map[string]interface{}{},
				ResponseBody:    map[string]interface{}{},
			})
		}()

		results, passed := sv.ValidateStepWithRetry(step, stepExec, nil)
		if !passed {
			t.Error("expected retry to eventually pass")
		}
		if len(results) != 1 {
			t.Errorf("expected 1 result, got %d", len(results))
		}
	})

	t.Run("flushes buffer after validation", func(t *testing.T) {
		buf := NewStepLogBuffer()
		status := 200
		now := time.Now()
		buf.AddHttpLog(HttpLogMessage{
			Method: "GET", URL: "/test", StatusCode: &status,
			Timestamp:       now.Format(time.RFC3339Nano),
			RequestHeaders:  map[string]interface{}{},
			ResponseHeaders: map[string]interface{}{},
		})

		sv := NewStepValidator(buf, NewVariableContext())
		step := TestStep{
			Action: StepAction{Type: "httpRequest", Method: "GET", URL: "/test"},
			Assertions: []AssertionBlock{{
				Assertions: []Assertion{
					{Path: "response.status", Operator: "eq", Value: float64(200)},
				},
			}},
		}
		stepExec := StepExecution{
			StartTime: now.Add(-200 * time.Millisecond).Format(time.RFC3339Nano),
			EndTime:   now.Add(200 * time.Millisecond).Format(time.RFC3339Nano),
		}

		sv.ValidateStepWithRetry(step, stepExec, nil)
		if buf.LogCount() != 0 {
			t.Errorf("expected buffer flushed after validation, got %d logs", buf.LogCount())
		}
	})
}

func TestStepValidator(t *testing.T) {
	t.Run("validates step with self-block assertions", func(t *testing.T) {
		buf := NewStepLogBuffer()
		status := 200
		now := time.Now()
		buf.AddHttpLog(HttpLogMessage{
			Method:          "GET",
			URL:             "/users",
			StatusCode:      &status,
			Timestamp:       now.Format(time.RFC3339Nano),
			RequestHeaders:  map[string]interface{}{},
			ResponseHeaders: map[string]interface{}{},
			ResponseBody:    map[string]interface{}{"name": "Alice"},
		})

		varCtx := NewVariableContext()
		sv := NewStepValidator(buf, varCtx)

		step := TestStep{
			Action: StepAction{Type: "httpRequest", Method: "GET", URL: "/users"},
			Assertions: []AssertionBlock{
				{
					Assertions: []Assertion{
						{Path: "response.body.name", Operator: "eq", Value: "Alice"},
						{Path: "response.status", Operator: "eq", Value: float64(200)},
					},
				},
			},
		}
		stepExec := StepExecution{
			StartTime: now.Add(-200 * time.Millisecond).Format(time.RFC3339Nano),
			EndTime:   now.Add(200 * time.Millisecond).Format(time.RFC3339Nano),
		}

		results, passed := sv.validateStep(step, stepExec, nil)
		if !passed {
			t.Error("expected step to pass")
		}
		if len(results) != 2 {
			t.Errorf("expected 2 results, got %d", len(results))
		}
	})

	t.Run("extracts variables from step", func(t *testing.T) {
		buf := NewStepLogBuffer()
		status := 200
		now := time.Now()
		buf.AddHttpLog(HttpLogMessage{
			Method:          "GET",
			URL:             "/users",
			StatusCode:      &status,
			Timestamp:       now.Format(time.RFC3339Nano),
			RequestHeaders:  map[string]interface{}{},
			ResponseHeaders: map[string]interface{}{},
			ResponseBody:    map[string]interface{}{"id": float64(42)},
		})

		varCtx := NewVariableContext()
		sv := NewStepValidator(buf, varCtx)

		step := TestStep{
			Action:  StepAction{Type: "httpRequest", Method: "GET", URL: "/users"},
			Extract: map[string]ExtractRule{"userId": {Path: "$.response.body.id"}},
		}
		stepExec := StepExecution{
			StartTime: now.Add(-200 * time.Millisecond).Format(time.RFC3339Nano),
			EndTime:   now.Add(200 * time.Millisecond).Format(time.RFC3339Nano),
		}

		results, passed := sv.validateStep(step, stepExec, nil)
		if !passed {
			t.Error("expected step to pass")
		}
		if len(results) != 1 {
			t.Errorf("expected 1 extract result, got %d", len(results))
		}

		val, ok := varCtx.variables["userId"]
		if !ok || val != float64(42) {
			t.Errorf("expected userId=42, got %v", val)
		}
	})
}
