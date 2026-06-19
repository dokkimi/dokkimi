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

		// Build the iteration plan.
		type testIteration struct {
			label   string
			setupFn func()
		}
		var iterations []testIteration

		if testDef.ForEach != nil {
			items, err := resolveForEachItems(testDef.ForEach.Items, e.varCtx, nil)
			if err != nil {
				return stepExecutions, err
			}
			for i, item := range items {
				idx := i
				it := item
				label := fmt.Sprintf("[%s=%v]", testDef.ForEach.As, valueToString(it))
				iterations = append(iterations, testIteration{
					label:   label,
					setupFn: func() { setForEachVars(e.varCtx, testDef.ForEach.As, testDef.ForEach.Name, it, idx, items) },
				})
			}
		} else if testDef.For != nil {
			values := forRangeValues(testDef.For)
			for i, v := range values {
				idx := i
				val := v
				label := fmt.Sprintf("[%s=%d]", testDef.For.As, val)
				iterations = append(iterations, testIteration{
					label:   label,
					setupFn: func() { setForVars(e.varCtx, testDef.For.As, testDef.For.Name, val, idx) },
				})
			}
		} else if testDef.Repeat != nil {
			for i := 0; i < testDef.Repeat.Count; i++ {
				idx := i
				label := fmt.Sprintf("[%s=%d]", testDef.Repeat.As, idx)
				iterations = append(iterations, testIteration{
					label:   label,
					setupFn: func() { setRepeatVars(e.varCtx, testDef.Repeat.As, idx) },
				})
			}
		} else {
			iterations = []testIteration{{label: "", setupFn: func() {}}}
		}

		testLoopCompleted := true
		testIterationsRan := 0

		for iterIdx, iter := range iterations {
			if hasLoop {
				delayMs := 0
				if testDef.ForEach != nil {
					delayMs = testDef.ForEach.DelayMs
				}
				if testDef.For != nil {
					delayMs = testDef.For.DelayMs
				}
				if testDef.Repeat != nil {
					delayMs = testDef.Repeat.DelayMs
				}
				delayBetweenIterations(iterIdx, delayMs)
			}

			for _, fs := range tg.steps {
				if fs.globalIndex < startAtStep {
					continue
				}
				if stopBefore >= 0 && fs.globalIndex >= stopBefore {
					break
				}

				if fs.testIndex != lastTestIndex || hasLoop {
					if !hasLoop || iterIdx == 0 {
						lastTestIndex = fs.testIndex
					}
					if fs.stepIndex == 0 {
						e.varCtx.Reset()
						if testConfig.Variables != nil {
							for name, value := range testConfig.Variables {
								e.varCtx.Set(name, value)
							}
						}
						if fs.testVariables != nil {
							for name, value := range fs.testVariables {
								e.varCtx.Set(name, value)
							}
						}
						iter.setupFn()
					}
				}

				// Safety delay between steps
				if len(stepExecutions) > 0 {
					if fs.step.Action.Type != "wait" {
						const DEFAULT_WAIT_MS = 100
						time.Sleep(DEFAULT_WAIT_MS * time.Millisecond)
					}
				}

				fsWithLabel := fs
				fsWithLabel.loopLabel = iter.label

				stepExec, err := e.executeStepAt(ctx, fsWithLabel)
				stepExecutions = append(stepExecutions, stepExec)
				if err != nil {
					return stepExecutions, fmt.Errorf("%s failed: %w", fsWithLabel.label(), err)
				}
			}

			testIterationsRan++

			// Check repeat until condition after all steps in this iteration.
			if testDef.Repeat != nil && len(testDef.Repeat.Until) > 0 {
				untilDoc := map[string]interface{}{
					"variables": e.varCtx.Snapshot(),
				}
				if e.lastStepResponse != nil {
					untilDoc["response"] = normalizeResponseForUntil(e.lastStepResponse)
				}
				if evaluateUntil(testDef.Repeat.Until, untilDoc, e.varCtx) {
					log.Printf("Test-level repeat: until condition met after iteration %d", iterIdx)
					testLoopCompleted = true
					break
				}
				if iterIdx == len(iterations)-1 {
					testLoopCompleted = false
				}
			}
		}

		if hasLoop {
			testLoopName := ""
			if testDef.ForEach != nil {
				testLoopName = testDef.ForEach.Name
			} else if testDef.For != nil {
				testLoopName = testDef.For.Name
			} else if testDef.Repeat != nil {
				testLoopName = testDef.Repeat.Name
			}
			setLoopResult(e.varCtx, testLoopName, testLoopCompleted, testIterationsRan)
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
