package main

import (
	"encoding/json"
	"fmt"
	"log"
	"reflect"
	"strings"
	"time"
)

const timestampBufferMs = 500

// NormalizeHeaderKeys lowercases all header keys for case-insensitive access.
func NormalizeHeaderKeys(headers map[string]interface{}) map[string]interface{} {
	if headers == nil {
		return map[string]interface{}{}
	}
	normalized := make(map[string]interface{}, len(headers))
	for k, v := range headers {
		normalized[strings.ToLower(k)] = v
	}
	return normalized
}

// AssembleHttpDocument builds a nested assertion document from an HTTP log.
// Shape: { request: { method, url, header, body }, response: { status, header, body }, responseTime }
func AssembleHttpDocument(log *HttpLogMessage) map[string]interface{} {
	if log == nil {
		return map[string]interface{}{}
	}

	requestBody := log.RequestBody
	if requestBody == nil {
		requestBody = map[string]interface{}{}
	}
	responseBody := log.ResponseBody
	if responseBody == nil {
		responseBody = map[string]interface{}{}
	}

	var responseTime interface{}
	if log.RequestSentAt != nil && log.ResponseReceivedAt != nil {
		sentAt, err1 := time.Parse(time.RFC3339Nano, *log.RequestSentAt)
		receivedAt, err2 := time.Parse(time.RFC3339Nano, *log.ResponseReceivedAt)
		if err1 == nil && err2 == nil {
			responseTime = float64(receivedAt.Sub(sentAt).Milliseconds())
		}
	}

	var statusCode interface{}
	if log.StatusCode != nil {
		statusCode = float64(*log.StatusCode)
	}

	return map[string]interface{}{
		"request": map[string]interface{}{
			"method":  log.Method,
			"url":     log.URL,
			"headers": NormalizeHeaderKeys(log.RequestHeaders),
			"body":    requestBody,
		},
		"response": map[string]interface{}{
			"status":  statusCode,
			"headers": NormalizeHeaderKeys(log.ResponseHeaders),
			"body":    responseBody,
		},
		"responseTime": responseTime,
	}
}

// AssembleDbDocument builds a document from an in-memory database log.
// Shape: { success, data, rowsAffected, error, duration }
func AssembleDbDocument(log *DatabaseLogMessage) map[string]interface{} {
	if log == nil {
		return map[string]interface{}{}
	}

	data := make([]interface{}, len(log.Data))
	for i, row := range log.Data {
		data[i] = row
	}
	if log.Data == nil {
		data = []interface{}{}
	}

	var rowsAffected interface{}
	if log.RowsAffected != nil {
		rowsAffected = float64(*log.RowsAffected)
	}

	var duration interface{}
	if log.Duration != nil {
		duration = float64(*log.Duration)
	}

	return map[string]interface{}{
		"success":      log.Success,
		"data":         data,
		"rowsAffected": rowsAffected,
		"error":        log.Error,
		"duration":     duration,
	}
}

// FindDirectRequestLog finds the HTTP log for the step's own action.
func FindDirectRequestLog(httpLogs []HttpLogMessage, action StepAction, stepExec StepExecution) *HttpLogMessage {
	startTime, endTime, err := stepTimeWindow(stepExec)
	if err != nil {
		log.Printf("FindDirectRequestLog: %v", err)
		return nil
	}

	var candidates []*HttpLogMessage
	for i := range httpLogs {
		log := &httpLogs[i]
		ts := log.Timestamp
		if log.RequestSentAt != nil {
			ts = *log.RequestSentAt
		}
		logTime := parseLogTimestamp(ts)
		if logTime.Before(startTime) || logTime.After(endTime) {
			continue
		}
		if log.Origin != nil && *log.Origin != "" {
			continue // made by a service, not by the test agent
		}
		if log.Method != action.Method {
			continue
		}
		if action.URL != "" {
			// Compare as it was sent: without a scheme, and encoded as the
			// interceptor logs the path
			stepURL := encodeURLChars(stripScheme(action.URL))
			slashIdx := strings.Index(stepURL, "/")
			var service, path string
			if slashIdx >= 0 {
				service = stepURL[:slashIdx]
				path = stepURL[slashIdx:]
			} else {
				service = stepURL
			}
			// The log's target has no port: a service is reached on its own
			// port, and an external host's port isn't part of its name
			service, _, _ = strings.Cut(service, ":")
			if service != "" && (log.Target == nil || *log.Target != service) {
				continue
			}
			if path != "" && !strings.Contains(log.URL, path) {
				continue
			}
		}
		candidates = append(candidates, log)
	}

	// The step's last request: an action loop sends it several times, and
	// extract and assertions run once, on the last response.
	var latest *HttpLogMessage
	for _, c := range candidates {
		if latest == nil || !httpLogTime(c).Before(httpLogTime(latest)) {
			latest = c
		}
	}
	return latest
}

