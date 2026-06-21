package main

import (
	"fmt"
	"strings"
)

// MatchResult holds the output of ExecuteMatch.
type MatchResult struct {
	Matches   []interface{}
	Match     interface{}
	LastMatch interface{}
}

// ExecuteMatch resolves the source array from the root context, filters by where criteria,
// and returns the match result.
func ExecuteMatch(match *MatchCriteria, rootCtx map[string]interface{}, scopedCtx ...interface{}) (*MatchResult, error) {
	sourceVal, found := EvaluateDocPath(rootCtx, match.Path, scopedCtx...)
	if !found {
		return nil, fmt.Errorf("match path not found: %s", match.Path)
	}

	arr, ok := toSlice(sourceVal)
	if !ok {
		return nil, fmt.Errorf("match path must resolve to an array: %s", match.Path)
	}

	var matches []interface{}
	for _, elem := range arr {
		if len(match.Where) == 0 {
			matches = append(matches, elem)
			continue
		}
		elemCtx, ok := elem.(map[string]interface{})
		if !ok {
			continue
		}
		if evaluateWhereEntries(match.Where, rootCtx, elemCtx) {
			matches = append(matches, elem)
		}
	}

	result := &MatchResult{Matches: matches}
	if len(matches) > 0 {
		result.Match = matches[0]
		result.LastMatch = matches[len(matches)-1]
	}
	return result, nil
}

// evaluateWhereEntries evaluates a list of WhereEntry as an AND-list.
func evaluateWhereEntries(entries []WhereEntry, rootCtx map[string]interface{}, elemCtx map[string]interface{}) bool {
	for _, entry := range entries {
		if !evaluateSingleWhereEntry(entry, rootCtx, elemCtx) {
			return false
		}
	}
	return true
}

// evaluateSingleWhereEntry evaluates one WhereEntry: assertion, or, and, or not.
func evaluateSingleWhereEntry(entry WhereEntry, rootCtx map[string]interface{}, elemCtx map[string]interface{}) bool {
	if entry.Not != nil {
		return !evaluateSingleWhereEntry(*entry.Not, rootCtx, elemCtx)
	}

	if len(entry.Or) > 0 {
		for _, sub := range entry.Or {
			if evaluateSingleWhereEntry(sub, rootCtx, elemCtx) {
				return true
			}
		}
		return false
	}

	if len(entry.And) > 0 {
		for _, sub := range entry.And {
			if !evaluateSingleWhereEntry(sub, rootCtx, elemCtx) {
				return false
			}
		}
		return true
	}

	// Simple assertion form — resolve value (may be ValueRef against rootCtx)
	value, err := resolveValue(entry.Value, rootCtx)
	if err != nil {
		return false
	}

	a := Assertion{
		Path:     entry.Path,
		Operator: entry.Operator,
		Value:    value,
	}
	result := ValidateAssertion(a, rootCtx, elemCtx)
	return result.Passed
}

// savedMatchEntry tracks a single key's prior value in the match stack.
type savedMatchEntry struct {
	value   interface{}
	present bool
}

// MatchStack supports push/pop of match results on the root context.
type MatchStack struct {
	stack []map[string]savedMatchEntry
}

// Push saves current match keys and injects new values.
func (ms *MatchStack) Push(rootCtx map[string]interface{}, result *MatchResult) {
	saved := make(map[string]savedMatchEntry)
	for _, key := range []string{"matches", "match", "lastMatch"} {
		val, present := rootCtx[key]
		saved[key] = savedMatchEntry{value: val, present: present}
	}
	ms.stack = append(ms.stack, saved)

	rootCtx["matches"] = result.Matches
	rootCtx["match"] = result.Match
	rootCtx["lastMatch"] = result.LastMatch
}

// Pop restores the previous match values.
func (ms *MatchStack) Pop(rootCtx map[string]interface{}) {
	if len(ms.stack) == 0 {
		return
	}
	saved := ms.stack[len(ms.stack)-1]
	ms.stack = ms.stack[:len(ms.stack)-1]

	for _, key := range []string{"matches", "match", "lastMatch"} {
		entry := saved[key]
		if entry.present {
			rootCtx[key] = entry.value
		} else {
			delete(rootCtx, key)
		}
	}
}

// desugarMatchCount converts the count field on match (int or CountAssertion object)
// into a CountAssertion. Returns nil if no count specified.
func desugarMatchCount(count interface{}) *CountAssertion {
	if count == nil {
		return nil
	}
	switch c := count.(type) {
	case float64:
		return &CountAssertion{Operator: "eq", Value: int(c)}
	case int:
		return &CountAssertion{Operator: "eq", Value: c}
	case map[string]interface{}:
		op, _ := c["operator"].(string)
		val := 0
		if v, ok := toFloat(c["value"]); ok {
			val = int(v)
		}
		return &CountAssertion{Operator: op, Value: val}
	default:
		return nil
	}
}

// formatWhereDescription serializes where criteria for error messages.
func formatWhereDescription(entries []WhereEntry) string {
	var parts []string
	for _, e := range entries {
		parts = append(parts, formatSingleWhereEntry(e))
	}
	return strings.Join(parts, " AND ")
}

func formatSingleWhereEntry(e WhereEntry) string {
	if e.Not != nil {
		return fmt.Sprintf("NOT(%s)", formatSingleWhereEntry(*e.Not))
	}
	if len(e.Or) > 0 {
		var subs []string
		for _, sub := range e.Or {
			subs = append(subs, formatSingleWhereEntry(sub))
		}
		return fmt.Sprintf("(%s)", strings.Join(subs, " OR "))
	}
	if len(e.And) > 0 {
		var subs []string
		for _, sub := range e.And {
			subs = append(subs, formatSingleWhereEntry(sub))
		}
		return fmt.Sprintf("(%s)", strings.Join(subs, " AND "))
	}
	return fmt.Sprintf("%s %s %v", e.Path, e.Operator, e.Value)
}
