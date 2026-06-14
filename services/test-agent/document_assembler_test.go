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

		header := resp["header"].(map[string]interface{})
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

func TestAssembleStepDocument(t *testing.T) {
	now := time.Now()
	start := now.Add(-100 * time.Millisecond).Format(time.RFC3339Nano)
	end := now.Add(100 * time.Millisecond).Format(time.RFC3339Nano)
	stepExec := StepExecution{StartTime: start, EndTime: end}

	t.Run("assembles HTTP document for httpRequest action", func(t *testing.T) {
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
		step := TestStep{Action: StepAction{Type: "httpRequest", Method: "GET", URL: "api/items"}}
		doc := AssembleStepDocument(step, httpLogs, nil, stepExec)
		resp, ok := doc["response"].(map[string]interface{})
		if !ok {
			t.Fatal("expected response in doc")
		}
		if resp["status"] != float64(200) {
			t.Errorf("expected status 200, got %v", resp["status"])
		}
	})

	t.Run("assembles DB document for dbQuery action", func(t *testing.T) {
		rows := int64(3)
		dbLogs := []DatabaseLogMessage{
			{
				DatabaseName: "mydb", Query: "SELECT 1",
				Timestamp: now.Format(time.RFC3339Nano),
				Success:   true, RowsAffected: &rows,
			},
		}
		step := TestStep{Action: StepAction{Type: "dbQuery", Database: "mydb", Query: "SELECT 1"}}
		doc := AssembleStepDocument(step, nil, dbLogs, stepExec)
		if doc["success"] != true {
			t.Error("expected success true")
		}
		if doc["rowsAffected"] != float64(3) {
			t.Errorf("expected rowsAffected 3, got %v", doc["rowsAffected"])
		}
	})

	t.Run("returns empty doc for wait action", func(t *testing.T) {
		step := TestStep{Action: StepAction{Type: "wait"}}
		doc := AssembleStepDocument(step, nil, nil, stepExec)
		if len(doc) != 0 {
			t.Errorf("expected empty doc, got %v", doc)
		}
	})
}

func TestAssembleExtractDocument(t *testing.T) {
	now := time.Now()
	start := now.Add(-100 * time.Millisecond).Format(time.RFC3339Nano)
	end := now.Add(100 * time.Millisecond).Format(time.RFC3339Nano)
	stepExec := StepExecution{StartTime: start, EndTime: end}

	t.Run("returns flat response doc for httpRequest", func(t *testing.T) {
		target := "api"
		status := 201
		httpLogs := []HttpLogMessage{
			{
				Method: "POST", URL: "/items", StatusCode: &status,
				Timestamp: now.Format(time.RFC3339Nano), Target: &target,
				RequestHeaders:  map[string]interface{}{},
				ResponseHeaders: map[string]interface{}{"X-Id": "abc"},
				ResponseBody:    map[string]interface{}{"id": float64(42)},
			},
		}
		step := TestStep{Action: StepAction{Type: "httpRequest", Method: "POST", URL: "api/items"}}
		doc := AssembleExtractDocument(step, httpLogs, nil, stepExec)
		if doc["statusCode"] != float64(201) {
			t.Errorf("expected statusCode 201, got %v", doc["statusCode"])
		}
		body, ok := doc["body"].(map[string]interface{})
		if !ok {
			t.Fatal("expected body in extract doc")
		}
		if body["id"] != float64(42) {
			t.Errorf("expected body.id 42, got %v", body["id"])
		}
		headers, ok := doc["headers"].(map[string]interface{})
		if !ok {
			t.Fatal("expected headers in extract doc")
		}
		if headers["x-id"] != "abc" {
			t.Errorf("expected normalized header x-id, got %v", headers["x-id"])
		}
	})

	t.Run("returns empty doc when no matching log", func(t *testing.T) {
		step := TestStep{Action: StepAction{Type: "httpRequest", Method: "GET", URL: "api/missing"}}
		doc := AssembleExtractDocument(step, nil, nil, stepExec)
		if len(doc) != 0 {
			t.Errorf("expected empty doc, got %v", doc)
		}
	})
}
