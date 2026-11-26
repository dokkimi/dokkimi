package main

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func TestNewTestExecutor(t *testing.T) {
	executor := NewTestExecutor("http://interceptor-service.test.svc.cluster.local", 30*time.Second, nil, nil)

	if executor == nil {
		t.Fatal("NewTestExecutor returned nil")
	}

	if executor.httpClient == nil {
		t.Error("Expected httpClient to be set")
	}
}

func TestTestExecutor_DisableCompression(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		ae := r.Header.Get("Accept-Encoding")
		if ae != "" {
			t.Errorf("Expected no Accept-Encoding header, got %q", ae)
		}
		w.WriteHeader(http.StatusOK)
		w.Write([]byte(`{"ok": true}`))
	}))
	defer server.Close()

	executor := NewTestExecutor(server.URL, 30*time.Second, nil, nil)

	step := TestStep{
		Action: StepAction{Type: "httpRequest", Method: "GET", URL: "svc/test"},
	}
	ctx := context.Background()
	_, err := executor.executeStep(ctx, step, 0)
	if err != nil {
		t.Fatalf("executeStep() error = %v", err)
	}
}

func TestTestExecutor_ExecuteStep(t *testing.T) {
	// Create a test server that simulates the interceptor
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == "GET" && r.URL.Path == "/test-service/api/users" {
			w.WriteHeader(http.StatusOK)
			w.Write([]byte(`{"users": []}`))
		} else if r.Method == "POST" && r.URL.Path == "/test-service/api/users" {
			w.WriteHeader(http.StatusCreated)
			w.Write([]byte(`{"id": "123"}`))
		} else {
			w.WriteHeader(http.StatusNotFound)
		}
	}))
	defer server.Close()

	executor := NewTestExecutor(server.URL, 30*time.Second, nil, nil)

	tests := []struct {
		name      string
		step      TestStep
		wantError bool
	}{
		{
			name: "successful GET request",
			step: TestStep{
				Action: StepAction{Type: "httpRequest", Method: "GET", URL: "test-service/api/users"},
			},
			wantError: false,
		},
		{
			name: "successful POST request",
			step: TestStep{
				Action: StepAction{Type: "httpRequest", Method: "POST", URL: "test-service/api/users", Body: map[string]interface{}{"name": "test"}},
			},
			wantError: false,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			ctx := context.Background()
			_, err := executor.executeStep(ctx, tt.step, 0)

			if (err != nil) != tt.wantError {
				t.Errorf("executeStep() error = %v, wantError %v", err, tt.wantError)
			}
		})
	}
}

func TestTestExecutor_ExecuteParallelAction(t *testing.T) {
	requestCount := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requestCount++
		w.WriteHeader(http.StatusOK)
		w.Write([]byte(`{"status": "ok"}`))
	}))
	defer server.Close()

	executor := NewTestExecutor(server.URL, 30*time.Second, nil, nil)

	step := TestStep{
		Action: StepAction{
			Type: "parallel",
			Actions: []StepAction{
				{Type: "httpRequest", Method: "GET", URL: "test-service/api/1"},
				{Type: "httpRequest", Method: "GET", URL: "test-service/api/2"},
				{Type: "httpRequest", Method: "GET", URL: "test-service/api/3"},
			},
		},
	}

	ctx := context.Background()
	_, err := executor.executeStep(ctx, step, 0)

	if err != nil {
		t.Errorf("executeStep(parallel) error = %v", err)
	}

	if requestCount != 3 {
		t.Errorf("Expected 3 requests, got %d", requestCount)
	}
}

func TestTestExecutor_ExecuteTests(t *testing.T) {
	requestOrder := []string{}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requestOrder = append(requestOrder, r.URL.Path)
		w.WriteHeader(http.StatusOK)
		w.Write([]byte(`{"status": "ok"}`))
	}))
	defer server.Close()

	executor := NewTestExecutor(server.URL, 30*time.Second, nil, nil)

	testConfig := &TestConfig{
		TestRunID:      "test-run-123",
		TimeoutSeconds: 30,
		Tests: []TestDefinition{
			{
				Name: "Create and fetch users",
				Steps: []TestStep{
					{Action: StepAction{Type: "httpRequest", Method: "POST", URL: "test-service/api/users"}},
					{Action: StepAction{Type: "httpRequest", Method: "GET", URL: "test-service/api/users/1"}},
				},
			},
		},
	}

	ctx := context.Background()
	_, err := executor.ExecuteTests(ctx, testConfig, 0, -1)

	if err != nil {
		t.Errorf("ExecuteTests() error = %v", err)
	}

	if len(requestOrder) != 2 {
		t.Errorf("Expected 2 requests, got %d", len(requestOrder))
	}

	if requestOrder[0] != "/test-service/api/users" {
		t.Errorf("Expected first request to be /test-service/api/users, got %s", requestOrder[0])
	}

	if requestOrder[1] != "/test-service/api/users/1" {
		t.Errorf("Expected second request to be /test-service/api/users/1, got %s", requestOrder[1])
	}
}

