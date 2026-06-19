package main

import (
	"context"
	"fmt"
	"log"
	"strings"
	"time"
)

// defaultUISubStepTimeout caps how long a single UI sub-step (visit, click,
// type, waitFor, screenshot) may run before the browser context is cancelled.
// Without this, a `waitFor` whose target never appears hangs indefinitely up
// to the test-level timeoutSeconds (240s+ in practice), making real bugs hard
// to spot. 30s is well above any healthy interaction time and short enough to
// surface a stuck UI quickly. Individual sub-steps can override this via
// `timeoutMs` in the YAML — see resolveSubStepTimeout below.
const defaultUISubStepTimeout = 30 * time.Second

// resolveSubStepTimeout returns the effective timeout for a sub-step: the
// per-sub-step `timeoutMs` override when set, otherwise the default.
func resolveSubStepTimeout(sub UISubStep) time.Duration {
	if sub.TimeoutMs > 0 {
		return time.Duration(sub.TimeoutMs) * time.Millisecond
	}
	return defaultUISubStepTimeout
}

// UIDriver is the browser-facing surface the UI step executor depends on.
// BrowserClient satisfies this in production; tests inject fakes.
type UIDriver interface {
	BrowserReader

	Navigate(url string, timeout time.Duration) error
	Click(sel string, timeout time.Duration) error
	Type(sel, text string, timeout time.Duration) error
	WaitVisible(sel string, timeout time.Duration) error
	WaitForText(sel, want string, timeout time.Duration) error
	Screenshot(quality int, timeout time.Duration) ([]byte, error)
	SelectorScreenshot(sel string, timeout time.Duration) ([]byte, error)
	ElementBounds(sel string, timeout time.Duration) (x, y, w, h float64, err error)
	PageHTML(timeout time.Duration) (string, error)
	ScrollIntoView(sel string, timeout time.Duration) error
	ScrollWindow(x, y int, timeout time.Duration) error
	SelectOption(sel, value string, timeout time.Duration) error
	Hover(sel string, timeout time.Duration) error
	KeyPress(sel, key string, timeout time.Duration) error
	Upload(sel string, files []string, timeout time.Duration) error
	Drag(fromSel, toSel string, timeout time.Duration) error
	SetViewport(width, height int) error

	Close()
}

// UIDriverFactory produces a driver for a single UI action. test-agent creates
// one driver per UI action so each action starts with a clean browser tab;
// the driver is closed at the end of the action.
type UIDriverFactory func(ctx context.Context) (UIDriver, error)

// defaultBrowserFactory constructs a real BrowserClient against the sidecar.
// Fails fast if browserURL is unset — a caller-friendly error surfaces up to
// the test runner.
func defaultBrowserFactory(browserURL string, viewportWidth, viewportHeight int) UIDriverFactory {
	return func(ctx context.Context) (UIDriver, error) {
		if browserURL == "" {
			return nil, fmt.Errorf(
				"ui step requires BROWSER_URL (no chromium sidecar configured)",
			)
		}
		return NewBrowserClient(ctx, browserURL, viewportWidth, viewportHeight)
	}
}

// UIStepExecutor runs a single UIAction: target resolution, sub-step dispatch,
// per-sub-step variable interpolation, and in-process variable extraction.
// The browser session is created lazily on the first Execute call and reused
// across all subsequent calls so that cookies, localStorage, and page state
// persist across step groups within a test run.
type UIStepExecutor struct {
	factory        UIDriverFactory
	cachedDrv      UIDriver
	urlMap         map[string]URLMapEntry
	varCtx         *VariableContext
	logger         *TestExecutionLogger
	uploader       *ArtifactUploader // nil = no artifact pipeline (tests / non-CT runs); screenshot/failure capture log instead
	matcher        *VisualMatcher    // nil = no baselines available; screenshot captures upload without verdict
	visualFailures []string          // collected visual match failure messages
}

// NewUIStepExecutor constructs an executor against the default chromedp-backed
// BrowserClient.
func NewUIStepExecutor(
	browserURL string,
	viewportWidth, viewportHeight int,
	urlMap map[string]URLMapEntry,
	varCtx *VariableContext,
	logger *TestExecutionLogger,
	uploader *ArtifactUploader,
	matcher *VisualMatcher,
) *UIStepExecutor {
	return &UIStepExecutor{
		factory:  defaultBrowserFactory(browserURL, viewportWidth, viewportHeight),
		urlMap:   urlMap,
		varCtx:   varCtx,
		logger:   logger,
		uploader: uploader,
		matcher:  matcher,
	}
}

