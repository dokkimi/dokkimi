package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"
	"time"
)

// ---------------------------------------------------------------------------
// fakeDriver — implements UIDriver, records every call, no chromium required
// ---------------------------------------------------------------------------

type driverCall struct {
	op   string
	args []string
}

type fakeDriver struct {
	fakeBrowser // reuses the BrowserReader fake from ui_extract_test.go

	calls       []driverCall
	closed      bool
	navigateErr error
	clickErr    error
	typeErr     error
	waitErr     error
	screenshot  []byte
}

func (f *fakeDriver) Navigate(url string, _ time.Duration) error {
	f.calls = append(f.calls, driverCall{op: "navigate", args: []string{url}})
	return f.navigateErr
}
func (f *fakeDriver) Click(sel string, _ time.Duration) error {
	f.calls = append(f.calls, driverCall{op: "click", args: []string{sel}})
	return f.clickErr
}
func (f *fakeDriver) Type(sel, text string, _ time.Duration) error {
	f.calls = append(f.calls, driverCall{op: "type", args: []string{sel, text}})
	return f.typeErr
}
func (f *fakeDriver) WaitVisible(sel string, _ time.Duration) error {
	f.calls = append(f.calls, driverCall{op: "waitVisible", args: []string{sel}})
	return f.waitErr
}
func (f *fakeDriver) WaitForText(sel, want string, _ time.Duration) error {
	f.calls = append(f.calls, driverCall{op: "waitForText", args: []string{sel, want}})
	return f.waitErr
}
func (f *fakeDriver) Screenshot(_ int, _ time.Duration) ([]byte, error) {
	f.calls = append(f.calls, driverCall{op: "screenshot"})
	if f.screenshot == nil {
		return []byte{0x89, 'P', 'N', 'G'}, nil
	}
	return f.screenshot, nil
}
func (f *fakeDriver) SelectorScreenshot(sel string, _ time.Duration) ([]byte, error) {
	f.calls = append(f.calls, driverCall{op: "selectorScreenshot", args: []string{sel}})
	if f.screenshot == nil {
		return []byte{0x89, 'P', 'N', 'G', 'S', 'E', 'L'}, nil
	}
	return f.screenshot, nil
}
func (f *fakeDriver) ElementBounds(sel string, _ time.Duration) (float64, float64, float64, float64, error) {
	f.calls = append(f.calls, driverCall{op: "elementBounds", args: []string{sel}})
	return 10, 20, 100, 50, nil
}
func (f *fakeDriver) PageHTML(_ time.Duration) (string, error) {
	f.calls = append(f.calls, driverCall{op: "pageHtml"})
	return "<html><body/></html>", nil
}
func (f *fakeDriver) ScrollIntoView(sel string, _ time.Duration) error {
	f.calls = append(f.calls, driverCall{op: "scrollIntoView", args: []string{sel}})
	return nil
}
func (f *fakeDriver) ScrollWindow(x, y int, _ time.Duration) error {
	f.calls = append(f.calls, driverCall{op: "scrollWindow", args: []string{strconv.Itoa(x), strconv.Itoa(y)}})
	return nil
}
func (f *fakeDriver) SelectOption(sel, value string, _ time.Duration) error {
	f.calls = append(f.calls, driverCall{op: "select", args: []string{sel, value}})
	return nil
}
func (f *fakeDriver) Hover(sel string, _ time.Duration) error {
	f.calls = append(f.calls, driverCall{op: "hover", args: []string{sel}})
	return nil
}
func (f *fakeDriver) KeyPress(sel, key string, _ time.Duration) error {
	f.calls = append(f.calls, driverCall{op: "key", args: []string{sel, key}})
	return nil
}
func (f *fakeDriver) Upload(sel string, files []string, _ time.Duration) error {
	args := append([]string{sel}, files...)
	f.calls = append(f.calls, driverCall{op: "upload", args: args})
	return nil
}
func (f *fakeDriver) Drag(fromSel, toSel string, _ time.Duration) error {
	f.calls = append(f.calls, driverCall{op: "drag", args: []string{fromSel, toSel}})
	return nil
}
func (f *fakeDriver) SetViewport(width, height int) error {
	f.calls = append(f.calls, driverCall{op: "viewport", args: []string{fmt.Sprintf("%dx%d", width, height)}})
	return nil
}
func (f *fakeDriver) Close() {
	f.closed = true
	f.calls = append(f.calls, driverCall{op: "close"})
}

