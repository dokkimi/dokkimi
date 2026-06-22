package main

import (
	"encoding/json"
	"fmt"
	"regexp"
	"sync"
)

var variablePattern = regexp.MustCompile(`\{\{([\w-]+(?:\.[\w-]+|\[\d+\])*)\}\}`)

// VariableContext stores and resolves variables during test execution.
type VariableContext struct {
	mu         sync.RWMutex
	variables  map[string]interface{}
	generation uint64
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
	vc.generation++
}

// Set stores a variable value.
func (vc *VariableContext) Set(name string, value interface{}) {
	vc.mu.Lock()
	defer vc.mu.Unlock()
	vc.variables[name] = value
	vc.generation++
}

// Delete removes a variable. No-op if the variable does not exist.
func (vc *VariableContext) Delete(name string) {
	vc.mu.Lock()
	defer vc.mu.Unlock()
	delete(vc.variables, name)
	vc.generation++
}

// Generation returns the current generation counter. It increments on every
// Set, Delete, or Reset call, allowing callers to detect whether the variable
// context has changed since their last observation.
func (vc *VariableContext) Generation() uint64 {
	vc.mu.RLock()
	defer vc.mu.RUnlock()
	return vc.generation
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
		if m, ok := resolvedParams.(map[string]interface{}); ok {
			resolved.Params = m
		} else {
			return resolved, fmt.Errorf("resolving params: expected object, got %T", resolvedParams)
		}
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

// ResolveAssertionBlocks resolves variable templates in assertion paths/values
// and match where entry values. Does NOT resolve $$-prefixed paths.
func (vc *VariableContext) ResolveAssertionBlocks(blocks []AssertionBlock) []AssertionBlock {
	resolved := make([]AssertionBlock, len(blocks))
	for i, block := range blocks {
		resolved[i] = block

		// Resolve assertion values and string-form paths
		if len(block.Assertions) > 0 {
			resolved[i].Assertions = vc.resolveAssertions(block.Assertions)
		}

		// Resolve match where entry values
		if block.Match != nil {
			m := *block.Match
			if len(m.Where) > 0 {
				m.Where = vc.resolveWhereEntries(m.Where)
			}
			resolved[i].Match = &m
		}

		// Resolve nested loop bodies recursively
		if block.ForEach != nil {
			fe := *block.ForEach
			fe.Assertions = vc.resolveLoopAssertions(fe.Assertions)
			resolved[i].ForEach = &fe
		}
		if block.For != nil {
			f := *block.For
			f.Assertions = vc.resolveLoopAssertions(f.Assertions)
			resolved[i].For = &f
		}
		if block.Repeat != nil {
			r := *block.Repeat
			r.Assertions = vc.resolveLoopAssertions(r.Assertions)
			resolved[i].Repeat = &r
		}
	}
	return resolved
}

func (vc *VariableContext) resolveLoopAssertions(la LoopAssertions) LoopAssertions {
	if len(la.Blocks) > 0 {
		la.Blocks = vc.ResolveAssertionBlocks(la.Blocks)
	}
	if len(la.Flat) > 0 {
		la.Flat = vc.resolveAssertions(la.Flat)
	}
	return la
}

func (vc *VariableContext) resolveAssertions(assertions []Assertion) []Assertion {
	resolvedAssertions := make([]Assertion, len(assertions))
	for j, a := range assertions {
		resolvedAssertions[j] = a
		if pathStr, ok := a.Path.(string); ok && pathStr != "" {
			if rv, err := vc.Resolve(pathStr); err == nil {
				resolvedAssertions[j].Path = rv
			}
		}
		if a.Count != "" {
			if rv, err := vc.Resolve(a.Count); err == nil {
				resolvedAssertions[j].Count = rv
			}
		}
		if a.Type != "" {
			if rv, err := vc.Resolve(a.Type); err == nil {
				resolvedAssertions[j].Type = rv
			}
		}
		if a.Keys != "" {
			if rv, err := vc.Resolve(a.Keys); err == nil {
				resolvedAssertions[j].Keys = rv
			}
		}
		if a.Values != "" {
			if rv, err := vc.Resolve(a.Values); err == nil {
				resolvedAssertions[j].Values = rv
			}
		}
		if a.Entries != "" {
			if rv, err := vc.Resolve(a.Entries); err == nil {
				resolvedAssertions[j].Entries = rv
			}
		}
		if a.Value != nil {
			if rv, err := vc.resolveValue(a.Value); err == nil {
				resolvedAssertions[j].Value = rv
			}
		}
	}
	return resolvedAssertions
}

func (vc *VariableContext) resolveWhereEntries(entries []WhereEntry) []WhereEntry {
	resolved := make([]WhereEntry, len(entries))
	for i, e := range entries {
		resolved[i] = e
		// Do NOT resolve $$-prefixed paths — they resolve at match time
		if e.Value != nil {
			if rv, err := vc.resolveValue(e.Value); err == nil {
				resolved[i].Value = rv
			}
		}
		if len(e.Or) > 0 {
			resolved[i].Or = vc.resolveWhereEntries(e.Or)
		}
		if len(e.And) > 0 {
			resolved[i].And = vc.resolveWhereEntries(e.And)
		}
		if e.Not != nil {
			notEntries := vc.resolveWhereEntries([]WhereEntry{*e.Not})
			resolved[i].Not = &notEntries[0]
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
