package main

import (
	"bytes"
	"encoding/json"
	"testing"
)

// ---------------------------------------------------------------------------
// applyExtractRegex
// ---------------------------------------------------------------------------

func TestApplyExtractRegex_NoPatternTrims(t *testing.T) {
	got, err := applyExtractRegex("  hello  ", "", 0)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if got != "hello" {
		t.Errorf("want %q, got %q", "hello", got)
	}
}

func TestApplyExtractRegex_WholeMatchGroup0(t *testing.T) {
	got, err := applyExtractRegex("Order #ABC-123 created", `Order #\S+`, 0)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if got != "Order #ABC-123" {
		t.Errorf("want %q, got %q", "Order #ABC-123", got)
	}
}

func TestApplyExtractRegex_CaptureGroup1(t *testing.T) {
	got, err := applyExtractRegex("Order #ABC-123 created", `Order #(\S+)`, 1)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if got != "ABC-123" {
		t.Errorf("want %q, got %q", "ABC-123", got)
	}
}

func TestApplyExtractRegex_CompileError(t *testing.T) {
	_, err := applyExtractRegex("irrelevant", `[unclosed`, 0)
	if err == nil {
		t.Fatal("want compile error, got nil")
	}
}

func TestApplyExtractRegex_NoMatch(t *testing.T) {
	_, err := applyExtractRegex("nope", `foo-(\d+)`, 1)
	if err == nil {
		t.Fatal("want no-match error, got nil")
	}
}

func TestApplyExtractRegex_GroupOutOfRange(t *testing.T) {
	_, err := applyExtractRegex("abc", `(a)(b)`, 5)
	if err == nil {
		t.Fatal("want out-of-range error, got nil")
	}
}

// ---------------------------------------------------------------------------
// resolveExtractGroup
// ---------------------------------------------------------------------------

func TestResolveExtractGroup_ExplicitWins(t *testing.T) {
	g := 3
	if got := resolveExtractGroup(&g, true); got != 3 {
		t.Errorf("want 3, got %d", got)
	}
	if got := resolveExtractGroup(&g, false); got != 3 {
		t.Errorf("want 3, got %d", got)
	}
}

func TestResolveExtractGroup_DefaultWithPattern(t *testing.T) {
	if got := resolveExtractGroup(nil, true); got != 1 {
		t.Errorf("want 1, got %d", got)
	}
}

func TestResolveExtractGroup_DefaultWithoutPattern(t *testing.T) {
	if got := resolveExtractGroup(nil, false); got != 0 {
		t.Errorf("want 0, got %d", got)
	}
}

// ---------------------------------------------------------------------------
// extractURLPart
// ---------------------------------------------------------------------------

func TestExtractURLPart(t *testing.T) {
	raw := "https://example.com:8080/orders/42?ref=abc#section"

	cases := []struct {
		part UIExtractURLPart
		want string
	}{
		{UIURLPartFull, raw},
		{"", raw},
		{UIURLPartPathname, "/orders/42"},
		{UIURLPartSearch, "?ref=abc"},
		{UIURLPartHash, "#section"},
		{UIURLPartHost, "example.com:8080"},
	}

	for _, tc := range cases {
		got, err := extractURLPart(raw, tc.part)
		if err != nil {
			t.Errorf("part=%q unexpected error: %v", tc.part, err)
			continue
		}
		if got != tc.want {
			t.Errorf("part=%q: want %q, got %q", tc.part, tc.want, got)
		}
	}
}

func TestExtractURLPart_EmptyQueryAndHash(t *testing.T) {
	raw := "https://example.com/foo"
	if got, _ := extractURLPart(raw, UIURLPartSearch); got != "" {
		t.Errorf("empty search: want %q, got %q", "", got)
	}
	if got, _ := extractURLPart(raw, UIURLPartHash); got != "" {
		t.Errorf("empty hash: want %q, got %q", "", got)
	}
}

