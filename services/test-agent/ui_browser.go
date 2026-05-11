package main

import (
	"context"
	"fmt"
	"strconv"
	"strings"
	"time"

	"github.com/chromedp/cdproto/cdp"
	"github.com/chromedp/cdproto/dom"
	"github.com/chromedp/cdproto/emulation"
	"github.com/chromedp/cdproto/input"
	"github.com/chromedp/cdproto/network"
	"github.com/chromedp/chromedp"
	"github.com/chromedp/chromedp/kb"
)

// BrowserClient drives the chromium sidecar via CDP.
//
// In production the client connects to the co-located chromium container at
// ws://localhost:9222 (or http://localhost:9222 with auto-discovery). The
// client holds one browser tab for the lifetime of a UI action. Creating a
// new client per action keeps state clean across runs.
type BrowserClient struct {
	allocCancel   context.CancelFunc
	browserCtx    context.Context
	browserCancel context.CancelFunc
}

// NewBrowserClient attaches to a remote chromium at browserURL. browserURL may
// be a direct WebSocket URL (ws://host:port/...) or an HTTP URL that the
// chromedp allocator will resolve via /json/version (http://host:port).
//
// Caller is responsible for calling Close when done.
func NewBrowserClient(parent context.Context, browserURL string, viewportWidth, viewportHeight int) (*BrowserClient, error) {
	if browserURL == "" {
		return nil, fmt.Errorf("browser: empty browserURL")
	}
	allocCtx, allocCancel := chromedp.NewRemoteAllocator(parent, browserURL)
	browserCtx, browserCancel := chromedp.NewContext(allocCtx)

	// Force the context to realize by issuing an empty run — fails fast if
	// the remote chromium is unreachable.
	if err := chromedp.Run(browserCtx); err != nil {
		browserCancel()
		allocCancel()
		return nil, fmt.Errorf("browser connect %s: %w", browserURL, err)
	}

	// Set a consistent viewport so tests behave the same regardless of
	// the headless shell's default window size.
	if err := chromedp.Run(browserCtx, chromedp.ActionFunc(func(ctx context.Context) error {
		return emulation.SetDeviceMetricsOverride(int64(viewportWidth), int64(viewportHeight), 1.0, false).Do(ctx)
	})); err != nil {
		browserCancel()
		allocCancel()
		return nil, fmt.Errorf("browser set viewport: %w", err)
	}
	return &BrowserClient{
		allocCancel:   allocCancel,
		browserCtx:    browserCtx,
		browserCancel: browserCancel,
	}, nil
}

// Close tears down the browser context and the allocator. Safe to call
// multiple times.
func (c *BrowserClient) Close() {
	if c.browserCancel != nil {
		c.browserCancel()
		c.browserCancel = nil
	}
	if c.allocCancel != nil {
		c.allocCancel()
		c.allocCancel = nil
	}
}

// BrowserContext returns the underlying chromedp context. Callers may derive
// timeouts from it with context.WithTimeout before passing to helper methods.
func (c *BrowserClient) BrowserContext() context.Context {
	return c.browserCtx
}

// SetViewport overrides the browser's device metrics to the given dimensions.
func (c *BrowserClient) SetViewport(width, height int) error {
	return chromedp.Run(c.browserCtx, chromedp.ActionFunc(func(ctx context.Context) error {
		return emulation.SetDeviceMetricsOverride(int64(width), int64(height), 1.0, false).Do(ctx)
	}))
}

// run is a small helper that executes one chromedp action with an optional
// timeout. If timeout <= 0 the browser context is used as-is.
func (c *BrowserClient) run(timeout time.Duration, actions ...chromedp.Action) error {
	ctx := c.browserCtx
	if timeout > 0 {
		var cancel context.CancelFunc
		ctx, cancel = context.WithTimeout(ctx, timeout)
		defer cancel()
	}
	return chromedp.Run(ctx, actions...)
}

