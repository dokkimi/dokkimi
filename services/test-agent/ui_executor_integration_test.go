package main

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"strings"
	"testing"
	"time"
)

// Full end-to-end smoke test: exercises UIStepExecutor against a real chromium
// sidecar (via DOKKIMI_UI_BROWSER_URL) and a local httptest fixture. Skips
// unless chromium is configured, so `go test ./...` stays green without Docker.
//
// Host-reachability: chromium running in Docker cannot reach the host's
// 127.0.0.1. The test rewrites the fixture URL's host to DOKKIMI_UI_TEST_HOST
// (defaults to host.docker.internal, which Docker Desktop resolves automatically
// on Mac and Linux with --add-host=host.docker.internal:host-gateway).

func TestUIExecutor_Integration_FullFlow(t *testing.T) {
	browserURL := os.Getenv("DOKKIMI_UI_BROWSER_URL")
	if browserURL == "" {
		t.Skip("DOKKIMI_UI_BROWSER_URL not set — skipping smoke test")
	}

	srv := smokeFixtureServer()
	defer srv.Close()

	// Rewrite httptest loopback host so chromium-in-Docker can reach it.
	testHost := os.Getenv("DOKKIMI_UI_TEST_HOST")
	if testHost == "" {
		testHost = "host.docker.internal"
	}
	reachableURL := rewriteHost(t, srv.URL, testHost)
	// URLMap stores scheme separately; strip it from the entry URL.
	parsed, err := url.Parse(reachableURL)
	if err != nil {
		t.Fatalf("parse reachable URL: %v", err)
	}
	urlMap := map[string]URLMapEntry{
		"frontend-svc": {Scheme: parsed.Scheme, URL: parsed.Host, Name: "frontend-svc"},
	}

	varCtx := NewVariableContext()
	varCtx.Set("userEmail", "buyer@test.com")
	varCtx.Set("productSku", "SKU-1234")

	exec := NewUIStepExecutor(browserURL, 1280, 720, urlMap, varCtx, nil, nil)

	// Exercise the full sub-step vocabulary: visit, type, click, waitFor (both
	// forms), extract (text + attribute + regex), screenshot. Interpolates
	// {{productSku}} and {{userEmail}}. Later sub-steps use {{orderId}} that's
	// extracted mid-flow.
	action := parseSmokeAction(t, `{
		"type": "ui",
		"target": "frontend-svc",
		"steps": [
			{ "visit": "/login" },
			{ "type": { "selector": "#email", "text": "{{userEmail}}" } },
			{ "click": "#submit" },
			{ "waitFor": "#dashboard" },
			{ "visit": "/products/{{productSku}}" },
			{ "click": "#buy" },
			{ "waitFor": { "selector": "#order-confirmation", "text": "Order Confirmed" } },
			{
				"extract": {
					"orderId":    { "from": "text", "selector": "#order-id", "pattern": "Order #(\\S+)", "group": 1 },
					"cartId":     { "from": "attribute", "selector": "[data-cart]", "name": "data-cart-id" },
					"finalPath":  { "from": "url", "part": "pathname" }
				}
			},
			{ "visit": "/orders/{{orderId}}" },
			{ "waitFor": "#receipt" },
			{ "screenshot": "receipt" }
		]
	}`)

	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()

	result, err := exec.Execute(ctx, action, "test-step", 0)
	if err != nil {
		t.Fatalf("Execute: %v", err)
	}

	// Variables must have landed in varCtx (for downstream step interpolation).
	if got, _ := varCtx.Resolve("{{orderId}}"); got != "ABC-123" {
		t.Errorf("orderId in varCtx: got %q, want %q", got, "ABC-123")
	}
	if got, _ := varCtx.Resolve("{{cartId}}"); got != "CART-7" {
		t.Errorf("cartId in varCtx: got %q, want %q", got, "CART-7")
	}
	if got, _ := varCtx.Resolve("{{finalPath}}"); got != "/products/SKU-1234" {
		t.Errorf("finalPath in varCtx: got %q", got)
	}

	// Result summary shape.
	extracted, _ := result["extracted"].(map[string]interface{})
	if extracted["orderId"] != "ABC-123" {
		t.Errorf("result extracted.orderId: %v", extracted["orderId"])
	}
}

// ---------------------------------------------------------------------------
// Fixture server — a small "shop" app: /login → /dashboard → /products/:sku →
// /order-confirmation → /orders/:id.
// ---------------------------------------------------------------------------

func smokeFixtureServer() *httptest.Server {
	page := func(title, body string) string {
		return `<!doctype html><html><head><title>` + title + `</title></head><body>` + body + `</body></html>`
	}

	mux := http.NewServeMux()

	mux.HandleFunc("/login", func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(page("login", `
			<form><input id="email" /><button id="submit" type="button" onclick="location='/dashboard'">Submit</button></form>
		`)))
	})

	mux.HandleFunc("/dashboard", func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(page("dashboard", `<div id="dashboard">Welcome</div>`)))
	})

	mux.HandleFunc("/products/", func(w http.ResponseWriter, r *http.Request) {
		sku := strings.TrimPrefix(r.URL.Path, "/products/")
		_, _ = w.Write([]byte(page("product", `
			<h1>Product `+sku+`</h1>
			<button id="buy" type="button" onclick="location='/order-confirmation'">Buy</button>
		`)))
	})

	mux.HandleFunc("/order-confirmation", func(w http.ResponseWriter, r *http.Request) {
		// Redirect back through /products/SKU-1234 so the URL extract sees that
		// pathname at extract time, matching the test's finalPath assertion.
		_, _ = w.Write([]byte(page("confirmation", `
			<div id="order-confirmation">Order Confirmed</div>
			<div id="order-id">Order #ABC-123</div>
			<div data-cart data-cart-id="CART-7">cart</div>
			<script>history.replaceState(null, '', '/products/SKU-1234');</script>
		`)))
	})

	mux.HandleFunc("/orders/", func(w http.ResponseWriter, r *http.Request) {
		id := strings.TrimPrefix(r.URL.Path, "/orders/")
		_, _ = w.Write([]byte(page("receipt", `<div id="receipt">Receipt for `+id+`</div>`)))
	})

	return httptest.NewServer(mux)
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

func parseSmokeAction(t *testing.T, body string) StepAction {
	t.Helper()
	var a StepAction
	if err := json.Unmarshal([]byte(body), &a); err != nil {
		t.Fatalf("parse action: %v", err)
	}
	return a
}

// rewriteHost replaces the host part of rawURL with newHost, preserving port.
// httptest URLs look like http://127.0.0.1:PPPPP — we swap the host only.
func rewriteHost(t *testing.T, rawURL, newHost string) string {
	t.Helper()
	u, err := url.Parse(rawURL)
	if err != nil {
		t.Fatalf("parse %q: %v", rawURL, err)
	}
	port := u.Port()
	if port != "" {
		u.Host = newHost + ":" + port
	} else {
		u.Host = newHost
	}
	return u.String()
}
