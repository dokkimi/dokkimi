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
	forEach := fs.step.ForEach
	forLoop := fs.step.For
	repeat := fs.step.Repeat
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

	plan, err := buildIterationPlan(forEach, forLoop, repeat, e.varCtx)
	if err != nil {
		stepExec.EndTime = time.Now().Format(time.RFC3339Nano)
		return stepExec, err
	}

	// Extract the loop body's action, assertions, and extract (nested inside the loop struct)
	var loopAction *StepAction
	var loopAssertions []AssertionBlock
	var loopExtract map[string]ExtractRule
	if forEach != nil {
		loopAction = forEach.Action
		loopAssertions, loopExtract = stepLoopBody(forEach.Assertions, forEach.Match, forEach.Extract,
			forEach.ForEach, forEach.For, forEach.Repeat)
	} else if forLoop != nil {
		loopAction = forLoop.Action
		loopAssertions, loopExtract = stepLoopBody(forLoop.Assertions, forLoop.Match, forLoop.Extract,
			forLoop.ForEach, forLoop.For, forLoop.Repeat)
	} else if repeat != nil {
		loopAction = repeat.Action
		loopAssertions, loopExtract = stepLoopBody(repeat.Assertions, repeat.Match, repeat.Extract,
			repeat.ForEach, repeat.For, repeat.Repeat)
	}

	result, loopErr := runLoop(plan, e.varCtx, func(iterIdx int, iter Iteration) (map[string]interface{}, error) {
		iter.SetupFn()
		iterFS := fs
		iterFS.loopLabel = fs.loopLabel + iter.Label

		log.Printf("Step loop iteration %d: %s", iterIdx, iterFS.label())

		// Build a step using the loop body's action
		iterStep := iterFS.step
		if loopAction != nil {
			iterStep.Action = *loopAction
		}
		iterStep.Assertions = loopAssertions
		iterStep.Extract = loopExtract

		iterStart := time.Now().Format(time.RFC3339Nano)
		resp, err := e.executeStep(ctx, iterStep, si)
		iterEnd := time.Now().Format(time.RFC3339Nano)

		if err != nil {
			hasUntil := repeat != nil && len(repeat.Until) > 0
			stopOnFailure := iterStep.StopOnFailure == nil || *iterStep.StopOnFailure
			if !stopOnFailure || hasUntil {
				e.testExecutionLogger.LogEvent("STEP_WARNING",
					fmt.Sprintf("%s failed at iteration %d (continuing): %v", label, iterIdx, err), &si, nil)
				return nil, nil
			}
			stepExec.EndTime = iterEnd
			e.testExecutionLogger.LogEvent("STEP_FAILED",
				fmt.Sprintf("%s failed at iteration %d: %v", label, iterIdx, err), &si, nil)
			return nil, err
		}

		iterExec := StepExecution{
			StepIndex: si,
			StartTime: iterStart,
			EndTime:   iterEnd,
		}

		if e.stepValidator == nil && resp != nil && len(iterStep.Extract) > 0 {
			if extractErr := e.varCtx.Extract(iterStep.Extract, resp); extractErr != nil {
				stepExec.EndTime = iterEnd
				return nil, fmt.Errorf("variable extraction failed: %w", extractErr)
			}
		}

		if e.stepValidator != nil {
			e.stepValidator.RecordStepTime(iterStep, iterExec)
		}

		if e.stepValidator != nil && (len(iterStep.Assertions) > 0 || len(iterStep.Extract) > 0) {
			results, passed := e.stepValidator.ValidateStepWithRetry(iterStep, iterExec, resp, false)
			if e.validationReporter != nil {
				e.validationReporter.ReportStepResultsAsync(e.instanceID, si, results, passed)
			}
			if !passed {
				summary := FormatStepResult(si, iterFS.label(), results, passed)
				stopOnFailure := iterStep.StopOnFailure == nil || *iterStep.StopOnFailure
				if stopOnFailure {
					e.testExecutionLogger.LogEvent("STEP_FAILED", summary, &si, nil)
					stepExec.EndTime = iterEnd
					return nil, fmt.Errorf("assertion validation failed: %s", summary)
				}
				e.testExecutionLogger.LogEvent("STEP_WARNING",
					fmt.Sprintf("%s (stopOnFailure=false, continuing)", summary), &si, nil)
			}
		}

		return resp, nil
	})

	if loopErr != nil {
		return stepExec, loopErr
	}

	stepExec.EndTime = time.Now().Format(time.RFC3339Nano)
	log.Printf("%s loop completed (%d iterations, completed=%v)", label, result.IterationsRan, result.Completed)
	e.testExecutionLogger.LogEvent("STEP_COMPLETED",
		fmt.Sprintf("%s loop completed (%d iterations)", label, result.IterationsRan), &si, nil)
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

	if e.stepValidator != nil {
		e.stepValidator.RecordStepTime(fs.step, stepExec)
	}

	// Inline validation: try immediately, retry if logs haven't arrived yet
	if e.stepValidator != nil && (len(fs.step.Assertions) > 0 || len(fs.step.Extract) > 0) {
		results, passed := e.stepValidator.ValidateStepWithRetry(fs.step, stepExec, resp, fs.nextIsWait)

		if e.validationReporter != nil {
			e.validationReporter.ReportStepResultsAsync(e.instanceID, si, results, passed)
		}

		summary := FormatStepResult(si, fs.label(), results, passed)
		if !passed {
			stopOnFailure := fs.step.StopOnFailure == nil || *fs.step.StopOnFailure
			if stopOnFailure {
				e.testExecutionLogger.LogEvent("STEP_FAILED", summary, &si, nil)
				return stepExec, fmt.Errorf("assertion validation failed: %s", summary)
			}
			e.testExecutionLogger.LogEvent("STEP_WARNING",
				fmt.Sprintf("%s (stopOnFailure=false, continuing)", summary), &si, nil)
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

	hasActionLoop := step.Action.ForEach != nil || step.Action.For != nil || step.Action.Repeat != nil

	if hasActionLoop {
		resp, err := e.executeActionLoop(ctx, step, stepIndex,
			step.Action.ForEach, step.Action.For, step.Action.Repeat)
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

	plan, err := buildIterationPlan(forEach, forLoop, repeat, e.varCtx)
	if err != nil {
		return nil, err
	}

	var lastResp map[string]interface{}
	_, loopErr := runLoop(plan, e.varCtx, func(iterIdx int, iter Iteration) (map[string]interface{}, error) {
		iter.SetupFn()
		log.Printf("Action loop iteration %d %s", iterIdx, iter.Label)
		resp, err := e.executeAction(ctx, step, stepIndex)
		if err != nil {
			return nil, err
		}
		lastResp = resp
		return resp, nil
	})

	return lastResp, loopErr
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

// stepLoopBody extracts assertion blocks from a step-level loop body.
// When the loop has assertion blocks (Blocks), they are used directly with extract at step level.
// When the loop has flat assertions, a single AssertionBlock is built from all body fields
// so match/assertions/extract/nested-loops execute in the correct order via validateBlock.
func stepLoopBody(la LoopAssertions, match *MatchCriteria, extract map[string]ExtractRule,
	forEach *ForEachLoop, forLoop *ForLoop, repeat *RepeatLoop) ([]AssertionBlock, map[string]ExtractRule) {
	if len(la.Blocks) > 0 {
		return la.Blocks, extract
	}
	body := AssertionBlock{
		Match:      match,
		Assertions: la.Flat,
		Extract:    extract,
		ForEach:    forEach,
		For:        forLoop,
		Repeat:     repeat,
	}
	hasContent := len(body.Assertions) > 0 || body.Match != nil || body.Extract != nil ||
		body.ForEach != nil || body.For != nil || body.Repeat != nil
	if hasContent {
		return []AssertionBlock{body}, nil
	}
	return nil, extract
}