// ---------------------------------------------------------------------------
// Navigation / interaction primitives
// ---------------------------------------------------------------------------

// Navigate points the browser at url and waits for the load event.
func (c *BrowserClient) Navigate(url string, timeout time.Duration) error {
	return c.run(timeout, chromedp.Navigate(url))
}

// Click waits for sel to be visible then clicks. This is the "safe click" —
// chromedp.Click alone does not auto-wait reliably on SPA re-renders.
func (c *BrowserClient) Click(sel string, timeout time.Duration) error {
	return c.run(
		timeout,
		chromedp.WaitVisible(sel, chromedp.ByQuery),
		chromedp.Click(sel, chromedp.ByQuery),
	)
}

// Type sends keystrokes to sel. It waits for sel to be visible first.
func (c *BrowserClient) Type(sel, text string, timeout time.Duration) error {
	return c.run(
		timeout,
		chromedp.WaitVisible(sel, chromedp.ByQuery),
		chromedp.SendKeys(sel, text, chromedp.ByQuery),
	)
}

// WaitVisible waits for sel to become visible.
func (c *BrowserClient) WaitVisible(sel string, timeout time.Duration) error {
	return c.run(timeout, chromedp.WaitVisible(sel, chromedp.ByQuery))
}

// WaitForText polls until the innerText of sel equals want (trimmed) or timeout
// elapses. Polling is preferred over retry-on-value because chromedp does not
// ship a native "wait until text equals" action.
func (c *BrowserClient) WaitForText(sel, want string, timeout time.Duration) error {
	if timeout <= 0 {
		timeout = 10 * time.Second
	}
	deadline := time.Now().Add(timeout)
	for {
		got, err := c.Text(sel, 0)
		if err == nil && strings.Contains(strings.TrimSpace(got), want) {
			return nil
		}
		if time.Now().After(deadline) {
			if err != nil {
				return fmt.Errorf("waitForText %q=%q: %w", sel, want, err)
			}
			return fmt.Errorf("waitForText timeout: %q text %q != %q", sel, got, want)
		}
		select {
		case <-time.After(100 * time.Millisecond):
		case <-c.browserCtx.Done():
			return c.browserCtx.Err()
		}
	}
}

// ScrollIntoView scrolls the matching element into the viewport. chromedp's
// Click/WaitVisible already do this implicitly before interacting; the
// explicit form is for cases like infinite-scroll triggers where you need
// to scroll without clicking.
func (c *BrowserClient) ScrollIntoView(sel string, timeout time.Duration) error {
	return c.run(
		timeout,
		chromedp.WaitVisible(sel, chromedp.ByQuery),
		chromedp.ScrollIntoView(sel, chromedp.ByQuery),
	)
}

// ScrollWindow scrolls the page to absolute pixel coordinates.
func (c *BrowserClient) ScrollWindow(x, y int, timeout time.Duration) error {
	return c.run(
		timeout,
		chromedp.Evaluate(fmt.Sprintf("window.scrollTo(%d, %d)", x, y), nil),
	)
}

// SelectOption sets the value of a native <select> and dispatches a `change`
// event. SetAttributeValue alone doesn't fire change, so React/Vue listeners
// wouldn't run; we evaluate JS that does both. Custom (non-`<select>`) UIs
// styled to look like dropdowns should use plain `click` sub-steps instead.
func (c *BrowserClient) SelectOption(sel, value string, timeout time.Duration) error {
	js := fmt.Sprintf(
		`(function(){var el = document.querySelector(%q); if (!el) throw new Error("select not found: " + %q); el.value = %q; el.dispatchEvent(new Event("input", {bubbles: true})); el.dispatchEvent(new Event("change", {bubbles: true}));})()`,
		sel, sel, value,
	)
	return c.run(
		timeout,
		chromedp.WaitVisible(sel, chromedp.ByQuery),
		chromedp.Evaluate(js, nil),
	)
}

