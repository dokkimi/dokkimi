package main

import "testing"

func stepRequestLog(url, sentAt string, status int) HttpLogMessage {
	return HttpLogMessage{Method: "GET", URL: url, Target: ptrStr("user-service"), Timestamp: sentAt, RequestSentAt: &sentAt, StatusCode: ptrInt(status)}
}

// A service making the same call during the step is not the step's request.
func TestFindDirectRequestLog_IgnoresCallsMadeByServices(t *testing.T) {
	exec := stepExecWindow("2024-01-01T00:00:00.000Z", "2024-01-01T00:00:04.000Z")
	byService := stepRequestLog("/api/users", "2024-01-01T00:00:02.000Z", 500)
	byService.Origin = ptrStr("api-gateway")
	own := stepRequestLog("/api/users", "2024-01-01T00:00:00.100Z", 200)
	action := StepAction{Method: "GET", URL: "user-service/api/users"}

	got := FindDirectRequestLog([]HttpLogMessage{own, byService}, action, exec)
	if got == nil || *got.StatusCode != 200 {
		t.Errorf("got %+v, want the step's own request (200)", got)
	}
}

// An action loop sends the request several times; extract and assertions run
// once, on the last response.
func TestFindDirectRequestLog_ActionLoopUsesTheLastRequest(t *testing.T) {
	exec := stepExecWindow("2024-01-01T00:00:00.000Z", "2024-01-01T00:00:03.000Z")
	logs := []HttpLogMessage{
		stepRequestLog("/api/users", "2024-01-01T00:00:00.100Z", 201),
		stepRequestLog("/api/users", "2024-01-01T00:00:01.500Z", 202),
		stepRequestLog("/api/users", "2024-01-01T00:00:02.900Z", 203),
	}
	action := StepAction{Method: "GET", URL: "user-service/api/users"}
	if got := FindDirectRequestLog(logs, action, exec); got == nil || *got.StatusCode != 203 {
		t.Errorf("got %+v, want the last request (203)", got)
	}
}

// A dbQuery action loop runs the query several times; extract and assertions
// use the last result.
func TestFindDirectDatabaseLog_ActionLoopUsesTheLastQuery(t *testing.T) {
	exec := stepExecWindow("2024-01-01T00:00:00.000Z", "2024-01-01T00:00:03.000Z")
	query := "SELECT * FROM jobs WHERE id = 1"
	logs := []DatabaseLogMessage{
		{DatabaseName: "pg", Query: query, Timestamp: "2024-01-01T00:00:00.100Z", RowsAffected: ptrInt64(1)},
		{DatabaseName: "pg", Query: query, Timestamp: "2024-01-01T00:00:01.500Z", RowsAffected: ptrInt64(2)},
		{DatabaseName: "pg", Query: query, Timestamp: "2024-01-01T00:00:02.900Z", RowsAffected: ptrInt64(3)},
	}
	got := FindDirectDatabaseLog(logs, StepAction{Database: "pg", Query: query}, exec)
	if got == nil || *got.RowsAffected != 3 {
		t.Errorf("got %+v, want the last query (rowsAffected 3)", got)
	}
}

func ptrInt64(v int64) *int64 { return &v }
