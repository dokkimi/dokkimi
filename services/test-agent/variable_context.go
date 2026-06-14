package main

import (
	"encoding/json"
	"fmt"
	"regexp"
	"strings"
	"sync"
)

var variablePattern = regexp.MustCompile(`\{\{(\w+)\}\}`)

// VariableContext stores and resolves variables during test execution.
type VariableContext struct {
	mu        sync.RWMutex
	variables map[string]string
}

// NewVariableContext creates a new empty variable context.
func NewVariableContext() *VariableContext {
	return &VariableContext{
		variables: make(map[string]string),
	}
}

// Reset clears all variables in place. Use this instead of replacing the
// pointer when other components (UI executor, logger) hold references to the
// same context — reassigning the pointer leaves them looking at stale state.
func (vc *VariableContext) Reset() {
	vc.mu.Lock()
	defer vc.mu.Unlock()
	vc.variables = make(map[string]string)
}

// Set stores a variable value.
func (vc *VariableContext) Set(name, value string) {
	vc.mu.Lock()
	defer vc.mu.Unlock()
	vc.variables[name] = value
}

// Resolve replaces {{variableName}} placeholders in a template string.
// Returns an error if a referenced variable is not defined.
func (vc *VariableContext) Resolve(template string) (string, error) {
	vc.mu.RLock()
	defer vc.mu.RUnlock()
	var resolveErr error
	result := variablePattern.ReplaceAllStringFunc(template, func(match string) string {
		varName := variablePattern.FindStringSubmatch(match)[1]
		value, ok := vc.variables[varName]
		if !ok {
			resolveErr = fmt.Errorf("variable '%s' is not defined", varName)
			return match
		}
		return value
	})
	if resolveErr != nil {
		return "", resolveErr
	}
	return result, nil
}

// ResolveAction returns a copy of the action with variables resolved in URL, Headers values, and Body string values.
func (vc *VariableContext) ResolveAction(action StepAction) (StepAction, error) {
	resolved := action

	// Resolve URL
	if action.URL != "" {
		url, err := vc.Resolve(action.URL)
		if err != nil {
			return resolved, fmt.Errorf("resolving url: %w", err)
		}
		resolved.URL = url
	}

	// Resolve header values
	if len(action.Headers) > 0 {
		resolvedHeaders := make(map[string]string, len(action.Headers))
		for key, value := range action.Headers {
			resolvedValue, err := vc.Resolve(value)
			if err != nil {
				return resolved, fmt.Errorf("resolving header '%s': %w", key, err)
			}
			resolvedHeaders[key] = resolvedValue
		}
		resolved.Headers = resolvedHeaders
	}

	// Resolve body (if it's a string or contains strings)
	if action.Body != nil {
		resolvedBody, err := vc.resolveValue(action.Body)
		if err != nil {
			return resolved, fmt.Errorf("resolving body: %w", err)
		}
		resolved.Body = resolvedBody
	}

	// Resolve database query string
	if action.Query != "" {
		query, err := vc.Resolve(action.Query)
		if err != nil {
			return resolved, fmt.Errorf("resolving query: %w", err)
		}
		resolved.Query = query
	}

	// Resolve database query params (string values may reference {{vars}}).
	if len(action.Params) > 0 {
		resolvedParams, err := vc.resolveValue(action.Params)
		if err != nil {
			return resolved, fmt.Errorf("resolving params: %w", err)
		}
		resolved.Params = resolvedParams.(map[string]interface{})
	}

	// Resolve sub-actions in parallel blocks.
	if len(action.Actions) > 0 {
		resolvedActions := make([]StepAction, len(action.Actions))
		for i, sub := range action.Actions {
			r, err := vc.ResolveAction(sub)
			if err != nil {
				return resolved, fmt.Errorf("resolving parallel sub-action %d: %w", i, err)
			}
			resolvedActions[i] = r
		}
		resolved.Actions = resolvedActions
	}

	return resolved, nil
}

