package main

import (
	"log"
	"sort"
	"time"
)

func computeResponseTime(l *HttpLogMessage) interface{} {
	if l.RequestSentAt != nil && l.ResponseReceivedAt != nil {
		sentAt, err1 := time.Parse(time.RFC3339Nano, *l.RequestSentAt)
		receivedAt, err2 := time.Parse(time.RFC3339Nano, *l.ResponseReceivedAt)
		if err1 == nil && err2 == nil {
			return float64(receivedAt.Sub(sentAt).Milliseconds())
		}
	}
	return nil
}

type timelineEntry struct {
	timestamp time.Time
	entry     map[string]interface{}
}

func assembleTrafficList(httpLogs []HttpLogMessage, stepExec StepExecution) ([]interface{}, []timelineEntry) {
	startTime, endTime, err := stepTimeWindow(stepExec)
	if err != nil {
		log.Printf("assembleTrafficList: %v", err)
		return []interface{}{}, nil
	}
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

		trafficIdx := float64(len(traffic))
		entry := map[string]interface{}{
			"timestamp":    ts,
			"origin":       from,
			"from":         from,
			"to":           to,
			"responseTime": computeResponseTime(l),
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
				"type":         "httpRequest",
				"timestamp":    ts,
				"trafficIndex": trafficIdx,
				"direction":    "request",
				"from":         from,
				"to":           to,
				"method":       l.Method,
				"url":          l.URL,
			},
		})
		if l.StatusCode != nil {
			respTs := ts
			respLogTime := logTime
			if l.ResponseReceivedAt != nil {
				respTs = *l.ResponseReceivedAt
				respLogTime = parseLogTimestamp(respTs)
			}
			timeline = append(timeline, timelineEntry{
				timestamp: respLogTime,
				entry: map[string]interface{}{
					"type":         "httpResponse",
					"timestamp":    respTs,
					"trafficIndex": trafficIdx,
					"direction":    "response",
					"from":         from,
					"to":           to,
					"status":       ptrIntToFloat(l.StatusCode),
				},
			})
		}
	}
	if traffic == nil {
		traffic = []interface{}{}
	}
	return traffic, timeline
}

func assembleConsoleLogList(consoleLogs []ConsoleLogMessage, stepExec StepExecution) ([]interface{}, []timelineEntry) {
	startTime, endTime, err := stepTimeWindow(stepExec)
	if err != nil {
		log.Printf("assembleConsoleLogList: %v", err)
		return nil, nil
	}
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
	startTime, endTime, err := stepTimeWindow(stepExec)
	if err != nil {
		log.Printf("assembleDbLogList: %v", err)
		return nil, nil
	}
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

func assembleMessageLogList(msgLogs []MessageLogMessage, stepExec StepExecution) ([]interface{}, []timelineEntry) {
	startTime, endTime, err := stepTimeWindow(stepExec)
	if err != nil {
		log.Printf("assembleMessageLogList: %v", err)
		return nil, nil
	}
	var result []interface{}
	var timeline []timelineEntry
	for _, l := range msgLogs {
		logTime := parseLogTimestamp(l.Timestamp)
		if logTime.Before(startTime) || logTime.After(endTime) {
			continue
		}
		entry := map[string]interface{}{
			"timestamp":  l.Timestamp,
			"broker":     l.BrokerName,
			"brokerType": l.BrokerType,
			"operation":  l.Operation,
			"body":       nilToEmptyMap(l.Body),
		}
		for k, v := range l.Metadata {
			entry[k] = v
		}
		result = append(result, entry)
		tlEntry := map[string]interface{}{
			"type":      "message",
			"timestamp": l.Timestamp,
			"broker":    l.BrokerName,
			"operation": l.Operation,
		}
		for k, v := range l.Metadata {
			tlEntry[k] = v
		}
		timeline = append(timeline, timelineEntry{
			timestamp: logTime,
			entry:     tlEntry,
		})
	}
	if result == nil {
		result = []interface{}{}
	}
	return result, timeline
}

func mergeTimeline(slices ...[]timelineEntry) []interface{} {
	var entries []timelineEntry
	for _, s := range slices {
		entries = append(entries, s...)
	}

	sort.SliceStable(entries, func(i, j int) bool {
		return entries[i].timestamp.Before(entries[j].timestamp)
	})

	result := make([]interface{}, len(entries))
	for i, e := range entries {
		result[i] = e.entry
	}
	return result
}

type timelineLookupKey struct {
	trafficIndex float64
	direction    string
}

func annotateTimelineIndices(traffic []interface{}, timeline []interface{}) {
	// Build a map from (trafficIndex, direction) → timeline index in a single pass.
	lookup := make(map[timelineLookupKey]int, len(timeline))
	for i, t := range timeline {
		entry, ok := t.(map[string]interface{})
		if !ok {
			continue
		}
		ti, ok1 := entry["trafficIndex"]
		dir, ok2 := entry["direction"]
		if !ok1 || !ok2 {
			continue
		}
		tiFloat, fOk := ti.(float64)
		dirStr, dOk := dir.(string)
		if !fOk || !dOk {
			continue
		}
		lookup[timelineLookupKey{trafficIndex: tiFloat, direction: dirStr}] = i
	}

	for i, t := range traffic {
		entry, ok := t.(map[string]interface{})
		if !ok {
			continue
		}
		tiFloat := float64(i)
		if reqIdx, found := lookup[timelineLookupKey{trafficIndex: tiFloat, direction: "request"}]; found {
			entry["requestTimelineIndex"] = float64(reqIdx)
		} else {
			entry["requestTimelineIndex"] = nil
		}
		if respIdx, found := lookup[timelineLookupKey{trafficIndex: tiFloat, direction: "response"}]; found {
			entry["responseTimelineIndex"] = float64(respIdx)
		} else {
			entry["responseTimelineIndex"] = nil
		}
	}
}