// WithDriverFactory overrides the driver factory. Used by tests to inject a
// fake driver without spinning up chromium.
func (e *UIStepExecutor) WithDriverFactory(f UIDriverFactory) *UIStepExecutor {
	e.factory = f
	return e
}

// VisualFailures returns collected visual match failure messages (verdict
// "fail" or "no-baseline"). Empty when all visual matches passed or no
// visual matching was configured.
func (e *UIStepExecutor) VisualFailures() []string {
	return e.visualFailures
}

// Close tears down the shared browser session. Must be called when the test
// run is complete.
func (e *UIStepExecutor) Close() {
	if e.cachedDrv != nil {
		e.cachedDrv.Close()
		e.cachedDrv = nil
	}
}

// getDriver returns the shared browser driver, creating it lazily on first call.
func (e *UIStepExecutor) getDriver(ctx context.Context) (UIDriver, error) {
	if e.cachedDrv != nil {
		return e.cachedDrv, nil
	}
	drv, err := e.factory(ctx)
	if err != nil {
		return nil, err
	}
	e.cachedDrv = drv
	return drv, nil
}

// Execute runs one UI action. Returns a summary extraction document shaped as
//
//	{ "target": "...", "baseURL": "...", "extracted": { varName: value, ... } }
//
// Extracted variables are also written directly to varCtx so downstream steps
// can reference them as `{{varName}}`.
func (e *UIStepExecutor) Execute(
	ctx context.Context,
	action StepAction,
	stepName string,
	stepIndex int,
) (map[string]interface{}, error) {
	target, err := e.varCtx.Resolve(action.Target)
	if err != nil {
		return nil, fmt.Errorf("ui target: %w", err)
	}
	baseURL, err := e.resolveTargetURL(target)
	if err != nil {
		return nil, err
	}

	driver, err := e.getDriver(ctx)
	if err != nil {
		return nil, fmt.Errorf("ui browser: %w", err)
	}

	extractor := NewUIExtractor(driver, 0)
	extracted := map[string]interface{}{}

	for i, sub := range action.Steps {
		if sub.IsGroup {
			if err := e.runSubStepGroup(ctx, driver, extractor, sub, baseURL, extracted, stepIndex, i, stepName, target); err != nil {
				return nil, err
			}
			continue
		}

		selector := subStepSelector(sub)
		pos := SubStepPosition{StepIndex: stepIndex, SubStepIndex: i}
		start := time.Now()
		e.logger.LogUISubStepStarted(stepIndex, i, string(sub.Kind), selector, target)

		err := e.runSubStep(ctx, driver, extractor, sub, baseURL, extracted, pos, stepName)
		dur := int(time.Since(start).Milliseconds())
		e.logger.LogUISubStepCompleted(stepIndex, i, string(sub.Kind), selector, dur, err)

		if err != nil {
			failureName := buildFailureName(stepName, sub)
			e.captureFailureArtifacts(ctx, driver, pos, failureName)
			return nil, fmt.Errorf(
				"ui target=%s step=%d sub[%d/%s]: %w",
				target, stepIndex, i, sub.Kind, err,
			)
		}
	}

	return map[string]interface{}{
		"target":    target,
		"baseURL":   baseURL,
		"extracted": extracted,
	}, nil
}

// resolveTargetURL maps action.target → a base URL from the ConfigMap URLMap.
// Scheme defaults to http if URLMapEntry.Scheme is blank.
func (e *UIStepExecutor) resolveTargetURL(target string) (string, error) {
	if target == "" {
		return "", fmt.Errorf("ui: empty target")
	}
	entry, ok := e.urlMap[target]
	if !ok {
		return "", fmt.Errorf("ui: target %q not found in URL map", target)
	}
	scheme := entry.Scheme
	if scheme == "" {
		scheme = "http"
	}
	// entry.URL may or may not include scheme already — strip it to normalize.
	host := stripScheme(entry.URL)
	return fmt.Sprintf("%s://%s", scheme, host), nil
}

