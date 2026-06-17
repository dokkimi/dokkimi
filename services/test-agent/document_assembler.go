package main

import (
	"log"
	"math"
	"sort"
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

// MatchUrl matches a user-provided URL against a log's target and url path.
func MatchUrl(matchUrl string, logTarget *string, logUrl string) bool {
	if matchUrl == "" {
		return true
	}
	if strings.HasPrefix(matchUrl, "/") {
		return strings.Contains(logUrl, matchUrl)
	}

	slashIdx := strings.Index(matchUrl, "/")
	var service, path string
	if slashIdx >= 0 {
		service = matchUrl[:slashIdx]
		path = matchUrl[slashIdx:]
	} else {
		service = matchUrl
	}

	if service != "" {
		if logTarget == nil || *logTarget != service {
			return false
		}
	}
	if path != "" && !strings.Contains(logUrl, path) {
		return false
	}

	return true
}

// FindDirectRequestLog finds the HTTP log for the step's own action.
func FindDirectRequestLog(httpLogs []HttpLogMessage, action StepAction, stepExec StepExecution) *HttpLogMessage {
	startTime, endTime := stepTimeWindow(stepExec)

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
		if log.Method != action.Method {
			continue
		}
		if action.URL != "" {
			slashIdx := strings.Index(action.URL, "/")
			var service, path string
			if slashIdx >= 0 {
				service = action.URL[:slashIdx]
				path = action.URL[slashIdx:]
			} else {
				service = action.URL
			}
			if service != "" && (log.Target == nil || *log.Target != service) {
				continue
			}
			if path != "" && !strings.Contains(log.URL, path) {
				continue
			}
		}
		candidates = append(candidates, log)
	}

	if len(candidates) == 0 {
		return nil
	}
	if len(candidates) == 1 {
		return candidates[0]
	}

	mid := stepExecMidpoint(stepExec)
	best := candidates[0]
	bestDist := math.Abs(float64(parseLogTimestamp(best.Timestamp).UnixMilli() - mid))
	for _, c := range candidates[1:] {
		dist := math.Abs(float64(parseLogTimestamp(c.Timestamp).UnixMilli() - mid))
		if dist < bestDist {
			best = c
			bestDist = dist
		}
	}
	return best
}

// FindDirectDatabaseLog finds the database log for a dbQuery action.
func FindDirectDatabaseLog(dbLogs []DatabaseLogMessage, action StepAction, stepExec StepExecution) *DatabaseLogMessage {
	startTime, endTime := stepTimeWindow(stepExec)

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
		if strings.TrimSpace(log.Query) != strings.TrimSpace(action.Query) {
			continue
		}
		candidates = append(candidates, log)
	}

	if len(candidates) == 0 {
		return nil
	}
	if len(candidates) == 1 {
		return candidates[0]
	}

	mid := stepExecMidpoint(stepExec)
	best := candidates[0]
	bestDist := math.Abs(float64(parseLogTimestamp(best.Timestamp).UnixMilli() - mid))
	for _, c := range candidates[1:] {
		dist := math.Abs(float64(parseLogTimestamp(c.Timestamp).UnixMilli() - mid))
		if dist < bestDist {
			best = c
			bestDist = dist
		}
	}
	return best
}

func stepTimeWindow(stepExec StepExecution) (time.Time, time.Time) {
	start, startErr := time.Parse(time.RFC3339Nano, stepExec.StartTime)
	end, endErr := time.Parse(time.RFC3339Nano, stepExec.EndTime)
	if startErr != nil {
		log.Printf("Warning: failed to parse step StartTime %q: %v", stepExec.StartTime, startErr)
	}
	if endErr != nil {
		log.Printf("Warning: failed to parse step EndTime %q: %v", stepExec.EndTime, endErr)
	}
	// No backward buffer on start — the test-agent controls the step start
	// time so there's no clock skew. Forward buffer on end catches interceptor
	// logs that arrive slightly after the step response returns.
	end = end.Add(timestampBufferMs * time.Millisecond)
	return start, end
}

func stepExecMidpoint(stepExec StepExecution) int64 {
	start, startErr := time.Parse(time.RFC3339Nano, stepExec.StartTime)
	end, endErr := time.Parse(time.RFC3339Nano, stepExec.EndTime)
	if startErr != nil {
		log.Printf("Warning: failed to parse step StartTime %q: %v", stepExec.StartTime, startErr)
	}
	if endErr != nil {
		log.Printf("Warning: failed to parse step EndTime %q: %v", stepExec.EndTime, endErr)
	}
	return (start.UnixMilli() + end.UnixMilli()) / 2
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
func AssembleRootContext(
	step TestStep,
	stepExec StepExecution,
	httpLogs []HttpLogMessage,
	dbLogs []DatabaseLogMessage,
	consoleLogs []ConsoleLogMessage,
	varCtx *VariableContext,
	stepResp map[string]interface{},
) map[string]interface{} {
	traffic, httpTimeline := assembleTrafficList(httpLogs, stepExec)
	consoleLogList, consoleTimeline := assembleConsoleLogList(consoleLogs, stepExec)
	dbLogList, dbTimeline := assembleDbLogList(dbLogs, stepExec)

	rootCtx := map[string]interface{}{
		"variables":   varCtx.Snapshot(),
		"traffic":     traffic,
		"consoleLogs": consoleLogList,
		"dbLogs":      dbLogList,
		"timeline":    mergeTimeline(httpTimeline, consoleTimeline, dbTimeline),
	}

	switch step.Action.Type {
	case "wait":
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
		}
	}

	return rootCtx
}