// Hover dispatches a synthetic `mouseover`/`mouseenter` pair on the matching
// element. Used for tooltips and hover-revealed menus. Synthesizing via
// dispatchEvent is more reliable in headless than a real mouse move because
// chromedp's mouse coords depend on layout that isn't always settled.
func (c *BrowserClient) Hover(sel string, timeout time.Duration) error {
	js := fmt.Sprintf(
		`(function(){var el = document.querySelector(%q); if (!el) throw new Error("hover target not found: " + %q); ["mouseover","mouseenter"].forEach(function(t){ el.dispatchEvent(new MouseEvent(t, {bubbles: true, cancelable: true, view: window})); });})()`,
		sel, sel,
	)
	return c.run(
		timeout,
		chromedp.WaitVisible(sel, chromedp.ByQuery),
		chromedp.Evaluate(js, nil),
	)
}

// KeyPress sends a single named key (Enter, Escape, Tab, ArrowDown, etc.)
// to the currently focused element, or to `sel` if non-empty (the selector
// is focused first via WaitVisible+Focus). The name is mapped to a chromedp
// kb constant; unknown names fall back to sending the literal rune.
func (c *BrowserClient) KeyPress(sel, key string, timeout time.Duration) error {
	mapped := mapNamedKey(key)
	if sel == "" {
		return c.run(timeout, chromedp.KeyEvent(mapped))
	}
	return c.run(
		timeout,
		chromedp.WaitVisible(sel, chromedp.ByQuery),
		chromedp.Focus(sel, chromedp.ByQuery),
		chromedp.KeyEvent(mapped),
	)
}

// Upload attaches local files to a `<input type="file">`. Paths must exist
// inside the test-agent container.
func (c *BrowserClient) Upload(sel string, files []string, timeout time.Duration) error {
	return c.run(
		timeout,
		chromedp.WaitVisible(sel, chromedp.ByQuery),
		chromedp.SetUploadFiles(sel, files, chromedp.ByQuery),
	)
}

// Drag synthesizes a mouse drag from `fromSel` element's center to `toSel`
// element's center. The intermediate `mouseMoved` is required for HTML5
// `dragstart` to fire on most drag libraries — a single press→release at
// the destination is treated as a click. Coordinates come from each
// element's CSS box model.
func (c *BrowserClient) Drag(fromSel, toSel string, timeout time.Duration) error {
	var fromNodes, toNodes []*cdp.Node
	return c.run(
		timeout,
		chromedp.WaitVisible(fromSel, chromedp.ByQuery),
		chromedp.WaitVisible(toSel, chromedp.ByQuery),
		chromedp.Nodes(fromSel, &fromNodes, chromedp.ByQuery),
		chromedp.Nodes(toSel, &toNodes, chromedp.ByQuery),
		chromedp.ActionFunc(func(ctx context.Context) error {
			if len(fromNodes) == 0 {
				return fmt.Errorf("drag: source not found: %s", fromSel)
			}
			if len(toNodes) == 0 {
				return fmt.Errorf("drag: target not found: %s", toSel)
			}
			fromBox, err := dom.GetBoxModel().WithNodeID(fromNodes[0].NodeID).Do(ctx)
			if err != nil {
				return fmt.Errorf("drag: get source box: %w", err)
			}
			toBox, err := dom.GetBoxModel().WithNodeID(toNodes[0].NodeID).Do(ctx)
			if err != nil {
				return fmt.Errorf("drag: get target box: %w", err)
			}
			fx, fy := centerOfQuad(fromBox.Content)
			tx, ty := centerOfQuad(toBox.Content)
			// Press at source.
			if err := input.DispatchMouseEvent(input.MousePressed, fx, fy).
				WithButton(input.Left).
				WithClickCount(1).
				Do(ctx); err != nil {
				return fmt.Errorf("drag: mouse press: %w", err)
			}
			// Move through an intermediate point so dragstart fires before
			// the cursor reaches the drop zone. Some libraries gate on
			// pixel-distance from press to first move.
			mx, my := (fx+tx)/2, (fy+ty)/2
			if err := input.DispatchMouseEvent(input.MouseMoved, mx, my).
				WithButton(input.Left).
				Do(ctx); err != nil {
				return fmt.Errorf("drag: mouse move (mid): %w", err)
			}
			if err := input.DispatchMouseEvent(input.MouseMoved, tx, ty).
				WithButton(input.Left).
				Do(ctx); err != nil {
				return fmt.Errorf("drag: mouse move (target): %w", err)
			}
			if err := input.DispatchMouseEvent(input.MouseReleased, tx, ty).
				WithButton(input.Left).
				WithClickCount(1).
				Do(ctx); err != nil {
				return fmt.Errorf("drag: mouse release: %w", err)
			}
			return nil
		}),
	)
}