// runSubStep dispatches one sub-step to the driver or extractor. All string
// fields with `{{var}}` are resolved against the current variable context just
// before dispatch — so mid-flow extracts produced by earlier sub-steps are
// visible to later ones. ctx + pos are threaded through so the screenshot
// sub-step can hand the captured bytes to the artifact pipeline.
func (e *UIStepExecutor) runSubStep(
	ctx context.Context,
	driver UIDriver,
	extractor *UIExtractor,
	sub UISubStep,
	baseURL string,
	extracted map[string]interface{},
	pos SubStepPosition,
	stepName string,
) error {
	switch sub.Kind {
	case UISubVisit:
		path, err := e.varCtx.Resolve(sub.Visit)
		if err != nil {
			return fmt.Errorf("visit path resolve: %w", err)
		}
		url, err := resolveUIPath(baseURL, path)
		if err != nil {
			return err
		}
		return driver.Navigate(url, resolveSubStepTimeout(sub))

	case UISubClick:
		sel, err := e.varCtx.Resolve(sub.Click)
		if err != nil {
			return fmt.Errorf("click selector resolve: %w", err)
		}
		return driver.Click(sel, resolveSubStepTimeout(sub))

	case UISubType:
		if sub.Type == nil {
			return fmt.Errorf("type sub-step missing payload")
		}
		sel, err := e.varCtx.Resolve(sub.Type.Selector)
		if err != nil {
			return fmt.Errorf("type selector resolve: %w", err)
		}
		text, err := e.varCtx.Resolve(sub.Type.Text)
		if err != nil {
			return fmt.Errorf("type text resolve: %w", err)
		}
		return driver.Type(sel, text, resolveSubStepTimeout(sub))

	case UISubWaitFor:
		if sub.WaitFor == nil {
			return fmt.Errorf("waitFor sub-step missing payload")
		}
		sel, err := e.varCtx.Resolve(sub.WaitFor.Selector)
		if err != nil {
			return fmt.Errorf("waitFor selector resolve: %w", err)
		}
		if sub.WaitFor.Text != "" {
			text, err := e.varCtx.Resolve(sub.WaitFor.Text)
			if err != nil {
				return fmt.Errorf("waitFor text resolve: %w", err)
			}
			return driver.WaitForText(sel, text, resolveSubStepTimeout(sub))
		}
		return driver.WaitVisible(sel, resolveSubStepTimeout(sub))

	case UISubExtract:
		for varName, src := range sub.Extract {
			resolved, err := e.interpolateExtractSource(src)
			if err != nil {
				return fmt.Errorf("extract %q: %w", varName, err)
			}
			value, err := extractor.Extract(resolved)
			if err != nil {
				return fmt.Errorf("extract %q: %w", varName, err)
			}
			e.varCtx.Set(varName, value)
			extracted[varName] = value
		}
		return nil

	case UISubScreenshot:
		if sub.Screenshot == nil {
			return fmt.Errorf("screenshot sub-step missing payload")
		}
		name, err := e.varCtx.Resolve(sub.Screenshot.Name)
		if err != nil {
			return fmt.Errorf("screenshot name resolve: %w", err)
		}
		if name == "" {
			name = buildScreenshotName(stepName, sub)
		}
		// Region-scoped capture when selector is set; full page otherwise.
		var png []byte
		if sub.Screenshot.Selector != "" {
			sel, err := e.varCtx.Resolve(sub.Screenshot.Selector)
			if err != nil {
				return fmt.Errorf("screenshot selector resolve: %w", err)
			}
			png, err = driver.SelectorScreenshot(sel, resolveSubStepTimeout(sub))
			if err != nil {
				return fmt.Errorf("screenshot: %w", err)
			}
		} else {
			png, err = driver.Screenshot(90, resolveSubStepTimeout(sub))
			if err != nil {
				return fmt.Errorf("screenshot: %w", err)
			}
		}
		// Always upload as a screenshot artifact. The presence of a `match`
		// block on the sub-step is what tells CT to run a post-run diff
		// against `.dokkimi/<project>/baselines/<name>.png` — that lookup
		// happens server-side from the resolved definition, so test-agent
		// doesn't need to carry the match flag through the upload.
		if e.uploader == nil {
			log.Printf("UI screenshot captured (no uploader): name=%q size=%d bytes", name, len(png))
			return nil
		}
		// Resolve ignoreRegions to bounding boxes while the browser is still open.
		var bounds []BoundingBox
		if sub.Screenshot.Match != nil && len(sub.Screenshot.Match.IgnoreRegions) > 0 {
			for _, sel := range sub.Screenshot.Match.IgnoreRegions {
				resolved, resolveErr := e.varCtx.Resolve(sel)
				if resolveErr != nil {
					return fmt.Errorf("ignoreRegions selector resolve %q: %w", sel, resolveErr)
				}
				bx, by, bw, bh, boundsErr := driver.ElementBounds(resolved, 2*time.Second)
				if boundsErr != nil {
					log.Printf("ignoreRegions: skipping %q (not found or not visible): %v", resolved, boundsErr)
					continue
				}
				bounds = append(bounds, BoundingBox{Selector: resolved, X: bx, Y: by, Width: bw, Height: bh})
			}
		}
		result := e.matcher.Match(name, png, sub.Screenshot.Match, bounds)
		uri, err := e.uploader.Upload(ctx, ArtifactTypeScreenshot, name, pos, png, false, bounds, result.Verdict)
		if err != nil {
			return fmt.Errorf("screenshot upload: %w", err)
		}
		if result.Verdict == "fail" && len(result.DiffPng) > 0 {
			if _, diffErr := e.uploader.Upload(ctx, ArtifactTypeDiff, name, pos, result.DiffPng, false, nil, ""); diffErr != nil {
				log.Printf("visualMatch diff upload error: %v", diffErr)
			}
		}
		if result.Verdict == "fail" {
			e.visualFailures = append(e.visualFailures, fmt.Sprintf("visual diff exceeded threshold for %q — review diff/%s.png and either fix the regression or `dokkimi baselines approve %s` to accept the new look", name, name, name))
		} else if result.Verdict == "no-baseline" {
			e.visualFailures = append(e.visualFailures, fmt.Sprintf("no baseline for %q — run `dokkimi baselines approve %s` (or `--all`) after reviewing the capture", name, name))
		}
		log.Printf("UI screenshot uploaded: name=%q size=%d bytes uri=%s verdict=%s", name, len(png), uri, result.Verdict)
		return nil

	case UISubScroll:
		if sub.Scroll == nil {
			return fmt.Errorf("scroll sub-step missing payload")
		}
		// Selector form: scroll the matching element into view.
		if sub.Scroll.Selector != "" {
			sel, err := e.varCtx.Resolve(sub.Scroll.Selector)
			if err != nil {
				return fmt.Errorf("scroll selector resolve: %w", err)
			}
			return driver.ScrollIntoView(sel, resolveSubStepTimeout(sub))
		}
		// Coordinate form: scroll the page (X/Y default to 0).
		x, y := 0, 0
		if sub.Scroll.X != nil {
			x = *sub.Scroll.X
		}
		if sub.Scroll.Y != nil {
			y = *sub.Scroll.Y
		}
		return driver.ScrollWindow(x, y, resolveSubStepTimeout(sub))

	case UISubSelect:
		if sub.Select == nil {
			return fmt.Errorf("select sub-step missing payload")
		}
		sel, err := e.varCtx.Resolve(sub.Select.Selector)
		if err != nil {
			return fmt.Errorf("select selector resolve: %w", err)
		}
		value, err := e.varCtx.Resolve(sub.Select.Value)
		if err != nil {
			return fmt.Errorf("select value resolve: %w", err)
		}
		return driver.SelectOption(sel, value, resolveSubStepTimeout(sub))

	case UISubHover:
		sel, err := e.varCtx.Resolve(sub.Hover)
		if err != nil {
			return fmt.Errorf("hover selector resolve: %w", err)
		}
		return driver.Hover(sel, resolveSubStepTimeout(sub))

	case UISubKey:
		if sub.Key == nil {
			return fmt.Errorf("key sub-step missing payload")
		}
		key, err := e.varCtx.Resolve(sub.Key.Key)
		if err != nil {
			return fmt.Errorf("key resolve: %w", err)
		}
		var sel string
		if sub.Key.Selector != "" {
			sel, err = e.varCtx.Resolve(sub.Key.Selector)
			if err != nil {
				return fmt.Errorf("key selector resolve: %w", err)
			}
		}
		return driver.KeyPress(sel, key, resolveSubStepTimeout(sub))

	case UISubUpload:
		if sub.Upload == nil {
			return fmt.Errorf("upload sub-step missing payload")
		}
		sel, err := e.varCtx.Resolve(sub.Upload.Selector)
		if err != nil {
			return fmt.Errorf("upload selector resolve: %w", err)
		}
		files := make([]string, 0, len(sub.Upload.Files))
		for _, f := range sub.Upload.Files {
			resolved, err := e.varCtx.Resolve(f)
			if err != nil {
				return fmt.Errorf("upload file resolve: %w", err)
			}
			files = append(files, resolved)
		}
		return driver.Upload(sel, files, resolveSubStepTimeout(sub))

	case UISubDrag:
		if sub.Drag == nil {
			return fmt.Errorf("drag sub-step missing payload")
		}
		from, err := e.varCtx.Resolve(sub.Drag.From)
		if err != nil {
			return fmt.Errorf("drag from selector resolve: %w", err)
		}
		to, err := e.varCtx.Resolve(sub.Drag.To)
		if err != nil {
			return fmt.Errorf("drag to selector resolve: %w", err)
		}
		return driver.Drag(from, to, resolveSubStepTimeout(sub))

	case UISubViewport:
		if sub.Viewport == nil {
			return fmt.Errorf("viewport sub-step missing payload")
		}
		return driver.SetViewport(sub.Viewport.Width, sub.Viewport.Height)

	default:
		return fmt.Errorf("unknown sub-step kind %q", sub.Kind)
	}
}

