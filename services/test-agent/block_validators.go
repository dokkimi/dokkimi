package main

import (
	"fmt"
	"regexp"
	"strings"
)

// ValidateSelfBlock validates assertions against the step's own action result.
func ValidateSelfBlock(block AssertionBlock, stepDoc map[string]interface{}) []AssertionResult {
	if len(stepDoc) == 0 {
		results := make([]AssertionResult, len(block.Assertions))
		for i, a := range block.Assertions {
			results[i] = AssertionResult{
				Passed:     false,
				Error:      "Step log not found",
				Path:       a.Path,
				Operator:   a.Operator,
				ResultKind: "field",
			}
		}
		return results
	}

	var results []AssertionResult
	for _, a := range block.Assertions {
		if a.Disabled {
			continue
		}
		r := ValidateAssertion(a, stepDoc)
		r.Path = a.Path
		r.Operator = a.Operator
		r.ResultKind = "field"
		results = append(results, r)
	}
	return results
}

// ValidateHttpCallBlock validates assertions against matching HTTP logs observed during the step.
func ValidateHttpCallBlock(
	block AssertionBlock,
	stepExec StepExecution,
	httpLogs []HttpLogMessage,
) []AssertionResult {
	var results []AssertionResult

	startTime, endTime := stepTimeWindow(stepExec)

	var matchingLogs []HttpLogMessage
	for _, log := range httpLogs {
		ts := log.Timestamp
		if log.RequestSentAt != nil {
			ts = *log.RequestSentAt
		}
		logTime := parseLogTimestamp(ts)
		if logTime.Before(startTime) || logTime.After(endTime) {
			continue
		}
		if block.Match != nil {
			if block.Match.Origin != "" {
				if log.Origin == nil || *log.Origin != block.Match.Origin {
					continue
				}
			}
			if block.Match.Method != "" && log.Method != block.Match.Method {
				continue
			}
			if block.Match.URL != "" {
				if !MatchUrl(block.Match.URL, log.Target, log.URL) {
					continue
				}
			}
		}
		matchingLogs = append(matchingLogs, log)
	}

	count := block.Count
	if count == nil {
		count = &CountAssertion{Operator: "gte", Value: 1}
	}
	countResult := ValidateCount(len(matchingLogs), *count)
	countResult.ResultKind = "count"
	results = append(results, countResult)
	if !countResult.Passed {
		return results
	}

	var activeAssertions []Assertion
	for _, a := range block.Assertions {
		if !a.Disabled {
			activeAssertions = append(activeAssertions, a)
		}
	}
	if len(activeAssertions) == 0 {
		return results
	}

	docs := make([]map[string]interface{}, len(matchingLogs))
	for i := range matchingLogs {
		docs[i] = AssembleHttpDocument(&matchingLogs[i])
	}

	scope := block.AssertionScope
	if scope == "" {
		scope = "all"
	}

	var docsToValidate []map[string]interface{}
	switch scope {
	case "first":
		docsToValidate = docs[:1]
	case "last":
		docsToValidate = docs[len(docs)-1:]
	default:
		docsToValidate = docs
	}

	if scope == "any" {
		for _, a := range activeAssertions {
			anyPassed := false
			for _, doc := range docsToValidate {
				r := ValidateAssertion(a, doc)
				if r.Passed {
					anyPassed = true
					break
				}
			}
			if anyPassed {
				results = append(results, AssertionResult{
					Passed:     true,
					Path:       a.Path,
					Operator:   a.Operator,
					ResultKind: "field",
				})
			} else {
				results = append(results, AssertionResult{
					Passed:     false,
					Error:      fmt.Sprintf("No matching log passed assertion: %s", a.Path),
					Path:       a.Path,
					Operator:   a.Operator,
					ResultKind: "field",
				})
			}
		}
	} else {
		for _, a := range activeAssertions {
			for _, doc := range docsToValidate {
				r := ValidateAssertion(a, doc)
				r.Path = a.Path
				r.Operator = a.Operator
				r.ResultKind = "field"
				results = append(results, r)
				if !r.Passed {
					return results
				}
			}
		}
	}

	return results
}

// ValidateConsoleLogBlock validates console log assertions against in-memory console logs.
func ValidateConsoleLogBlock(
	block AssertionBlock,
	consoleLogs []ConsoleLogMessage,
	serviceName string,
) []AssertionResult {
	var results []AssertionResult

	for _, ca := range block.ConsoleAssertions {
		if ca.Disabled {
			continue
		}

		matchCount := 0
		for _, log := range consoleLogs {
			if serviceName != "" && log.Service != serviceName {
				continue
			}
			if ca.Level != "" && !strings.EqualFold(log.Level, ca.Level) {
				continue
			}
			if ca.Message != nil {
				if !matchMessage(log.Message, ca.Message) {
					continue
				}
			}
			matchCount++
		}

		r := ValidateCount(matchCount, ca.Count)
		var parts []string
		if ca.Level != "" {
			parts = append(parts, strings.ToUpper(ca.Level))
		}
		if ca.Message != nil {
			parts = append(parts, fmt.Sprintf(`%s "%s"`, ca.Message.Operator, ca.Message.Value))
		}
		r.Path = fmt.Sprintf("console(%s)", strings.Join(parts, ", "))
		r.ResultKind = "count"
		results = append(results, r)
	}

	return results
}

func matchMessage(logMessage string, filter *MessageFilter) bool {
	switch filter.Operator {
	case "eq":
		return logMessage == filter.Value
	case "contains":
		return strings.Contains(logMessage, filter.Value)
	case "matches":
		re, err := regexp.Compile(filter.Value)
		if err != nil {
			return false
		}
		return re.MatchString(logMessage)
	default:
		return false
	}
}
