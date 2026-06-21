package main

import (
	"testing"
	"time"
)

func TestExecuteMatch(t *testing.T) {
	rootCtx := map[string]interface{}{
		"traffic": []interface{}{
			map[string]interface{}{
				"origin":  "api-gateway",
				"request": map[string]interface{}{"method": "GET", "url": "/users"},
			},
			map[string]interface{}{
				"origin":  "api-gateway",
				"request": map[string]interface{}{"method": "POST", "url": "/users"},
			},
			map[string]interface{}{
				"origin":  "worker",
				"request": map[string]interface{}{"method": "GET", "url": "/jobs"},
			},
		},
	}

	t.Run("filters by where criteria", func(t *testing.T) {
		match := &MatchCriteria{
			Path: "$.traffic",
			Where: []WhereEntry{
				{Path: "$$.origin", Operator: "eq", Value: "api-gateway"},
			},
		}
		result, err := ExecuteMatch(match, rootCtx)
		if err != nil {
			t.Fatal(err)
		}
		if len(result.Matches) != 2 {
			t.Errorf("expected 2 matches, got %d", len(result.Matches))
		}
	})

	t.Run("empty where matches all", func(t *testing.T) {
		match := &MatchCriteria{Path: "$.traffic"}
		result, err := ExecuteMatch(match, rootCtx)
		if err != nil {
			t.Fatal(err)
		}
		if len(result.Matches) != 3 {
			t.Errorf("expected 3 matches, got %d", len(result.Matches))
		}
	})

	t.Run("no matches returns empty", func(t *testing.T) {
		match := &MatchCriteria{
			Path: "$.traffic",
			Where: []WhereEntry{
				{Path: "$$.origin", Operator: "eq", Value: "nonexistent"},
			},
		}
		result, err := ExecuteMatch(match, rootCtx)
		if err != nil {
			t.Fatal(err)
		}
		if len(result.Matches) != 0 {
			t.Errorf("expected 0 matches, got %d", len(result.Matches))
		}
		if result.Match != nil {
			t.Error("expected Match to be nil")
		}
	})

	t.Run("where with or combinator", func(t *testing.T) {
		match := &MatchCriteria{
			Path: "$.traffic",
			Where: []WhereEntry{
				{Or: []WhereEntry{
					{Path: "$$.request.method", Operator: "eq", Value: "POST"},
					{Path: "$$.origin", Operator: "eq", Value: "worker"},
				}},
			},
		}
		result, err := ExecuteMatch(match, rootCtx)
		if err != nil {
			t.Fatal(err)
		}
		if len(result.Matches) != 2 {
			t.Errorf("expected 2 matches (POST + worker), got %d", len(result.Matches))
		}
	})

	t.Run("where with not combinator", func(t *testing.T) {
		match := &MatchCriteria{
			Path: "$.traffic",
			Where: []WhereEntry{
				{Not: &WhereEntry{Path: "$$.origin", Operator: "eq", Value: "worker"}},
			},
		}
		result, err := ExecuteMatch(match, rootCtx)
		if err != nil {
			t.Fatal(err)
		}
		if len(result.Matches) != 2 {
			t.Errorf("expected 2 matches (not worker), got %d", len(result.Matches))
		}
	})
}

func TestMatchStack(t *testing.T) {
	t.Run("push and pop", func(t *testing.T) {
		rootCtx := map[string]interface{}{}
		ms := &MatchStack{}

		result := &MatchResult{
			Matches:   []interface{}{"a", "b"},
			Match:     "a",
			LastMatch: "b",
		}
		ms.Push(rootCtx, result)

		if rootCtx["match"] != "a" {
			t.Error("expected match = a")
		}

		ms.Pop(rootCtx)
		if _, exists := rootCtx["match"]; exists {
			t.Error("expected match to be removed after pop")
		}
	})

	t.Run("nested push/pop restores outer values", func(t *testing.T) {
		rootCtx := map[string]interface{}{}
		ms := &MatchStack{}

		outer := &MatchResult{Matches: []interface{}{"outer"}, Match: "outer", LastMatch: "outer"}
		ms.Push(rootCtx, outer)

		inner := &MatchResult{Matches: []interface{}{"inner"}, Match: "inner", LastMatch: "inner"}
		ms.Push(rootCtx, inner)

		if rootCtx["match"] != "inner" {
			t.Error("expected inner match")
		}

		ms.Pop(rootCtx)
		if rootCtx["match"] != "outer" {
			t.Error("expected outer match restored")
		}

		ms.Pop(rootCtx)
		if _, exists := rootCtx["match"]; exists {
			t.Error("expected match removed after final pop")
		}
	})

	t.Run("pop restores nil correctly", func(t *testing.T) {
		rootCtx := map[string]interface{}{"match": nil}
		ms := &MatchStack{}

		result := &MatchResult{Matches: []interface{}{"x"}, Match: "x", LastMatch: "x"}
		ms.Push(rootCtx, result)
		ms.Pop(rootCtx)

		val, present := rootCtx["match"]
		if !present {
			t.Error("expected match key to be present (was nil before push)")
		}
		if val != nil {
			t.Errorf("expected nil, got %v", val)
		}
	})
}

