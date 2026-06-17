package main

import (
	"errors"
	"strings"
	"testing"
	"time"
)

// fakeBrowser implements BrowserReader for unit tests — no chromium required.
type fakeBrowser struct {
	text           map[string]string
	attrs          map[string]map[string]string
	values         map[string]string
	counts         map[string]int
	exists         map[string]bool
	location       string
	cookies        map[string]string
	localStorage   map[string]string
	sessionStorage map[string]string
	readErr        error
}

func (f *fakeBrowser) Text(sel string, _ time.Duration) (string, error) {
	if f.readErr != nil {
		return "", f.readErr
	}
	return f.text[sel], nil
}

func (f *fakeBrowser) AttributeValue(sel, attr string, _ time.Duration) (string, error) {
	if f.readErr != nil {
		return "", f.readErr
	}
	if m, ok := f.attrs[sel]; ok {
		return m[attr], nil
	}
	return "", nil
}

func (f *fakeBrowser) InputValue(sel string, _ time.Duration) (string, error) {
	if f.readErr != nil {
		return "", f.readErr
	}
	return f.values[sel], nil
}

func (f *fakeBrowser) Count(sel string, _ time.Duration) (int, error) {
	if f.readErr != nil {
		return 0, f.readErr
	}
	return f.counts[sel], nil
}

func (f *fakeBrowser) Exists(sel string, _ time.Duration) (bool, error) {
	if f.readErr != nil {
		return false, f.readErr
	}
	return f.exists[sel], nil
}

func (f *fakeBrowser) Location(_ time.Duration) (string, error) {
	if f.readErr != nil {
		return "", f.readErr
	}
	return f.location, nil
}

func (f *fakeBrowser) Cookie(name string, _ time.Duration) (string, error) {
	if f.readErr != nil {
		return "", f.readErr
	}
	return f.cookies[name], nil
}

func (f *fakeBrowser) LocalStorageItem(key string, _ time.Duration) (string, error) {
	if f.readErr != nil {
		return "", f.readErr
	}
	return f.localStorage[key], nil
}

func (f *fakeBrowser) SessionStorageItem(key string, _ time.Duration) (string, error) {
	if f.readErr != nil {
		return "", f.readErr
	}
	return f.sessionStorage[key], nil
}

// ---------------------------------------------------------------------------
// Per-from extraction
// ---------------------------------------------------------------------------