func TestTestExecutor_FlattenSteps_DefinitionLevelVariables(t *testing.T) {
	executor := NewTestExecutor("http://localhost", 30*time.Second, nil, nil)

	testConfig := &TestConfig{
		TestRunID:      "test-123",
		TimeoutSeconds: 30,
		Variables: map[string]interface{}{
			"defVar":    "from-definition",
			"sharedVar": "from-definition",
		},
		Tests: []TestDefinition{
			{
				Name: "Test 1",
				Variables: map[string]interface{}{
					"testVar":   "from-test",
					"sharedVar": "from-test", // should override definition-level
				},
				Steps: []TestStep{
					{Action: StepAction{Type: "httpRequest", Method: "GET", URL: "svc/api"}},
				},
			},
		},
	}

	steps := executor.flattenSteps(testConfig, true)

	if len(steps) != 1 {
		t.Fatalf("Expected 1 step, got %d", len(steps))
	}

	// Definition-level variable should be seeded by flattenSteps
	val, err := executor.varCtx.Resolve("{{defVar}}")
	if err != nil {
		t.Fatalf("Expected defVar to be set, got error: %v", err)
	}
	if val != "from-definition" {
		t.Errorf("Expected defVar='from-definition', got '%s'", val)
	}

	// Test-level variables are attached to the step for per-test seeding
	if steps[0].testVariables == nil {
		t.Fatal("Expected testVariables on step, got nil")
	}
	if steps[0].testVariables["testVar"] != "from-test" {
		t.Errorf("Expected testVariables[testVar]='from-test', got '%s'", steps[0].testVariables["testVar"])
	}
	if steps[0].testVariables["sharedVar"] != "from-test" {
		t.Errorf("Expected testVariables[sharedVar]='from-test', got '%s'", steps[0].testVariables["sharedVar"])
	}
}

func TestTestExecutor_FlattenSteps_NoDefinitionVariables(t *testing.T) {
	executor := NewTestExecutor("http://localhost", 30*time.Second, nil, nil)

	testConfig := &TestConfig{
		TestRunID:      "test-123",
		TimeoutSeconds: 30,
		Tests: []TestDefinition{
			{
				Name: "Test 1",
				Variables: map[string]interface{}{
					"testVar": "value",
				},
				Steps: []TestStep{
					{Action: StepAction{Type: "httpRequest", Method: "GET", URL: "svc/api"}},
				},
			},
		},
	}

	steps := executor.flattenSteps(testConfig, true)

	if len(steps) != 1 {
		t.Fatalf("Expected 1 step, got %d", len(steps))
	}

	if steps[0].testVariables == nil {
		t.Fatal("Expected testVariables on step, got nil")
	}
	if steps[0].testVariables["testVar"] != "value" {
		t.Errorf("Expected testVariables[testVar]='value', got '%s'", steps[0].testVariables["testVar"])
	}
}

func TestTestExecutor_FlattenSteps_MultiTestVariableIsolation(t *testing.T) {
	executor := NewTestExecutor("http://localhost", 30*time.Second, nil, nil)

	testConfig := &TestConfig{
		TestRunID:      "test-123",
		TimeoutSeconds: 30,
		Variables: map[string]interface{}{
			"connStr": "default-conn",
		},
		Tests: []TestDefinition{
			{
				Name: "Test 1 — uses default connStr",
				Steps: []TestStep{
					{Action: StepAction{Type: "httpRequest", Method: "GET", URL: "svc/api"}},
				},
			},
			{
				Name: "Test 2 — overrides connStr",
				Variables: map[string]interface{}{
					"connStr": "custom-conn",
				},
				Steps: []TestStep{
					{Action: StepAction{Type: "httpRequest", Method: "GET", URL: "svc/api"}},
				},
			},
		},
	}

	steps := executor.flattenSteps(testConfig, true)

	if len(steps) != 2 {
		t.Fatalf("Expected 2 steps, got %d", len(steps))
	}

	// Test 1 has no test-level variables — should inherit definition-level
	if steps[0].testVariables != nil {
		t.Errorf("Expected nil testVariables for test 1, got %v", steps[0].testVariables)
	}

	// Test 2 overrides connStr
	if steps[1].testVariables["connStr"] != "custom-conn" {
		t.Errorf("Expected testVariables[connStr]='custom-conn', got '%s'", steps[1].testVariables["connStr"])
	}

	// After flattenSteps, only definition-level vars are seeded — test 2's override should NOT be present
	val, err := executor.varCtx.Resolve("{{connStr}}")
	if err != nil {
		t.Fatalf("Expected connStr to be set, got error: %v", err)
	}
	if val != "default-conn" {
		t.Errorf("Expected connStr='default-conn' after flattenSteps (not polluted by test 2), got '%s'", val)
	}
}

