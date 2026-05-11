package main

import (
	"fmt"
	"strconv"
	"time"
)

// defaultExtractTimeout bounds any single DOM/browser read that the extract
// pipeline triggers. The step interpreter is free to override per call.
const defaultExtractTimeout = 5 * time.Second

// UIExtractor routes a UIExtractSource to the appropriate browser reader and
// applies optional regex post-processing. Keep this free of chromedp types so
// the dispatch is easy to unit-test with fakes.
type UIExtractor struct {
	browser BrowserReader
	timeout time.Duration
}

// BrowserReader is the subset of BrowserClient that the extractor depends on.
// Declared as an interface for testability.
type BrowserReader interface {
	Text(sel string, timeout time.Duration) (string, error)
	AttributeValue(sel, attr string, timeout time.Duration) (string, error)
	InputValue(sel string, timeout time.Duration) (string, error)
	Count(sel string, timeout time.Duration) (int, error)
	Exists(sel string, timeout time.Duration) (bool, error)
	Location(timeout time.Duration) (string, error)
	Cookie(name string, timeout time.Duration) (string, error)
	LocalStorageItem(key string, timeout time.Duration) (string, error)
	SessionStorageItem(key string, timeout time.Duration) (string, error)
}

// NewUIExtractor constructs an extractor over a BrowserReader. timeout bounds
// any single read; pass 0 to use defaultExtractTimeout.
func NewUIExtractor(b BrowserReader, timeout time.Duration) *UIExtractor {
	if timeout <= 0 {
		timeout = defaultExtractTimeout
	}
	return &UIExtractor{browser: b, timeout: timeout}
}

// Extract reads a single UIExtractSource and returns its final string value
// (post-regex). Non-string kinds (count / exists) are rendered as their
// decimal or "true"/"false" form so that the returned value slots into
// test-agent's string-keyed variable scope.
func (e *UIExtractor) Extract(src UIExtractSource) (string, error) {
	raw, err := e.readRaw(src)
	if err != nil {
		return "", err
	}
	group := resolveExtractGroup(src.Group, src.Pattern != "")
	return applyExtractRegex(raw, src.Pattern, group)
}

// readRaw returns the pre-regex string for src.
func (e *UIExtractor) readRaw(src UIExtractSource) (string, error) {
	switch src.From {
	case UIExtractFromText:
		if src.Selector == "" {
			return "", fmt.Errorf(`extract "text" requires "selector"`)
		}
		return e.browser.Text(src.Selector, e.timeout)

	case UIExtractFromAttribute:
		if src.Selector == "" {
			return "", fmt.Errorf(`extract "attribute" requires "selector"`)
		}
		if src.Name == "" {
			return "", fmt.Errorf(`extract "attribute" requires "name"`)
		}
		return e.browser.AttributeValue(src.Selector, src.Name, e.timeout)

	case UIExtractFromValue:
		if src.Selector == "" {
			return "", fmt.Errorf(`extract "value" requires "selector"`)
		}
		return e.browser.InputValue(src.Selector, e.timeout)

	case UIExtractFromURL:
		loc, err := e.browser.Location(e.timeout)
		if err != nil {
			return "", err
		}
		return extractURLPart(loc, src.Part)

	case UIExtractFromCookie:
		if src.Name == "" {
			return "", fmt.Errorf(`extract "cookie" requires "name"`)
		}
		return e.browser.Cookie(src.Name, e.timeout)

	case UIExtractFromLocalStorage:
		if src.Key == "" {
			return "", fmt.Errorf(`extract "localStorage" requires "key"`)
		}
		return e.browser.LocalStorageItem(src.Key, e.timeout)

	case UIExtractFromSessionStorage:
		if src.Key == "" {
			return "", fmt.Errorf(`extract "sessionStorage" requires "key"`)
		}
		return e.browser.SessionStorageItem(src.Key, e.timeout)

	case UIExtractFromCount:
		if src.Selector == "" {
			return "", fmt.Errorf(`extract "count" requires "selector"`)
		}
		n, err := e.browser.Count(src.Selector, e.timeout)
		if err != nil {
			return "", err
		}
		return strconv.Itoa(n), nil

	case UIExtractFromExists:
		if src.Selector == "" {
			return "", fmt.Errorf(`extract "exists" requires "selector"`)
		}
		ok, err := e.browser.Exists(src.Selector, e.timeout)
		if err != nil {
			return "", err
		}
		if ok {
			return "true", nil
		}
		return "false", nil

	default:
		return "", fmt.Errorf(`extract: unknown "from" value %q`, src.From)
	}
}
