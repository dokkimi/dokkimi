package main

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"os/signal"
	"strings"
	"sync"
	"syscall"
	"time"
)

// Version is set at build time via -ldflags "-X main.Version=..."
var Version = "dev"

func main() {
	log.SetFlags(log.LstdFlags | log.Lshortfile)
	log.Printf("Starting test-agent version=%s", Version)

	// Load configuration
	cfg, err := LoadConfig()
	if err != nil {
		log.Fatalf("Failed to load configuration: %v", err)
	}

	// Create a root context that cancels on SIGTERM/SIGINT so in-flight
	// test execution stops promptly when the container is torn down.
	ctx, rootCancel := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)

	// Read config from file
	if cfg.ConfigFilePath == "" {
		log.Fatalf("CONFIG_FILE_PATH is required")
	}
	log.Printf("Config source: file (%s)", cfg.ConfigFilePath)
	fileReader := NewFileConfigReader(cfg.ConfigFilePath)
	configMapData, readErr := fileReader.ReadConfigData()
	if readErr != nil {
		log.Fatalf("Failed to read config file: %v", readErr)
	}

	if configMapData.TestConfig == nil {
		log.Fatalf("testConfig not found in ConfigMap")
	}

	testConfig := configMapData.TestConfig
	instanceId := testConfig.TestRunID

	// Create test execution logger
	testExecutionLogger := NewTestExecutionLogger(cfg.ControlTowerURL, instanceId, 30*time.Second)
	defer testExecutionLogger.Stop()

	// Build item ID → name reverse lookup from urlMap and databaseMap
	itemIdToName := buildItemIdToNameMap(configMapData)

	// Log STARTED event
	testExecutionLogger.LogEvent("STARTED", "Preparing test environment...", nil, nil)

	// Create health tracker (pass logger for health event logging)
	healthTracker := NewHealthTracker(configMapData.ExpectedNamespaceItemIds, testExecutionLogger, itemIdToName)
	log.Printf("Tracking health for %d expected items", len(configMapData.ExpectedNamespaceItemIds))
	testExecutionLogger.LogEvent("HEALTH_WAIT_STARTED", "Waiting for services to be ready...", nil, nil)

	// Create database query executor
	var databaseQueryExecutor *DatabaseQueryExecutor
	if len(configMapData.DatabaseMap) > 0 {
		databaseQueryExecutor = NewDatabaseQueryExecutor(cfg.ControlTowerURL, configMapData.DatabaseMap, instanceId)
		defer databaseQueryExecutor.Close()
		log.Printf("Created database query executor with %d databases", len(configMapData.DatabaseMap))
	} else {
		log.Printf("No databaseMap found in ConfigMap, database queries will not be available")
	}

	// Create test executor (pass logger for test execution logging)
	testExecutor := NewTestExecutor(cfg.InterceptorURL, cfg.RequestTimeout, databaseQueryExecutor, testExecutionLogger)

	// Attach UI step executor when the browser sidecar is configured. API/DB-only
	// runs don't need this; if a UI step arrives and the executor is unset, the
	// test-agent fails that step loudly with a clear message.
	if cfg.BrowserURL != "" {
		artifactUploader := NewArtifactUploader(cfg.ControlTowerURL, instanceId, cfg.RequestTimeout)
		uiExecutor := NewUIStepExecutor(
			cfg.BrowserURL,
			cfg.DefaultViewportWidth, cfg.DefaultViewportHeight,
			configMapData.URLMap,
			testExecutor.VarContext(),
			testExecutionLogger,
			artifactUploader,
		)
		testExecutor.SetUIStepExecutor(uiExecutor)
		log.Printf("UI step executor configured (browser at %s)", cfg.BrowserURL)
	}

	// Create test-completion notifier (pass logger for notification logging).
	// After the service consolidation, the /test-complete endpoint lives on
	// Control Tower alongside everything else.
	completionNotifier := NewCompletionNotifier(cfg.ControlTowerURL+"/test-complete", testExecutionLogger)

	// Mutex to prevent concurrent executions
	var executionMu sync.Mutex
	executing := false

	// runExecution performs health check (only on first-time calls), loads latest config,
	// dispatches the correct execution mode, and notifies Control Tower.
	// healthChecked tracks whether we've already waited for services (skipped on re-runs).
	healthChecked := false

	runExecution := func(req ExecuteRequest) {
		timeout := time.Duration(testConfig.TimeoutSeconds) * time.Second

		// partial=true for debug step commands (only a subset of steps run)
		isPartial := req.Mode == "run-step" ||
			(req.Mode == "all" && (req.StartAtStep != nil || req.StopBefore != nil))

		if !healthChecked {
			{
				allReady := false
				failureMessage := ""
				select {
				case <-healthTracker.allReadyChan:
					allReady = true
				case <-time.After(timeout):
					notReady := healthTracker.NotReadyNames()
					if len(notReady) > 0 {
						failureMessage = fmt.Sprintf("Startup timeout: %s not ready after %ds", strings.Join(notReady, ", "), testConfig.TimeoutSeconds)
					} else {
						failureMessage = fmt.Sprintf("Startup timeout after %ds", testConfig.TimeoutSeconds)
					}
				}

				if !allReady {
					log.Printf("%s, aborting test execution", failureMessage)
					testExecutionLogger.LogEvent("HEALTH_TIMEOUT", failureMessage, nil, nil)
					notificationErr := completionNotifier.NotifyCompletion(
						req.TestRunID,
						"failure",
						failureMessage,
						nil,
						false,
					)
					if notificationErr != nil {
						log.Printf("Failed to notify Control Tower: %v", notificationErr)
					}
					return
				}

				log.Printf("All items reported ready")
			}
			healthChecked = true
		}

		// Re-read config before execution
		var latestConfigMapData *ConfigMapData
		{
			fileReader := NewFileConfigReader(cfg.ConfigFilePath)
			readData, readErr := fileReader.ReadConfigData()
			if readErr != nil {
				log.Printf("Warning: failed to re-read config file before execution: %v, using cached config", readErr)
				latestConfigMapData = configMapData
			} else {
				latestConfigMapData = readData
			}
		}
		if latestConfigMapData.TestConfig == nil {
			log.Printf("Warning: testConfig missing from re-read config, using cached config")
			latestConfigMapData = configMapData
		}

		// Use the testRunId from the execute request (scopes this run's logs)
		runConfig := &TestConfig{
			TestRunID:      req.TestRunID,
			TimeoutSeconds: latestConfigMapData.TestConfig.TimeoutSeconds,
			ExecutionMode:  latestConfigMapData.TestConfig.ExecutionMode,
			Tests:          latestConfigMapData.TestConfig.Tests,
			Variables:      latestConfigMapData.TestConfig.Variables,
		}

		execTimeout := time.Duration(runConfig.TimeoutSeconds) * time.Second
		testCtx, cancel := context.WithTimeout(ctx, execTimeout)
		defer cancel()

		var stepExecutions []StepExecution
		var execErr error

		switch req.Mode {
		case "run-step":
			if req.StepIndex == nil {
				log.Printf("run-step mode requires stepIndex")
				completionNotifier.NotifyCompletion(req.TestRunID, "failure", "run-step mode requires stepIndex", nil, true)
				return
			}
			log.Printf("Debug: executing step %d", *req.StepIndex)
			stepExecutions, execErr = testExecutor.ExecuteStep(testCtx, runConfig, *req.StepIndex)

		default: // "all"
			startAt := 0
			if req.StartAtStep != nil {
				startAt = *req.StartAtStep
			}
			stopBefore := -1
			if req.StopBefore != nil {
				stopBefore = *req.StopBefore
			}
			log.Printf("Executing all steps startAt=%d stopBefore=%d", startAt, stopBefore)
			stepExecutions, execErr = testExecutor.ExecuteTests(testCtx, runConfig, startAt, stopBefore)
		}

		if execErr != nil {
			log.Printf("Test execution failed: %v", execErr)
			notificationErr := completionNotifier.NotifyCompletion(
				req.TestRunID,
				"failure",
				fmt.Sprintf("Test execution failed: %v", execErr),
				stepExecutions,
				isPartial,
			)
			if notificationErr != nil {
				log.Printf("Failed to notify Control Tower: %v", notificationErr)
			}
			return
		}

		log.Printf("Execution complete, notifying Control Tower...")
		if notifyErr := completionNotifier.NotifyCompletion(req.TestRunID, "success", "", stepExecutions, isPartial); notifyErr != nil {
			log.Printf("Failed to notify Control Tower: %v", notifyErr)
		}
	}

	// Set up HTTP server
	mux := http.NewServeMux()

	mux.HandleFunc("/health/status", func(w http.ResponseWriter, r *http.Request) {
		handleHealthStatus(w, r, healthTracker)
	})

	mux.HandleFunc("/health", func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
		w.Write([]byte(`{"status":"healthy"}`))
	})

	// POST /execute — trigger test execution on demand (used in manual executionMode
	// and for re-runs in run-tests-keep-alive mode)
	mux.HandleFunc("/execute", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
			return
		}

		var req ExecuteRequest
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			http.Error(w, fmt.Sprintf("Failed to decode request: %v", err), http.StatusBadRequest)
			return
		}

		if req.TestRunID == "" {
			http.Error(w, "testRunId is required", http.StatusBadRequest)
			return
		}

		validModes := map[string]bool{"all": true, "run-step": true}
		if req.Mode != "" && !validModes[req.Mode] {
			http.Error(w, fmt.Sprintf("invalid mode: %q", req.Mode), http.StatusBadRequest)
			return
		}

		executionMu.Lock()
		if executing {
			executionMu.Unlock()
			http.Error(w, `{"error":"already executing"}`, http.StatusConflict)
			return
		}
		executing = true
		executionMu.Unlock()

		// Accept immediately, run async
		w.WriteHeader(http.StatusAccepted)
		w.Write([]byte(`{"status":"accepted"}`))

		go func() {
			defer func() {
				executionMu.Lock()
				executing = false
				executionMu.Unlock()
			}()
			runExecution(req)
		}()
	})

	server := &http.Server{
		Addr:    ":" + cfg.Port,
		Handler: mux,
	}

	// Start HTTP server
	go func() {
		log.Printf("Starting HTTP server on port %s", cfg.Port)
		if err := server.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			log.Fatalf("HTTP server error: %v", err)
		}
	}()

	// Auto mode: run tests immediately after server starts (preserves existing behavior
	// for run-tests and run-tests-keep-alive modes)
	executionMode := testConfig.ExecutionMode
	if executionMode == "" {
		executionMode = "auto"
	}

	if executionMode == "auto" {
		go func() {
			executionMu.Lock()
			executing = true
			executionMu.Unlock()

			defer func() {
				executionMu.Lock()
				executing = false
				executionMu.Unlock()
			}()

			runExecution(ExecuteRequest{TestRunID: testConfig.TestRunID, Mode: "all"})
			log.Printf("Test execution complete. Test-agent continuing to run for /execute commands.")
		}()
	} else {
		log.Printf("executionMode=manual: test-agent waiting for POST /execute commands")
	}

	// Wait for shutdown signal (ctx is cancelled by SIGINT/SIGTERM via signal.NotifyContext)
	<-ctx.Done()
	rootCancel()

	log.Printf("Shutting down...")
	shutdownCtx, shutdownCancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer shutdownCancel()

	if err := server.Shutdown(shutdownCtx); err != nil {
		log.Printf("Error shutting down server: %v", err)
	}

	log.Printf("Test-agent stopped")
}