func newExecutor(d *fakeDriver) (*UIStepExecutor, *VariableContext) {
	varCtx := NewVariableContext()
	urlMap := map[string]URLMapEntry{
		"frontend-svc": {Scheme: "http", URL: "frontend-svc.ns.svc.cluster.local", Name: "frontend"},
	}
	exec := NewUIStepExecutor("", 1280, 720, urlMap, varCtx, nil, nil).
		WithDriverFactory(func(_ context.Context) (UIDriver, error) { return d, nil })
	return exec, varCtx
}

// parseAction is a test convenience — parses the wire JSON into a StepAction
// (including UI sub-steps) so test fixtures can stay readable.
func parseAction(t *testing.T, jsonBody string) StepAction {
	t.Helper()
	var a StepAction
	if err := json.Unmarshal([]byte(jsonBody), &a); err != nil {
		t.Fatalf("parse action: %v", err)
	}
	return a
}

// ---------------------------------------------------------------------------
// Target resolution
// ---------------------------------------------------------------------------

func TestUIExecutor_ResolveTargetFromURLMap(t *testing.T) {
	d := &fakeDriver{}
	exec, _ := newExecutor(d)

	action := parseAction(t, `{
		"type":"ui","target":"frontend-svc",
		"steps":[{"visit":"/login"}]
	}`)

	result, err := exec.Execute(context.Background(), action, "test-step", 0)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if got := result["baseURL"]; got != "http://frontend-svc.ns.svc.cluster.local" {
		t.Errorf("baseURL: got %v", got)
	}
	// Navigate should have been called with the joined URL.
	if d.calls[0].op != "navigate" ||
		d.calls[0].args[0] != "http://frontend-svc.ns.svc.cluster.local/login" {
		t.Errorf("navigate call: %+v", d.calls[0])
	}
}

func TestUIExecutor_UnknownTargetErrors(t *testing.T) {
	d := &fakeDriver{}
	exec, _ := newExecutor(d)

	action := parseAction(t, `{
		"type":"ui","target":"nope",
		"steps":[{"visit":"/"}]
	}`)
	_, err := exec.Execute(context.Background(), action, "test-step", 0)
	if err == nil {
		t.Fatal("want error for unknown target, got nil")
	}
	if !strings.Contains(err.Error(), `target "nope" not found`) {
		t.Errorf("wrong error: %v", err)
	}
}

func TestUIExecutor_FactoryFailureSurfaces(t *testing.T) {
	exec := NewUIStepExecutor("", 1280, 720, map[string]URLMapEntry{
		"svc": {Scheme: "http", URL: "svc"},
	}, NewVariableContext(), nil, nil).WithDriverFactory(
		func(_ context.Context) (UIDriver, error) {
			return nil, errors.New("no browser")
		},
	)

	action := parseAction(t, `{
		"type":"ui","target":"svc",
		"steps":[{"visit":"/"}]
	}`)
	_, err := exec.Execute(context.Background(), action, "test-step", 0)
	if err == nil || !strings.Contains(err.Error(), "no browser") {
		t.Fatalf("want wrapped factory error, got %v", err)
	}
}

// ---------------------------------------------------------------------------
// Sub-step dispatch
// ---------------------------------------------------------------------------

func TestUIExecutor_DispatchVisitClickType(t *testing.T) {
	d := &fakeDriver{}
	exec, _ := newExecutor(d)

	action := parseAction(t, `{
		"type":"ui","target":"frontend-svc",
		"steps":[
			{"visit":"/login"},
			{"type":{"selector":"#email","text":"a@b.c"}},
			{"click":"#submit"}
		]
	}`)
	if _, err := exec.Execute(context.Background(), action, "test-step", 0); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	wantOps := []string{"navigate", "type", "click"}
	if len(d.calls) != len(wantOps) {
		t.Fatalf("call count: want %d, got %d (%+v)", len(wantOps), len(d.calls), d.calls)
	}
	for i, op := range wantOps {
		if d.calls[i].op != op {
			t.Errorf("call[%d]: want %q, got %q", i, op, d.calls[i].op)
		}
	}
	exec.Close()
	if !d.closed {
		t.Error("driver not closed after Close()")
	}
}

