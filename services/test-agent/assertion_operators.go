package main

import (
	"encoding/json"
	"fmt"
	"reflect"
	"regexp"
	"strconv"
	"strings"
	"sync"
)

var regexCache sync.Map // pattern string → *regexp.Regexp

func getOrCompileRegex(pattern string) (*regexp.Regexp, error) {
	if cached, ok := regexCache.Load(pattern); ok {
		return cached.(*regexp.Regexp), nil
	}
	re, err := regexp.Compile(pattern)
	if err != nil {
		return nil, err
	}
	regexCache.Store(pattern, re)
	return re, nil
}

func CompareValues(operator string, actual, expected interface{}) AssertionResult {
	switch operator {
	case "eq":
		return AssertionResult{Passed: looseEqual(actual, expected), Expected: expected, Actual: actual}
	case "eqIgnoreCase":
		return AssertionResult{Passed: ciEquals(actual, expected), Expected: expected, Actual: actual}
	case "ne":
		return AssertionResult{Passed: !looseEqual(actual, expected), Expected: expected, Actual: actual}
	case "gt":
		af, aOk := toFloat(actual)
		ef, eOk := toFloat(expected)
		if !aOk || !eOk {
			return AssertionResult{Passed: false, Expected: expected, Actual: actual, Error: fmt.Sprintf("cannot compare non-numeric values with %s", operator)}
		}
		return AssertionResult{Passed: af > ef, Expected: expected, Actual: actual}
	case "gte":
		af, aOk := toFloat(actual)
		ef, eOk := toFloat(expected)
		if !aOk || !eOk {
			return AssertionResult{Passed: false, Expected: expected, Actual: actual, Error: fmt.Sprintf("cannot compare non-numeric values with %s", operator)}
		}
		return AssertionResult{Passed: af >= ef, Expected: expected, Actual: actual}
	case "lt":
		af, aOk := toFloat(actual)
		ef, eOk := toFloat(expected)
		if !aOk || !eOk {
			return AssertionResult{Passed: false, Expected: expected, Actual: actual, Error: fmt.Sprintf("cannot compare non-numeric values with %s", operator)}
		}
		return AssertionResult{Passed: af < ef, Expected: expected, Actual: actual}
	case "lte":
		af, aOk := toFloat(actual)
		ef, eOk := toFloat(expected)
		if !aOk || !eOk {
			return AssertionResult{Passed: false, Expected: expected, Actual: actual, Error: fmt.Sprintf("cannot compare non-numeric values with %s", operator)}
		}
		return AssertionResult{Passed: af <= ef, Expected: expected, Actual: actual}
	case "contains":
		return containsDispatch(actual, expected, false)
	case "notContains":
		return containsDispatch(actual, expected, true)
	case "containsIgnoreCase":
		return containsIgnoreCaseDispatch(actual, expected, false)
	case "notContainsIgnoreCase":
		return containsIgnoreCaseDispatch(actual, expected, true)
	case "matches":
		pattern := fmt.Sprintf("%v", expected)
		re, err := getOrCompileRegex(pattern)
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
			if looseEqual(item, actual) {
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
			if looseEqual(item, actual) {
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

func containsDispatch(actual, expected interface{}, negate bool) AssertionResult {
	if actual == nil {
		return AssertionResult{
			Passed:   false,
			Error:    fmt.Sprintf("cannot use contains on %s — expected string, array, or object", goTypeLabel(actual)),
			Expected: expected,
			Actual:   actual,
		}
	}
	switch v := actual.(type) {
	case string:
		passed := strings.Contains(v, fmt.Sprintf("%v", expected))
		if negate {
			passed = !passed
		}
		return AssertionResult{Passed: passed, Expected: expected, Actual: actual}
	case []interface{}:
		found := false
		for _, item := range v {
			if reflect.DeepEqual(item, expected) {
				found = true
				break
			}
		}
		if negate {
			found = !found
		}
		return AssertionResult{Passed: found, Expected: expected, Actual: actual}
	case map[string]interface{}:
		key := fmt.Sprintf("%v", expected)
		_, found := v[key]
		if negate {
			found = !found
		}
		return AssertionResult{Passed: found, Expected: expected, Actual: actual}
	default:
		return AssertionResult{
			Passed:   false,
			Error:    fmt.Sprintf("cannot use contains on %s — expected string, array, or object", goTypeLabel(actual)),
			Expected: expected,
			Actual:   actual,
		}
	}
}

func containsIgnoreCaseDispatch(actual, expected interface{}, negate bool) AssertionResult {
	if actual == nil {
		return AssertionResult{
			Passed:   false,
			Error:    fmt.Sprintf("cannot use containsIgnoreCase on %s — expected string, array, or object", goTypeLabel(actual)),
			Expected: expected,
			Actual:   actual,
		}
	}
	switch v := actual.(type) {
	case string:
		passed := strings.Contains(
			strings.ToLower(v),
			strings.ToLower(fmt.Sprintf("%v", expected)),
		)
		if negate {
			passed = !passed
		}
		return AssertionResult{Passed: passed, Expected: expected, Actual: actual}
	case []interface{}:
		expStr := strings.ToLower(fmt.Sprintf("%v", expected))
		found := false
		for _, item := range v {
			if strings.EqualFold(fmt.Sprintf("%v", item), expStr) {
				found = true
				break
			}
		}
		if negate {
			found = !found
		}
		return AssertionResult{Passed: found, Expected: expected, Actual: actual}
	case map[string]interface{}:
		key := fmt.Sprintf("%v", expected)
		found := false
		for k := range v {
			if strings.EqualFold(k, key) {
				found = true
				break
			}
		}
		if negate {
			found = !found
		}
		return AssertionResult{Passed: found, Expected: expected, Actual: actual}
	default:
		return AssertionResult{
			Passed:   false,
			Error:    fmt.Sprintf("cannot use containsIgnoreCase on %s — expected string, array, or object", goTypeLabel(actual)),
			Expected: expected,
			Actual:   actual,
		}
	}
}

func looseEqual(a, b interface{}) bool {
	if reflect.DeepEqual(a, b) {
		return true
	}
	ab, aOk := toBool(a)
	bb, bOk := toBool(b)
	if aOk && bOk {
		return ab == bb
	}
	af, aOk := toFloat(a)
	bf, bOk := toFloat(b)
	return aOk && bOk && af == bf
}

func toBool(v interface{}) (bool, bool) {
	switch b := v.(type) {
	case bool:
		return b, true
	case string:
		switch strings.ToLower(b) {
		case "true":
			return true, true
		case "false":
			return false, true
		}
	}
	return false, false
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
		f, err := strconv.ParseFloat(n, 64)
		if err == nil {
			return f, true
		}
		return 0, false
	}
	return 0, false
}

func goTypeLabel(v interface{}) string {
	if v == nil {
		return "null"
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
