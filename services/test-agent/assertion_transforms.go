package main

import (
	"encoding/json"
	"fmt"
	"regexp"
	"sort"
	"strings"
)

func resolveSource(a Assertion) (sourcePath string, transform string, err error) {
	switch p := a.Path.(type) {
	case string:
		if p != "" {
			return p, "", nil
		}
	case map[string]interface{}:
		from, _ := p["from"].(string)
		t, _ := p["transform"].(string)
		if from == "" || !strings.HasPrefix(from, "$.") {
			return "", "", fmt.Errorf("path.from must be a $.-prefixed path (e.g., \"$.response.body\")")
		}
		return from, t, nil
	}
	if a.Count != "" {
		return a.Count, "length", nil
	}
	if a.Type != "" {
		return a.Type, "type", nil
	}
	if a.Keys != "" {
		return a.Keys, "keys", nil
	}
	if a.Values != "" {
		return a.Values, "values", nil
	}
	if a.Entries != "" {
		return a.Entries, "entries", nil
	}
	return "", "", fmt.Errorf("assertion must have exactly one source field")
}

func applyAssertionTransform(value interface{}, transform string) (interface{}, error) {
	switch transform {
	case "length":
		switch v := value.(type) {
		case []interface{}:
			return float64(len(v)), nil
		case string:
			return float64(len([]rune(v))), nil
		default:
			return nil, fmt.Errorf("transform 'length' requires array or string, got %s", goTypeLabel(value))
		}
	case "type":
		return goTypeLabel(value), nil
	case "keys":
		obj, ok := value.(map[string]interface{})
		if !ok {
			return nil, fmt.Errorf("transform 'keys' requires object, got %s", goTypeLabel(value))
		}
		keys := sortedKeys(obj)
		result := make([]interface{}, len(keys))
		for i, k := range keys {
			result[i] = k
		}
		return result, nil
	case "values":
		obj, ok := value.(map[string]interface{})
		if !ok {
			return nil, fmt.Errorf("transform 'values' requires object, got %s", goTypeLabel(value))
		}
		keys := sortedKeys(obj)
		result := make([]interface{}, len(keys))
		for i, k := range keys {
			result[i] = obj[k]
		}
		return result, nil
	case "entries":
		obj, ok := value.(map[string]interface{})
		if !ok {
			return nil, fmt.Errorf("transform 'entries' requires object, got %s", goTypeLabel(value))
		}
		keys := sortedKeys(obj)
		result := make([]interface{}, len(keys))
		for i, k := range keys {
			result[i] = map[string]interface{}{"key": k, "value": obj[k]}
		}
		return result, nil
	default:
		return nil, fmt.Errorf("unknown transform: %s", transform)
	}
}

func resolveValue(v interface{}, doc map[string]interface{}, scopedCtx ...interface{}) (interface{}, error) {
	m, ok := v.(map[string]interface{})
	if !ok {
		return v, nil
	}
	from, _ := m["from"].(string)
	if from == "" || !strings.HasPrefix(from, "$.") {
		return v, nil
	}
	resolved, found := EvaluateDocPath(doc, from, scopedCtx...)
	if !found {
		return nil, fmt.Errorf("value.from path not found: %s", from)
	}
	transform, _ := m["transform"].(string)
	if transform != "" {
		return applyAssertionTransform(resolved, transform)
	}
	return resolved, nil
}

// ResolveExtractRule extracts a variable value from a document using a path and optional regex.
// Without a regex pattern, the raw typed value is returned (preserving numbers, arrays, objects).
// With a regex pattern, the value is stringified and the matched group is returned as a string.
// With a transform, the source object is converted to an array (keys/values/entries).
func ResolveExtractRule(doc map[string]interface{}, variable string, rule ExtractRule) (interface{}, error) {
	if rule.Transform != "" {
		return resolveTransformExtract(doc, variable, rule)
	}

	rawValue, found := EvaluateDocPath(doc, rule.Path)
	if !found {
		return nil, fmt.Errorf("Failed to extract variable '%s': path '%s' not found", variable, rule.Path)
	}

	if rule.Pattern == "" {
		return rawValue, nil
	}

	var strValue string
	if s, ok := rawValue.(string); ok {
		strValue = s
	} else {
		b, _ := json.Marshal(rawValue)
		strValue = string(b)
	}

	re, err := regexp.Compile(rule.Pattern)
	if err != nil {
		return nil, fmt.Errorf("Failed to extract variable '%s': invalid regex pattern '%s': %w", variable, rule.Pattern, err)
	}

	group := 1
	if rule.Group != nil {
		group = *rule.Group
	}

	matches := re.FindStringSubmatch(strValue)
	if matches == nil {
		return nil, fmt.Errorf("Failed to extract variable '%s': pattern '%s' did not match value '%s'", variable, rule.Pattern, strValue)
	}
	if group < 0 || group >= len(matches) {
		return nil, fmt.Errorf("Failed to extract variable '%s': capture group %d out of range (pattern has %d groups)", variable, group, len(matches)-1)
	}

	return matches[group], nil
}

// resolveTransformExtract handles extract rules with the transform field.
func resolveTransformExtract(doc map[string]interface{}, variable string, rule ExtractRule) (interface{}, error) {
	var source interface{}

	if rule.From != "" {
		from := rule.From
		if len(from) >= 4 && from[:2] == "{{" && from[len(from)-2:] == "}}" {
			varName := from[2 : len(from)-2]
			if vars, ok := doc["variables"].(map[string]interface{}); ok {
				if val, exists := vars[varName]; exists {
					source = val
				} else if val, found := EvaluateDocPath(vars, varName); found {
					source = val
				}
			}
		}
		if source == nil {
			return nil, fmt.Errorf("Failed to extract variable '%s': from reference '%s' could not be resolved", variable, rule.From)
		}
	} else if rule.Path != "" {
		rawValue, found := EvaluateDocPath(doc, rule.Path)
		if !found {
			return nil, fmt.Errorf("Failed to extract variable '%s': path '%s' not found", variable, rule.Path)
		}
		source = rawValue
	} else {
		return nil, fmt.Errorf("Failed to extract variable '%s': transform requires 'path' or 'from'", variable)
	}

	obj, ok := source.(map[string]interface{})
	if !ok {
		return nil, fmt.Errorf("Failed to extract variable '%s': transform source must be an object, got %T", variable, source)
	}

	return applyTransform(obj, rule.Transform, variable)
}

// applyTransform converts a map to an array using the specified transform.
// It delegates to applyAssertionTransform and wraps errors with the variable name.
func applyTransform(obj map[string]interface{}, transform string, variable string) (interface{}, error) {
	result, err := applyAssertionTransform(obj, transform)
	if err != nil {
		return nil, fmt.Errorf("Failed to extract variable '%s': %w", variable, err)
	}
	return result, nil
}

func sortedKeys[V any](m map[string]V) []string {
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	return keys
}