func TestExtractURLPart_UnknownPart(t *testing.T) {
	if _, err := extractURLPart("https://example.com", UIExtractURLPart("bogus")); err == nil {
		t.Fatal("want error for unknown part, got nil")
	}
}

// ---------------------------------------------------------------------------
// resolveUIPath
// ---------------------------------------------------------------------------

func TestResolveUIPath(t *testing.T) {
	cases := []struct {
		base, path, want string
	}{
		{"http://svc", "/orders", "http://svc/orders"},
		{"http://svc/", "/orders", "http://svc/orders"},
		{"http://svc", "orders", "http://svc/orders"},
		{"http://svc", "", "http://svc"},
		{"http://svc", "http://other/path", "http://other/path"},
		{"", "https://example.com", "https://example.com"},
	}
	for _, tc := range cases {
		got, err := resolveUIPath(tc.base, tc.path)
		if err != nil {
			t.Errorf("base=%q path=%q unexpected error: %v", tc.base, tc.path, err)
			continue
		}
		if got != tc.want {
			t.Errorf("base=%q path=%q: want %q, got %q", tc.base, tc.path, tc.want, got)
		}
	}
}

func TestResolveUIPath_RelativeWithoutBaseErrors(t *testing.T) {
	if _, err := resolveUIPath("", "/orders"); err == nil {
		t.Fatal("want error for relative path without baseURL, got nil")
	}
}

// ---------------------------------------------------------------------------
// UISubStep JSON round-trip
// ---------------------------------------------------------------------------

func TestUISubStep_UnmarshalVisit(t *testing.T) {
	var s UISubStep
	if err := json.Unmarshal([]byte(`{"visit":"/login"}`), &s); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if s.Kind != UISubVisit || s.Visit != "/login" {
		t.Errorf("got kind=%q visit=%q", s.Kind, s.Visit)
	}
}

func TestUISubStep_UnmarshalClick(t *testing.T) {
	var s UISubStep
	if err := json.Unmarshal(
		[]byte(`{"click":"[data-testid='submit']"}`),
		&s,
	); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if s.Kind != UISubClick || s.Click != "[data-testid='submit']" {
		t.Errorf("got kind=%q click=%q", s.Kind, s.Click)
	}
}

func TestUISubStep_UnmarshalType(t *testing.T) {
	var s UISubStep
	data := []byte(`{"type":{"selector":"#email","text":"a@b.c"}}`)
	if err := json.Unmarshal(data, &s); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if s.Kind != UISubType {
		t.Errorf("kind: want %q, got %q", UISubType, s.Kind)
	}
	if s.Type == nil || s.Type.Selector != "#email" || s.Type.Text != "a@b.c" {
		t.Errorf("type payload mismatch: %+v", s.Type)
	}
}

func TestUISubStep_UnmarshalWaitForString(t *testing.T) {
	var s UISubStep
	if err := json.Unmarshal(
		[]byte(`{"waitFor":"[data-testid='dashboard']"}`),
		&s,
	); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if s.Kind != UISubWaitFor {
		t.Fatalf("kind: want %q, got %q", UISubWaitFor, s.Kind)
	}
	if s.WaitFor == nil || s.WaitFor.Selector != "[data-testid='dashboard']" {
		t.Errorf("waitFor payload: %+v", s.WaitFor)
	}
	if s.WaitFor.Text != "" {
		t.Errorf("waitFor text should be empty, got %q", s.WaitFor.Text)
	}
}

func TestUISubStep_UnmarshalWaitForObject(t *testing.T) {
	var s UISubStep
	data := []byte(`{"waitFor":{"selector":"[data-x]","text":"1"}}`)
	if err := json.Unmarshal(data, &s); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if s.WaitFor == nil || s.WaitFor.Selector != "[data-x]" || s.WaitFor.Text != "1" {
		t.Errorf("waitFor payload: %+v", s.WaitFor)
	}
}