// runSubStepGroup executes a UI sub-step group (loop modifier + nested steps).
func (e *UIStepExecutor) runSubStepGroup(
	ctx context.Context,
	driver UIDriver,
	extractor *UIExtractor,
	group UISubStep,
	baseURL string,
	extracted map[string]interface{},
	stepIndex, subStepIndex int,
	stepName, target string,
) error {
	plan, err := buildIterationPlan(group.ForEach, group.For, group.Repeat, e.varCtx)
	if err != nil {
		return err
	}

	_, loopErr := runLoop(plan, e.varCtx, func(iterIdx int, iter Iteration) (map[string]interface{}, error) {
		iter.SetupFn()
		log.Printf("UI sub-step group iteration %d %s", iterIdx, iter.Label)

		for j, sub := range group.Steps {
			selector := subStepSelector(sub)
			pos := SubStepPosition{StepIndex: stepIndex, SubStepIndex: subStepIndex*10000000 + iterIdx*10000 + j}
			start := time.Now()
			e.logger.LogUISubStepStarted(stepIndex, pos.SubStepIndex, string(sub.Kind), selector, target)

			err := e.runSubStep(ctx, driver, extractor, sub, baseURL, extracted, pos, stepName)
			dur := int(time.Since(start).Milliseconds())
			e.logger.LogUISubStepCompleted(stepIndex, pos.SubStepIndex, string(sub.Kind), selector, dur, err)

			if err != nil {
				failureName := buildFailureName(stepName, sub)
				e.captureFailureArtifacts(ctx, driver, pos, failureName)
				return nil, fmt.Errorf(
					"ui target=%s step=%d group[%d] iter=%d sub[%d/%s]: %w",
					target, stepIndex, subStepIndex, iterIdx, j, sub.Kind, err,
				)
			}
		}

		return nil, nil
	})

	return loopErr
}