// resolveValue recursively resolves variables in a value.
// ResolveAssertionBlocks resolves variable templates in assertion expected values,
// match criteria, and console assertion message filters.
func (vc *VariableContext) ResolveAssertionBlocks(blocks []AssertionBlock) []AssertionBlock {
	resolved := make([]AssertionBlock, len(blocks))
	for i, block := range blocks {
		resolved[i] = block

		// Resolve assertion values
		if len(block.Assertions) > 0 {
			resolvedAssertions := make([]Assertion, len(block.Assertions))
			for j, a := range block.Assertions {
				resolvedAssertions[j] = a
				if a.Value != nil {
					if rv, err := vc.resolveValue(a.Value); err == nil {
						resolvedAssertions[j].Value = rv
					}
				}
			}
			resolved[i].Assertions = resolvedAssertions
		}

		// Resolve match criteria
		if block.Match != nil {
			m := *block.Match
			if m.URL != "" {
				if rv, err := vc.Resolve(m.URL); err == nil {
					m.URL = rv
				}
			}
			if m.Origin != "" {
				if rv, err := vc.Resolve(m.Origin); err == nil {
					m.Origin = rv
				}
			}
			resolved[i].Match = &m
		}

		// Resolve console assertion message filters
		if len(block.ConsoleAssertions) > 0 {
			resolvedCA := make([]ConsoleLogAssertion, len(block.ConsoleAssertions))
			for j, ca := range block.ConsoleAssertions {
				resolvedCA[j] = ca
				if ca.Message != nil && ca.Message.Value != "" {
					if rv, err := vc.Resolve(ca.Message.Value); err == nil {
						resolvedCA[j].Message = &MessageFilter{
							Operator: ca.Message.Operator,
							Value:    rv,
						}
					}
				}
			}
			resolved[i].ConsoleAssertions = resolvedCA
		}
	}
	return resolved
}

func (vc *VariableContext) resolveValue(value interface{}) (interface{}, error) {
	switch v := value.(type) {
	case string:
		return vc.Resolve(v)
	case map[string]interface{}:
		resolved := make(map[string]interface{}, len(v))
		for key, val := range v {
			resolvedVal, err := vc.resolveValue(val)
			if err != nil {
				return nil, err
			}
			resolved[key] = resolvedVal
		}
		return resolved, nil
	case []interface{}:
		resolved := make([]interface{}, len(v))
		for i, val := range v {
			resolvedVal, err := vc.resolveValue(val)
			if err != nil {
				return nil, err
			}
			resolved[i] = resolvedVal
		}
		return resolved, nil
	default:
		return value, nil
	}
}

// Extract evaluates extraction rules against a document and stores the results as variables.
// For HTTP steps, the document is the response: { statusCode, headers, body }.
// For DB steps, the document is the query result: { success, data, rowsAffected, error, duration }.
func (vc *VariableContext) Extract(rules map[string]ExtractRule, doc map[string]interface{}) error {
	if len(rules) == 0 || doc == nil {
		return nil
	}

	for varName, rule := range rules {
		value, err := EvaluateJsonPath(doc, rule.Path)
		if err != nil {
			return fmt.Errorf("failed to extract variable '%s' at path '%s': %w", varName, rule.Path, err)
		}

		strValue := valueToString(value)

		if rule.Pattern != "" {
			re, err := regexp.Compile(rule.Pattern)
			if err != nil {
				return fmt.Errorf("failed to extract variable '%s': invalid regex pattern '%s': %w", varName, rule.Pattern, err)
			}

			group := 1
			if rule.Group != nil {
				group = *rule.Group
			}

			matches := re.FindStringSubmatch(strValue)
			if matches == nil {
				return fmt.Errorf("failed to extract variable '%s': pattern '%s' did not match value '%s'", varName, rule.Pattern, strValue)
			}
			if group < 0 || group >= len(matches) {
				return fmt.Errorf("failed to extract variable '%s': capture group %d out of range (pattern has %d groups)", varName, group, len(matches)-1)
			}
			strValue = matches[group]
		}

		vc.Set(varName, strValue)
	}

	return nil
}

