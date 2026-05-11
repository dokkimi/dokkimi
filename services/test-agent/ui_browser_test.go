package main

import (
	"context"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"
)

// These tests exercise BrowserClient against a real chromium reachable via CDP.
// They are skipped unless DOKKIMI_UI_BROWSER_URL is set (e.g. for local dev
// after starting `docker run -p 9222:9222 chromedp/headless-shell:latest`).
//
// CI will wire this up once the chromium sidecar pod deployment lands; until
// then the rest of the package still compiles and the extract/regex/URL tests
// run without chromium.
func browserURL(t *testing.T) string {
	t.Helper()
	u := os.Getenv("DOKKIMI_UI_BROWSER_URL")
	if u == "" {
		t.Skip("DOKKIMI_UI_BROWSER_URL not set — skipping browser integration test")
	}
	return u
}

// newTestClient spins up a BrowserClient with a short-lived parent context
// and returns a cleanup function.
func newTestClient(t *testing.T) (*BrowserClient, func()) {
	t.Helper()
	u := browserURL(t)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	c, err := NewBrowserClient(ctx, u, 1280, 720)
	if err != nil {
		cancel()
		t.Fatalf("NewBrowserClient(%q): %v", u, err)
	}
	return c, func() {
		c.Close()
		cancel()
	}
}

// reachableFixtureURL returns a URL for the given httptest server that the
// chromium sidecar (running in Docker) can reach. chromium can't hit the host's
// 127.0.0.1 loopback, so we swap in DOKKIMI_UI_TEST_HOST (default:
// host.docker.internal, which Docker Desktop bridges automatically).
func reachableFixtureURL(t *testing.T, srv *httptest.Server) string {
	t.Helper()
	host := os.Getenv("DOKKIMI_UI_TEST_HOST")
	if host == "" {
		host = "host.docker.internal"
	}
	return rewriteHost(t, srv.URL, host)
}

// fixtureServer serves a small HTML page for BrowserClient tests.
func fixtureServer() *httptest.Server {
	mux := http.NewServeMux()
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/html")
		_, _ = w.Write([]byte(`<!doctype html>
<html>
<head><title>fixture</title></head>
<body>
  <h1 data-testid="heading">Order #ABC-123</h1>
  <input id="email" value="prefilled" />
  <div data-cart-id="CART-7">drawer</div>
  <ul id="items">
    <li class="item">one</li>
    <li class="item">two</li>
    <li class="item">three</li>
  </ul>
  <a id="cta" href="/dest">go</a>
  <script>
    localStorage.setItem("draft", "saved-draft");
    sessionStorage.setItem("flash", "ok");
  </script>
</body>
</html>`))
	})
	mux.HandleFunc("/dest", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/html")
		_, _ = w.Write([]byte(`<!doctype html><html><body><p data-testid="done">arrived</p></body></html>`))
	})
	return httptest.NewServer(mux)
}

func TestBrowserClient_NavigateAndText(t *testing.T) {
	c, cleanup := newTestClient(t)
	defer cleanup()

	srv := fixtureServer()
	defer srv.Close()

	fixtureURL := reachableFixtureURL(t, srv)
	if err := c.Navigate(fixtureURL+"/", 10*time.Second); err != nil {
		t.Fatalf("Navigate: %v", err)
	}
	got, err := c.Text(`[data-testid="heading"]`, 5*time.Second)
	if err != nil {
		t.Fatalf("Text: %v", err)
	}
	if !strings.Contains(got, "Order #ABC-123") {
		t.Errorf("heading text: got %q", got)
	}
}

func TestBrowserClient_AttributeCountExists(t *testing.T) {
	c, cleanup := newTestClient(t)
	defer cleanup()

	srv := fixtureServer()
	defer srv.Close()

	fixtureURL := reachableFixtureURL(t, srv)
	if err := c.Navigate(fixtureURL+"/", 10*time.Second); err != nil {
		t.Fatalf("Navigate: %v", err)
	}

	attr, err := c.AttributeValue(`[data-cart-id]`, "data-cart-id", 5*time.Second)
	if err != nil {
		t.Fatalf("AttributeValue: %v", err)
	}
	if attr != "CART-7" {
		t.Errorf("attr: got %q", attr)
	}

	count, err := c.Count("li.item", 5*time.Second)
	if err != nil {
		t.Fatalf("Count: %v", err)
	}
	if count != 3 {
		t.Errorf("count: got %d, want 3", count)
	}

	exists, err := c.Exists("#cta", 5*time.Second)
	if err != nil {
		t.Fatalf("Exists #cta: %v", err)
	}
	if !exists {
		t.Error("#cta should exist")
	}

	missing, err := c.Exists("#nope", 5*time.Second)
	if err != nil {
		t.Fatalf("Exists #nope: %v", err)
	}
	if missing {
		t.Error("#nope should not exist")
	}
}

func TestBrowserClient_StorageAndLocation(t *testing.T) {
	c, cleanup := newTestClient(t)
	defer cleanup()

	srv := fixtureServer()
	defer srv.Close()

	fixtureURL := reachableFixtureURL(t, srv)
	if err := c.Navigate(fixtureURL+"/", 10*time.Second); err != nil {
		t.Fatalf("Navigate: %v", err)
	}

	draft, err := c.LocalStorageItem("draft", 5*time.Second)
	if err != nil {
		t.Fatalf("LocalStorageItem: %v", err)
	}
	if draft != "saved-draft" {
		t.Errorf("localStorage: got %q", draft)
	}

	flash, err := c.SessionStorageItem("flash", 5*time.Second)
	if err != nil {
		t.Fatalf("SessionStorageItem: %v", err)
	}
	if flash != "ok" {
		t.Errorf("sessionStorage: got %q", flash)
	}

	loc, err := c.Location(5 * time.Second)
	if err != nil {
		t.Fatalf("Location: %v", err)
	}
	if !strings.HasPrefix(loc, fixtureURL) {
		t.Errorf("Location: got %q, want prefix %q", loc, fixtureURL)
	}
}

func TestBrowserClient_ClickAndWaitForText(t *testing.T) {
	c, cleanup := newTestClient(t)
	defer cleanup()

	srv := fixtureServer()
	defer srv.Close()

	fixtureURL := reachableFixtureURL(t, srv)
	if err := c.Navigate(fixtureURL+"/", 10*time.Second); err != nil {
		t.Fatalf("Navigate: %v", err)
	}
	if err := c.Click("#cta", 5*time.Second); err != nil {
		t.Fatalf("Click: %v", err)
	}
	if err := c.WaitForText(`[data-testid="done"]`, "arrived", 5*time.Second); err != nil {
		t.Fatalf("WaitForText: %v", err)
	}
}

func TestBrowserClient_Screenshot(t *testing.T) {
	c, cleanup := newTestClient(t)
	defer cleanup()

	srv := fixtureServer()
	defer srv.Close()

	fixtureURL := reachableFixtureURL(t, srv)
	if err := c.Navigate(fixtureURL+"/", 10*time.Second); err != nil {
		t.Fatalf("Navigate: %v", err)
	}
	png, err := c.Screenshot(90, 10*time.Second)
	if err != nil {
		t.Fatalf("Screenshot: %v", err)
	}
	if len(png) < 100 {
		t.Errorf("screenshot too small: %d bytes", len(png))
	}
	// PNG magic: 0x89 P N G
	if !(png[0] == 0x89 && png[1] == 'P' && png[2] == 'N' && png[3] == 'G') {
		t.Errorf("screenshot does not look like PNG: %x", png[:8])
	}
}
