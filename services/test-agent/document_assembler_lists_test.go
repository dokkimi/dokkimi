package main

import (
	"testing"
	"time"
)

func stepExecWindow(start, end string) StepExecution {
	return StepExecution{
		StepIndex: 0,
		StartTime: start,
		EndTime:   end,
	}
}

func ptrStr(s string) *string { return &s }
func ptrInt(i int) *int       { return &i }

func TestAssembleTrafficList(t *testing.T) {
	exec := stepExecWindow("2024-01-01T00:00:00.000Z", "2024-01-01T00:00:05.000Z")

	t.Run("returns empty list when no logs", func(t *testing.T) {
		traffic, timeline := assembleTrafficList(nil, exec)
		if len(traffic) != 0 {
			t.Errorf("expected empty traffic, got %d entries", len(traffic))
		}
		if len(timeline) != 0 {
			t.Errorf("expected empty timeline, got %d entries", len(timeline))
		}
	})

	t.Run("includes log within time window", func(t *testing.T) {
		logs := []HttpLogMessage{
			{
				Method:       "GET",
				URL:          "/users",
				Timestamp:    "2024-01-01T00:00:01.000Z",
				StatusCode:   ptrInt(200),
				Origin:       ptrStr("frontend"),
				Target:       ptrStr("backend"),
				RequestBody:  nil,
				ResponseBody: map[string]interface{}{"id": float64(1)},
			},
		}
		traffic, timeline := assembleTrafficList(logs, exec)
		if len(traffic) != 1 {
			t.Fatalf("expected 1 traffic entry, got %d", len(traffic))
		}
		entry := traffic[0].(map[string]interface{})
		req := entry["request"].(map[string]interface{})
		if req["method"] != "GET" {
			t.Errorf("expected GET, got %v", req["method"])
		}
		if req["url"] != "/users" {
			t.Errorf("expected /users, got %v", req["url"])
		}
		if entry["from"] != "frontend" {
			t.Errorf("expected from=frontend, got %v", entry["from"])
		}
		if entry["to"] != "backend" {
			t.Errorf("expected to=backend, got %v", entry["to"])
		}
		// request + response timeline entries
		if len(timeline) != 2 {
			t.Errorf("expected 2 timeline entries, got %d", len(timeline))
		}
	})

	t.Run("excludes log outside time window", func(t *testing.T) {
		logs := []HttpLogMessage{
			{
				Method:    "GET",
				URL:       "/old",
				Timestamp: "2023-12-31T23:59:59.000Z",
			},
		}
		traffic, _ := assembleTrafficList(logs, exec)
		if len(traffic) != 0 {
			t.Errorf("expected 0 traffic entries, got %d", len(traffic))
		}
	})

	t.Run("uses requestSentAt over timestamp when available", func(t *testing.T) {
		sentAt := "2024-01-01T00:00:02.000Z"
		logs := []HttpLogMessage{
			{
				Method:        "POST",
				URL:           "/submit",
				Timestamp:     "2023-12-31T00:00:00.000Z", // outside window
				RequestSentAt: &sentAt,                    // inside window
			},
		}
		traffic, _ := assembleTrafficList(logs, exec)
		if len(traffic) != 1 {
			t.Errorf("expected 1 traffic entry using requestSentAt, got %d", len(traffic))
		}
	})

	t.Run("no response timeline entry when statusCode is nil", func(t *testing.T) {
		logs := []HttpLogMessage{
			{
				Method:    "GET",
				URL:       "/pending",
				Timestamp: "2024-01-01T00:00:01.000Z",
			},
		}
		_, timeline := assembleTrafficList(logs, exec)
		if len(timeline) != 1 {
			t.Errorf("expected 1 timeline entry (request only), got %d", len(timeline))
		}
		if timeline[0].entry["type"] != "httpRequest" {
			t.Errorf("expected httpRequest, got %v", timeline[0].entry["type"])
		}
	})
}