func TestDesugarMatchCount(t *testing.T) {
	t.Run("bare int", func(t *testing.T) {
		c := desugarMatchCount(float64(3))
		if c == nil || c.Operator != "eq" || c.Value != 3 {
			t.Errorf("expected eq 3, got %+v", c)
		}
	})

	t.Run("object form", func(t *testing.T) {
		c := desugarMatchCount(map[string]interface{}{"operator": "gte", "value": float64(2)})
		if c == nil || c.Operator != "gte" || c.Value != 2 {
			t.Errorf("expected gte 2, got %+v", c)
		}
	})

	t.Run("nil", func(t *testing.T) {
		c := desugarMatchCount(nil)
		if c != nil {
			t.Errorf("expected nil, got %+v", c)
		}
	})
}

func TestExecuteMatchAdditional(t *testing.T) {
	rootCtx := map[string]interface{}{
		"traffic": []interface{}{
			map[string]interface{}{
				"origin":  "api-gateway",
				"request": map[string]interface{}{"method": "GET", "url": "/users"},
			},
			map[string]interface{}{
				"origin":  "api-gateway",
				"request": map[string]interface{}{"method": "POST", "url": "/users"},
			},
			map[string]interface{}{
				"origin":  "worker",
				"request": map[string]interface{}{"method": "GET", "url": "/jobs"},
			},
			map[string]interface{}{
				"origin":  "scheduler",
				"request": map[string]interface{}{"method": "PUT", "url": "/tasks"},
			},
		},
	}

	t.Run("multiple matches sets Match and LastMatch correctly", func(t *testing.T) {
		match := &MatchCriteria{
			Path: "$.traffic",
			Where: []WhereEntry{
				{Path: "$$.request.method", Operator: "eq", Value: "GET"},
			},
		}
		result, err := ExecuteMatch(match, rootCtx)
		if err != nil {
			t.Fatal(err)
		}
		if len(result.Matches) != 2 {
			t.Fatalf("expected 2 matches, got %d", len(result.Matches))
		}
		// Match should be first, LastMatch should be last
		first := result.Match.(map[string]interface{})
		if first["origin"] != "api-gateway" {
			t.Errorf("expected first match origin=api-gateway, got %v", first["origin"])
		}
		last := result.LastMatch.(map[string]interface{})
		if last["origin"] != "worker" {
			t.Errorf("expected last match origin=worker, got %v", last["origin"])
		}
	})

	t.Run("and combinator requires all sub-clauses", func(t *testing.T) {
		match := &MatchCriteria{
			Path: "$.traffic",
			Where: []WhereEntry{
				{And: []WhereEntry{
					{Path: "$$.origin", Operator: "eq", Value: "api-gateway"},
					{Path: "$$.request.method", Operator: "eq", Value: "POST"},
				}},
			},
		}
		result, err := ExecuteMatch(match, rootCtx)
		if err != nil {
			t.Fatal(err)
		}
		if len(result.Matches) != 1 {
			t.Fatalf("expected 1 match (api-gateway + POST), got %d", len(result.Matches))
		}
		m := result.Match.(map[string]interface{})
		req := m["request"].(map[string]interface{})
		if req["url"] != "/users" {
			t.Errorf("expected url=/users, got %v", req["url"])
		}
	})

	t.Run("nested or containing not", func(t *testing.T) {
		// Match entries where: method is PUT OR origin is NOT api-gateway
		match := &MatchCriteria{
			Path: "$.traffic",
			Where: []WhereEntry{
				{Or: []WhereEntry{
					{Path: "$$.request.method", Operator: "eq", Value: "PUT"},
					{Not: &WhereEntry{Path: "$$.origin", Operator: "eq", Value: "api-gateway"}},
				}},
			},
		}
		result, err := ExecuteMatch(match, rootCtx)
		if err != nil {
			t.Fatal(err)
		}
		// worker (not api-gateway) and scheduler (PUT + not api-gateway) match
		if len(result.Matches) != 2 {
			t.Errorf("expected 2 matches, got %d", len(result.Matches))
			for i, m := range result.Matches {
				t.Logf("  match[%d]: %v", i, m)
			}
		}
	})

	t.Run("and combinator with no matches", func(t *testing.T) {
		match := &MatchCriteria{
			Path: "$.traffic",
			Where: []WhereEntry{
				{And: []WhereEntry{
					{Path: "$$.origin", Operator: "eq", Value: "worker"},
					{Path: "$$.request.method", Operator: "eq", Value: "POST"},
				}},
			},
		}
		result, err := ExecuteMatch(match, rootCtx)
		if err != nil {
			t.Fatal(err)
		}
		if len(result.Matches) != 0 {
			t.Errorf("expected 0 matches, got %d", len(result.Matches))
		}
	})

	t.Run("path not found returns error", func(t *testing.T) {
		match := &MatchCriteria{Path: "$.nonexistent"}
		_, err := ExecuteMatch(match, rootCtx)
		if err == nil {
			t.Error("expected error for non-existent path")
		}
	})
}

