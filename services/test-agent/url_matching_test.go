package main

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

func TestEncodeURLChars(t *testing.T) {
	for in, want := range map[string]string{
		"svc/search?q=hello world": "svc/search?q=hello%20world",
		"svc/a%20b":                "svc/a%20b", // already encoded: unchanged
		"svc/users?email=a+t@b.c":  "svc/users?email=a+t@b.c",
		"svc/café":                 "svc/caf%C3%A9",
		`svc/q?x="y"&z=<1>`:        "svc/q?x=%22y%22&z=%3C1%3E",
	} {
		if got := encodeURLChars(in); got != want {
			t.Errorf("%q: got %q, want %q", in, got, want)
		}
	}
}

// What the test agent sends: encoded, without the scheme in the URL, and with
// the scheme the step asked for in a header.
func TestExecuteAPIStep_SendsEncodedURLAndScheme(t *testing.T) {
	var gotURI, gotScheme string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotURI, gotScheme = r.RequestURI, r.Header.Get(dokkimiSchemeHeader)
	}))
	defer server.Close()
	executor := NewTestExecutor(server.URL, time.Second, nil, nil)
	for _, tc := range []struct{ url, uri, scheme string }{
		{"svc/search?q=hello world", "/svc/search?q=hello%20world", ""},
		{"http://api.example.com/v1", "/api.example.com/v1", "http"},
		{"https://svc/x", "/svc/x", "https"},
	} {
		if _, err := executor.executeAPIStep(context.Background(), StepAction{Type: "httpRequest", Method: "GET", URL: tc.url}, 0); err != nil {
			t.Fatalf("%s: %v", tc.url, err)
		}
		if gotURI != tc.uri || gotScheme != tc.scheme {
			t.Errorf("%s: sent %s with scheme %q, want %s with %q", tc.url, gotURI, gotScheme, tc.uri, tc.scheme)
		}
	}
}

// The step's URL is compared as it was sent: without its scheme, and encoded
// like the logged path.
func TestFindDirectRequestLog_MatchesSchemeAndEncoding(t *testing.T) {
	exec := stepExecWindow("2024-01-01T00:00:00.000Z", "2024-01-01T00:00:01.000Z")
	logAt := func(url string) HttpLogMessage {
		target := "service-a"
		return HttpLogMessage{Method: "GET", URL: url, Target: &target, Timestamp: "2024-01-01T00:00:00.100Z"}
	}
	for _, tc := range []struct{ step, logged string }{
		{"http://service-a/echo", "http://service-a/echo"},
		{"https://service-a/echo", "https://service-a/echo"},
		{"service-a/search?q=hello world", "http://service-a/search?q=hello%20world"},
		{"service-a/a%20b", "http://service-a/a%20b"},
		{"service-a/café", "http://service-a/caf%C3%A9"},
		{"service-a:3000/echo", "http://service-a/echo"},          // the port goes to the service's own
		{"https://service-a:3000/echo", "https://service-a/echo"}, // scheme and port
	} {
		if FindDirectRequestLog([]HttpLogMessage{logAt(tc.logged)}, StepAction{Method: "GET", URL: tc.step}, exec) == nil {
			t.Errorf("step %s didn't find its log %s", tc.step, tc.logged)
		}
	}
}

func TestRedisCommandsMatch(t *testing.T) {
	for _, tc := range []struct {
		logged, step string
		want         bool
	}{
		{`SET greeting "hello world"`, `SET greeting "hello world"`, true},
		{`set greeting "hello world"`, `SET greeting "hello world"`, true},
		{`SET greeting hello world`, `SET greeting "hello world"`, false},
		{`GET a`, `GET b`, false},
	} {
		if got := redisCommandsMatch(tc.logged, tc.step); got != tc.want {
			t.Errorf("%q vs %q: got %v, want %v", tc.logged, tc.step, got, tc.want)
		}
	}
	logs := []DatabaseLogMessage{{DatabaseName: "redis-db", DatabaseType: "redis", Query: `set greeting "hello world"`, Timestamp: "2024-01-01T00:00:00.100Z"}}
	exec := stepExecWindow("2024-01-01T00:00:00.000Z", "2024-01-01T00:00:01.000Z")
	if FindDirectDatabaseLog(logs, StepAction{Database: "redis-db", Query: `SET greeting "hello world"`}, exec) == nil {
		t.Error("a Redis step didn't find its log")
	}
}
