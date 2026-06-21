package main

import (
	"testing"
	"time"
)

func TestNormalizeHeaderKeys(t *testing.T) {
	t.Run("lowercases all keys", func(t *testing.T) {
		h := map[string]interface{}{"Content-Type": "application/json", "X-Request-Id": "abc"}
		result := NormalizeHeaderKeys(h)
		if result["content-type"] != "application/json" {
			t.Errorf("expected 'application/json', got %v", result["content-type"])
		}
		if result["x-request-id"] != "abc" {
			t.Errorf("expected 'abc', got %v", result["x-request-id"])
		}
	})

	t.Run("returns empty map for nil", func(t *testing.T) {
		result := NormalizeHeaderKeys(nil)
		if len(result) != 0 {
			t.Errorf("expected empty map, got %v", result)
		}
	})
}

func TestAssembleHttpDocument(t *testing.T) {
	t.Run("returns empty map for nil log", func(t *testing.T) {
		result := AssembleHttpDocument(nil)
		if len(result) != 0 {
			t.Errorf("expected empty map, got %v", result)
		}
	})

	t.Run("assembles full document", func(t *testing.T) {
		status := 200
		sentAt := "2024-01-01T00:00:00.000Z"
		receivedAt := "2024-01-01T00:00:00.150Z"
		log := &HttpLogMessage{
			Method:             "GET",
			URL:                "/users",
			StatusCode:         &status,
			RequestBody:        map[string]interface{}{"name": "test"},
			ResponseBody:       map[string]interface{}{"id": float64(1)},
			RequestHeaders:     map[string]interface{}{"Content-Type": "application/json"},
			ResponseHeaders:    map[string]interface{}{"X-Request-Id": "abc"},
			RequestSentAt:      &sentAt,
			ResponseReceivedAt: &receivedAt,
		}
		doc := AssembleHttpDocument(log)

		req := doc["request"].(map[string]interface{})
		if req["method"] != "GET" {
			t.Errorf("expected GET, got %v", req["method"])
		}
		if req["url"] != "/users" {
			t.Errorf("expected /users, got %v", req["url"])
		}

		resp := doc["response"].(map[string]interface{})
		if resp["status"] != float64(200) {
			t.Errorf("expected 200, got %v", resp["status"])
		}

		header := resp["headers"].(map[string]interface{})
		if header["x-request-id"] != "abc" {
			t.Errorf("expected abc, got %v", header["x-request-id"])
		}

		if doc["responseTime"] != float64(150) {
			t.Errorf("expected 150, got %v", doc["responseTime"])
		}
	})

	t.Run("defaults nil bodies to empty object", func(t *testing.T) {
		log := &HttpLogMessage{Method: "GET", URL: "/test"}
		doc := AssembleHttpDocument(log)
		req := doc["request"].(map[string]interface{})
		if _, ok := req["body"].(map[string]interface{}); !ok {
			t.Error("expected body to be empty map")
		}
	})
}

func TestAssembleDbDocument(t *testing.T) {
	t.Run("returns empty map for nil log", func(t *testing.T) {
		result := AssembleDbDocument(nil)
		if len(result) != 0 {
			t.Errorf("expected empty map, got %v", result)
		}
	})

	t.Run("assembles full document", func(t *testing.T) {
		rows := int64(1)
		dur := 42
		log := &DatabaseLogMessage{
			Success:      true,
			Data:         []map[string]interface{}{{"id": float64(1)}},
			RowsAffected: &rows,
			Duration:     &dur,
		}
		doc := AssembleDbDocument(log)
		if doc["success"] != true {
			t.Error("expected success true")
		}
		data := doc["data"].([]interface{})
		if len(data) != 1 {
			t.Errorf("expected 1 data row, got %d", len(data))
		}
		if doc["rowsAffected"] != float64(1) {
			t.Errorf("expected rowsAffected 1, got %v", doc["rowsAffected"])
		}
	})
}