func TestTestExecutor_RequestTimeout(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		time.Sleep(2 * time.Second)
		w.WriteHeader(http.StatusOK)
	}))
	defer server.Close()

	executor := NewTestExecutor(server.URL, 500*time.Millisecond, nil, nil)

	step := TestStep{
		Action: StepAction{Type: "httpRequest", Method: "GET", URL: "test-service/api/users", Timeout: 100},
	}

	ctx := context.Background()
	_, err := executor.executeStep(ctx, step, 0)

	if err == nil {
		t.Error("Expected timeout error, got nil")
	}
}

func TestTestExecutor_TimeoutOfActionOverDefault(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		select {
		case <-time.After(300 * time.Millisecond):
		case <-r.Context().Done():
		}
	}))
	defer server.Close()

	for _, tt := range []struct {
		name            string
		defaultTimeout  time.Duration
		actionTimeoutMs int
		wantErr         bool
	}{
		{"default long enough", 5 * time.Second, 0, false},
		{"default too short", 50 * time.Millisecond, 0, true},
		{"action longer than the default", 50 * time.Millisecond, 5000, false},
		{"action shorter than the default", 5 * time.Second, 50, true},
	} {
		executor := NewTestExecutor(server.URL, tt.defaultTimeout, nil, nil)
		action := StepAction{Type: "httpRequest", Method: "GET", URL: "service/x", Timeout: tt.actionTimeoutMs}
		if _, err := executor.doAPIRequest(context.Background(), action, server.URL+"/service/x"); (err != nil) != tt.wantErr {
			t.Errorf("%s: err %v", tt.name, err)
		}
	}
}

func TestTestExecutor_ResponseBreaksOff(t *testing.T) {
	var requests atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requests.Add(1)
		w.Header().Set("Content-Length", "1000")
		w.Write([]byte(`{"partial":`))
		w.(http.Flusher).Flush()
		if r.URL.Path == "/service/hangs" {
			<-r.Context().Done()
		}
		panic(http.ErrAbortHandler)
	}))
	defer server.Close()

	for path, cause := range map[string]string{"/crashes": "unexpected EOF", "/hangs": "context deadline exceeded"} {
		requests.Store(0)
		executor := NewTestExecutor(server.URL, 200*time.Millisecond, nil, nil)
		step := TestStep{Action: StepAction{Type: "httpRequest", Method: "POST", URL: "service" + path}}
		_, err := executor.executeStep(context.Background(), step, 0)
		want := "POST service" + path + " failed: the response broke off after status 200: " + cause
		if err == nil || err.Error() != want {
			t.Errorf("got error %v, want %q", err, want)
		}
		if requests.Load() != 1 {
			t.Errorf("%s: the request was sent %d times", path, requests.Load())
		}
	}
}

// ── Audit finding #2: test-level loop + startAtStep skipping step 0 prevents variable setup ──

