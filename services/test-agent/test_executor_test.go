package main

import (
	"context"
	"net/http"
	"net/http/httptest"
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
