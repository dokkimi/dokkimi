package main

import (
	"regexp"
	"strconv"
	"strings"
)

// findKeyFold returns the key of obj that equals key ignoring case. When
// several do, it returns the first in byte order, so the choice doesn't depend
// on map iteration order.
func findKeyFold(obj map[string]interface{}, key string) (string, bool) {
	found, ok := "", false
	for k := range obj {
		if strings.EqualFold(k, key) && (!ok || k < found) {
			found, ok = k, true
		}
	}
	return found, ok
}

// EvaluateDocPath resolves a dotted path against an assembled document.
// Supports: "response.body.user.name", "data[0].email", "data[-1].email", "responseTime"
// Unlike EvaluateJsonPath, this returns (value, found) with case-insensitive key fallback.
// Optional scopedCtx: when provided and path starts with "$$.", resolves against scopedCtx[0].
func EvaluateDocPath(doc interface{}, path string, scopedCtx ...interface{}) (interface{}, bool) {
	if path == "" {
		return nil, false
	}
	if doc == nil {
		return nil, false
	}

	// Reject bare "$$" without trailing ".field"
	if path == "$$" {
		return nil, false
	}

	// Handle "$$." prefix — resolve against scoped context
	if strings.HasPrefix(path, "$$.") {
		if len(scopedCtx) == 0 || scopedCtx[0] == nil {
			return nil, false
		}
		path = path[3:]
		doc = scopedCtx[0]
	} else if strings.HasPrefix(path, "$.") {
		path = path[2:]
	}

	segments := parsePathSegments(path)
	if segments == nil {
		return nil, false
	}

	value := doc
	for _, seg := range segments {
		if value == nil {
			return nil, false
		}

		if arrayMatch := arrayIndexPattern.FindStringSubmatch(seg); arrayMatch != nil {
			arr, ok := toSlice(value)
			if !ok {
				return nil, false
			}
			index, _ := strconv.Atoi(arrayMatch[1])
			if index < 0 {
				index = len(arr) + index
			}
			if index < 0 || index >= len(arr) {
				return nil, false
			}
			value = arr[index]
		} else {
			obj, ok := toMap(value)
			if !ok {
				return nil, false
			}
			if v, exists := obj[seg]; exists {
				value = v
			} else if origKey, exists := findKeyFold(obj, seg); exists {
				value = obj[origKey]
			} else {
				return nil, false
			}
		}
	}

	return value, true
}

var arrayIndexPattern = regexp.MustCompile(`^\[(-?\d+)\]$`)

func parsePathSegments(path string) []string {
	var segments []string
	var current strings.Builder
	for i := 0; i < len(path); i++ {
		switch path[i] {
		case '.':
			if current.Len() > 0 {
				segments = append(segments, current.String())
				current.Reset()
			}
		case '[':
			if current.Len() > 0 {
				segments = append(segments, current.String())
				current.Reset()
			}
			closeIdx := strings.Index(path[i:], "]")
			if closeIdx == -1 {
				return nil
			}
			segments = append(segments, path[i:i+closeIdx+1])
			i += closeIdx
		default:
			current.WriteByte(path[i])
		}
	}
	if current.Len() > 0 {
		segments = append(segments, current.String())
	}
	return segments
}

func toMap(v interface{}) (map[string]interface{}, bool) {
	m, ok := v.(map[string]interface{})
	return m, ok
}

func toSlice(v interface{}) ([]interface{}, bool) {
	s, ok := v.([]interface{})
	return s, ok
}
