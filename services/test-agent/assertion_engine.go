package main

import (
	"fmt"
)

type AssertionResult struct {
	Passed     bool        `json:"passed"`
	Error      string      `json:"error,omitempty"`
	Expected   interface{} `json:"expected,omitempty"`
	Actual     interface{} `json:"actual,omitempty"`
	Path       string      `json:"path,omitempty"`
	Operator   string      `json:"operator,omitempty"`
	BlockIndex *int        `json:"blockIndex,omitempty"`
	ResultKind string      `json:"resultKind,omitempty"` // "field", "count", "extract", "pending"
}

type Assertion struct {
	// Source fields — exactly one must be set
	Path    interface{} `json:"path,omitempty"`    // string or PathWithTransform
	Count   string      `json:"count,omitempty"`   // shorthand for transform:"length"
	Type    string      `json:"type,omitempty"`    // shorthand for transform:"type"
	Keys    string      `json:"keys,omitempty"`    // shorthand for transform:"keys"
	Values  string      `json:"values,omitempty"`  // shorthand for transform:"values"
	Entries string      `json:"entries,omitempty"` // shorthand for transform:"entries"

	Operator string      `json:"operator"`
	Value    interface{} `json:"value,omitempty"` // literal, or ValueRef object
	Disabled bool        `json:"disabled,omitempty"`
}

type PathWithTransform struct {
	From      string `json:"from"`
	Transform string `json:"transform"`
}

type ValueRef struct {
	From      string `json:"from"`
	Transform string `json:"transform,omitempty"`
}

type CountAssertion struct {
	Operator string `json:"operator"`
	Value    int    `json:"value"`
}

func ValidateAssertion(assertion Assertion, doc map[string]interface{}, scopedCtx ...interface{}) AssertionResult {
	sourcePath, transform, err := resolveSource(assertion)
	if err != nil {
		return AssertionResult{Passed: false, Error: err.Error()}
	}

	actual, found := EvaluateDocPath(doc, sourcePath, scopedCtx...)

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
			Path:     sourcePath,
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
			Path:     sourcePath,
		}
	}

	if !found {
		return AssertionResult{
			Passed:   false,
			Error:    fmt.Sprintf("Path '%s' not found in document", sourcePath),
			Expected: assertion.Value,
			Actual:   nil,
			Path:     sourcePath,
		}
	}

	if transform != "" {
		actual, err = applyAssertionTransform(actual, transform)
		if err != nil {
			return AssertionResult{Passed: false, Error: err.Error(), Path: sourcePath}
		}
	}

	expected, err := resolveValue(assertion.Value, doc, scopedCtx...)
	if err != nil {
		return AssertionResult{Passed: false, Error: err.Error(), Path: sourcePath}
	}

	result := CompareValues(assertion.Operator, actual, expected)
	result.Path = sourcePath
	return result
}
