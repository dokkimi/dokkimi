package main

import (
	"encoding/json"
	"fmt"
	"reflect"
	"regexp"
	"strings"
)

type AssertionResult struct {
	Passed     bool        `json:"passed"`
	Error      string      `json:"error,omitempty"`
	Expected   interface{} `json:"expected,omitempty"`
	Actual     interface{} `json:"actual,omitempty"`
	Path       string      `json:"path,omitempty"`
	Operator   string      `json:"operator,omitempty"`
	BlockIndex *int        `json:"blockIndex,omitempty"`
	ResultKind string      `json:"resultKind,omitempty"` // "field", "count", "extract"
}

type Assertion struct {
	Path     string      `json:"path"`
	Operator string      `json:"operator"`
	Value    interface{} `json:"value"`
	Disabled bool        `json:"disabled,omitempty"`
}

type CountAssertion struct {
	Operator string `json:"operator"`
	Value    int    `json:"value"`
}

// EvaluateDocPath resolves a dotted path against an assembled document.
// Supports: "response.body.user.name", "data[0].email", "responseTime", "success"
// Unlike EvaluateJsonPath, this returns (value, found) with case-insensitive key fallback.
func EvaluateDocPath(doc interface{}, path string) (interface{}, bool) {
	if path == "" {
		return nil, false
	}
	if doc == nil {
		return nil, false
	}

	if strings.HasPrefix(path, "$.") {
		path = path[2:]
	}

	segments := parsePathSegments(path)
	if segments == nil {
		return nil, false
	}

	value := doc
	for i, seg := range segments {
		if value == nil {
			if i < len(segments) {
				return nil, false
			}
			break
		}

		if arrayMatch := arrayIndexPattern.FindStringSubmatch(seg); arrayMatch != nil {
			arr, ok := toSlice(value)
			if !ok {
				return nil, false
			}
			var index int
			fmt.Sscanf(arrayMatch[1], "%d", &index)
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
			} else {
				lowerSeg := strings.ToLower(seg)
				found := false
				for k, v := range obj {
					if strings.ToLower(k) == lowerSeg {
						value = v
						found = true
						break
					}
				}
				if !found {
					return nil, false
				}
			}
		}
	}

	return value, true
}

var arrayIndexPattern = regexp.MustCompile(`^\[(\d+)\]$`)