func TestAssembleConsoleLogList(t *testing.T) {
	// time window: unix 1704067200 to 1704067205 (2024-01-01T00:00:00Z to +5s)
	exec := stepExecWindow("2024-01-01T00:00:00.000Z", "2024-01-01T00:00:05.000Z")

	t.Run("returns empty list when no logs", func(t *testing.T) {
		result, timeline := assembleConsoleLogList(nil, exec)
		if len(result) != 0 {
			t.Errorf("expected empty, got %d", len(result))
		}
		if len(timeline) != 0 {
			t.Errorf("expected empty timeline, got %d", len(timeline))
		}
	})

	t.Run("includes log within time window", func(t *testing.T) {
		logs := []ConsoleLogMessage{
			{
				Service:   "api",
				Level:     "info",
				Message:   "started",
				Timestamp: 1704067202.5, // +2.5s
			},
		}
		result, timeline := assembleConsoleLogList(logs, exec)
		if len(result) != 1 {
			t.Fatalf("expected 1 entry, got %d", len(result))
		}
		entry := result[0].(map[string]interface{})
		if entry["service"] != "api" {
			t.Errorf("expected api, got %v", entry["service"])
		}
		if entry["message"] != "started" {
			t.Errorf("expected 'started', got %v", entry["message"])
		}
		if len(timeline) != 1 {
			t.Errorf("expected 1 timeline entry, got %d", len(timeline))
		}
		if timeline[0].entry["type"] != "consoleLog" {
			t.Errorf("expected consoleLog, got %v", timeline[0].entry["type"])
		}
	})

	t.Run("excludes log outside time window", func(t *testing.T) {
		logs := []ConsoleLogMessage{
			{Service: "api", Message: "old", Timestamp: 1704067190.0},
		}
		result, _ := assembleConsoleLogList(logs, exec)
		if len(result) != 0 {
			t.Errorf("expected 0 entries, got %d", len(result))
		}
	})
}

func TestAssembleDbLogList(t *testing.T) {
	exec := stepExecWindow("2024-01-01T00:00:00.000Z", "2024-01-01T00:00:05.000Z")

	t.Run("returns empty list when no logs", func(t *testing.T) {
		result, timeline := assembleDbLogList(nil, exec)
		if len(result) != 0 {
			t.Errorf("expected empty, got %d", len(result))
		}
		if len(timeline) != 0 {
			t.Errorf("expected empty timeline, got %d", len(timeline))
		}
	})

	t.Run("includes log within time window", func(t *testing.T) {
		dur := 15
		rows := int64(3)
		logs := []DatabaseLogMessage{
			{
				DatabaseName: "users_db",
				Query:        "SELECT * FROM users",
				Success:      true,
				Duration:     &dur,
				RowsAffected: &rows,
				Timestamp:    "2024-01-01T00:00:02.000Z",
			},
		}
		result, timeline := assembleDbLogList(logs, exec)
		if len(result) != 1 {
			t.Fatalf("expected 1 entry, got %d", len(result))
		}
		entry := result[0].(map[string]interface{})
		if entry["database"] != "users_db" {
			t.Errorf("expected users_db, got %v", entry["database"])
		}
		if entry["query"] != "SELECT * FROM users" {
			t.Errorf("expected query, got %v", entry["query"])
		}
		if entry["duration"] != float64(15) {
			t.Errorf("expected duration 15, got %v", entry["duration"])
		}
		res := entry["result"].(map[string]interface{})
		if res["success"] != true {
			t.Errorf("expected success=true, got %v", res["success"])
		}
		if res["rowsAffected"] != float64(3) {
			t.Errorf("expected rowsAffected=3, got %v", res["rowsAffected"])
		}
		if len(timeline) != 1 {
			t.Errorf("expected 1 timeline entry, got %d", len(timeline))
		}
		if timeline[0].entry["type"] != "dbQuery" {
			t.Errorf("expected dbQuery, got %v", timeline[0].entry["type"])
		}
	})

	t.Run("handles nil duration and rowsAffected", func(t *testing.T) {
		logs := []DatabaseLogMessage{
			{
				DatabaseName: "db",
				Query:        "DROP TABLE foo",
				Success:      false,
				Error:        "access denied",
				Timestamp:    "2024-01-01T00:00:01.000Z",
			},
		}
		result, _ := assembleDbLogList(logs, exec)
		entry := result[0].(map[string]interface{})
		if entry["duration"] != nil {
			t.Errorf("expected nil duration, got %v", entry["duration"])
		}
		res := entry["result"].(map[string]interface{})
		if res["rowsAffected"] != nil {
			t.Errorf("expected nil rowsAffected, got %v", res["rowsAffected"])
		}
	})
}

