package main

import (
	"context"
	"fmt"
	"log"
	"time"
)

// executeStepAt executes a single flat step, emitting STEP_STARTED/COMPLETED/FAILED logs.
// When inline validation is configured, it also waits for quiescence, validates assertions,
// and reports results after each step. Handles step-level loop modifiers.
func (e *TestExecutor) executeStepAt(ctx context.Context, fs flatStep) (StepExecution, error) {
	forEach, forLoop, repeat := getStepLoop(fs.step)
	hasLoop := forEach != nil || forLoop != nil || repeat != nil

	if !hasLoop {
		return e.executeStepOnce(ctx, fs)
	}

	si := fs.globalIndex
	label := fs.label()
	log.Printf("Executing %s (looped)", label)
	e.testExecutionLogger.LogEvent("STEP_STARTED",
		fmt.Sprintf("%s started (loop)", label), &si, nil)

	stepExec := StepExecution{
		StepIndex: si,
		StartTime: time.Now().Format(time.RFC3339Nano),
	}

	// Build iteration plan.
	type stepIteration struct {
		iterLabel string
		setupFn   func()
	}
	var iterations []stepIteration
	var delayMs int

	if forEach != nil {
		items, err := resolveForEachItems(forEach.Items, e.varCtx, nil)
		if err != nil {
			stepExec.EndTime = time.Now().Format(time.RFC3339Nano)
			return stepExec, err
		}
		delayMs = forEach.DelayMs
		for i, item := range items {
			idx := i
			it := item
			il := fmt.Sprintf("[%s=%v]", forEach.As, valueToString(it))
			iterations = append(iterations, stepIteration{
				iterLabel: il,
				setupFn:   func() { setForEachVars(e.varCtx, forEach.As, forEach.Name, it, idx, items) },
			})
		}
	} else if forLoop != nil {
		values := forRangeValues(forLoop)
		delayMs = forLoop.DelayMs
		for i, v := range values {
			idx := i
			val := v
			il := fmt.Sprintf("[%s=%d]", forLoop.As, val)
			iterations = append(iterations, stepIteration{
				iterLabel: il,
				setupFn:   func() { setForVars(e.varCtx, forLoop.As, forLoop.Name, val, idx) },
			})
		}
	} else if repeat != nil {
		delayMs = repeat.DelayMs
		for i := 0; i < repeat.Count; i++ {
			idx := i
			il := fmt.Sprintf("[%s=%d]", repeat.As, idx)
			iterations = append(iterations, stepIteration{
				iterLabel: il,
				setupFn:   func() { setRepeatVars(e.varCtx, repeat.As, idx) },
			})
		}
	}

	var lastResp map[string]interface{}
	completed := true
	iterationsRan := 0

	for iterIdx, iter := range iterations {
		delayBetweenIterations(iterIdx, delayMs)
		iter.setupFn()

		iterFS := fs
		iterFS.loopLabel = fs.loopLabel + iter.iterLabel

		log.Printf("Step loop iteration %d: %s", iterIdx, iterFS.label())

		// Track per-iteration timing so the assertion engine's time-window
		// matching can find the HTTP/DB logs for this specific iteration.
		iterStart := time.Now().Format(time.RFC3339Nano)

		// Execute the action.
		resp, err := e.executeStep(ctx, iterFS.step, si)
		iterationsRan++

		iterEnd := time.Now().Format(time.RFC3339Nano)

		if err != nil {
			stepExec.EndTime = iterEnd
			e.testExecutionLogger.LogEvent("STEP_FAILED",
				fmt.Sprintf("%s failed at iteration %d: %v", label, iterIdx, err), &si, nil)
			return stepExec, err
		}

		lastResp = resp

		iterExec := StepExecution{
			StepIndex: si,
			StartTime: iterStart,
			EndTime:   iterEnd,
		}

		// Per-iteration extraction + validation (step-level loop repeats everything).
		if e.stepValidator == nil && resp != nil && len(fs.step.Extract) > 0 {
			if extractErr := e.varCtx.Extract(fs.step.Extract, resp); extractErr != nil {
				stepExec.EndTime = iterEnd
				return stepExec, fmt.Errorf("variable extraction failed: %w", extractErr)
			}
		}

		if e.stepValidator != nil && (len(fs.step.Assertions) > 0 || len(fs.step.Extract) > 0) {
			results, passed := e.stepValidator.ValidateStepWithRetry(fs.step, iterExec, resp)
			if e.validationReporter != nil {
				e.validationReporter.ReportStepResultsAsync(e.instanceID, si, results, passed)
			}
			if !passed {
				summary := FormatStepResult(si, iterFS.label(), results, passed)
				stopOnFailure := fs.step.StopOnFailure == nil || *fs.step.StopOnFailure
				if stopOnFailure {
					e.testExecutionLogger.LogEvent("STEP_FAILED", summary, &si, nil)
					stepExec.EndTime = iterEnd
					return stepExec, fmt.Errorf("assertion validation failed: %s", summary)
				}
				e.testExecutionLogger.LogEvent("STEP_WARNING",
					fmt.Sprintf("%s (stopOnFailure=false, continuing)", summary), &si, nil)
			}
		}

		// Check repeat until.
		if repeat != nil && len(repeat.Until) > 0 && lastResp != nil {
			rootCtx := map[string]interface{}{
				"response":  normalizeResponseForUntil(lastResp),
				"variables": e.varCtx.Snapshot(),
			}
			if evaluateUntil(repeat.Until, rootCtx, e.varCtx) {
				log.Printf("Step loop: until condition met after iteration %d", iterIdx)
				completed = true
				break
			}
			if iterIdx == len(iterations)-1 {
				completed = false
			}
		}
	}

	stepExec.EndTime = time.Now().Format(time.RFC3339Nano)

	loopName := ""
	if forEach != nil {
		loopName = forEach.Name
	} else if forLoop != nil {
		loopName = forLoop.Name
	} else if repeat != nil {
		loopName = repeat.Name
	}
	setLoopResult(e.varCtx, loopName, completed, iterationsRan)

	log.Printf("%s loop completed (%d iterations, completed=%v)", label, iterationsRan, completed)
	e.testExecutionLogger.LogEvent("STEP_COMPLETED",
		fmt.Sprintf("%s loop completed (%d iterations)", label, iterationsRan), &si, nil)
	return stepExec, nil
}