// captureFailureArtifacts grabs a screenshot + page HTML at the moment of
// sub-step failure and uploads them as nameless `screenshot` + `html`
// artifacts. Both the capture and upload are best-effort: any failure here
// is logged and swallowed so it cannot mask the original sub-step error
// the caller is about to surface. Skipped entirely when the uploader is
// nil (test paths that don't wire the artifact pipeline).
func (e *UIStepExecutor) captureFailureArtifacts(
	ctx context.Context,
	driver UIDriver,
	pos SubStepPosition,
	name string,
) {
	if e.uploader == nil {
		return
	}

	if png, err := driver.Screenshot(90, defaultUISubStepTimeout); err != nil {
		log.Printf("failure-capture screenshot: %v", err)
	} else if _, err := e.uploader.Upload(ctx, ArtifactTypeScreenshot, name, pos, png, true, nil, ""); err != nil {
		log.Printf("failure-capture screenshot upload: %v", err)
	}

	if html, err := driver.PageHTML(defaultUISubStepTimeout); err != nil {
		log.Printf("failure-capture html: %v", err)
	} else if _, err := e.uploader.Upload(ctx, ArtifactTypeHTML, "", pos, []byte(html), true, nil, ""); err != nil {
		log.Printf("failure-capture html upload: %v", err)
	}
}