func TestUIExecutor_WaitForStringVsObject(t *testing.T) {
	d := &fakeDriver{}
	exec, _ := newExecutor(d)

	action := parseAction(t, `{
		"type":"ui","target":"frontend-svc",
		"steps":[
			{"waitFor":"#dashboard"},
			{"waitFor":{"selector":"#cart","text":"1"}}
		]
	}`)
	if _, err := exec.Execute(context.Background(), action, "test-step", 0); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if d.calls[0].op != "waitVisible" || d.calls[0].args[0] != "#dashboard" {
		t.Errorf("first call: %+v", d.calls[0])
	}
	if d.calls[1].op != "waitForText" ||
		d.calls[1].args[0] != "#cart" ||
		d.calls[1].args[1] != "1" {
		t.Errorf("second call: %+v", d.calls[1])
	}
}

func TestUIExecutor_ScreenshotCaptures(t *testing.T) {
	d := &fakeDriver{}
	exec, _ := newExecutor(d)

	action := parseAction(t, `{
		"type":"ui","target":"frontend-svc",
		"steps":[{"screenshot":"final"}]
	}`)
	if _, err := exec.Execute(context.Background(), action, "test-step", 0); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if d.calls[0].op != "screenshot" {
		t.Errorf("want screenshot, got %+v", d.calls[0])
	}
}

// ---------------------------------------------------------------------------
// Extract — the mid-flow variable capture that downstream steps depend on
// ---------------------------------------------------------------------------

func TestUIExecutor_ExtractWritesToVarContext(t *testing.T) {
	d := &fakeDriver{}
	d.text = map[string]string{"h1": "Order #ABC-123"}
	d.attrs = map[string]map[string]string{
		"[data-cart]": {"data-cart-id": "CART-7"},
	}

	exec, varCtx := newExecutor(d)

	action := parseAction(t, `{
		"type":"ui","target":"frontend-svc",
		"steps":[
			{
				"extract":{
					"orderId":{"from":"text","selector":"h1","pattern":"Order #(\\S+)","group":1},
					"cartId":{"from":"attribute","selector":"[data-cart]","name":"data-cart-id"}
				}
			}
		]
	}`)
	result, err := exec.Execute(context.Background(), action, "test-step", 0)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	// Extracted values visible in varCtx for downstream interpolation.
	if got, _ := varCtx.Resolve("{{orderId}}"); got != "ABC-123" {
		t.Errorf("orderId in varCtx: got %q, want %q", got, "ABC-123")
	}
	if got, _ := varCtx.Resolve("{{cartId}}"); got != "CART-7" {
		t.Errorf("cartId in varCtx: got %q, want %q", got, "CART-7")
	}

	// And mirrored in the result summary.
	extracted, _ := result["extracted"].(map[string]interface{})
	if extracted["orderId"] != "ABC-123" {
		t.Errorf("result.extracted.orderId: got %v", extracted["orderId"])
	}
	if extracted["cartId"] != "CART-7" {
		t.Errorf("result.extracted.cartId: got %v", extracted["cartId"])
	}
}

// The killer scenario: a value extracted mid-flow is available for {{var}}
// interpolation in a LATER sub-step of the same action.
func TestUIExecutor_ExtractThenUseInLaterSubStep(t *testing.T) {
	d := &fakeDriver{}
	d.text = map[string]string{"h1.cart-id": "CART-42"}

	exec, _ := newExecutor(d)

	action := parseAction(t, `{
		"type":"ui","target":"frontend-svc",
		"steps":[
			{"extract":{"cartId":{"from":"text","selector":"h1.cart-id"}}},
			{"click":"[data-cart='{{cartId}}']"},
			{"visit":"/cart/{{cartId}}"}
		]
	}`)
	if _, err := exec.Execute(context.Background(), action, "test-step", 0); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	// click call should have the resolved cartId baked in.
	var clickArg, navArg string
	for _, c := range d.calls {
		if c.op == "click" {
			clickArg = c.args[0]
		}
		if c.op == "navigate" {
			navArg = c.args[0]
		}
	}
	if clickArg != `[data-cart='CART-42']` {
		t.Errorf("click after extract: got %q", clickArg)
	}
	if !strings.HasSuffix(navArg, "/cart/CART-42") {
		t.Errorf("navigate after extract: got %q", navArg)
	}
}