func TestMatchStackAdditional(t *testing.T) {
	t.Run("push sets matches and lastMatch in root context", func(t *testing.T) {
		rootCtx := map[string]interface{}{}
		ms := &MatchStack{}

		result := &MatchResult{
			Matches:   []interface{}{"first", "second", "third"},
			Match:     "first",
			LastMatch: "third",
		}
		ms.Push(rootCtx, result)

		matches, ok := rootCtx["matches"].([]interface{})
		if !ok || len(matches) != 3 {
			t.Errorf("expected matches to have 3 elements, got %v", rootCtx["matches"])
		}
		if rootCtx["match"] != "first" {
			t.Errorf("expected match=first, got %v", rootCtx["match"])
		}
		if rootCtx["lastMatch"] != "third" {
			t.Errorf("expected lastMatch=third, got %v", rootCtx["lastMatch"])
		}
	})

	t.Run("pop removes all three keys when outer had none", func(t *testing.T) {
		rootCtx := map[string]interface{}{}
		ms := &MatchStack{}

		result := &MatchResult{Matches: []interface{}{"x"}, Match: "x", LastMatch: "x"}
		ms.Push(rootCtx, result)
		ms.Pop(rootCtx)

		for _, key := range []string{"matches", "match", "lastMatch"} {
			if _, exists := rootCtx[key]; exists {
				t.Errorf("expected key %q to be removed after pop", key)
			}
		}
	})

	t.Run("nested push/pop restores all three keys", func(t *testing.T) {
		rootCtx := map[string]interface{}{}
		ms := &MatchStack{}

		outer := &MatchResult{
			Matches:   []interface{}{"a", "b"},
			Match:     "a",
			LastMatch: "b",
		}
		ms.Push(rootCtx, outer)

		inner := &MatchResult{
			Matches:   []interface{}{"x", "y", "z"},
			Match:     "x",
			LastMatch: "z",
		}
		ms.Push(rootCtx, inner)

		// Verify inner values
		if rootCtx["match"] != "x" {
			t.Errorf("expected inner match=x, got %v", rootCtx["match"])
		}
		if rootCtx["lastMatch"] != "z" {
			t.Errorf("expected inner lastMatch=z, got %v", rootCtx["lastMatch"])
		}

		ms.Pop(rootCtx)

		// Verify outer values restored
		if rootCtx["match"] != "a" {
			t.Errorf("expected outer match=a, got %v", rootCtx["match"])
		}
		if rootCtx["lastMatch"] != "b" {
			t.Errorf("expected outer lastMatch=b, got %v", rootCtx["lastMatch"])
		}
		matches := rootCtx["matches"].([]interface{})
		if len(matches) != 2 {
			t.Errorf("expected outer matches len=2, got %d", len(matches))
		}
	})

	t.Run("pop on empty stack is no-op", func(t *testing.T) {
		rootCtx := map[string]interface{}{"match": "preserved"}
		ms := &MatchStack{}
		ms.Pop(rootCtx) // should not panic or change context
		if rootCtx["match"] != "preserved" {
			t.Errorf("expected match to remain, got %v", rootCtx["match"])
		}
	})
}