// executeStepOnce executes a single flat step without loop logic.
func (e *TestExecutor) executeStepOnce(ctx context.Context, fs flatStep) (StepExecution, error) {
	si := fs.globalIndex
	label := fs.label()
	log.Printf("Executing %s", label)
	e.testExecutionLogger.LogEvent("STEP_STARTED",
		fmt.Sprintf("%s started", label), &si, nil)

	stepExec := StepExecution{
		StepIndex: si,
		StartTime: time.Now().Format(time.RFC3339Nano),
	}

	resp, err := e.executeStep(ctx, fs.step, si)
	stepExec.EndTime = time.Now().Format(time.RFC3339Nano)

	if err != nil {
		e.testExecutionLogger.LogEvent("STEP_FAILED",
			fmt.Sprintf("%s failed: %v", label, err), &si, nil)
		return stepExec, err
	}

	// Process extraction after successful execution (legacy path — used when
	// inline validation is not configured, e.g. for extract-only steps without assertions)
	if e.stepValidator == nil && resp != nil && len(fs.step.Extract) > 0 {
		if extractErr := e.varCtx.Extract(fs.step.Extract, resp); extractErr != nil {
			e.testExecutionLogger.LogEvent("STEP_FAILED",
				fmt.Sprintf("%s extraction failed: %v", label, extractErr), &si, nil)
			return stepExec, fmt.Errorf("variable extraction failed: %w", extractErr)
		}
	}

	// Inline validation: try immediately, retry if logs haven't arrived yet
	if e.stepValidator != nil && (len(fs.step.Assertions) > 0 || len(fs.step.Extract) > 0) {
		results, passed := e.stepValidator.ValidateStepWithRetry(fs.step, stepExec, resp)

		if e.validationReporter != nil {
			e.validationReporter.ReportStepResultsAsync(e.instanceID, si, results, passed)
		}

		summary := FormatStepResult(si, fs.label(), results, passed)
		if !passed {
			e.testExecutionLogger.LogEvent("STEP_FAILED", summary, &si, nil)
			return stepExec, fmt.Errorf("assertion validation failed: %s", summary)
		}
		log.Printf("%s", summary)
	}

	log.Printf("%s completed successfully", label)
	e.testExecutionLogger.LogEvent("STEP_COMPLETED",
		fmt.Sprintf("%s completed", label), &si, nil)
	return stepExec, nil
}