func TestMatchUrl(t *testing.T) {
	svc := "user-service"

	t.Run("empty match returns true", func(t *testing.T) {
		if !MatchUrl("", &svc, "/users") {
			t.Error("expected true")
		}
	})

	t.Run("path-only match", func(t *testing.T) {
		if !MatchUrl("/users", nil, "/api/users") {
			t.Error("expected true for path match")
		}
		if MatchUrl("/orders", nil, "/api/users") {
			t.Error("expected false for non-matching path")
		}
	})

	t.Run("service-only match", func(t *testing.T) {
		if !MatchUrl("user-service", &svc, "/anything") {
			t.Error("expected true for service match")
		}
		other := "other-service"
		if MatchUrl("user-service", &other, "/anything") {
			t.Error("expected false for non-matching service")
		}
	})

	t.Run("service+path match", func(t *testing.T) {
		if !MatchUrl("user-service/users", &svc, "/api/users") {
			t.Error("expected true")
		}
	})
}

func TestFindDirectRequestLog(t *testing.T) {
	now := time.Now()
	ts := now.Format(time.RFC3339Nano)
	start := now.Add(-100 * time.Millisecond).Format(time.RFC3339Nano)
	end := now.Add(100 * time.Millisecond).Format(time.RFC3339Nano)
	stepExec := StepExecution{StartTime: start, EndTime: end}
	target := "user-service"

	t.Run("finds matching log", func(t *testing.T) {
		logs := []HttpLogMessage{
			{Method: "GET", URL: "/users", Timestamp: ts, Target: &target},
		}
		result := FindDirectRequestLog(logs, StepAction{Type: "httpRequest", Method: "GET", URL: "user-service/users"}, stepExec)
		if result == nil {
			t.Fatal("expected to find log")
		}
	})

	t.Run("returns nil for no match", func(t *testing.T) {
		logs := []HttpLogMessage{
			{Method: "POST", URL: "/users", Timestamp: ts, Target: &target},
		}
		result := FindDirectRequestLog(logs, StepAction{Type: "httpRequest", Method: "GET", URL: "user-service/users"}, stepExec)
		if result != nil {
			t.Error("expected nil")
		}
	})

	t.Run("selects log closest to midpoint when multiple match", func(t *testing.T) {
		earlyTs := now.Add(-80 * time.Millisecond).Format(time.RFC3339Nano)
		midTs := now.Add(5 * time.Millisecond).Format(time.RFC3339Nano)
		lateTs := now.Add(80 * time.Millisecond).Format(time.RFC3339Nano)
		logs := []HttpLogMessage{
			{Method: "GET", URL: "/users", Timestamp: earlyTs, Target: &target},
			{Method: "GET", URL: "/users", Timestamp: midTs, Target: &target},
			{Method: "GET", URL: "/users", Timestamp: lateTs, Target: &target},
		}
		result := FindDirectRequestLog(logs, StepAction{Type: "httpRequest", Method: "GET", URL: "user-service/users"}, stepExec)
		if result == nil {
			t.Fatal("expected to find log")
		}
		if result.Timestamp != midTs {
			t.Errorf("expected midpoint log, got timestamp %s", result.Timestamp)
		}
	})

	t.Run("uses RequestSentAt for time matching", func(t *testing.T) {
		outsideTs := now.Add(-500 * time.Millisecond).Format(time.RFC3339Nano)
		sentAt := now.Format(time.RFC3339Nano)
		logs := []HttpLogMessage{
			{Method: "GET", URL: "/users", Timestamp: outsideTs, RequestSentAt: &sentAt, Target: &target},
		}
		result := FindDirectRequestLog(logs, StepAction{Type: "httpRequest", Method: "GET", URL: "user-service/users"}, stepExec)
		if result == nil {
			t.Fatal("expected to find log using RequestSentAt")
		}
	})
}