func TestTestExecutor_TestVarsNotSeededWhenStartAtStepSkipsStepZero(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
		w.Write([]byte(`{}`))
	}))
	defer server.Close()

	logger := NewTestExecutionLogger(server.URL, "test-instance", 5*time.Second)
	defer logger.Stop()
	executor := NewTestExecutor(server.URL, 30*time.Second, nil, logger)

	testConfig := &TestConfig{
		TestRunID:      "test-startat-loop",
		TimeoutSeconds: 30,
		Tests: []TestDefinition{
			{
				Name: "looped test with test-level vars",
				Variables: map[string]interface{}{
					"testVar": "should-be-seeded",
				},
				ForEach: &ForEachLoop{
					Items: []interface{}{"a"},
					As:    "item",
				},
				Steps: []TestStep{
					{Action: StepAction{Type: "httpRequest", Method: "GET", URL: "svc/step0"}},
					{Action: StepAction{Type: "httpRequest", Method: "GET", URL: "svc/step1"}},
				},
			},
		},
	}

	ctx := context.Background()
	_, err := executor.ExecuteTests(ctx, testConfig, 1, -1) // skip step 0
	if err != nil {
		t.Fatalf("ExecuteTests error: %v", err)
	}

	// Test-level variables should be seeded even when startAtStep skips step 0.
	// The seeding code is inside the `if fs.stepIndex == 0` guard, so it's
	// skipped when step 0 is filtered out by startAtStep.
	val, varErr := executor.varCtx.Resolve("{{testVar}}")
	if varErr != nil {
		t.Errorf("Bug #2: test-level variable {{testVar}} not set when startAtStep skips step 0: %v", varErr)
	} else if val != "should-be-seeded" {
		t.Errorf("Bug #2: expected testVar='should-be-seeded', got '%s'", val)
	}
}

func TestTestExecutor_TestLevelLoopUsesTestVariables(t *testing.T) {
	var paths []string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		paths = append(paths, r.URL.Path)
		w.Write([]byte(`{}`))
	}))
	defer server.Close()

	executor := NewTestExecutor(server.URL, 30*time.Second, nil, nil)
	testConfig := &TestConfig{
		TestRunID: "run",
		Variables: map[string]interface{}{"defIds": []interface{}{"a", "b"}},
		Tests: []TestDefinition{
			{
				Name:    "definition variable",
				ForEach: &ForEachLoop{Items: "{{defIds}}", As: "id"},
				Steps:   []TestStep{{Action: StepAction{Type: "httpRequest", Method: "GET", URL: "svc/{{id}}"}}},
			},
			{
				Name:      "test variable",
				Variables: map[string]interface{}{"testIds": []interface{}{"c", "d"}},
				ForEach:   &ForEachLoop{Items: "{{testIds}}", As: "id"},
				Steps:     []TestStep{{Action: StepAction{Type: "httpRequest", Method: "GET", URL: "svc/{{id}}"}}},
			},
		},
	}

	if _, err := executor.ExecuteTests(context.Background(), testConfig, 0, -1); err != nil {
		t.Fatalf("ExecuteTests() error = %v", err)
	}
	if want := []string{"/svc/a", "/svc/b", "/svc/c", "/svc/d"}; !reflect.DeepEqual(paths, want) {
		t.Errorf("requested %v, want %v", paths, want)
	}
}

func TestTestExecutor_StopOnFailureFalseContinuesAndFails(t *testing.T) {
	failing := []AssertionBlock{{Assertions: []Assertion{{Path: "$.variables.missing", Operator: "exists"}}}}
	no := false
	for _, tc := range []struct {
		name     string
		test     TestDefinition
		failures int
	}{
		{"on the step", TestDefinition{Name: "t", Steps: []TestStep{
			{StopOnFailure: &no, Action: StepAction{Type: "wait", DurationMs: 1}, Assertions: failing},
			{Action: StepAction{Type: "wait", DurationMs: 1}},
		}}, 1},
		{"on the test", TestDefinition{Name: "t", StopOnFailure: &no, Steps: []TestStep{
			{Action: StepAction{Type: "wait", DurationMs: 1}, Assertions: failing},
			{Action: StepAction{Type: "wait", DurationMs: 1}},
		}}, 1},
		{"in a loop", TestDefinition{Name: "t", Steps: []TestStep{
			{StopOnFailure: &no, Repeat: &RepeatLoop{Count: 2, As: "i", Assertions: LoopAssertions{Blocks: failing}}, Action: StepAction{Type: "wait", DurationMs: 1}},
			{Action: StepAction{Type: "wait", DurationMs: 1}},
		}}, 2},
	} {
		t.Run(tc.name, func(t *testing.T) {
			executor := NewTestExecutor("http://unused", time.Second, nil, nil)
			executor.SetInlineValidation(NewStepValidator(NewStepLogBuffer(), executor.VarContext()), nil, "run")
			execs, err := executor.ExecuteTests(context.Background(), &TestConfig{TestRunID: "run", Tests: []TestDefinition{tc.test}}, 0, -1)
			if err != nil {
				t.Fatalf("ExecuteTests() error = %v, want the test to continue", err)
			}
			if len(execs) != 2 {
				t.Errorf("ran %d steps, want 2", len(execs))
			}
			if got := len(executor.ContinuedFailures()); got != tc.failures {
				t.Errorf("%d failures recorded, want %d: %v", got, tc.failures, executor.ContinuedFailures())
			}
		})
	}
}