func TestUISubStep_UnmarshalExtract(t *testing.T) {
	var s UISubStep
	data := []byte(`{"extract":{"orderId":{"from":"text","selector":"h1","pattern":"Order #(\\S+)","group":1}}}`)
	if err := json.Unmarshal(data, &s); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if s.Kind != UISubExtract {
		t.Fatalf("kind: want %q, got %q", UISubExtract, s.Kind)
	}
	src, ok := s.Extract["orderId"]
	if !ok {
		t.Fatal("orderId not present in extract map")
	}
	if src.From != UIExtractFromText || src.Selector != "h1" || src.Pattern != "Order #(\\S+)" {
		t.Errorf("extract source: %+v", src)
	}
	if src.Group == nil || *src.Group != 1 {
		t.Errorf("extract group: want 1, got %v", src.Group)
	}
}

func TestUISubStep_UnmarshalScreenshotShortForm(t *testing.T) {
	var s UISubStep
	if err := json.Unmarshal([]byte(`{"screenshot":"done"}`), &s); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if s.Kind != UISubScreenshot {
		t.Errorf("kind=%q", s.Kind)
	}
	if s.Screenshot == nil || s.Screenshot.Name != "done" {
		t.Errorf("screenshot=%+v", s.Screenshot)
	}
	if s.Screenshot.Selector != "" || s.Screenshot.Match != nil {
		t.Errorf("short-form should leave selector/match unset, got %+v", s.Screenshot)
	}
}

func TestUISubStep_UnmarshalScreenshotMatchBooleanForm(t *testing.T) {
	cases := []struct {
		name     string
		body     string
		wantNil  bool
		wantOpts bool // true when Match should be a non-nil empty struct
	}{
		{"match true", `{"screenshot":{"name":"x","match":true}}`, false, true},
		{"match false", `{"screenshot":{"name":"x","match":false}}`, true, false},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			var s UISubStep
			if err := json.Unmarshal([]byte(c.body), &s); err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
			if c.wantNil {
				if s.Screenshot == nil {
					t.Fatal("screenshot itself unexpectedly nil")
				}
				if s.Screenshot.Match != nil {
					t.Errorf("want match=nil for false form, got %+v", s.Screenshot.Match)
				}
				return
			}
			if s.Screenshot == nil || s.Screenshot.Match == nil {
				t.Fatalf("want non-nil match for true form, got screenshot=%+v", s.Screenshot)
			}
			if c.wantOpts {
				if s.Screenshot.Match.Threshold != nil ||
					len(s.Screenshot.Match.IgnoreRegions) != 0 {
					t.Errorf("want empty match opts, got %+v", s.Screenshot.Match)
				}
			}
		})
	}
}

func TestUISubStep_MarshalScreenshotMatchEmitsBooleanWhenNoOverrides(t *testing.T) {
	s := UISubStep{
		Kind: UISubScreenshot,
		Screenshot: &UIScreenshotStep{
			Name:  "x",
			Match: &UIScreenshotMatch{},
		},
	}
	out, err := json.Marshal(s)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	if !bytes.Contains(out, []byte(`"match":true`)) {
		t.Errorf("want match emitted as boolean true, got: %s", out)
	}
}

func TestUISubStep_UnmarshalScreenshotObjectFormWithMatch(t *testing.T) {
	var s UISubStep
	body := `{"screenshot":{"name":"checkout","selector":"#main","match":{"threshold":0.02,"ignoreRegions":[".ts"]}}}`
	if err := json.Unmarshal([]byte(body), &s); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if s.Kind != UISubScreenshot {
		t.Fatalf("kind=%q", s.Kind)
	}
	if s.Screenshot == nil {
		t.Fatal("screenshot nil")
	}
	if s.Screenshot.Name != "checkout" || s.Screenshot.Selector != "#main" {
		t.Errorf("screenshot=%+v", s.Screenshot)
	}
	if s.Screenshot.Match == nil {
		t.Fatal("match block missing")
	}
	if s.Screenshot.Match.Threshold == nil || *s.Screenshot.Match.Threshold != 0.02 {
		t.Errorf("threshold: %+v", s.Screenshot.Match.Threshold)
	}
	if len(s.Screenshot.Match.IgnoreRegions) != 1 || s.Screenshot.Match.IgnoreRegions[0] != ".ts" {
		t.Errorf("ignoreRegions: %+v", s.Screenshot.Match.IgnoreRegions)
	}
}