// centerOfQuad returns the centroid of an 8-element CSS box-model quad
// (four (x, y) points: top-left, top-right, bottom-right, bottom-left).
func centerOfQuad(q []float64) (float64, float64) {
	if len(q) < 8 {
		return 0, 0
	}
	return (q[0] + q[2] + q[4] + q[6]) / 4, (q[1] + q[3] + q[5] + q[7]) / 4
}

// mapNamedKey turns a friendly key name ("Enter", "Tab", "ArrowDown", …)
// into the rune sequence chromedp's KeyEvent expects. Unknown names are
// returned verbatim so single-character names like "a" still work.
func mapNamedKey(name string) string {
	switch name {
	case "Enter":
		return kb.Enter
	case "Tab":
		return kb.Tab
	case "Escape", "Esc":
		return kb.Escape
	case "Backspace":
		return kb.Backspace
	case "Delete", "Del":
		return kb.Delete
	case "ArrowUp", "Up":
		return kb.ArrowUp
	case "ArrowDown", "Down":
		return kb.ArrowDown
	case "ArrowLeft", "Left":
		return kb.ArrowLeft
	case "ArrowRight", "Right":
		return kb.ArrowRight
	case "Home":
		return kb.Home
	case "End":
		return kb.End
	case "PageUp":
		return kb.PageUp
	case "PageDown":
		return kb.PageDown
	case "Space":
		return " "
	}
	return name
}

// ---------------------------------------------------------------------------
// State readers — used by extract helpers
// ---------------------------------------------------------------------------

// Text returns the innerText of the first element matching sel.
func (c *BrowserClient) Text(sel string, timeout time.Duration) (string, error) {
	var out string
	if err := c.run(timeout, chromedp.Text(sel, &out, chromedp.ByQuery, chromedp.NodeVisible)); err != nil {
		return "", err
	}
	return out, nil
}

// AttributeValue returns an element attribute value. Returns ("", nil) if the
// attribute is absent — matching DOM semantics.
func (c *BrowserClient) AttributeValue(sel, attr string, timeout time.Duration) (string, error) {
	var out string
	var ok bool
	if err := c.run(timeout, chromedp.AttributeValue(sel, attr, &out, &ok, chromedp.ByQuery)); err != nil {
		return "", err
	}
	if !ok {
		return "", nil
	}
	return out, nil
}

// InputValue returns the .value of an input/select/textarea.
func (c *BrowserClient) InputValue(sel string, timeout time.Duration) (string, error) {
	var out string
	if err := c.run(timeout, chromedp.Value(sel, &out, chromedp.ByQuery)); err != nil {
		return "", err
	}
	return out, nil
}

// Count returns the number of elements matching sel.
func (c *BrowserClient) Count(sel string, timeout time.Duration) (int, error) {
	js := fmt.Sprintf(`document.querySelectorAll(%s).length`, jsStringLiteral(sel))
	var out int
	if err := c.run(timeout, chromedp.Evaluate(js, &out)); err != nil {
		return 0, err
	}
	return out, nil
}