// FindDirectDatabaseLog finds the database log for a dbQuery action.
func FindDirectDatabaseLog(dbLogs []DatabaseLogMessage, action StepAction, stepExec StepExecution) *DatabaseLogMessage {
	startTime, endTime, err := stepTimeWindow(stepExec)
	if err != nil {
		log.Printf("FindDirectDatabaseLog: %v", err)
		return nil
	}

	var candidates []*DatabaseLogMessage
	for i := range dbLogs {
		log := &dbLogs[i]
		logTime := parseLogTimestamp(log.Timestamp)
		if logTime.Before(startTime) || logTime.After(endTime) {
			continue
		}
		if log.DatabaseName != action.Database {
			continue
		}
		if !queriesMatch(log.Query, action.Query) && !(strings.EqualFold(log.DatabaseType, "redis") && redisCommandsMatch(log.Query, action.Query)) {
			continue
		}
		candidates = append(candidates, log)
	}

	// The step's last query, as for HTTP requests (an action loop runs it
	// several times; extract and assertions use the last result).
	var latest *DatabaseLogMessage
	for _, c := range candidates {
		if latest == nil || !parseLogTimestamp(c.Timestamp).Before(parseLogTimestamp(latest.Timestamp)) {
			latest = c
		}
	}
	return latest
}

// queriesMatch reports whether a logged query is the step's own query. They
// are compared as text, or else structurally as JSON (key order and spacing
// don't matter). For a MongoDB insert, the driver adds a generated _id to each
// document that has none, so an _id that is only in the logged document is
// ignored.
func queriesMatch(logged, step string) bool {
	logged = strings.TrimSpace(logged)
	step = strings.TrimSpace(step)
	if logged == step {
		return true
	}
	var parsedLogged, parsedStep interface{}
	if json.Unmarshal([]byte(logged), &parsedLogged) != nil || json.Unmarshal([]byte(step), &parsedStep) != nil {
		return false
	}
	dropGeneratedIDs(parsedLogged, parsedStep)
	return reflect.DeepEqual(parsedLogged, parsedStep)
}