// subStepSelector returns the CSS selector associated with a sub-step, if any.
// Used for boundary-event metadata so downstream correlation can show "the
// user was clicking #submit" instead of just "clicking". Non-DOM sub-steps
// (visit, screenshot) return an empty string.
func subStepSelector(sub UISubStep) string {
	switch sub.Kind {
	case UISubClick:
		return sub.Click
	case UISubType:
		if sub.Type != nil {
			return sub.Type.Selector
		}
	case UISubWaitFor:
		if sub.WaitFor != nil {
			return sub.WaitFor.Selector
		}
	case UISubScroll:
		if sub.Scroll != nil {
			return sub.Scroll.Selector
		}
	case UISubSelect:
		if sub.Select != nil {
			return sub.Select.Selector
		}
	case UISubHover:
		return sub.Hover
	case UISubKey:
		if sub.Key != nil {
			return sub.Key.Selector
		}
	case UISubUpload:
		if sub.Upload != nil {
			return sub.Upload.Selector
		}
	case UISubDrag:
		if sub.Drag != nil {
			return sub.Drag.From
		}
	case UISubScreenshot:
		if sub.Screenshot != nil {
			return sub.Screenshot.Selector
		}
	}
	return ""
}

// interpolateExtractSource resolves {{var}} in selector/name/key but leaves
// `pattern` alone — patterns are regex, and `{{name}}` there is almost always
// a bug (the regex `\w+` syntax contains `{...}`).
func (e *UIStepExecutor) interpolateExtractSource(src UIExtractSource) (UIExtractSource, error) {
	resolved := src
	if src.Selector != "" {
		v, err := e.varCtx.Resolve(src.Selector)
		if err != nil {
			return resolved, fmt.Errorf("selector: %w", err)
		}
		resolved.Selector = v
	}
	if src.Name != "" {
		v, err := e.varCtx.Resolve(src.Name)
		if err != nil {
			return resolved, fmt.Errorf("name: %w", err)
		}
		resolved.Name = v
	}
	if src.Key != "" {
		v, err := e.varCtx.Resolve(src.Key)
		if err != nil {
			return resolved, fmt.Errorf("key: %w", err)
		}
		resolved.Key = v
	}
	return resolved, nil
}

// sanitizeArtifactName converts an arbitrary string into a valid artifact name
// matching [a-zA-Z0-9_-]{1,64}. Non-matching characters become dashes;
// consecutive dashes collapse; leading/trailing dashes are trimmed.
func sanitizeArtifactName(raw string) string {
	var buf []byte
	for i := 0; i < len(raw); i++ {
		c := raw[i]
		if (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || c == '_' {
			buf = append(buf, c)
		} else {
			if len(buf) > 0 && buf[len(buf)-1] != '-' {
				buf = append(buf, '-')
			}
		}
	}
	result := string(buf)
	result = strings.Trim(result, "-")
	if len(result) > 64 {
		result = result[:64]
		result = strings.TrimRight(result, "-")
	}
	if result == "" {
		return "screenshot"
	}
	return result
}

// buildScreenshotName generates a descriptive name for an explicit screenshot
// sub-step that doesn't have a user-provided name.
func buildScreenshotName(stepName string, sub UISubStep) string {
	base := stepName
	if base == "" {
		base = "screenshot"
	}
	sel := ""
	if sub.Screenshot != nil {
		sel = sub.Screenshot.Selector
	}
	if sel != "" {
		return sanitizeArtifactName(fmt.Sprintf("%s-screenshot-%s", base, sel))
	}
	return sanitizeArtifactName(fmt.Sprintf("%s-screenshot", base))
}

// buildFailureName generates a descriptive name for an auto-captured failure
// screenshot, incorporating the step name and the sub-step that failed.
func buildFailureName(stepName string, sub UISubStep) string {
	base := stepName
	if base == "" {
		base = "failure"
	}
	sel := subStepSelector(sub)
	if sel != "" {
		return sanitizeArtifactName(fmt.Sprintf("%s-failure-after-%s-%s", base, sub.Kind, sel))
	}
	return sanitizeArtifactName(fmt.Sprintf("%s-failure-after-%s", base, sub.Kind))
}