func parsePathSegments(path string) []string {
	var segments []string
	current := ""
	for i := 0; i < len(path); i++ {
		ch := path[i]
		if ch == '.' {
			if current != "" {
				segments = append(segments, current)
			}
			current = ""
		} else if ch == '[' {
			if current != "" {
				segments = append(segments, current)
			}
			closeIdx := strings.Index(path[i:], "]")
			if closeIdx == -1 {
				return nil
			}
			segments = append(segments, path[i:i+closeIdx+1])
			i += closeIdx
			current = ""
		} else {
			current += string(ch)
		}
	}
	if current != "" {
		segments = append(segments, current)
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

func ciEquals(a, b interface{}) bool {
	aStr, aIsStr := a.(string)
	bStr, bIsStr := b.(string)
	if aIsStr && bIsStr {
		return strings.EqualFold(aStr, bStr)
	}
	return reflect.DeepEqual(a, b)
}

func toFloat(v interface{}) (float64, bool) {
	switch n := v.(type) {
	case float64:
		return n, true
	case float32:
		return float64(n), true
	case int:
		return float64(n), true
	case int64:
		return float64(n), true
	case json.Number:
		f, err := n.Float64()
		return f, err == nil
	case string:
		var f float64
		if _, err := fmt.Sscanf(n, "%f", &f); err == nil {
			return f, true
		}
		return 0, false
	}
	return 0, false
}

func CompareValues(operator string, actual, expected interface{}) AssertionResult {
	switch operator {
	case "eq":
		return AssertionResult{Passed: reflect.DeepEqual(actual, expected), Expected: expected, Actual: actual}
	case "eqIgnoreCase":
		return AssertionResult{Passed: ciEquals(actual, expected), Expected: expected, Actual: actual}
	case "ne":
		return AssertionResult{Passed: !reflect.DeepEqual(actual, expected), Expected: expected, Actual: actual}
	case "gt":
		af, aOk := toFloat(actual)
		ef, eOk := toFloat(expected)
		passed := aOk && eOk && af > ef
		return AssertionResult{Passed: passed, Expected: expected, Actual: actual}
	case "gte":
		af, aOk := toFloat(actual)
		ef, eOk := toFloat(expected)
		passed := aOk && eOk && af >= ef
		return AssertionResult{Passed: passed, Expected: expected, Actual: actual}
	case "lt":
		af, aOk := toFloat(actual)
		ef, eOk := toFloat(expected)
		passed := aOk && eOk && af < ef
		return AssertionResult{Passed: passed, Expected: expected, Actual: actual}
	case "lte":
		af, aOk := toFloat(actual)
		ef, eOk := toFloat(expected)
		passed := aOk && eOk && af <= ef
		return AssertionResult{Passed: passed, Expected: expected, Actual: actual}
	case "contains":
		passed := strings.Contains(
			strings.ToLower(fmt.Sprintf("%v", actual)),
			strings.ToLower(fmt.Sprintf("%v", expected)),
		)
		return AssertionResult{Passed: passed, Expected: expected, Actual: actual}
	case "notContains":
		passed := !strings.Contains(
			strings.ToLower(fmt.Sprintf("%v", actual)),
			strings.ToLower(fmt.Sprintf("%v", expected)),
		)
		return AssertionResult{Passed: passed, Expected: expected, Actual: actual}
	case "matches":
		pattern := fmt.Sprintf("%v", expected)
		re, err := regexp.Compile(pattern)
		if err != nil {
			return AssertionResult{Passed: false, Error: fmt.Sprintf("Invalid regex pattern: %s", expected)}
		}
		return AssertionResult{Passed: re.MatchString(fmt.Sprintf("%v", actual)), Expected: expected, Actual: actual}
	case "in":
		arr, ok := toSlice(expected)
		if !ok {
			return AssertionResult{Passed: false, Expected: expected, Actual: actual}
		}
		found := false
		for _, item := range arr {
			if reflect.DeepEqual(item, actual) {
				found = true
				break
			}
		}
		return AssertionResult{Passed: found, Expected: expected, Actual: actual}
	case "notIn":
		arr, ok := toSlice(expected)
		if !ok {
			return AssertionResult{Passed: false, Expected: expected, Actual: actual}
		}
		found := false
		for _, item := range arr {
			if reflect.DeepEqual(item, actual) {
				found = true
				break
			}
		}
		return AssertionResult{Passed: !found, Expected: expected, Actual: actual}
	case "type":
		actualType := goTypeLabel(actual)
		return AssertionResult{Passed: actualType == expected, Expected: expected, Actual: actualType}
	case "length":
		length := getLength(actual)
		if length == -1 {
			return AssertionResult{Passed: false, Expected: expected, Actual: nil}
		}
		ef, _ := toFloat(expected)
		return AssertionResult{Passed: float64(length) == ef, Expected: expected, Actual: float64(length)}
	case "arrayContains":
		arr, ok := toSlice(actual)
		if !ok {
			return AssertionResult{Passed: false, Error: "Value is not an array", Expected: expected, Actual: actual}
		}
		found := false
		for _, item := range arr {
			if reflect.DeepEqual(item, expected) {
				found = true
				break
			}
		}
		return AssertionResult{Passed: found, Expected: expected, Actual: actual}
	case "arrayNotContains":
		arr, ok := toSlice(actual)
		if !ok {
			return AssertionResult{Passed: false, Error: "Value is not an array", Expected: expected, Actual: actual}
		}
		found := false
		for _, item := range arr {
			if reflect.DeepEqual(item, expected) {
				found = true
				break
			}
		}
		return AssertionResult{Passed: !found, Expected: expected, Actual: actual}
	case "isEmpty":
		empty := isEmptyValue(actual)
		actualLabel := "not empty"
		if empty {
			actualLabel = "empty"
		}
		return AssertionResult{Passed: empty, Expected: "empty", Actual: actualLabel}
	case "notEmpty":
		notEmpty := !isEmptyValue(actual)
		actualLabel := "empty"
		if notEmpty {
			actualLabel = "not empty"
		}
		return AssertionResult{Passed: notEmpty, Expected: "not empty", Actual: actualLabel}
	default:
		return AssertionResult{Passed: false, Error: fmt.Sprintf("Unknown operator: %s", operator)}
	}
}

func goTypeLabel(v interface{}) string {
	if v == nil {
		return "undefined"
	}
	switch v.(type) {
	case string:
		return "string"
	case float64, float32, int, int64, json.Number:
		return "number"
	case bool:
		return "boolean"
	case []interface{}:
		return "array"
	case map[string]interface{}:
		return "object"
	default:
		return "object"
	}
}

func getLength(v interface{}) int {
	switch val := v.(type) {
	case []interface{}:
		return len(val)
	case string:
		return len(val)
	default:
		return -1
	}
}

func isEmptyValue(v interface{}) bool {
	if v == nil {
		return true
	}
	switch val := v.(type) {
	case string:
		return len(val) == 0
	case []interface{}:
		return len(val) == 0
	case map[string]interface{}:
		return len(val) == 0
	default:
		return false
	}
}

func ValidateAssertion(assertion Assertion, doc map[string]interface{}) AssertionResult {
	actual, found := EvaluateDocPath(doc, assertion.Path)

	// For exists/notExists, treat null the same as not-found
	presentAndNonNil := found && actual != nil

	if assertion.Operator == "exists" {
		actualLabel := "exists"
		if !presentAndNonNil {
			actualLabel = "not found"
		}
		return AssertionResult{
			Passed:   presentAndNonNil,
			Expected: "exists",
			Actual:   actualLabel,
		}
	}

	if assertion.Operator == "notExists" {
		actualLabel := "exists"
		if !presentAndNonNil {
			actualLabel = "not found"
		}
		return AssertionResult{
			Passed:   !presentAndNonNil,
			Expected: "not exists",
			Actual:   actualLabel,
		}
	}

	if !found {
		return AssertionResult{
			Passed:   false,
			Error:    fmt.Sprintf("Path '%s' not found in document", assertion.Path),
			Expected: assertion.Value,
			Actual:   nil,
		}
	}

	return CompareValues(assertion.Operator, actual, assertion.Value)
}

func ValidateCount(actual int, count CountAssertion) AssertionResult {
	expected := count.Value
	switch count.Operator {
	case "eq":
		return AssertionResult{Passed: actual == expected, Expected: float64(expected), Actual: float64(actual)}
	case "gte":
		return AssertionResult{Passed: actual >= expected, Expected: float64(expected), Actual: float64(actual)}
	case "lte":
		return AssertionResult{Passed: actual <= expected, Expected: float64(expected), Actual: float64(actual)}
	case "gt":
		return AssertionResult{Passed: actual > expected, Expected: float64(expected), Actual: float64(actual)}
	case "lt":
		return AssertionResult{Passed: actual < expected, Expected: float64(expected), Actual: float64(actual)}
	default:
		return AssertionResult{Passed: false, Error: fmt.Sprintf("Unknown operator: %s", count.Operator)}
	}
}

// ResolveExtractRule extracts a variable value from a document using a path and optional regex.
func ResolveExtractRule(doc map[string]interface{}, variable string, rule ExtractRule) (string, error) {
	rawValue, found := EvaluateDocPath(doc, rule.Path)
	if !found {
		return "", fmt.Errorf("Failed to extract variable '%s': path '%s' not found", variable, rule.Path)
	}

	var strValue string
	if s, ok := rawValue.(string); ok {
		strValue = s
	} else {
		b, _ := json.Marshal(rawValue)
		strValue = string(b)
	}

	if rule.Pattern == "" {
		return strValue, nil
	}

	re, err := regexp.Compile(rule.Pattern)
	if err != nil {
		return "", fmt.Errorf("Failed to extract variable '%s': invalid regex pattern '%s': %w", variable, rule.Pattern, err)
	}

	group := 1
	if rule.Group != nil {
		group = *rule.Group
	}

	matches := re.FindStringSubmatch(strValue)
	if matches == nil {
		return "", fmt.Errorf("Failed to extract variable '%s': pattern '%s' did not match value '%s'", variable, rule.Pattern, strValue)
	}
	if group < 0 || group >= len(matches) {
		return "", fmt.Errorf("Failed to extract variable '%s': capture group %d out of range (pattern has %d groups)", variable, group, len(matches)-1)
	}

	return matches[group], nil
}