func TestMergeTimeline(t *testing.T) {
	t.Run("merges and sorts by timestamp", func(t *testing.T) {
		t1 := time.Date(2024, 1, 1, 0, 0, 1, 0, time.UTC)
		t2 := time.Date(2024, 1, 1, 0, 0, 2, 0, time.UTC)
		t3 := time.Date(2024, 1, 1, 0, 0, 3, 0, time.UTC)

		slice1 := []timelineEntry{
			{timestamp: t3, entry: map[string]interface{}{"type": "c"}},
			{timestamp: t1, entry: map[string]interface{}{"type": "a"}},
		}
		slice2 := []timelineEntry{
			{timestamp: t2, entry: map[string]interface{}{"type": "b"}},
		}

		result := mergeTimeline(slice1, slice2)
		if len(result) != 3 {
			t.Fatalf("expected 3, got %d", len(result))
		}
		if result[0].(map[string]interface{})["type"] != "a" {
			t.Errorf("expected 'a' first, got %v", result[0])
		}
		if result[1].(map[string]interface{})["type"] != "b" {
			t.Errorf("expected 'b' second, got %v", result[1])
		}
		if result[2].(map[string]interface{})["type"] != "c" {
			t.Errorf("expected 'c' third, got %v", result[2])
		}
	})

	t.Run("returns empty for no input", func(t *testing.T) {
		result := mergeTimeline()
		if len(result) != 0 {
			t.Errorf("expected empty, got %d", len(result))
		}
	})

	t.Run("handles single slice", func(t *testing.T) {
		ts := time.Date(2024, 1, 1, 0, 0, 0, 0, time.UTC)
		result := mergeTimeline([]timelineEntry{
			{timestamp: ts, entry: map[string]interface{}{"type": "only"}},
		})
		if len(result) != 1 {
			t.Fatalf("expected 1, got %d", len(result))
		}
	})
}

func TestAnnotateTimelineIndices(t *testing.T) {
	t.Run("sets request and response timeline indices", func(t *testing.T) {
		traffic := []interface{}{
			map[string]interface{}{"url": "/first"},
			map[string]interface{}{"url": "/second"},
		}
		timeline := []interface{}{
			map[string]interface{}{"trafficIndex": float64(0), "direction": "request"},
			map[string]interface{}{"trafficIndex": float64(0), "direction": "response"},
			map[string]interface{}{"trafficIndex": float64(1), "direction": "request"},
			map[string]interface{}{"trafficIndex": float64(1), "direction": "response"},
		}

		annotateTimelineIndices(traffic, timeline)

		first := traffic[0].(map[string]interface{})
		if first["requestTimelineIndex"] != float64(0) {
			t.Errorf("expected requestTimelineIndex=0, got %v", first["requestTimelineIndex"])
		}
		if first["responseTimelineIndex"] != float64(1) {
			t.Errorf("expected responseTimelineIndex=1, got %v", first["responseTimelineIndex"])
		}

		second := traffic[1].(map[string]interface{})
		if second["requestTimelineIndex"] != float64(2) {
			t.Errorf("expected requestTimelineIndex=2, got %v", second["requestTimelineIndex"])
		}
		if second["responseTimelineIndex"] != float64(3) {
			t.Errorf("expected responseTimelineIndex=3, got %v", second["responseTimelineIndex"])
		}
	})

	t.Run("sets nil responseTimelineIndex when no response entry", func(t *testing.T) {
		traffic := []interface{}{
			map[string]interface{}{"url": "/pending"},
		}
		timeline := []interface{}{
			map[string]interface{}{"trafficIndex": float64(0), "direction": "request"},
		}

		annotateTimelineIndices(traffic, timeline)

		entry := traffic[0].(map[string]interface{})
		if entry["responseTimelineIndex"] != nil {
			t.Errorf("expected nil responseTimelineIndex, got %v", entry["responseTimelineIndex"])
		}
	})

	t.Run("correct indices with interleaved non-HTTP entries", func(t *testing.T) {
		traffic := []interface{}{
			map[string]interface{}{"url": "/api"},
		}
		timeline := []interface{}{
			map[string]interface{}{"type": "consoleLog", "message": "startup"},
			map[string]interface{}{"trafficIndex": float64(0), "direction": "request"},
			map[string]interface{}{"type": "dbQuery", "query": "SELECT 1"},
			map[string]interface{}{"trafficIndex": float64(0), "direction": "response"},
			map[string]interface{}{"type": "consoleLog", "message": "done"},
		}

		annotateTimelineIndices(traffic, timeline)

		entry := traffic[0].(map[string]interface{})
		if entry["requestTimelineIndex"] != float64(1) {
			t.Errorf("expected requestTimelineIndex=1 (after consoleLog), got %v", entry["requestTimelineIndex"])
		}
		if entry["responseTimelineIndex"] != float64(3) {
			t.Errorf("expected responseTimelineIndex=3 (after dbQuery), got %v", entry["responseTimelineIndex"])
		}
	})
}