// ---------------------------------------------------------------------------
// Variable interpolation through sub-step fields
// ---------------------------------------------------------------------------

func TestUIExecutor_InterpolatesSubStepStrings(t *testing.T) {
	d := &fakeDriver{}
	exec, varCtx := newExecutor(d)
	varCtx.Set("productSku", "SKU-1234")
	varCtx.Set("userEmail", "buyer@test.com")

	action := parseAction(t, `{
		"type":"ui","target":"frontend-svc",
		"steps":[
			{"visit":"/products/{{productSku}}"},
			{"type":{"selector":"#email","text":"{{userEmail}}"}}
		]
	}`)
	if _, err := exec.Execute(context.Background(), action, "test-step", 0); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	if !strings.HasSuffix(d.calls[0].args[0], "/products/SKU-1234") {
		t.Errorf("visit interpolation: got %q", d.calls[0].args[0])
	}
	if d.calls[1].op != "type" || d.calls[1].args[1] != "buyer@test.com" {
		t.Errorf("type interpolation: got %+v", d.calls[1])
	}
}

func TestUIExecutor_UndefinedVariableErrors(t *testing.T) {
	d := &fakeDriver{}
	exec, _ := newExecutor(d)

	action := parseAction(t, `{
		"type":"ui","target":"frontend-svc",
		"steps":[{"visit":"/x/{{missingVar}}"}]
	}`)
	_, err := exec.Execute(context.Background(), action, "test-step", 0)
	if err == nil || !strings.Contains(err.Error(), "missingVar") {
		t.Fatalf("want error citing missingVar, got %v", err)
	}
}

// ---------------------------------------------------------------------------
// Error propagation + driver lifecycle
// ---------------------------------------------------------------------------

func TestUIExecutor_SubStepFailureAborts(t *testing.T) {
	d := &fakeDriver{clickErr: errors.New("element not visible")}
	exec, _ := newExecutor(d)

	action := parseAction(t, `{
		"type":"ui","target":"frontend-svc",
		"steps":[
			{"visit":"/"},
			{"click":"#submit"},
			{"visit":"/after"}
		]
	}`)
	_, err := exec.Execute(context.Background(), action, "test-step", 0)
	if err == nil {
		t.Fatal("want error from click failure")
	}
	// Later sub-steps MUST NOT run.
	for _, c := range d.calls {
		if c.op == "navigate" && c.args[0] != "http://frontend-svc.ns.svc.cluster.local/" {
			t.Errorf("sub-step after failure ran: %+v", c)
		}
	}
	exec.Close()
	if !d.closed {
		t.Error("driver should be closed after Close()")
	}
}

// ---------------------------------------------------------------------------
// Artifact pipeline integration
// ---------------------------------------------------------------------------

// captureRecord summarizes one POST /artifacts call seen by the fake CT.
type captureRecord struct {
	artifactType string
	name         string
	stepIndex    string
	subStepIndex string
	payloadLen   int
}

// fakeArtifactServer mimics CT's /artifacts endpoint enough to record what
// test-agent sends and return a plausible JSON response.
func fakeArtifactServer(t *testing.T) (*httptest.Server, *[]captureRecord) {
	t.Helper()
	var records []captureRecord
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/artifacts" {
			http.NotFound(w, r)
			return
		}
		if err := r.ParseMultipartForm(10 << 20); err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		field := func(k string) string { return r.MultipartForm.Value[k][0] }
		fileH := r.MultipartForm.File["payload"][0]
		f, err := fileH.Open()
		if err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		defer f.Close()
		body, _ := io.ReadAll(f)
		nameVals := r.MultipartForm.Value["name"]
		nameStr := ""
		if len(nameVals) > 0 {
			nameStr = nameVals[0]
		}
		records = append(records, captureRecord{
			artifactType: field("type"),
			name:         nameStr,
			stepIndex:    field("stepIndex"),
			subStepIndex: field("subStepIndex"),
			payloadLen:   len(body),
		})
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusCreated)
		fmt.Fprintf(w, `{"id":"art-%d","uri":"instances/i/artifacts/x"}`, len(records))
	}))
	t.Cleanup(srv.Close)
	return srv, &records
}