func TestDesugarMatchCountAdditional(t *testing.T) {
	t.Run("integer type coercion", func(t *testing.T) {
		c := desugarMatchCount(int(5))
		if c == nil || c.Operator != "eq" || c.Value != 5 {
			t.Errorf("expected eq 5, got %+v", c)
		}
	})

	t.Run("object with lte operator", func(t *testing.T) {
		c := desugarMatchCount(map[string]interface{}{"operator": "lte", "value": float64(10)})
		if c == nil || c.Operator != "lte" || c.Value != 10 {
			t.Errorf("expected lte 10, got %+v", c)
		}
	})

	t.Run("unsupported type returns nil", func(t *testing.T) {
		c := desugarMatchCount("invalid")
		if c != nil {
			t.Errorf("expected nil for string input, got %+v", c)
		}
	})
}

func TestFormatWhereDescription(t *testing.T) {
	t.Run("simple assertion", func(t *testing.T) {
		entries := []WhereEntry{
			{Path: "$$.origin", Operator: "eq", Value: "gateway"},
		}
		desc := formatWhereDescription(entries)
		if desc != "$$.origin eq gateway" {
			t.Errorf("unexpected description: %s", desc)
		}
	})

	t.Run("multiple entries joined by AND", func(t *testing.T) {
		entries := []WhereEntry{
			{Path: "$$.method", Operator: "eq", Value: "GET"},
			{Path: "$$.status", Operator: "eq", Value: 200},
		}
		desc := formatWhereDescription(entries)
		expected := "$$.method eq GET AND $$.status eq 200"
		if desc != expected {
			t.Errorf("expected %q, got %q", expected, desc)
		}
	})

	t.Run("or combinator", func(t *testing.T) {
		entries := []WhereEntry{
			{Or: []WhereEntry{
				{Path: "$$.a", Operator: "eq", Value: 1},
				{Path: "$$.b", Operator: "eq", Value: 2},
			}},
		}
		desc := formatWhereDescription(entries)
		expected := "($$.a eq 1 OR $$.b eq 2)"
		if desc != expected {
			t.Errorf("expected %q, got %q", expected, desc)
		}
	})

	t.Run("not combinator", func(t *testing.T) {
		entries := []WhereEntry{
			{Not: &WhereEntry{Path: "$$.x", Operator: "eq", Value: "no"}},
		}
		desc := formatWhereDescription(entries)
		expected := "NOT($$.x eq no)"
		if desc != expected {
			t.Errorf("expected %q, got %q", expected, desc)
		}
	})

	t.Run("nested and combinator", func(t *testing.T) {
		entries := []WhereEntry{
			{And: []WhereEntry{
				{Path: "$$.a", Operator: "eq", Value: 1},
				{Path: "$$.b", Operator: "gte", Value: 5},
			}},
		}
		desc := formatWhereDescription(entries)
		expected := "($$.a eq 1 AND $$.b gte 5)"
		if desc != expected {
			t.Errorf("expected %q, got %q", expected, desc)
		}
	})
}