func TestExtract_Text(t *testing.T) {
	b := &fakeBrowser{text: map[string]string{"h1": "  Welcome!  "}}
	got, err := NewUIExtractor(b, 0).Extract(UIExtractSource{
		From: UIExtractFromText, Selector: "h1",
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if got != "Welcome!" {
		t.Errorf("want %q, got %q", "Welcome!", got)
	}
}

func TestExtract_TextWithRegex(t *testing.T) {
	b := &fakeBrowser{text: map[string]string{"h1": "Order #ABC-123 created"}}
	got, err := NewUIExtractor(b, 0).Extract(UIExtractSource{
		From:     UIExtractFromText,
		Selector: "h1",
		Pattern:  `Order #(\S+)`,
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if got != "ABC-123" {
		t.Errorf("want %q, got %q", "ABC-123", got)
	}
}

func TestExtract_Attribute(t *testing.T) {
	b := &fakeBrowser{attrs: map[string]map[string]string{
		"[data-cart]": {"data-cart-id": "CART-99"},
	}}
	got, err := NewUIExtractor(b, 0).Extract(UIExtractSource{
		From: UIExtractFromAttribute, Selector: "[data-cart]", Name: "data-cart-id",
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if got != "CART-99" {
		t.Errorf("want %q, got %q", "CART-99", got)
	}
}

func TestExtract_AttributeRequiresName(t *testing.T) {
	b := &fakeBrowser{}
	_, err := NewUIExtractor(b, 0).Extract(UIExtractSource{
		From: UIExtractFromAttribute, Selector: "[x]",
	})
	if err == nil {
		t.Fatal("want error for missing name, got nil")
	}
	if !strings.Contains(err.Error(), `requires "name"`) {
		t.Errorf("unexpected error message: %v", err)
	}
}

func TestExtract_InputValue(t *testing.T) {
	b := &fakeBrowser{values: map[string]string{"#email": "a@b.c"}}
	got, err := NewUIExtractor(b, 0).Extract(UIExtractSource{
		From: UIExtractFromValue, Selector: "#email",
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if got != "a@b.c" {
		t.Errorf("want %q, got %q", "a@b.c", got)
	}
}

func TestExtract_URLWholeURL(t *testing.T) {
	b := &fakeBrowser{location: "https://example.com/orders/42?ref=1#top"}
	got, err := NewUIExtractor(b, 0).Extract(UIExtractSource{From: UIExtractFromURL})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if got != "https://example.com/orders/42?ref=1#top" {
		t.Errorf("got %q", got)
	}
}

func TestExtract_URLPathname(t *testing.T) {
	b := &fakeBrowser{location: "https://example.com/orders/42?ref=1"}
	got, err := NewUIExtractor(b, 0).Extract(UIExtractSource{
		From: UIExtractFromURL, Part: UIURLPartPathname,
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if got != "/orders/42" {
		t.Errorf("want %q, got %q", "/orders/42", got)
	}
}

func TestExtract_Cookie(t *testing.T) {
	b := &fakeBrowser{cookies: map[string]string{"sid": "xyz"}}
	got, err := NewUIExtractor(b, 0).Extract(UIExtractSource{
		From: UIExtractFromCookie, Name: "sid",
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if got != "xyz" {
		t.Errorf("want %q, got %q", "xyz", got)
	}
}

func TestExtract_LocalStorage(t *testing.T) {
	b := &fakeBrowser{localStorage: map[string]string{"cart.draft": "hello"}}
	got, err := NewUIExtractor(b, 0).Extract(UIExtractSource{
		From: UIExtractFromLocalStorage, Key: "cart.draft",
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if got != "hello" {
		t.Errorf("want %q, got %q", "hello", got)
	}
}

func TestExtract_SessionStorage(t *testing.T) {
	b := &fakeBrowser{sessionStorage: map[string]string{"flash": "saved"}}
	got, err := NewUIExtractor(b, 0).Extract(UIExtractSource{
		From: UIExtractFromSessionStorage, Key: "flash",
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if got != "saved" {
		t.Errorf("want %q, got %q", "saved", got)
	}
}

func TestExtract_Count(t *testing.T) {
	b := &fakeBrowser{counts: map[string]int{"li.item": 7}}
	got, err := NewUIExtractor(b, 0).Extract(UIExtractSource{
		From: UIExtractFromCount, Selector: "li.item",
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if got != 7 {
		t.Errorf("want 7 (int), got %v (%T)", got, got)
	}
}

func TestExtract_CountWithRegex(t *testing.T) {
	b := &fakeBrowser{counts: map[string]int{"li.item": 42}}
	group := 1
	got, err := NewUIExtractor(b, 0).Extract(UIExtractSource{
		From: UIExtractFromCount, Selector: "li.item",
		Pattern: `(\d)`, Group: &group,
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if got != "4" {
		t.Errorf("want %q (string via regex), got %v (%T)", "4", got, got)
	}
}

func TestExtract_ExistsTrue(t *testing.T) {
	b := &fakeBrowser{exists: map[string]bool{"[data-cta]": true}}
	got, err := NewUIExtractor(b, 0).Extract(UIExtractSource{
		From: UIExtractFromExists, Selector: "[data-cta]",
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if got != true {
		t.Errorf("want true (bool), got %v (%T)", got, got)
	}
}

func TestExtract_ExistsFalse(t *testing.T) {
	b := &fakeBrowser{}
	got, err := NewUIExtractor(b, 0).Extract(UIExtractSource{
		From: UIExtractFromExists, Selector: "[missing]",
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if got != false {
		t.Errorf("want false (bool), got %v (%T)", got, got)
	}
}

func TestExtract_UnknownFromErrors(t *testing.T) {
	b := &fakeBrowser{}
	_, err := NewUIExtractor(b, 0).Extract(UIExtractSource{From: UIExtractFrom("bogus")})
	if err == nil {
		t.Fatal("want error for unknown from, got nil")
	}
}

func TestExtract_MissingSelectorErrors(t *testing.T) {
	b := &fakeBrowser{}
	cases := []UIExtractFrom{
		UIExtractFromText, UIExtractFromValue, UIExtractFromCount, UIExtractFromExists,
	}
	for _, from := range cases {
		_, err := NewUIExtractor(b, 0).Extract(UIExtractSource{From: from})
		if err == nil {
			t.Errorf("from=%q: want error for missing selector, got nil", from)
		}
	}
}

func TestExtract_MissingKeyErrors(t *testing.T) {
	b := &fakeBrowser{}
	for _, from := range []UIExtractFrom{UIExtractFromLocalStorage, UIExtractFromSessionStorage} {
		_, err := NewUIExtractor(b, 0).Extract(UIExtractSource{From: from})
		if err == nil {
			t.Errorf("from=%q: want error for missing key, got nil", from)
		}
	}
}

func TestExtract_BrowserReadErrorPropagates(t *testing.T) {
	readErr := errors.New("boom")
	b := &fakeBrowser{readErr: readErr}
	_, err := NewUIExtractor(b, 0).Extract(UIExtractSource{
		From: UIExtractFromText, Selector: "h1",
	})
	if !errors.Is(err, readErr) {
		t.Errorf("want wrapped readErr, got %v", err)
	}
}