func TestAssembleRootContext(t *testing.T) {
	now := time.Now()
	start := now.Add(-100 * time.Millisecond).Format(time.RFC3339Nano)
	end := now.Add(100 * time.Millisecond).Format(time.RFC3339Nano)
	stepExec := StepExecution{StartTime: start, EndTime: end}

	t.Run("assembles unified root context for HTTP step", func(t *testing.T) {
		target := "api"
		status := 200
		httpLogs := []HttpLogMessage{
			{
				Method: "GET", URL: "/items", StatusCode: &status,
				Timestamp: now.Format(time.RFC3339Nano), Target: &target,
				RequestHeaders: map[string]interface{}{}, ResponseHeaders: map[string]interface{}{},
				ResponseBody: map[string]interface{}{"ok": true},
			},
		}
		varCtx := NewVariableContext()
		varCtx.Set("foo", "bar")
		step := TestStep{Action: StepAction{Type: "httpRequest", Method: "GET", URL: "api/items"}}
		doc, _ := AssembleRootContext(step, stepExec, httpLogs, nil, nil, varCtx, nil)
		resp, ok := doc["response"].(map[string]interface{})
		if !ok {
			t.Fatal("expected response in doc")
		}
		if resp["status"] != float64(200) {
			t.Errorf("expected status 200, got %v", resp["status"])
		}
		vars := doc["variables"].(map[string]interface{})
		if vars["foo"] != "bar" {
			t.Errorf("expected variables.foo = bar, got %v", vars["foo"])
		}
		traffic := doc["traffic"].([]interface{})
		if len(traffic) != 1 {
			t.Errorf("expected 1 traffic entry, got %d", len(traffic))
		}
	})

	t.Run("assembles root context for DB step", func(t *testing.T) {
		rows := int64(3)
		dur := 42
		dbLogs := []DatabaseLogMessage{
			{
				DatabaseName: "mydb", Query: "SELECT 1",
				Timestamp: now.Format(time.RFC3339Nano),
				Success:   true, RowsAffected: &rows, Duration: &dur,
			},
		}
		varCtx := NewVariableContext()
		step := TestStep{Action: StepAction{Type: "dbQuery", Database: "mydb", Query: "SELECT 1"}}
		doc, _ := AssembleRootContext(step, stepExec, nil, dbLogs, nil, varCtx, nil)
		resp := doc["response"].(map[string]interface{})
		if resp["success"] != true {
			t.Error("expected success true")
		}
		if resp["rowsAffected"] != float64(3) {
			t.Errorf("expected rowsAffected 3, got %v", resp["rowsAffected"])
		}
		if doc["responseTime"] != float64(42) {
			t.Errorf("expected responseTime 42, got %v", doc["responseTime"])
		}
	})

	t.Run("assembles root context for wait step", func(t *testing.T) {
		varCtx := NewVariableContext()
		step := TestStep{Action: StepAction{Type: "wait"}}
		doc, _ := AssembleRootContext(step, stepExec, nil, nil, nil, varCtx, nil)
		resp := doc["response"].(map[string]interface{})
		if len(resp) != 0 {
			t.Errorf("expected empty response, got %v", resp)
		}
	})

	t.Run("assembles root context for UI step with stepResp", func(t *testing.T) {
		varCtx := NewVariableContext()
		varCtx.Set("token", "abc123")
		step := TestStep{Action: StepAction{Type: "ui", Target: "frontend"}}
		stepResp := map[string]interface{}{
			"target":  "frontend",
			"baseURL": "http://frontend:3000",
			"extracted": map[string]interface{}{
				"pageTitle": "Dashboard",
			},
		}
		doc, _ := AssembleRootContext(step, stepExec, nil, nil, nil, varCtx, stepResp)
		resp, ok := doc["response"].(map[string]interface{})
		if !ok {
			t.Fatal("expected response in doc")
		}
		if resp["target"] != "frontend" {
			t.Errorf("expected response.target=frontend, got %v", resp["target"])
		}
		extracted := resp["extracted"].(map[string]interface{})
		if extracted["pageTitle"] != "Dashboard" {
			t.Errorf("expected extracted.pageTitle=Dashboard, got %v", extracted["pageTitle"])
		}
		vars := doc["variables"].(map[string]interface{})
		if vars["token"] != "abc123" {
			t.Errorf("expected variables.token=abc123, got %v", vars["token"])
		}
		if doc["responseTime"] != nil {
			t.Errorf("expected responseTime=nil for UI step, got %v", doc["responseTime"])
		}
	})

	t.Run("assembles root context for UI step without stepResp", func(t *testing.T) {
		varCtx := NewVariableContext()
		step := TestStep{Action: StepAction{Type: "ui", Target: "frontend"}}
		doc, _ := AssembleRootContext(step, stepExec, nil, nil, nil, varCtx, nil)
		resp, ok := doc["response"].(map[string]interface{})
		if !ok {
			t.Fatal("expected response in doc")
		}
		if len(resp) != 0 {
			t.Errorf("expected empty response for nil stepResp, got %v", resp)
		}
	})

	t.Run("includes timeline sorted by timestamp", func(t *testing.T) {
		target := "api"
		status := 200
		earlyTs := now.Add(-50 * time.Millisecond).Format(time.RFC3339Nano)
		lateTs := now.Add(50 * time.Millisecond).Format(time.RFC3339Nano)
		httpLogs := []HttpLogMessage{
			{
				Method: "GET", URL: "/items", StatusCode: &status,
				Timestamp: lateTs, Target: &target,
				RequestHeaders: map[string]interface{}{}, ResponseHeaders: map[string]interface{}{},
			},
		}
		dbLogs := []DatabaseLogMessage{
			{
				DatabaseName: "mydb", Query: "SELECT 1",
				Timestamp: earlyTs, Success: true,
			},
		}
		varCtx := NewVariableContext()
		step := TestStep{Action: StepAction{Type: "httpRequest", Method: "GET", URL: "api/items"}}
		doc, _ := AssembleRootContext(step, stepExec, httpLogs, dbLogs, nil, varCtx, nil)
		timeline := doc["timeline"].([]interface{})
		if len(timeline) < 2 {
			t.Fatalf("expected at least 2 timeline entries, got %d", len(timeline))
		}
		first := timeline[0].(map[string]interface{})
		if first["type"] != "dbQuery" {
			t.Errorf("expected first timeline entry to be dbQuery, got %v", first["type"])
		}
		// HTTP traffic produces httpRequest + httpResponse entries
		found := false
		for _, e := range timeline[1:] {
			entry := e.(map[string]interface{})
			if entry["type"] == "httpRequest" {
				found = true
				break
			}
		}
		if !found {
			t.Error("expected an httpRequest timeline entry")
		}
	})

	t.Run("traffic entries have requestTimelineIndex and responseTimelineIndex", func(t *testing.T) {
		target := "api"
		status := 200
		sentAt := now.Add(-50 * time.Millisecond).Format(time.RFC3339Nano)
		receivedAt := now.Add(50 * time.Millisecond).Format(time.RFC3339Nano)
		httpLogs := []HttpLogMessage{
			{
				Method: "GET", URL: "/items", StatusCode: &status,
				Timestamp: sentAt, Target: &target,
				RequestHeaders: map[string]interface{}{}, ResponseHeaders: map[string]interface{}{},
				RequestSentAt: &sentAt, ResponseReceivedAt: &receivedAt,
			},
		}
		varCtx := NewVariableContext()
		step := TestStep{Action: StepAction{Type: "httpRequest", Method: "GET", URL: "api/items"}}
		doc, _ := AssembleRootContext(step, stepExec, httpLogs, nil, nil, varCtx, nil)
		traffic := doc["traffic"].([]interface{})
		if len(traffic) == 0 {
			t.Fatal("expected traffic entries")
		}
		entry := traffic[0].(map[string]interface{})
		reqIdx, hasReq := entry["requestTimelineIndex"]
		if !hasReq {
			t.Fatal("expected requestTimelineIndex on traffic entry")
		}
		if _, ok := reqIdx.(float64); !ok {
			t.Errorf("expected requestTimelineIndex to be float64, got %T", reqIdx)
		}
		respIdx, hasResp := entry["responseTimelineIndex"]
		if !hasResp {
			t.Fatal("expected responseTimelineIndex on traffic entry")
		}
		if _, ok := respIdx.(float64); !ok {
			t.Errorf("expected responseTimelineIndex to be float64, got %T", respIdx)
		}
	})

	t.Run("responseTimelineIndex is nil when no response", func(t *testing.T) {
		target := "api"
		ts := now.Format(time.RFC3339Nano)
		httpLogs := []HttpLogMessage{
			{
				Method: "GET", URL: "/timeout", StatusCode: nil,
				Timestamp: ts, Target: &target,
				RequestHeaders: map[string]interface{}{}, ResponseHeaders: map[string]interface{}{},
				RequestSentAt: &ts,
			},
		}
		varCtx := NewVariableContext()
		step := TestStep{Action: StepAction{Type: "httpRequest", Method: "GET", URL: "api/timeout"}}
		doc, _ := AssembleRootContext(step, stepExec, httpLogs, nil, nil, varCtx, nil)
		traffic := doc["traffic"].([]interface{})
		if len(traffic) == 0 {
			t.Fatal("expected traffic entries")
		}
		entry := traffic[0].(map[string]interface{})
		respIdx := entry["responseTimelineIndex"]
		if respIdx != nil {
			t.Errorf("expected responseTimelineIndex=nil for no response, got %v", respIdx)
		}
	})
}