func TestTestExecutor_WaitEndsAtTheDeadline(t *testing.T) {
	executor := NewTestExecutor("http://unused", time.Second, nil, nil)
	ctx, cancel := context.WithTimeout(context.Background(), 50*time.Millisecond)
	defer cancel()
	start := time.Now()
	_, err := executor.executeStep(ctx, TestStep{Action: StepAction{Type: "wait", DurationMs: 5000}}, 0)
	if !errors.Is(err, context.DeadlineExceeded) || time.Since(start) > time.Second {
		t.Errorf("got %v after %v, want the deadline right away", err, time.Since(start))
	}
}

func TestTestExecutor_DokkimiErrorsFailTheStep(t *testing.T) {
	for _, tc := range []struct {
		name    string
		header  bool
		wantErr bool
	}{
		{"Dokkimi couldn't deliver it", true, true},
		{"the service answered 502", false, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if tc.header {
					w.Header().Set(dokkimiErrorHeader, "true")
				}
				w.WriteHeader(http.StatusBadGateway)
				w.Write([]byte("Proxy error: no service named \"nosuch\"\n"))
			}))
			defer server.Close()
			executor := NewTestExecutor(server.URL, time.Second, nil, nil)
			resp, err := executor.executeAPIStep(context.Background(), StepAction{Type: "httpRequest", Method: "GET", URL: "nosuch/x"}, 0)
			if tc.wantErr {
				if err == nil || !strings.Contains(err.Error(), `no service named "nosuch"`) {
					t.Errorf("got %v, want the interceptor's error", err)
				}
			} else if err != nil || resp["statusCode"] != http.StatusBadGateway {
				t.Errorf("got %v %v, want the 502 as a response", resp, err)
			}
		})
	}
}

func TestQueryFailure(t *testing.T) {
	failed := map[string]interface{}{"success": false, "error": `relation "x" does not exist`}
	if err := queryFailure(StepAction{Database: "pg"}, failed); err == nil || !strings.Contains(err.Error(), `pg failed: relation "x"`) {
		t.Errorf("got %v", err)
	}
	if err := queryFailure(StepAction{}, map[string]interface{}{"success": true}); err != nil {
		t.Errorf("got %v for a query that worked", err)
	}
	for path, want := range map[string]bool{"$.response.success": true, "$.response.error": true, "$.response.data": false} {
		step := TestStep{Assertions: []AssertionBlock{{Assertions: []Assertion{{Path: path, Operator: "exists"}}}}}
		if got := assertsOnQueryOutcome(step); got != want {
			t.Errorf("assertsOnQueryOutcome(%s) = %v, want %v", path, got, want)
		}
	}
}

func TestTestExecutor_UntilFailsWhenTheLastIterationFailed(t *testing.T) {
	executor := NewTestExecutor("http://127.0.0.1:1", time.Second, nil, nil)
	step := TestStep{
		Action: StepAction{Type: "httpRequest", Method: "GET", URL: "svc/x"},
		Repeat: &RepeatLoop{Count: 2, As: "i", Until: []Assertion{{Path: "$.response.status", Operator: "eq", Value: float64(200)}}},
	}
	if _, err := executor.executeStepAt(context.Background(), flatStep{step: step}); err == nil {
		t.Error("want an error: no iteration got a response")
	}
}

func TestTestExecutor_LoopStoppedByTheDeadlineHasAnEndTime(t *testing.T) {
	executor := NewTestExecutor("http://unused", time.Second, nil, nil)
	ctx, cancel := context.WithTimeout(context.Background(), 50*time.Millisecond)
	defer cancel()
	step := TestStep{Action: StepAction{Type: "wait", DurationMs: 1}, Repeat: &RepeatLoop{Count: 2, As: "i", DelayMs: 5000}}
	exec, err := executor.executeStepAt(ctx, flatStep{step: step})
	if !errors.Is(err, context.DeadlineExceeded) || exec.EndTime == "" {
		t.Errorf("got %v with end time %q, want the deadline and an end time", err, exec.EndTime)
	}
}