func TestValidateStepWithRetry(t *testing.T) {
	t.Run("passes immediately when assertions match", func(t *testing.T) {
		buf := NewStepLogBuffer()
		status := 200
		now := time.Now()
		buf.AddHttpLog(HttpLogMessage{
			Method: "GET", URL: "/test", StatusCode: &status,
			Timestamp:       now.Format(time.RFC3339Nano),
			RequestHeaders:  map[string]interface{}{},
			ResponseHeaders: map[string]interface{}{},
			ResponseBody:    map[string]interface{}{"ok": true},
		})

		sv := NewStepValidator(buf, NewVariableContext())
		step := TestStep{
			Action: StepAction{Type: "httpRequest", Method: "GET", URL: "/test"},
			Assertions: []AssertionBlock{{
				Assertions: []Assertion{
					{Path: "$.response.status", Operator: "eq", Value: float64(200)},
				},
			}},
		}
		stepExec := StepExecution{
			StartTime: now.Add(-200 * time.Millisecond).Format(time.RFC3339Nano),
			EndTime:   now.Add(200 * time.Millisecond).Format(time.RFC3339Nano),
		}

		results, passed := sv.ValidateStepWithRetry(step, stepExec, nil)
		if !passed {
			t.Errorf("expected pass, got results: %+v", results)
		}
	})

	t.Run("retries and passes when logs arrive late", func(t *testing.T) {
		buf := NewStepLogBuffer()
		now := time.Now()

		sv := NewStepValidator(buf, NewVariableContext())
		step := TestStep{
			Action: StepAction{Type: "httpRequest", Method: "GET", URL: "/test"},
			Assertions: []AssertionBlock{{
				Assertions: []Assertion{
					{Path: "$.response.status", Operator: "eq", Value: float64(200)},
				},
			}},
		}
		stepExec := StepExecution{
			StartTime: now.Add(-200 * time.Millisecond).Format(time.RFC3339Nano),
			EndTime:   now.Add(200 * time.Millisecond).Format(time.RFC3339Nano),
		}

		status := 200
		go func() {
			time.Sleep(150 * time.Millisecond)
			buf.AddHttpLog(HttpLogMessage{
				Method: "GET", URL: "/test", StatusCode: &status,
				Timestamp:       now.Format(time.RFC3339Nano),
				RequestHeaders:  map[string]interface{}{},
				ResponseHeaders: map[string]interface{}{},
				ResponseBody:    map[string]interface{}{},
			})
		}()

		results, passed := sv.ValidateStepWithRetry(step, stepExec, nil)
		if !passed {
			t.Errorf("expected retry to eventually pass, got results: %+v", results)
		}
	})
}

func TestStepValidator(t *testing.T) {
	t.Run("validates assertions against root context", func(t *testing.T) {
		buf := NewStepLogBuffer()
		status := 200
		now := time.Now()
		buf.AddHttpLog(HttpLogMessage{
			Method:          "GET",
			URL:             "/users",
			StatusCode:      &status,
			Timestamp:       now.Format(time.RFC3339Nano),
			RequestHeaders:  map[string]interface{}{},
			ResponseHeaders: map[string]interface{}{},
			ResponseBody:    map[string]interface{}{"name": "Alice"},
		})

		varCtx := NewVariableContext()
		sv := NewStepValidator(buf, varCtx)

		step := TestStep{
			Action: StepAction{Type: "httpRequest", Method: "GET", URL: "/users"},
			Assertions: []AssertionBlock{
				{
					Assertions: []Assertion{
						{Path: "$.response.body.name", Operator: "eq", Value: "Alice"},
						{Path: "$.response.status", Operator: "eq", Value: float64(200)},
					},
				},
			},
		}
		stepExec := StepExecution{
			StartTime: now.Add(-200 * time.Millisecond).Format(time.RFC3339Nano),
			EndTime:   now.Add(200 * time.Millisecond).Format(time.RFC3339Nano),
		}

		results, passed := sv.validateStep(step, stepExec, nil)
		if !passed {
			t.Errorf("expected step to pass, got results: %+v", results)
		}
	})

	t.Run("extracts variables from step", func(t *testing.T) {
		buf := NewStepLogBuffer()
		status := 200
		now := time.Now()
		buf.AddHttpLog(HttpLogMessage{
			Method:          "GET",
			URL:             "/users",
			StatusCode:      &status,
			Timestamp:       now.Format(time.RFC3339Nano),
			RequestHeaders:  map[string]interface{}{},
			ResponseHeaders: map[string]interface{}{},
			ResponseBody:    map[string]interface{}{"id": float64(42)},
		})

		varCtx := NewVariableContext()
		sv := NewStepValidator(buf, varCtx)

		step := TestStep{
			Action:  StepAction{Type: "httpRequest", Method: "GET", URL: "/users"},
			Extract: map[string]ExtractRule{"userId": {Path: "$.response.body.id"}},
		}
		stepExec := StepExecution{
			StartTime: now.Add(-200 * time.Millisecond).Format(time.RFC3339Nano),
			EndTime:   now.Add(200 * time.Millisecond).Format(time.RFC3339Nano),
		}

		results, passed := sv.validateStep(step, stepExec, nil)
		if !passed {
			t.Errorf("expected step to pass, got results: %+v", results)
		}
		if len(results) != 1 {
			t.Errorf("expected 1 extract result, got %d", len(results))
		}

		val, ok := varCtx.variables["userId"]
		if !ok || val != float64(42) {
			t.Errorf("expected userId=42, got %v", val)
		}
	})
}