func assembleTrafficList(httpLogs []HttpLogMessage, stepExec StepExecution) ([]interface{}, []timelineEntry) {
	startTime, endTime := stepTimeWindow(stepExec)
	var traffic []interface{}
	var timeline []timelineEntry
	for i := range httpLogs {
		l := &httpLogs[i]
		ts := l.Timestamp
		if l.RequestSentAt != nil {
			ts = *l.RequestSentAt
		}
		logTime := parseLogTimestamp(ts)
		if logTime.Before(startTime) || logTime.After(endTime) {
			continue
		}

		var from interface{}
		if l.Origin != nil {
			from = *l.Origin
		}
		var to interface{}
		if l.Target != nil {
			to = *l.Target
		}

		entry := map[string]interface{}{
			"timestamp": ts,
			"from":      from,
			"to":        to,
			"request": map[string]interface{}{
				"method":  l.Method,
				"url":     l.URL,
				"headers": NormalizeHeaderKeys(l.RequestHeaders),
				"body":    nilToEmptyMap(l.RequestBody),
			},
			"response": map[string]interface{}{
				"status":  ptrIntToFloat(l.StatusCode),
				"headers": NormalizeHeaderKeys(l.ResponseHeaders),
				"body":    nilToEmptyMap(l.ResponseBody),
			},
		}
		traffic = append(traffic, entry)
		timeline = append(timeline, timelineEntry{
			timestamp: logTime,
			entry: map[string]interface{}{
				"type":      "httpTraffic",
				"timestamp": ts,
				"from":      from,
				"to":        to,
				"method":    l.Method,
				"url":       l.URL,
				"status":    ptrIntToFloat(l.StatusCode),
			},
		})
	}
	if traffic == nil {
		traffic = []interface{}{}
	}
	return traffic, timeline
}

func assembleConsoleLogList(consoleLogs []ConsoleLogMessage, stepExec StepExecution) ([]interface{}, []timelineEntry) {
	startTime, endTime := stepTimeWindow(stepExec)
	var result []interface{}
	var timeline []timelineEntry
	for _, l := range consoleLogs {
		logTime := time.Unix(int64(l.Timestamp), int64((l.Timestamp-float64(int64(l.Timestamp)))*1e9))
		if logTime.Before(startTime) || logTime.After(endTime) {
			continue
		}
		entry := map[string]interface{}{
			"timestamp": l.Timestamp,
			"service":   l.Service,
			"level":     l.Level,
			"message":   l.Message,
		}
		result = append(result, entry)
		timeline = append(timeline, timelineEntry{
			timestamp: logTime,
			entry: map[string]interface{}{
				"type":      "consoleLog",
				"timestamp": l.Timestamp,
				"service":   l.Service,
				"level":     l.Level,
				"message":   l.Message,
			},
		})
	}
	if result == nil {
		result = []interface{}{}
	}
	return result, timeline
}

func assembleDbLogList(dbLogs []DatabaseLogMessage, stepExec StepExecution) ([]interface{}, []timelineEntry) {
	startTime, endTime := stepTimeWindow(stepExec)
	var result []interface{}
	var timeline []timelineEntry
	for _, l := range dbLogs {
		logTime := parseLogTimestamp(l.Timestamp)
		if logTime.Before(startTime) || logTime.After(endTime) {
			continue
		}
		var duration interface{}
		if l.Duration != nil {
			duration = float64(*l.Duration)
		}
		entry := map[string]interface{}{
			"timestamp": l.Timestamp,
			"database":  l.DatabaseName,
			"query":     l.Query,
			"duration":  duration,
			"result": map[string]interface{}{
				"success":      l.Success,
				"rowsAffected": ptrInt64ToFloat(l.RowsAffected),
				"error":        l.Error,
			},
		}
		result = append(result, entry)
		timeline = append(timeline, timelineEntry{
			timestamp: logTime,
			entry: map[string]interface{}{
				"type":      "dbQuery",
				"timestamp": l.Timestamp,
				"database":  l.DatabaseName,
				"query":     l.Query,
				"success":   l.Success,
			},
		})
	}
	if result == nil {
		result = []interface{}{}
	}
	return result, timeline
}

type timelineEntry struct {
	timestamp time.Time
	entry     map[string]interface{}
}

func mergeTimeline(slices ...[]timelineEntry) []interface{} {
	var entries []timelineEntry
	for _, s := range slices {
		entries = append(entries, s...)
	}

	sort.Slice(entries, func(i, j int) bool {
		return entries[i].timestamp.Before(entries[j].timestamp)
	})

	result := make([]interface{}, len(entries))
	for i, e := range entries {
		result[i] = e.entry
	}
	return result
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