// Exists returns true iff at least one element matches sel.
func (c *BrowserClient) Exists(sel string, timeout time.Duration) (bool, error) {
	js := fmt.Sprintf(`!!document.querySelector(%s)`, jsStringLiteral(sel))
	var out bool
	if err := c.run(timeout, chromedp.Evaluate(js, &out)); err != nil {
		return false, err
	}
	return out, nil
}

// Location returns the current page URL.
func (c *BrowserClient) Location(timeout time.Duration) (string, error) {
	var out string
	if err := c.run(timeout, chromedp.Location(&out)); err != nil {
		return "", err
	}
	return out, nil
}

// Cookie returns the value of the named cookie, or "" if absent.
func (c *BrowserClient) Cookie(name string, timeout time.Duration) (string, error) {
	var out string
	action := chromedp.ActionFunc(func(ctx context.Context) error {
		cookies, err := network.GetCookies().Do(ctx)
		if err != nil {
			return err
		}
		for _, cookie := range cookies {
			if cookie.Name == name {
				out = cookie.Value
				return nil
			}
		}
		return nil
	})
	if err := c.run(timeout, action); err != nil {
		return "", err
	}
	return out, nil
}

// LocalStorageItem returns a single localStorage value.
func (c *BrowserClient) LocalStorageItem(key string, timeout time.Duration) (string, error) {
	return c.storageItem("localStorage", key, timeout)
}

// SessionStorageItem returns a single sessionStorage value.
func (c *BrowserClient) SessionStorageItem(key string, timeout time.Duration) (string, error) {
	return c.storageItem("sessionStorage", key, timeout)
}

func (c *BrowserClient) storageItem(store, key string, timeout time.Duration) (string, error) {
	// Evaluate returns null if absent; we coerce to empty string to match other readers.
	js := fmt.Sprintf(`(function(){ var v = %s.getItem(%s); return v === null ? "" : v; })()`,
		store, jsStringLiteral(key))
	var out string
	if err := c.run(timeout, chromedp.Evaluate(js, &out)); err != nil {
		return "", err
	}
	return out, nil
}

// ---------------------------------------------------------------------------
// Artifacts
// ---------------------------------------------------------------------------

// Screenshot captures a full-page PNG. The `quality` argument is accepted for
// API symmetry with other tuning knobs but is currently unused — chromedp's
// FullScreenshot emits PNG only when quality == 100 and JPEG otherwise, and
// lossless PNG is the right default for debug artifacts where we'd rather not
// compress away pixels that might matter in a visual diff or a bug report.
func (c *BrowserClient) Screenshot(_ int, timeout time.Duration) ([]byte, error) {
	var buf []byte
	if err := c.run(timeout, chromedp.FullScreenshot(&buf, 100)); err != nil {
		return nil, err
	}
	return buf, nil
}

// SelectorScreenshot captures only the bounding box of the matching element
// as a PNG. Used by visualMatch when the user wants a region-scoped diff
// instead of comparing the entire page.
func (c *BrowserClient) SelectorScreenshot(sel string, timeout time.Duration) ([]byte, error) {
	var buf []byte
	if err := c.run(timeout, chromedp.Screenshot(sel, &buf, chromedp.NodeVisible, chromedp.ByQuery)); err != nil {
		return nil, err
	}
	return buf, nil
}

// PageHTML returns the full serialized page HTML. Useful as a failure artifact.
func (c *BrowserClient) PageHTML(timeout time.Duration) (string, error) {
	var out string
	if err := c.run(timeout, chromedp.OuterHTML("html", &out, chromedp.ByQuery)); err != nil {
		return "", err
	}
	return out, nil
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// jsStringLiteral renders a Go string as a JS string literal suitable for
// inclusion in an Evaluate expression. We use strconv.Quote which emits a
// JSON-compatible double-quoted string — safe for JS.
func jsStringLiteral(s string) string {
	return strconv.Quote(s)
}