func TestMatchAs(t *testing.T) {
	t.Run("as saves match results to variable context", func(t *testing.T) {
		buf := NewStepLogBuffer()
		now := time.Now()
		status := 200

		// Add some HTTP traffic so that the root context has something to match
		buf.AddHttpLog(HttpLogMessage{
			Method:          "GET",
			URL:             "/items",
			StatusCode:      &status,
			Timestamp:       now.Format(time.RFC3339Nano),
			RequestHeaders:  map[string]interface{}{},
			ResponseHeaders: map[string]interface{}{},
			ResponseBody:    map[string]interface{}{},
			Origin:          strPtr("service-a"),
		})
		buf.AddHttpLog(HttpLogMessage{
			Method:          "POST",
			URL:             "/items",
			StatusCode:      &status,
			Timestamp:       now.Format(time.RFC3339Nano),
			RequestHeaders:  map[string]interface{}{},
			ResponseHeaders: map[string]interface{}{},
			ResponseBody:    map[string]interface{}{},
			Origin:          strPtr("service-a"),
		})

		varCtx := NewVariableContext()
		sv := NewStepValidator(buf, varCtx)

		step := TestStep{
			Action: StepAction{Type: "wait"},
			Assertions: []AssertionBlock{
				{
					Match: &MatchCriteria{
						Path: "$.traffic",
						Where: []WhereEntry{
							{Path: "$$.origin", Operator: "eq", Value: "service-a"},
						},
						As: "myMatches",
					},
					Assertions: []Assertion{
						{Path: "$.match.request.method", Operator: "exists"},
					},
				},
			},
		}
		stepExec := StepExecution{
			StartTime: now.Add(-200 * time.Millisecond).Format(time.RFC3339Nano),
			EndTime:   now.Add(200 * time.Millisecond).Format(time.RFC3339Nano),
		}

		results, passed := sv.validateStep(step, stepExec, nil)
		if !passed {
			t.Errorf("expected step to pass, got results: %+v", results)
		}

		// Verify the variable was saved in varCtx
		val, ok := varCtx.variables["myMatches"]
		if !ok {
			t.Fatal("expected 'myMatches' to be set in variable context")
		}
		arr, ok := val.([]interface{})
		if !ok {
			t.Fatalf("expected myMatches to be []interface{}, got %T", val)
		}
		if len(arr) != 2 {
			t.Errorf("expected 2 matches saved, got %d", len(arr))
		}
	})

	t.Run("as variable accessible via $.variables path in subsequent blocks", func(t *testing.T) {
		buf := NewStepLogBuffer()
		now := time.Now()
		status := 200

		buf.AddHttpLog(HttpLogMessage{
			Method:          "GET",
			URL:             "/users",
			StatusCode:      &status,
			Timestamp:       now.Format(time.RFC3339Nano),
			RequestHeaders:  map[string]interface{}{},
			ResponseHeaders: map[string]interface{}{},
			ResponseBody:    map[string]interface{}{},
			Origin:          strPtr("gateway"),
		})

		varCtx := NewVariableContext()
		sv := NewStepValidator(buf, varCtx)

		step := TestStep{
			Action: StepAction{Type: "wait"},
			Assertions: []AssertionBlock{
				{
					Match: &MatchCriteria{
						Path: "$.traffic",
						As:   "savedTraffic",
					},
				},
				{
					// Second block references the saved variable
					Assertions: []Assertion{
						{Path: "$.variables.savedTraffic", Operator: "exists"},
					},
				},
			},
		}
		stepExec := StepExecution{
			StartTime: now.Add(-200 * time.Millisecond).Format(time.RFC3339Nano),
			EndTime:   now.Add(200 * time.Millisecond).Format(time.RFC3339Nano),
		}

		results, passed := sv.validateStep(step, stepExec, nil)
		if !passed {
			t.Errorf("expected step to pass, got results: %+v", results)
		}
	})
}

