package main

import (
	"encoding/json"
	"fmt"
	"regexp"
	"strings"
	"sync"
)

var variablePattern = regexp.MustCompile(`\{\{([\w]+(?:\.[\w]+|\[\d+\])*)\}\}`)

// VariableContext stores and resolves variables during test execution.
type VariableContext struct {
	mu        sync.RWMutex
	variables map[string]interface{}
}

// NewVariableContext creates a new empty variable context.
func NewVariableContext() *VariableContext {
	return &VariableContext{
		variables: make(map[string]interface{}),
	}
}

// Reset clears all variables in place. Use this instead of replacing the
// pointer when other components (UI executor, logger) hold references to the
// same context — reassigning the pointer leaves them looking at stale state.
func (vc *VariableContext) Reset() {
	vc.mu.Lock()
	defer vc.mu.Unlock()
	vc.variables = make(map[string]interface{})
}

// Set stores a variable value.
func (vc *VariableContext) Set(name string, value interface{}) {
	vc.mu.Lock()
	defer vc.mu.Unlock()
	vc.variables[name] = value
}

// Delete removes a variable. No-op if the variable does not exist.
func (vc *VariableContext) Delete(name string) {
	vc.mu.Lock()
	defer vc.mu.Unlock()
	delete(vc.variables, name)
}

// Resolve replaces {{variableName}} placeholders in a template string.
// Returns an error if a referenced variable is not defined.
// Dotted paths (e.g. {{user.email}}, {{users[0].name}}) are resolved
// by looking up the first segment in the variable map and traversing
// remaining segments into the value.
func (vc *VariableContext) Resolve(template string) (string, error) {
	vc.mu.RLock()
	defer vc.mu.RUnlock()
	var resolveErr error
	result := variablePattern.ReplaceAllStringFunc(template, func(match string) string {
		varPath := variablePattern.FindStringSubmatch(match)[1]
		value, err := vc.resolveVarPath(varPath)
		if err != nil {
			resolveErr = err
			return match
		}
		return valueToString(value)
	})
	if resolveErr != nil {
		return "", resolveErr
	}
	return result, nil
}

// ResolveTyped resolves a template that is exactly one {{var}} reference,
// returning the typed value. If the template contains anything besides a
// single {{var}}, it falls back to string interpolation via Resolve.
func (vc *VariableContext) ResolveTyped(template string) (interface{}, error) {
	matches := variablePattern.FindAllStringIndex(template, -1)
	if len(matches) == 1 && matches[0][0] == 0 && matches[0][1] == len(template) {
		vc.mu.RLock()
		defer vc.mu.RUnlock()
		varPath := variablePattern.FindStringSubmatch(template)[1]
		return vc.resolveVarPath(varPath)
	}
	return vc.Resolve(template)
}

// resolveVarPath looks up a dotted/bracketed path in the variable map.
// Must be called with vc.mu held (at least RLock).
// Tries the full path as a flat key first, then falls back to
// EvaluateDocPath for nested object traversal (e.g. map-valued variables).
func (vc *VariableContext) resolveVarPath(varPath string) (interface{}, error) {
	if value, ok := vc.variables[varPath]; ok {
		return value, nil
	}
	value, ok := EvaluateDocPath(vc.variables, varPath)
	if !ok {
		return nil, fmt.Errorf("variable '%s' is not defined", varPath)
	}
	return value, nil
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
				if a.Path != "" {
					if rv, err := vc.Resolve(a.Path); err == nil {
						resolvedAssertions[j].Path = rv
					}
				}
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
		return vc.ResolveTyped(v)
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
func (vc *VariableContext) Extract(rules map[string]ExtractRule, doc map[string]interface{}) error {
	if len(rules) == 0 || doc == nil {
		return nil
	}

	for varName, rule := range rules {
		value, err := ResolveExtractRule(doc, varName, rule)
		if err != nil {
			return err
		}
		vc.Set(varName, value)
	}

	return nil
}

// Snapshot returns a copy of all current variable values.
func (vc *VariableContext) Snapshot() map[string]interface{} {
	vc.mu.RLock()
	defer vc.mu.RUnlock()
	snapshot := make(map[string]interface{}, len(vc.variables))
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
