package main

import (
	"context"
	"fmt"
	"log"
	"time"
)

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

	// Group steps by test index so we can iterate test-level loops.
	type testGroup struct {
		testIndex int
		testDef   TestDefinition
		steps     []flatStep
	}
	var groups []testGroup
	for _, fs := range steps {
		if len(groups) == 0 || groups[len(groups)-1].testIndex != fs.testIndex {
			groups = append(groups, testGroup{
				testIndex: fs.testIndex,
				testDef:   testConfig.Tests[fs.testIndex],
				steps:     nil,
			})
		}
		groups[len(groups)-1].steps = append(groups[len(groups)-1].steps, fs)
	}

	for _, tg := range groups {
		testDef := tg.testDef
		hasLoop := testDef.ForEach != nil || testDef.For != nil || testDef.Repeat != nil

		plan, err := buildIterationPlan(testDef.ForEach, testDef.For, testDef.Repeat, e.varCtx)
		if err != nil {
			return stepExecutions, err
		}

		if !hasLoop {
			plan.Iterations = []Iteration{{Label: "", SetupFn: func() {}}}
		}

		_, loopErr := runLoop(plan, e.varCtx, func(iterIdx int, iter Iteration) (map[string]interface{}, error) {
			if tg.testIndex != lastTestIndex || hasLoop {
				if !hasLoop || iterIdx == 0 {
					lastTestIndex = tg.testIndex
				}
				e.varCtx.Reset()
				if testConfig.Variables != nil {
					for name, value := range testConfig.Variables {
						e.varCtx.Set(name, value)
					}
				}
				if len(tg.steps) > 0 {
					if vars := tg.steps[0].testVariables; vars != nil {
						for name, value := range vars {
							e.varCtx.Set(name, value)
						}
					}
				}
				iter.SetupFn()
			}

			for i, fs := range tg.steps {
				if fs.globalIndex < startAtStep {
					continue
				}
				if stopBefore >= 0 && fs.globalIndex >= stopBefore {
					break
				}

				if len(stepExecutions) > 0 {
					if fs.step.Action.Type != "wait" {
						const DEFAULT_WAIT_MS = 100
						time.Sleep(DEFAULT_WAIT_MS * time.Millisecond)
					}
				}

				fsWithLabel := fs
				fsWithLabel.loopLabel = iter.Label
				if i+1 < len(tg.steps) && tg.steps[i+1].step.Action.Type == "wait" {
					fsWithLabel.nextIsWait = true
				}

				stepExec, err := e.executeStepAt(ctx, fsWithLabel)
				stepExecutions = append(stepExecutions, stepExec)
				if err != nil {
					return nil, fmt.Errorf("%s failed: %w", fsWithLabel.label(), err)
				}
			}

			return e.lastStepResponse, nil
		})

		if loopErr != nil {
			return stepExecutions, loopErr
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