// executeStep executes a single test step based on its action type.
// Returns an extraction document for variable extraction.
// Handles action-level loop modifiers (loops only the action, not extract/assertions).
func (e *TestExecutor) executeStep(ctx context.Context, step TestStep, stepIndex int) (map[string]interface{}, error) {
	// Resolve variables in step name and description
	if step.Name != "" {
		resolved, err := e.varCtx.Resolve(step.Name)
		if err != nil {
			return nil, fmt.Errorf("variable resolution failed for step name: %w", err)
		}
		step.Name = resolved
	}
	if step.Description != "" {
		resolved, err := e.varCtx.Resolve(step.Description)
		if err != nil {
			return nil, fmt.Errorf("variable resolution failed for step description: %w", err)
		}
		step.Description = resolved
	}

	forEach, forLoop, repeat := getActionLoop(step.Action)
	hasActionLoop := forEach != nil || forLoop != nil || repeat != nil

	if hasActionLoop {
		resp, err := e.executeActionLoop(ctx, step, stepIndex, forEach, forLoop, repeat)
		e.lastStepResponse = resp
		return resp, err
	}

	resp, err := e.executeAction(ctx, step, stepIndex)
	e.lastStepResponse = resp
	return resp, err
}

// executeAction dispatches a single action execution (no loop).
func (e *TestExecutor) executeAction(ctx context.Context, step TestStep, stepIndex int) (map[string]interface{}, error) {
	resolvedAction, err := e.varCtx.ResolveAction(step.Action)
	if err != nil {
		return nil, fmt.Errorf("variable resolution failed: %w", err)
	}

	switch resolvedAction.Type {
	case "httpRequest":
		return e.executeAPIStep(ctx, resolvedAction, stepIndex)
	case "dbQuery":
		return e.executeDbQueryStep(ctx, resolvedAction, stepIndex)
	case "wait":
		log.Printf("Executing wait action: %d ms", resolvedAction.DurationMs)
		e.testExecutionLogger.LogEvent("WAIT_STARTED", fmt.Sprintf("Waiting %d ms", resolvedAction.DurationMs), &stepIndex, nil)
		time.Sleep(time.Duration(resolvedAction.DurationMs) * time.Millisecond)
		e.testExecutionLogger.LogEvent("WAIT_COMPLETED", fmt.Sprintf("Wait completed (%d ms)", resolvedAction.DurationMs), &stepIndex, nil)
		return nil, nil
	case "ui":
		if e.uiStepExecutor == nil {
			return nil, fmt.Errorf(
				"ui action encountered but UI executor is not configured (BROWSER_URL may be unset)",
			)
		}
		return e.uiStepExecutor.Execute(ctx, step.Action, step.Name, stepIndex)
	case "parallel":
		return e.executeParallelAction(ctx, resolvedAction, step, stepIndex)
	default:
		return nil, fmt.Errorf("unsupported action type: %s", resolvedAction.Type)
	}
}