// buildItemIdToNameMap builds a reverse lookup from instance item ID to human-readable name
func buildItemIdToNameMap(configMapData *ConfigMapData) map[string]string {
	m := make(map[string]string)
	for serviceName, entry := range configMapData.URLMap {
		if entry.InstanceItemID != "" {
			name := entry.Name
			if name == "" {
				name = serviceName
			}
			m[entry.InstanceItemID] = name
		}
	}
	for dbName, entry := range configMapData.DatabaseMap {
		if entry.InstanceItemID != "" {
			m[entry.InstanceItemID] = dbName
		}
	}
	return m
}

// handleHealthStatus handles health status updates from interceptors/sidecars
func handleHealthStatus(w http.ResponseWriter, r *http.Request, healthTracker *HealthTracker) {
	if r.Method != http.MethodPost {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	var update HealthStatusUpdate
	if err := json.NewDecoder(r.Body).Decode(&update); err != nil {
		http.Error(w, fmt.Sprintf("Failed to decode request: %v", err), http.StatusBadRequest)
		return
	}

	itemId := update.InstanceItemID
	if itemId == "" {
		itemId = update.InstanceItemName
	}
	healthTracker.UpdateHealth(itemId, update.Ready)

	w.WriteHeader(http.StatusOK)
	w.Write([]byte(`{"status":"ok"}`))
}