// redisCommandsMatch compares two Redis commands argument by argument, as the
// Redis executor splits them, ignoring the case of the command name.
func redisCommandsMatch(logged, step string) bool {
	a, b := parseRedisCommand(logged), parseRedisCommand(step)
	if len(a) == 0 || len(a) != len(b) || !strings.EqualFold(a[0], b[0]) {
		return false
	}
	for i := 1; i < len(a); i++ {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}

// dropGeneratedIDs removes, from a logged MongoDB insertOne or insertMany, the
// _id of each document whose counterpart in the step's query has no _id.
func dropGeneratedIDs(logged, step interface{}) {
	l, lok := logged.(map[string]interface{})
	s, sok := step.(map[string]interface{})
	if !lok || !sok || (l["operation"] != "insertOne" && l["operation"] != "insertMany") {
		return
	}
	dropID := func(loggedDoc, stepDoc interface{}) {
		ld, lok := loggedDoc.(map[string]interface{})
		sd, sok := stepDoc.(map[string]interface{})
		if lok && sok {
			if _, has := sd["_id"]; !has {
				delete(ld, "_id")
			}
		}
	}
	dropID(l["document"], s["document"])
	ldocs, lok := l["documents"].([]interface{})
	sdocs, sok := s["documents"].([]interface{})
	if lok && sok && len(ldocs) == len(sdocs) {
		for i := range ldocs {
			dropID(ldocs[i], sdocs[i])
		}
	}
}

func stepTimeWindow(stepExec StepExecution) (time.Time, time.Time, error) {
	start, startErr := time.Parse(time.RFC3339Nano, stepExec.StartTime)
	if startErr != nil {
		return time.Time{}, time.Time{}, fmt.Errorf("failed to parse step StartTime %q: %w", stepExec.StartTime, startErr)
	}
	end, endErr := time.Parse(time.RFC3339Nano, stepExec.EndTime)
	if endErr != nil {
		return time.Time{}, time.Time{}, fmt.Errorf("failed to parse step EndTime %q: %w", stepExec.EndTime, endErr)
	}
	// No backward buffer on start — the test-agent controls the step start
	// time so there's no clock skew. Forward buffer on end catches interceptor
	// logs that arrive slightly after the step response returns.
	end = end.Add(timestampBufferMs * time.Millisecond)
	return start, end, nil
}

func parseLogTimestamp(ts string) time.Time {
	t, err := time.Parse(time.RFC3339Nano, ts)
	if err != nil {
		return time.Time{}
	}
	return t
}

// AssembleRootContext builds the unified root context document ($) for a step.
// One document, one path system, used for both extract and assertion evaluation.
// The second return value is false when the action's sidecar log (interceptor
// or db-proxy) has not arrived yet — callers should retry rather than evaluate
// assertions against the incomplete context.
func AssembleRootContext(
	step TestStep,
	stepExec StepExecution,
	httpLogs []HttpLogMessage,
	dbLogs []DatabaseLogMessage,
	msgLogs []MessageLogMessage,
	consoleLogs []ConsoleLogMessage,
	varCtx *VariableContext,
	stepResp map[string]interface{},
) (map[string]interface{}, bool) {
	traffic, httpTimeline := assembleTrafficList(httpLogs, stepExec)
	consoleLogList, consoleTimeline := assembleConsoleLogList(consoleLogs, stepExec)
	dbLogList, dbTimeline := assembleDbLogList(dbLogs, stepExec)
	msgLogList, msgTimeline := assembleMessageLogList(msgLogs, stepExec)

	timeline := mergeTimeline(httpTimeline, consoleTimeline, dbTimeline, msgTimeline)
	annotateTimelineIndices(traffic, timeline)

	rootCtx := map[string]interface{}{
		"variables":   varCtx.Snapshot(),
		"traffic":     traffic,
		"consoleLogs": consoleLogList,
		"dbLogs":      dbLogList,
		"messageLogs": msgLogList,
		"timeline":    timeline,
	}

	actionLogFound := true

	switch step.Action.Type {
	case "wait", "parallel":
		rootCtx["request"] = map[string]interface{}{}
		rootCtx["response"] = map[string]interface{}{}
		rootCtx["responseTime"] = nil
	case "dbQuery":
		dbLog := FindDirectDatabaseLog(dbLogs, step.Action, stepExec)
		rootCtx["request"] = map[string]interface{}{
			"database": step.Action.Database,
			"query":    step.Action.Query,
		}
		if dbLog != nil {
			doc := AssembleDbDocument(dbLog)
			delete(doc, "duration")
			rootCtx["response"] = doc
			if dbLog.Duration != nil {
				rootCtx["responseTime"] = float64(*dbLog.Duration)
			} else {
				rootCtx["responseTime"] = nil
			}
		} else {
			rootCtx["response"] = map[string]interface{}{}
			rootCtx["responseTime"] = nil
			actionLogFound = false
		}
	case "ui":
		rootCtx["request"] = map[string]interface{}{}
		if stepResp != nil {
			rootCtx["response"] = stepResp
		} else {
			rootCtx["response"] = map[string]interface{}{}
		}
		rootCtx["responseTime"] = nil
	default:
		httpLog := FindDirectRequestLog(httpLogs, step.Action, stepExec)
		if httpLog != nil {
			doc := AssembleHttpDocument(httpLog)
			rootCtx["request"] = doc["request"]
			rootCtx["response"] = doc["response"]
			rootCtx["responseTime"] = doc["responseTime"]
		} else {
			rootCtx["request"] = map[string]interface{}{}
			rootCtx["response"] = map[string]interface{}{}
			rootCtx["responseTime"] = nil
			actionLogFound = false
		}
	}

	return rootCtx, actionLogFound
}

func nilToEmptyMap(v interface{}) interface{} {
	if v == nil {
		return map[string]interface{}{}
	}
	return v
}

func ptrIntToFloat(p *int) interface{} {
	if p == nil {
		return nil
	}
	return float64(*p)
}

func ptrInt64ToFloat(p *int64) interface{} {
	if p == nil {
		return nil
	}
	return float64(*p)
}