func TestValidateBlock_MatchThenAssertions(t *testing.T) {
	t.Run("match populates $.match and assertions reference it", func(t *testing.T) {
		buf := NewStepLogBuffer()
		now := time.Now()
		status := 201

		buf.AddHttpLog(HttpLogMessage{
			Method:          "POST",
			URL:             "/orders",
			StatusCode:      &status,
			Timestamp:       now.Format(time.RFC3339Nano),
			RequestHeaders:  map[string]interface{}{},
			ResponseHeaders: map[string]interface{}{},
			ResponseBody:    map[string]interface{}{"orderId": "abc123"},
			Origin:          strPtr("checkout"),
		})
		buf.AddHttpLog(HttpLogMessage{
			Method:          "GET",
			URL:             "/health",
			StatusCode:      &status,
			Timestamp:       now.Format(time.RFC3339Nano),
			RequestHeaders:  map[string]interface{}{},
			ResponseHeaders: map[string]interface{}{},
			ResponseBody:    map[string]interface{}{},
			Origin:          strPtr("monitor"),
		})

		varCtx := NewVariableContext()
		sv := NewStepValidator(buf, varCtx)

		step := TestStep{
			Action: StepAction{Type: "wait"},
			Assertions: []AssertionBlock{
				{
					Match: &MatchCriteria{
						Path: "$.traffic",
						Where: []WhereEntry{
							{Path: "$$.origin", Operator: "eq", Value: "checkout"},
						},
						Count: float64(1),
					},
					Assertions: []Assertion{
						{Path: "$.match.request.method", Operator: "eq", Value: "POST"},
						{Path: "$.match.request.url", Operator: "eq", Value: "/orders"},
						{Path: "$.match.response.body.orderId", Operator: "eq", Value: "abc123"},
					},
				},
			},
		}
		stepExec := StepExecution{
			StartTime: now.Add(-200 * time.Millisecond).Format(time.RFC3339Nano),
			EndTime:   now.Add(200 * time.Millisecond).Format(time.RFC3339Nano),
		}

		results, passed := sv.validateStep(step, stepExec, nil)
		if !passed {
			t.Errorf("expected step to pass, got failing results:")
			for _, r := range results {
				if !r.Passed {
					t.Errorf("  path=%s op=%s err=%s actual=%v expected=%v", r.Path, r.Operator, r.Error, r.Actual, r.Expected)
				}
			}
		}
	})

	t.Run("match with count failure reports count error", func(t *testing.T) {
		buf := NewStepLogBuffer()
		now := time.Now()
		status := 200

		buf.AddHttpLog(HttpLogMessage{
			Method:          "GET",
			URL:             "/users",
			StatusCode:      &status,
			Timestamp:       now.Format(time.RFC3339Nano),
			RequestHeaders:  map[string]interface{}{},
			ResponseHeaders: map[string]interface{}{},
			ResponseBody:    map[string]interface{}{},
			Origin:          strPtr("gateway"),
		})

		varCtx := NewVariableContext()
		sv := NewStepValidator(buf, varCtx)

		step := TestStep{
			Action: StepAction{Type: "wait"},
			Assertions: []AssertionBlock{
				{
					Match: &MatchCriteria{
						Path: "$.traffic",
						Where: []WhereEntry{
							{Path: "$$.origin", Operator: "eq", Value: "nonexistent"},
						},
						Count: float64(1),
					},
					Assertions: []Assertion{
						// These should NOT be evaluated since count fails
						{Path: "$.match.request.method", Operator: "eq", Value: "GET"},
					},
				},
			},
		}
		stepExec := StepExecution{
			StartTime: now.Add(-200 * time.Millisecond).Format(time.RFC3339Nano),
			EndTime:   now.Add(200 * time.Millisecond).Format(time.RFC3339Nano),
		}

		results, passed := sv.validateStep(step, stepExec, nil)
		if passed {
			t.Error("expected step to fail due to count mismatch")
		}

		// Should have exactly 1 result (the count failure), NOT the assertion
		countResults := 0
		for _, r := range results {
			if r.ResultKind == "count" {
				countResults++
				if r.Passed {
					t.Error("expected count result to fail")
				}
			}
		}
		if countResults == 0 {
			t.Error("expected at least one count result")
		}

		// The assertion on $.match.request.method should NOT be in results
		for _, r := range results {
			if r.Path == "$.match.request.method" {
				t.Error("assertion should not be evaluated when count fails")
			}
		}
	})
}

func strPtr(s string) *string {
	return &s
}