func TestUIExecutor_ScreenshotSubStepUploads(t *testing.T) {
	srv, records := fakeArtifactServer(t)
	uploader := NewArtifactUploader(srv.URL, "inst-test", 5*time.Second)

	d := &fakeDriver{screenshot: []byte("PNG-DATA")}
	varCtx := NewVariableContext()
	urlMap := map[string]URLMapEntry{"frontend-svc": {Scheme: "http", URL: "h"}}
	exec := NewUIStepExecutor("", 1280, 720, urlMap, varCtx, nil, uploader).
		WithDriverFactory(func(_ context.Context) (UIDriver, error) { return d, nil })

	action := parseAction(t, `{
		"type":"ui","target":"frontend-svc",
		"steps":[{"screenshot":"checkout-page"}]
	}`)
	if _, err := exec.Execute(context.Background(), action, "test-step", 2); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(*records) != 1 {
		t.Fatalf("want 1 upload, got %d", len(*records))
	}
	got := (*records)[0]
	if got.artifactType != "screenshot" || got.name != "checkout-page" {
		t.Errorf("wrong type/name: %+v", got)
	}
	if got.stepIndex != "2" || got.subStepIndex != "0" {
		t.Errorf("wrong position: %+v", got)
	}
	if got.payloadLen != len("PNG-DATA") {
		t.Errorf("wrong payload size: %d", got.payloadLen)
	}
}

func TestUIExecutor_ScreenshotObjectFormWithMatchUploads(t *testing.T) {
	srv, records := fakeArtifactServer(t)
	uploader := NewArtifactUploader(srv.URL, "inst-test", 5*time.Second)

	d := &fakeDriver{screenshot: []byte("PNG-FULL")}
	varCtx := NewVariableContext()
	urlMap := map[string]URLMapEntry{"frontend-svc": {Scheme: "http", URL: "h"}}
	exec := NewUIStepExecutor("", 1280, 720, urlMap, varCtx, nil, uploader).
		WithDriverFactory(func(_ context.Context) (UIDriver, error) { return d, nil })

	// Object-form screenshot with a match block → full-page capture path.
	// The match block is the cue for CT to run a post-run diff; test-agent
	// just uploads the bytes as a regular screenshot artifact.
	action := parseAction(t, `{
		"type":"ui","target":"frontend-svc",
		"steps":[{"screenshot":{"name":"checkout-page","match":{}}}]
	}`)
	if _, err := exec.Execute(context.Background(), action, "test-step", 3); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(*records) != 1 {
		t.Fatalf("want 1 upload, got %d", len(*records))
	}
	got := (*records)[0]
	if got.artifactType != "screenshot" {
		t.Errorf("want artifact type=screenshot, got %q", got.artifactType)
	}
	if got.name != "checkout-page" {
		t.Errorf("want name=checkout-page, got %q", got.name)
	}
	// No selector → full-page Screenshot, not SelectorScreenshot.
	for _, c := range d.calls {
		if c.op == "selectorScreenshot" {
			t.Errorf("no-selector screenshot should not call SelectorScreenshot, got: %+v", c)
		}
	}
}

func TestUIExecutor_ScreenshotObjectFormSelectorBoundedCapture(t *testing.T) {
	srv, records := fakeArtifactServer(t)
	uploader := NewArtifactUploader(srv.URL, "inst-test", 5*time.Second)

	d := &fakeDriver{screenshot: []byte("PNG-SEL")}
	varCtx := NewVariableContext()
	urlMap := map[string]URLMapEntry{"frontend-svc": {Scheme: "http", URL: "h"}}
	exec := NewUIStepExecutor("", 1280, 720, urlMap, varCtx, nil, uploader).
		WithDriverFactory(func(_ context.Context) (UIDriver, error) { return d, nil })

	action := parseAction(t, `{
		"type":"ui","target":"frontend-svc",
		"steps":[{"screenshot":{"name":"hero","selector":"#hero","match":{}}}]
	}`)
	if _, err := exec.Execute(context.Background(), action, "test-step", 0); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(*records) != 1 {
		t.Fatalf("want 1 upload, got %d", len(*records))
	}
	// Selector present → SelectorScreenshot path with the resolved selector.
	var sawSelector bool
	for _, c := range d.calls {
		if c.op == "selectorScreenshot" && len(c.args) > 0 && c.args[0] == "#hero" {
			sawSelector = true
		}
	}
	if !sawSelector {
		t.Errorf("want SelectorScreenshot('#hero') call, got: %+v", d.calls)
	}
}