// Snapshot returns a copy of all current variable values.
func (vc *VariableContext) Snapshot() map[string]string {
	vc.mu.RLock()
	defer vc.mu.RUnlock()
	snapshot := make(map[string]string, len(vc.variables))
	for k, v := range vc.variables {
		snapshot[k] = v
	}
	return snapshot
}

// HasVariables returns true if the template string contains variable references.
func HasVariables(s string) bool {
	return variablePattern.MatchString(s)
}

// valueToString converts a value to its string representation.
func valueToString(value interface{}) string {
	switch v := value.(type) {
	case string:
		return v
	case float64:
		if v == float64(int64(v)) {
			return fmt.Sprintf("%d", int64(v))
		}
		return fmt.Sprintf("%g", v)
	case bool:
		return fmt.Sprintf("%t", v)
	case nil:
		return ""
	default:
		// For objects/arrays, JSON-encode
		b, err := json.Marshal(v)
		if err != nil {
			return fmt.Sprintf("%v", v)
		}
		return string(b)
	}
}

// EvaluateJsonPath evaluates a simple JSONPath expression against parsed JSON data.
// Supports: $, $.field, $.nested.field, $.array[0], $.array[0].field
func EvaluateJsonPath(data interface{}, path string) (interface{}, error) {
	if path == "$" {
		return data, nil
	}

	var dotPath string
	if strings.HasPrefix(path, "$.") {
		dotPath = path[2:]
	} else {
		// Support bare dotted paths (e.g., "body.user.id")
		dotPath = path
	}

	parts := strings.Split(dotPath, ".")
	current := data

	for _, part := range parts {
		if current == nil {
			return nil, fmt.Errorf("path '%s' not found: encountered null", path)
		}

		// Check for array access: field[0], [0], or chained field[0][1][2]
		if idx := strings.Index(part, "["); idx >= 0 {
			fieldName := part[:idx]

			// Access field first if present
			if fieldName != "" {
				obj, ok := current.(map[string]interface{})
				if !ok {
					return nil, fmt.Errorf("path '%s' not found: expected object at '%s'", path, fieldName)
				}
				current, ok = obj[fieldName]
				if !ok {
					return nil, fmt.Errorf("path '%s' not found: key '%s' does not exist", path, fieldName)
				}
			}

			// Process all chained bracket accesses: [0], [0][1], etc.
			bracketPart := part[idx:]
			for bracketPart != "" {
				if bracketPart[0] != '[' {
					return nil, fmt.Errorf("invalid JSONPath at '%s': expected '[' in '%s'", path, part)
				}
				closeIdx := strings.Index(bracketPart, "]")
				if closeIdx < 0 {
					return nil, fmt.Errorf("invalid JSONPath at '%s': missing ']' in '%s'", path, part)
				}
				indexStr := bracketPart[1:closeIdx]

				arr, ok := current.([]interface{})
				if !ok {
					return nil, fmt.Errorf("path '%s' not found: expected array at '%s'", path, part)
				}
				var index int
				if _, err := fmt.Sscanf(indexStr, "%d", &index); err != nil {
					return nil, fmt.Errorf("invalid array index in path '%s': %s", path, indexStr)
				}
				if index < 0 || index >= len(arr) {
					return nil, fmt.Errorf("path '%s' not found: array index %d out of bounds (length %d)", path, index, len(arr))
				}
				current = arr[index]

				bracketPart = bracketPart[closeIdx+1:]
			}
		} else {
			obj, ok := current.(map[string]interface{})
			if !ok {
				return nil, fmt.Errorf("path '%s' not found: expected object at '%s'", path, part)
			}
			current, ok = obj[part]
			if !ok {
				return nil, fmt.Errorf("path '%s' not found: key '%s' does not exist", path, part)
			}
		}
	}

	return current, nil
}