// executeActionLoop runs the action portion of a step in a loop.
// Extract + assertions run once after all iterations against the last response.
func (e *TestExecutor) executeActionLoop(ctx context.Context, step TestStep, stepIndex int,
	forEach *ForEachLoop, forLoop *ForLoop, repeat *RepeatLoop) (map[string]interface{}, error) {

	type actionIteration struct {
		label   string
		setupFn func()
	}
	var iterations []actionIteration
	var delayMs int

	if forEach != nil {
		items, err := resolveForEachItems(forEach.Items, e.varCtx, nil)
		if err != nil {
			return nil, err
		}
		delayMs = forEach.DelayMs
		for i, item := range items {
			idx := i
			it := item
			il := fmt.Sprintf("[%s=%v]", forEach.As, valueToString(it))
			iterations = append(iterations, actionIteration{
				label:   il,
				setupFn: func() { setForEachVars(e.varCtx, forEach.As, forEach.Name, it, idx, items) },
			})
		}
	} else if forLoop != nil {
		values := forRangeValues(forLoop)
		delayMs = forLoop.DelayMs
		for i, v := range values {
			idx := i
			val := v
			il := fmt.Sprintf("[%s=%d]", forLoop.As, val)
			iterations = append(iterations, actionIteration{
				label:   il,
				setupFn: func() { setForVars(e.varCtx, forLoop.As, forLoop.Name, val, idx) },
			})
		}
	} else if repeat != nil {
		delayMs = repeat.DelayMs
		for i := 0; i < repeat.Count; i++ {
			idx := i
			il := fmt.Sprintf("[%s=%d]", repeat.As, idx)
			iterations = append(iterations, actionIteration{
				label:   il,
				setupFn: func() { setRepeatVars(e.varCtx, repeat.As, idx) },
			})
		}
	}

	var lastResp map[string]interface{}
	completed := true
	iterationsRan := 0

	for iterIdx, iter := range iterations {
		delayBetweenIterations(iterIdx, delayMs)
		iter.setupFn()

		log.Printf("Action loop iteration %d %s", iterIdx, iter.label)

		resp, err := e.executeAction(ctx, step, stepIndex)
		if err != nil {
			return nil, err
		}
		lastResp = resp
		iterationsRan++

		// Check repeat until after each action iteration.
		if repeat != nil && len(repeat.Until) > 0 && lastResp != nil {
			rootCtx := map[string]interface{}{
				"response":  normalizeResponseForUntil(lastResp),
				"variables": e.varCtx.Snapshot(),
			}
			if evaluateUntil(repeat.Until, rootCtx, e.varCtx) {
				log.Printf("Action loop: until condition met after iteration %d", iterIdx)
				completed = true
				break
			}
			if iterIdx == len(iterations)-1 {
				completed = false
			}
		}
	}

	loopName := ""
	if forEach != nil {
		loopName = forEach.Name
	} else if forLoop != nil {
		loopName = forLoop.Name
	} else if repeat != nil {
		loopName = repeat.Name
	}
	setLoopResult(e.varCtx, loopName, completed, iterationsRan)

	return lastResp, nil
}

// executeParallelAction runs all sub-actions concurrently and collects results.
func (e *TestExecutor) executeParallelAction(ctx context.Context, action StepAction, step TestStep, stepIndex int) (map[string]interface{}, error) {
	if len(action.Actions) == 0 {
		return nil, nil
	}

	log.Printf("Executing parallel action with %d sub-actions", len(action.Actions))

	type result struct {
		subIndex   int
		err        error
		duration   int
		extractDoc map[string]interface{}
	}

	results := make(chan result, len(action.Actions))

	for idx, subAction := range action.Actions {
		go func(subIdx int, sa StepAction) {
			startTime := time.Now()
			var resp map[string]interface{}
			var err error

			switch sa.Type {
			case "httpRequest":
				resp, err = e.executeAPIStep(ctx, sa, stepIndex)
			case "dbQuery":
				resp, err = e.executeDbQueryStep(ctx, sa, stepIndex)
			default:
				err = fmt.Errorf("unsupported action type in parallel block: %s", sa.Type)
			}

			duration := int(time.Since(startTime).Milliseconds())
			results <- result{
				subIndex:   subIdx,
				err:        err,
				duration:   duration,
				extractDoc: resp,
			}
		}(idx, subAction)
	}

	var firstError error
	allResults := make([]result, 0, len(action.Actions))
	for i := 0; i < len(action.Actions); i++ {
		res := <-results
		allResults = append(allResults, res)

		sa := action.Actions[res.subIndex]
		stepLabel := fmt.Sprintf("%s %s", sa.Method, sa.URL)
		if sa.Type == "dbQuery" {
			stepLabel = fmt.Sprintf("dbQuery %s", sa.Database)
		}
		if res.err != nil {
			if firstError == nil {
				firstError = res.err
			}
			log.Printf("Parallel sub-action %d (%s) failed: %v", res.subIndex, stepLabel, res.err)
			e.testExecutionLogger.LogRequestCompleted(stepIndex, res.subIndex, res.duration, res.err)
		} else {
			log.Printf("Parallel sub-action %d (%s) completed successfully", res.subIndex, stepLabel)
			e.testExecutionLogger.LogRequestCompleted(stepIndex, res.subIndex, res.duration, nil)
		}
	}

	return nil, firstError
}