func TestUIExecutor_FailureAutoCapturesScreenshotAndHTML(t *testing.T) {
	srv, records := fakeArtifactServer(t)
	uploader := NewArtifactUploader(srv.URL, "inst-test", 5*time.Second)

	d := &fakeDriver{
		clickErr:   errors.New("element not visible"),
		screenshot: []byte("PNG-FAIL"),
	}
	varCtx := NewVariableContext()
	urlMap := map[string]URLMapEntry{"frontend-svc": {Scheme: "http", URL: "h"}}
	exec := NewUIStepExecutor("", 1280, 720, urlMap, varCtx, nil, uploader).
		WithDriverFactory(func(_ context.Context) (UIDriver, error) { return d, nil })

	action := parseAction(t, `{
		"type":"ui","target":"frontend-svc",
		"steps":[
			{"visit":"/"},
			{"click":"#submit"}
		]
	}`)
	_, err := exec.Execute(context.Background(), action, "test-step", 4)
	if err == nil {
		t.Fatal("want error from click failure")
	}

	// Two artifacts: failure screenshot + failure HTML, pinned to the
	// position of the failed click sub-step (1.4.1). The screenshot
	// carries a descriptive name; HTML remains nameless.
	if len(*records) != 2 {
		t.Fatalf("want 2 failure artifacts, got %d: %+v", len(*records), *records)
	}
	for _, r := range *records {
		if r.artifactType == "screenshot" && r.name == "" {
			t.Errorf("failure screenshot should have a descriptive name, got empty")
		}
		if r.artifactType == "html" && r.name != "" {
			t.Errorf("failure HTML must be nameless, got name=%q", r.name)
		}
		if r.stepIndex != "4" || r.subStepIndex != "1" {
			t.Errorf("wrong failure position: %+v", r)
		}
	}
	types := []string{(*records)[0].artifactType, (*records)[1].artifactType}
	if !((types[0] == "screenshot" && types[1] == "html") ||
		(types[0] == "html" && types[1] == "screenshot")) {
		t.Errorf("want one screenshot + one html, got %v", types)
	}
}

// ---------------------------------------------------------------------------
// Per-sub-step timeout override
// ---------------------------------------------------------------------------

func TestResolveSubStepTimeout(t *testing.T) {
	cases := []struct {
		name string
		sub  UISubStep
		want time.Duration
	}{
		{"unset uses default", UISubStep{Kind: UISubClick, Click: "x"}, defaultUISubStepTimeout},
		{"zero uses default", UISubStep{Kind: UISubClick, Click: "x", TimeoutMs: 0}, defaultUISubStepTimeout},
		{"override 5s", UISubStep{Kind: UISubWaitFor, TimeoutMs: 5000}, 5 * time.Second},
		{"override 250ms", UISubStep{Kind: UISubVisit, TimeoutMs: 250}, 250 * time.Millisecond},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if got := resolveSubStepTimeout(c.sub); got != c.want {
				t.Errorf("got %v, want %v", got, c.want)
			}
		})
	}
}

func TestUISubStep_TimeoutMsRoundTrip(t *testing.T) {
	wire := []byte(`{"click":"[data-testid='go']","timeoutMs":5000}`)
	var s UISubStep
	if err := json.Unmarshal(wire, &s); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if s.Kind != UISubClick || s.Click != "[data-testid='go']" || s.TimeoutMs != 5000 {
		t.Fatalf("unexpected sub-step: %+v", s)
	}
	out, err := json.Marshal(s)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	var round map[string]interface{}
	if err := json.Unmarshal(out, &round); err != nil {
		t.Fatalf("re-unmarshal: %v", err)
	}
	if round["click"] != "[data-testid='go']" {
		t.Errorf("click field lost in marshal: %v", round)
	}
	if v, _ := round["timeoutMs"].(float64); int(v) != 5000 {
		t.Errorf("timeoutMs field lost in marshal: %v", round)
	}
}

func TestUISubStep_OmitsTimeoutMsWhenUnset(t *testing.T) {
	s := UISubStep{Kind: UISubClick, Click: "x"}
	out, err := json.Marshal(s)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	if strings.Contains(string(out), "timeoutMs") {
		t.Errorf("expected no timeoutMs when unset; got %s", string(out))
	}
}