func TestUISubStep_UnmarshalNoKindErrors(t *testing.T) {
	var s UISubStep
	err := json.Unmarshal([]byte(`{"nothing":"here"}`), &s)
	if err == nil {
		t.Fatal("want error for no-kind, got nil")
	}
}

func TestUISubStep_UnmarshalMultipleKindErrors(t *testing.T) {
	var s UISubStep
	err := json.Unmarshal([]byte(`{"visit":"/","click":"[x]"}`), &s)
	if err == nil {
		t.Fatal("want error for multiple kinds, got nil")
	}
}

func TestUISubStep_MarshalVisit(t *testing.T) {
	s := UISubStep{Kind: UISubVisit, Visit: "/foo"}
	b, err := json.Marshal(s)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if string(b) != `{"visit":"/foo"}` {
		t.Errorf("got %s", b)
	}
}

func TestUISubStep_MarshalWaitForStringWhenNoText(t *testing.T) {
	s := UISubStep{Kind: UISubWaitFor, WaitFor: &UIWaitForStep{Selector: "#a"}}
	b, err := json.Marshal(s)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if string(b) != `{"waitFor":"#a"}` {
		t.Errorf("got %s", b)
	}
}

func TestUISubStep_MarshalWaitForObjectWhenTextSet(t *testing.T) {
	s := UISubStep{Kind: UISubWaitFor, WaitFor: &UIWaitForStep{Selector: "#a", Text: "1"}}
	b, err := json.Marshal(s)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	// Object form; specific field order isn't important, so assert round-trip.
	var back UISubStep
	if err := json.Unmarshal(b, &back); err != nil {
		t.Fatalf("round-trip unmarshal: %v", err)
	}
	if back.WaitFor == nil || back.WaitFor.Selector != "#a" || back.WaitFor.Text != "1" {
		t.Errorf("round-trip mismatch: %+v", back.WaitFor)
	}
}

// Acceptance: the full worked-example UI action from UI_E2E_TESTING.md parses
// without error and retains all fields.
func TestUIAction_UnmarshalWorkedExample(t *testing.T) {
	data := []byte(`{
	  "target": "frontend-svc",
	  "steps": [
	    { "visit": "/products/{{productSku}}" },
	    { "click": "[data-testid='add-to-cart']" },
	    { "waitFor": { "selector": "[data-testid='cart-count']", "text": "1" } },
	    {
	      "extract": {
	        "cartId": {
	          "selector": "[data-testid='cart-drawer']",
	          "from": "attribute",
	          "name": "data-cart-id"
	        }
	      }
	    },
	    { "click": "[data-testid='checkout-btn']" },
	    { "waitFor": "[data-testid='order-confirmation']" },
	    {
	      "extract": {
	        "orderId": {
	          "selector": "h1.order-heading",
	          "from": "text",
	          "pattern": "Order #(\\S+)",
	          "group": 1
	        }
	      }
	    },
	    { "screenshot": "order-confirmation" }
	  ]
	}`)

	var a UIAction
	if err := json.Unmarshal(data, &a); err != nil {
		t.Fatalf("worked example failed to parse: %v", err)
	}
	if a.Target != "frontend-svc" {
		t.Errorf("target: got %q", a.Target)
	}
	if len(a.Steps) != 8 {
		t.Fatalf("want 8 sub-steps, got %d", len(a.Steps))
	}
	kinds := []UISubStepKind{
		UISubVisit, UISubClick, UISubWaitFor, UISubExtract,
		UISubClick, UISubWaitFor, UISubExtract, UISubScreenshot,
	}
	for i, want := range kinds {
		if a.Steps[i].Kind != want {
			t.Errorf("step %d kind: want %q, got %q", i, want, a.Steps[i].Kind)
		}
	}
}
