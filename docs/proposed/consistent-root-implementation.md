# Consistent Root Document — Implementation Guide

Companion to `consistent-root-document.md`. This document specifies exact code changes: struct modifications, function rewrites, new algorithms, and validation rules. Each section maps to a source file.

---

## 1. Go Type Changes (`services/test-agent/types.go`)

### `MatchCriteria` → full rewrite

Current (lines 108–113):
```go
type MatchCriteria struct {
    Origin string `json:"origin,omitempty"`
    Method string `json:"method,omitempty"`
    URL    string `json:"url,omitempty"`
}
```

New:
```go
type MatchCriteria struct {
    Path  string          `json:"path"`
    Where []WhereEntry    `json:"where,omitempty"`
    Count interface{}     `json:"count,omitempty"` // int or CountAssertion
    As    string          `json:"as,omitempty"`
}

type WhereEntry struct {
    // Assertion fields (used when this entry is a simple assertion)
    Path     string      `json:"path,omitempty"`
    Operator string      `json:"operator,omitempty"`
    Value    interface{} `json:"value,omitempty"`

    // Boolean combinators (mutually exclusive with assertion fields)
    Or  []WhereEntry `json:"or,omitempty"`
    And []WhereEntry `json:"and,omitempty"`
    Not *WhereEntry  `json:"not,omitempty"`
}
```

`WhereEntry` is a discriminated union: an entry is either an assertion (has `Path`+`Operator`), a boolean combinator (has `Or` or `And`), or a negation (has `Not`). Validation rejects entries that mix forms.

`Count` uses `interface{}` because it accepts either a bare integer (desugars to `CountAssertion{Operator: "eq", Value: n}`) or a `CountAssertion` object. Desugaring happens at the start of match execution, not at parse time — the Go JSON decoder handles both forms naturally via `interface{}`.

### `Assertion` → add source fields and object-form support

Current (lines 24–29 of `assertion_engine.go`):
```go
type Assertion struct {
    Path     string      `json:"path"`
    Operator string      `json:"operator"`
    Value    interface{} `json:"value"`
    Disabled bool        `json:"disabled,omitempty"`
}
```

New:
```go
type Assertion struct {
    // Source fields — exactly one must be set
    Path     interface{} `json:"path,omitempty"`     // string or PathWithTransform
    Count    string      `json:"count,omitempty"`    // shorthand for transform:"length"
    Type     string      `json:"type,omitempty"`     // shorthand for transform:"type"
    Keys     string      `json:"keys,omitempty"`     // shorthand for transform:"keys"
    Values   string      `json:"values,omitempty"`   // shorthand for transform:"values"
    Entries  string      `json:"entries,omitempty"`  // shorthand for transform:"entries"

    Operator string      `json:"operator"`
    Value    interface{} `json:"value,omitempty"`    // literal, or ValueRef object
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
```

`Path` is `interface{}` because it accepts either a string (`"$.response.status"`) or an object (`{"from": "$.x", "transform": "length"}`). At the start of `ValidateAssertion`, type-switch to determine the form:

```go
func resolveSource(a Assertion) (sourcePath string, transform string, err error) {
    switch p := a.Path.(type) {
    case string:
        if p != "" {
            return p, "", nil
        }
    case map[string]interface{}:
        from, _ := p["from"].(string)
        transform, _ := p["transform"].(string)
        if from == "" || !strings.HasPrefix(from, "$.") {
            return "", "", fmt.Errorf("path.from must be a $.-prefixed path (e.g., \"$.response.body\")")
        }
        return from, transform, nil
    }
    // Check shorthands
    if a.Count != "" { return a.Count, "length", nil }
    if a.Type != "" { return a.Type, "type", nil }
    if a.Keys != "" { return a.Keys, "keys", nil }
    if a.Values != "" { return a.Values, "values", nil }
    if a.Entries != "" { return a.Entries, "entries", nil }
    return "", "", fmt.Errorf("assertion must have exactly one source field")
}
```

`Value` is `interface{}` and undergoes the same disambiguation: if it's a `map[string]interface{}` with a `from` key starting with `$.`, it's a `ValueRef`; otherwise it's a literal. The `$.` prefix (with the dot) is required to avoid false positives — a literal value like `{ "from": "$50", "amount": 500 }` must be treated as a literal object, not a document-path reference.

```go
func resolveValue(v interface{}, doc map[string]interface{}) (interface{}, error) {
    m, ok := v.(map[string]interface{})
    if !ok {
        return v, nil // literal
    }
    from, _ := m["from"].(string)
    if from == "" || !strings.HasPrefix(from, "$.") {
        return v, nil // literal object (no $.-prefixed "from")
    }
    resolved, found := EvaluateDocPath(doc, from)
    if !found {
        return nil, fmt.Errorf("value.from path not found: %s", from)
    }
    transform, _ := m["transform"].(string)
    if transform != "" {
        return applyAssertionTransform(resolved, transform)
    }
    return resolved, nil
}
```

### `AssertionBlock` → remove deprecated fields, support nested loops

Current (lines 96–106):
```go
type AssertionBlock struct {
    Extract           map[string]ExtractRule `json:"extract,omitempty"`
    Match             *MatchCriteria         `json:"match,omitempty"`
    Count             *CountAssertion        `json:"count,omitempty"`
    AssertionScope    string                 `json:"assertionScope,omitempty"`
    Assertions        []Assertion            `json:"assertions,omitempty"`
    Service           string                 `json:"service,omitempty"`
    ConsoleAssertions []ConsoleLogAssertion  `json:"consoleAssertions,omitempty"`
    ForEach           *ForEachLoop           `json:"forEach,omitempty"`
}
```

New:
```go
type AssertionBlock struct {
    Extract    map[string]ExtractRule `json:"extract,omitempty"`
    Match      *MatchCriteria         `json:"match,omitempty"`
    Assertions []Assertion            `json:"assertions,omitempty"`
    ForEach    *ForEachLoop           `json:"forEach,omitempty"`
    For        *ForLoop               `json:"for,omitempty"`
    Repeat     *RepeatLoop            `json:"repeat,omitempty"`
}
```

Removed: `Count`, `AssertionScope`, `Service`, `ConsoleAssertions`.
Added: `For`, `Repeat` (loops are now nested, so all three loop types are supported at assertion-block level).

### Loop types → add nested body fields

Current `ForEachLoop` (lines 69–75):
```go
type ForEachLoop struct {
    Items   interface{} `json:"items"`
    As      string      `json:"as"`
    Name    string      `json:"name,omitempty"`
    DelayMs int         `json:"delayMs,omitempty"`
}
```

New — add nested body fields:
```go
type ForEachLoop struct {
    Items      interface{}            `json:"items"`
    As         string                 `json:"as"`
    Name       string                 `json:"name,omitempty"`
    DelayMs    int                    `json:"delayMs,omitempty"`

    // Nested body (assertion-block level)
    Match      *MatchCriteria         `json:"match,omitempty"`
    Assertions []Assertion            `json:"assertions,omitempty"`
    Extract    map[string]ExtractRule `json:"extract,omitempty"`
    ForEach    *ForEachLoop           `json:"forEach,omitempty"`
    For        *ForLoop               `json:"for,omitempty"`
    Repeat     *RepeatLoop            `json:"repeat,omitempty"`

    // Step-level body (only when used at step level)
    Action     *StepAction            `json:"action,omitempty"`

    // Test-level body (only when used at test level)
    Steps      []TestStep             `json:"steps,omitempty"`
}
```

Same pattern for `ForLoop` and `RepeatLoop` — add the same nested body fields.

The body level is determined by context:
- Test-level loop: `Steps` is populated, `Action`/`Match`/`Assertions` are not
- Step-level loop: `Action` may be populated, `Match`/`Assertions`/`Extract` may be populated
- Assertion-block loop: `Match`/`Assertions`/`Extract` may be populated, `Action` is not

Validation enforces these constraints (see TS validator section below). The Go side trusts the validator and just checks what fields are present.

### `TestStep` → keep loop fields for step-level loops

No structural change — step-level loops still use `TestStep.ForEach`/`For`/`Repeat`. The difference is behavioral: the loop body is now nested inside the loop struct rather than being sibling keys on the step.

Currently, `step.ForEach` contains only loop config (`items`, `as`, `name`, `delayMs`) and `step.Assertions` contains the assertions. After the change, `step.ForEach` contains both loop config AND the assertions/extract/match inside it.

When a step has `ForEach`/`For`/`Repeat` set, the step's own `Assertions` and `Extract` fields are ignored — the loop body's `Assertions` and `Extract` are used instead. Validation rejects steps that set both — e.g., a step with `forEach.assertions` AND top-level `assertions` is a validation error.

---

## 2. Path Resolution (`assertion_engine.go` — `EvaluateDocPath`)

### Remove `.length` special case

Current (lines 62–70):
```go
if seg == "length" {
    if arr, ok := toSlice(current); ok {
        return float64(len(arr)), true
    }
    if str, ok := current.(string); ok {
        return float64(len([]rune(str))), true
    }
}
```

Delete this entire block. After removal, `"length"` is treated as a normal object key — if the object has a `"length"` property, it resolves; otherwise path resolution fails.

### Add negative indexing

Current array index handling (lines 71–81):
```go
if idxMatch := regexp.MustCompile(`^\[(\d+)\]$`).FindStringSubmatch(seg); idxMatch != nil {
    idx, _ := strconv.Atoi(idxMatch[1])
    // ...
}
```

New — update regex to accept negative indices:
```go
if idxMatch := regexp.MustCompile(`^\[(-?\d+)\]$`).FindStringSubmatch(seg); idxMatch != nil {
    idx, _ := strconv.Atoi(idxMatch[1])
    arr, ok := toSlice(current)
    if !ok {
        return nil, false
    }
    if idx < 0 {
        idx = len(arr) + idx // -1 → last element, -2 → second-to-last
    }
    if idx < 0 || idx >= len(arr) {
        return nil, false
    }
    current = arr[idx]
    continue
}
```

### Add `$$` resolution

`EvaluateDocPath` currently only handles `$` prefix. Add `$$` support by accepting an optional scoped context parameter.

Change signature:
```go
// Before
func EvaluateDocPath(doc interface{}, path string) (interface{}, bool)

// After
func EvaluateDocPath(doc interface{}, path string, scopedCtx ...interface{}) (interface{}, bool)
```

At the top of the function, before stripping the `$.` prefix:
```go
if path == "$$" {
    return nil, false // bare $$ is invalid — must be $$.field
}
if strings.HasPrefix(path, "$$.") {
    if len(scopedCtx) == 0 || scopedCtx[0] == nil {
        return nil, false // $$ used outside where context
    }
    path = strings.TrimPrefix(path, "$$.")
    doc = scopedCtx[0]
}
```

All existing callers pass no `scopedCtx` and work unchanged. The match engine passes the current element being tested as `scopedCtx[0]` when evaluating `where` assertions.

---

## 3. Operator Changes (`assertion_engine.go` — `CompareValues`)

### Remove operators

Delete the following cases from the switch statement:

- `"type"` (lines 300–302) — replaced by `type` transform shorthand
- `"length"` (lines 303–309) — replaced by `count` transform shorthand
- `"arrayContains"` (lines 310–322) — subsumed by unified `contains`
- `"arrayNotContains"` (lines 323–335) — subsumed by unified `notContains`

### Unify `contains` / `notContains`

Current (lines 249–254):
```go
case "contains":
    return boolResult(strings.Contains(fmt.Sprintf("%v", actual), fmt.Sprintf("%v", expected)))
case "notContains":
    return boolResult(!strings.Contains(fmt.Sprintf("%v", actual), fmt.Sprintf("%v", expected)))
```

New — dispatch on actual type:
```go
case "contains":
    return containsDispatch(actual, expected, false)
case "notContains":
    return containsDispatch(actual, expected, true)
```

```go
func containsDispatch(actual, expected interface{}, negate bool) AssertionResult {
    switch v := actual.(type) {
    case string:
        match := strings.Contains(v, fmt.Sprintf("%v", expected))
        if negate { match = !match }
        return boolResult(match)
    case []interface{}:
        found := false
        for _, elem := range v {
            if reflect.DeepEqual(elem, expected) {
                found = true
                break
            }
        }
        if negate { found = !found }
        return boolResult(found)
    case map[string]interface{}:
        key := fmt.Sprintf("%v", expected)
        _, found := v[key]
        if negate { found = !found }
        return boolResult(found)
    default:
        return AssertionResult{
            Passed: false,
            Error:  fmt.Sprintf("contains operator requires string, array, or object; got %s", goTypeLabel(actual)),
        }
    }
}
```

Handle the case where `actual` is `nil` — treat as type error, not silent false:
```go
if actual == nil {
    return AssertionResult{
        Passed: false,
        Error:  "contains operator requires string, array, or object; got null",
    }
}
```

---

## 4. Assertion Resolution Pipeline (`assertion_engine.go` — `ValidateAssertion`)

### Full rewrite

Current `ValidateAssertion` (lines 402–442) is a simple path→compare flow. Replace with the full evaluation pipeline:

```go
func ValidateAssertion(assertion Assertion, doc map[string]interface{}, scopedCtx ...interface{}) AssertionResult {
    if assertion.Disabled {
        return AssertionResult{Passed: true, ResultKind: "field"}
    }

    // Step 1: Resolve source
    sourcePath, transform, err := resolveSource(assertion)
    if err != nil {
        return AssertionResult{Passed: false, Error: err.Error()}
    }

    // Step 2: Evaluate path
    actual, found := EvaluateDocPath(doc, sourcePath, scopedCtx...)

    // Handle exists/notExists before transform
    if assertion.Operator == "exists" {
        return existsResult(found && actual != nil)
    }
    if assertion.Operator == "notExists" {
        return notExistsResult(found && actual != nil)
    }
    if !found || actual == nil {
        return AssertionResult{
            Passed: false,
            Error:  fmt.Sprintf("path not found: %s", sourcePath),
        }
    }

    // Step 3: Apply transform (if any)
    if transform != "" {
        actual, err = applyAssertionTransform(actual, transform)
        if err != nil {
            return AssertionResult{Passed: false, Error: err.Error()}
        }
    }

    // Step 4: Resolve value
    expected, err := resolveValue(assertion.Value, doc)
    if err != nil {
        return AssertionResult{Passed: false, Error: err.Error()}
    }

    // Step 5: Compare
    result := CompareValues(assertion.Operator, actual, expected)
    result.Path = sourcePath
    result.Operator = assertion.Operator
    return result
}
```

### `applyAssertionTransform`

Distinct from the existing extract-only `applyTransform`. This version supports `length` and `type` (which extract doesn't need):

```go
func applyAssertionTransform(value interface{}, transform string) (interface{}, error) {
    switch transform {
    case "length":
        switch v := value.(type) {
        case []interface{}:
            return float64(len(v)), nil
        case string:
            return float64(len([]rune(v))), nil
        default:
            return nil, fmt.Errorf("transform 'length' requires array or string; got %s", goTypeLabel(value))
        }
    case "type":
        return goTypeLabel(value), nil
    case "keys":
        m, ok := value.(map[string]interface{})
        if !ok {
            hint := goTypeLabel(value)
            if _, isArr := value.([]interface{}); isArr {
                hint = "array (use 'length' to get array size)"
            }
            return nil, fmt.Errorf("transform 'keys' requires object; got %s", hint)
        }
        keys := make([]interface{}, 0, len(m))
        for k := range m {
            keys = append(keys, k)
        }
        sort.Slice(keys, func(i, j int) bool { return keys[i].(string) < keys[j].(string) })
        return keys, nil
    case "values":
        m, ok := value.(map[string]interface{})
        if !ok {
            hint := goTypeLabel(value)
            if _, isArr := value.([]interface{}); isArr {
                hint = "array (use 'length' to get array size, or index with [n] to access elements)"
            }
            return nil, fmt.Errorf("transform 'values' requires object; got %s", hint)
        }
        sortedKeys := sortedMapKeys(m)
        vals := make([]interface{}, len(sortedKeys))
        for i, k := range sortedKeys {
            vals[i] = m[k]
        }
        return vals, nil
    case "entries":
        m, ok := value.(map[string]interface{})
        if !ok {
            hint := goTypeLabel(value)
            if _, isArr := value.([]interface{}); isArr {
                hint = "array (use 'length' to get array size, or index with [n] to access elements)"
            }
            return nil, fmt.Errorf("transform 'entries' requires object; got %s", hint)
        }
        sortedKeys := sortedMapKeys(m)
        entries := make([]interface{}, len(sortedKeys))
        for i, k := range sortedKeys {
            entries[i] = map[string]interface{}{"key": k, "value": m[k]}
        }
        return entries, nil
    default:
        return nil, fmt.Errorf("unknown transform: %s", transform)
    }
}
```

### Shared helpers

```go
// goTypeLabel returns the JSON-style type label for a Go value.
// Used by transform error messages and the "type" transform itself.
func goTypeLabel(v interface{}) string {
    if v == nil {
        return "null"
    }
    switch v.(type) {
    case string:
        return "string"
    case float64, int:
        return "number"
    case bool:
        return "boolean"
    case []interface{}:
        return "array"
    case map[string]interface{}:
        return "object"
    default:
        return fmt.Sprintf("unknown(%T)", v)
    }
}

// sortedMapKeys returns the keys of a map in sorted order.
func sortedMapKeys(m map[string]interface{}) []string {
    keys := make([]string, 0, len(m))
    for k := range m {
        keys = append(keys, k)
    }
    sort.Strings(keys)
    return keys
}

// For sortedMapKeys on map[string]ExtractRule (used by executeExtract):
func sortedExtractKeys(m map[string]ExtractRule) []string {
    keys := make([]string, 0, len(m))
    for k := range m {
        keys = append(keys, k)
    }
    sort.Strings(keys)
    return keys
}
```

---

## 5. Match Engine Rewrite (`block_validators.go`)

### Delete `ValidateSelfBlock`, `ValidateConsoleLogBlock`

Remove both functions entirely. All assertion blocks now flow through a single unified path in `step_validator.go`.

### Rewrite `ValidateHttpCallBlock` → `ExecuteMatch`

Replace `ValidateHttpCallBlock` with a general-purpose match engine that works on any array:

```go
type MatchResult struct {
    Matches   []interface{}
    Match     interface{} // first element or nil
    LastMatch interface{} // last element or nil
}

func ExecuteMatch(match MatchCriteria, rootCtx map[string]interface{}) (MatchResult, error) {
    // 1. Resolve source array
    sourceVal, found := EvaluateDocPath(rootCtx, match.Path)
    if !found {
        return MatchResult{}, fmt.Errorf("match.path not found: %s", match.Path)
    }
    sourceArr, ok := toSlice(sourceVal)
    if !ok {
        return MatchResult{}, fmt.Errorf("match.path must resolve to an array; got %s", goTypeLabel(sourceVal))
    }

    // 2. Filter by where (if present)
    var matched []interface{}
    if len(match.Where) == 0 {
        matched = sourceArr // no filter → match all
    } else {
        for _, elem := range sourceArr {
            if evaluateWhereEntry(match.Where, elem, rootCtx) {
                matched = append(matched, elem)
            }
        }
    }

    // 3. Build result
    result := MatchResult{Matches: matched}
    if len(matched) > 0 {
        result.Match = matched[0]
        result.LastMatch = matched[len(matched)-1]
    }
    return result, nil
}
```

The top-level `where` array is implicitly AND — all entries must pass:

```go
// evaluateWhereEntry evaluates an AND-list of where entries against a single element.
// Each entry is either an assertion, an `or` block, or an `and` block.
func evaluateWhereEntry(entries []WhereEntry, elem interface{}, rootCtx map[string]interface{}) bool {
    for _, entry := range entries {
        if !evaluateSingleWhereEntry(entry, elem, rootCtx) {
            return false
        }
    }
    return true
}

func evaluateSingleWhereEntry(entry WhereEntry, elem interface{}, rootCtx map[string]interface{}) bool {
    // Boolean combinators
    if entry.Not != nil {
        return !evaluateSingleWhereEntry(*entry.Not, elem, rootCtx)
    }
    if len(entry.Or) > 0 {
        for _, child := range entry.Or {
            if evaluateSingleWhereEntry(child, elem, rootCtx) {
                return true
            }
        }
        return false
    }
    if len(entry.And) > 0 {
        for _, child := range entry.And {
            if !evaluateSingleWhereEntry(child, elem, rootCtx) {
                return false
            }
        }
        return true
    }

    // Simple assertion — evaluate with $$ scoped to elem
    assertion := Assertion{
        Path:     entry.Path,
        Operator: entry.Operator,
        Value:    entry.Value,
    }
    result := ValidateAssertion(assertion, rootCtx, elem)
    return result.Passed
}
```

The `elem` parameter flows through to `EvaluateDocPath` as the `scopedCtx`, so `$$.request.method` resolves `request.method` on the current traffic entry being tested.

### Stack-based match result injection

Add a match result stack to the step validator context:

```go
type savedMatchEntry struct {
    value   interface{}
    present bool
}

type MatchStack struct {
    stack []map[string]savedMatchEntry
}

func (ms *MatchStack) Push(result MatchResult, rootCtx map[string]interface{}) {
    // Save current values, tracking whether the key was present (even if nil)
    saved := make(map[string]savedMatchEntry)
    for _, key := range []string{"matches", "match", "lastMatch"} {
        val, present := rootCtx[key]
        saved[key] = savedMatchEntry{value: val, present: present}
    }
    ms.stack = append(ms.stack, saved)

    // Set new values
    rootCtx["matches"] = result.Matches
    rootCtx["match"] = result.Match
    rootCtx["lastMatch"] = result.LastMatch
}

func (ms *MatchStack) Pop(rootCtx map[string]interface{}) {
    if len(ms.stack) == 0 {
        delete(rootCtx, "matches")
        delete(rootCtx, "match")
        delete(rootCtx, "lastMatch")
        return
    }
    saved := ms.stack[len(ms.stack)-1]
    ms.stack = ms.stack[:len(ms.stack)-1]

    for _, key := range []string{"matches", "match", "lastMatch"} {
        entry := saved[key]
        if entry.present {
            rootCtx[key] = entry.value // restores nil correctly when outer match had 0 results
        } else {
            delete(rootCtx, key)
        }
    }
}
```

### Count desugaring

At the start of block execution, after `ExecuteMatch`, desugar `count` on match into a validation check:

```go
func desugarMatchCount(match MatchCriteria, matchedCount int) *AssertionResult {
    if match.Count == nil {
        return nil
    }

    var countAssertion CountAssertion
    switch c := match.Count.(type) {
    case float64:
        countAssertion = CountAssertion{Operator: "eq", Value: int(c)}
    case int:
        countAssertion = CountAssertion{Operator: "eq", Value: c}
    case map[string]interface{}:
        op, _ := c["operator"].(string)
        val, _ := c["value"].(float64)
        countAssertion = CountAssertion{Operator: op, Value: int(val)}
    }

    result := ValidateCount(matchedCount, countAssertion)
    if !result.Passed {
        result.Error = fmt.Sprintf("match count failed: expected %s %d entries matching {path: %s}, found %d",
            countAssertion.Operator, countAssertion.Value, match.Path, matchedCount)
        result.ResultKind = "count"
    }
    return &result
}
```

### `as` handling

After `ExecuteMatch`, if `match.As` is set:

```go
if match.As != "" {
    varCtx.Set(match.As, result.Matches)
    // Update rootCtx variables snapshot
    rootCtx["variables"] = varCtx.Snapshot()
}
```

---

## 6. Document Assembly Changes (`document_assembler.go`)

### Add timeline indices to traffic entries

In `assembleTrafficList` (lines 340–398), each traffic entry is a `map[string]interface{}`. After assembling all entries and the timeline, annotate each traffic entry with its timeline position.

This requires a two-pass approach:

```go
func assembleTrafficList(httpLogs []HttpLogMessage, stepExec StepExecution) ([]interface{}, []timelineEntry) {
    // ... existing logic to build traffic entries and timeline entries ...

    // After timeline is sorted, annotate traffic entries with indices
    // (done in AssembleRootContext after mergeTimeline)
}
```

In `AssembleRootContext`, after `mergeTimeline`:

```go
// Annotate traffic entries with timeline indices
timeline := mergeTimeline(trafficTimeline, consoleTimeline, dbTimeline)
annotateTimelineIndices(traffic, timeline)

rootCtx["timeline"] = timeline
```

```go
func annotateTimelineIndices(traffic []interface{}, timeline []interface{}) {
    // Build lookup: timeline entry pointer → index
    // Each traffic entry contributed 1-2 timeline entries (request sent, response received)
    // The timeline entries have "trafficIndex" set during assembly

    for i, t := range traffic {
        entry := t.(map[string]interface{})
        reqIdx, _ := findTimelineIndex(timeline, i, "request")
        entry["requestTimelineIndex"] = float64(reqIdx) // always present

        respIdx, found := findTimelineIndex(timeline, i, "response")
        if !found {
            entry["responseTimelineIndex"] = nil // no response received
        } else {
            entry["responseTimelineIndex"] = float64(respIdx)
        }
    }
}
```

To make this work, timeline entries need to carry their source traffic index and type. Modify `assembleTrafficList` to tag timeline entries:

```go
// When creating timeline entries for a traffic log:
reqEntry := map[string]interface{}{
    "type":         "httpRequest",
    "timestamp":    requestTimestamp,
    "trafficIndex": float64(i), // index in traffic array
    "direction":    "request",
    // ... other fields
}
respEntry := map[string]interface{}{
    "type":         "httpResponse",
    "timestamp":    responseTimestamp,
    "trafficIndex": float64(i),
    "direction":    "response",
    // ... other fields
}
```

```go
func findTimelineIndex(timeline []interface{}, trafficIdx int, direction string) (int, bool) {
    for i, t := range timeline {
        entry := t.(map[string]interface{})
        ti, ok1 := entry["trafficIndex"]
        dir, ok2 := entry["direction"]
        if ok1 && ok2 && ti == float64(trafficIdx) && dir == direction {
            return i, true
        }
    }
    return 0, false
}
```

---

## 7. Step Validation Flow (`step_validator.go`)

### Remove self-block vs match-block distinction

Current `validateStep` (lines 143–231) dispatches to three different validators:
1. `ValidateConsoleLogBlock` (if `service` + `consoleAssertions`)
2. `ValidateHttpCallBlock` (if `match`)
3. `ValidateSelfBlock` (fallback)

Replace with a single unified flow:

```go
func (sv *StepValidator) validateBlock(block AssertionBlock, rootCtx map[string]interface{}) []AssertionResult {
    var results []AssertionResult

    // 1. Match (if present)
    if block.Match != nil {
        matchResult, err := ExecuteMatch(*block.Match, rootCtx)
        if err != nil {
            results = append(results, AssertionResult{Passed: false, Error: err.Error(), ResultKind: "match"})
            return results
        }

        // Push match results onto stack
        sv.matchStack.Push(matchResult, rootCtx)
        defer sv.matchStack.Pop(rootCtx)

        // Save to variables if `as` is set
        if block.Match.As != "" {
            sv.varCtx.Set(block.Match.As, matchResult.Matches)
            rootCtx["variables"] = sv.varCtx.Snapshot()
        }

        // Desugar count
        if countResult := desugarMatchCount(*block.Match, len(matchResult.Matches)); countResult != nil {
            results = append(results, *countResult)
            if !countResult.Passed {
                return results // count failed, skip assertions
            }
        }
    }

    // 2. Loop (if present) — execute recursively
    if loop := getBlockLoop(block); loop != nil {
        loopResults := sv.executeBlockLoop(loop, rootCtx)
        results = append(results, loopResults...)
        // After loop, fall through to outer assertions (if any)
    }

    // 3. Assertions (skip any that already got targeted empty-match errors above)
    emptyMatchHandled := make(map[int]bool)
    for _, r := range results {
        if r.BlockIndex != nil && r.ResultKind == "field" {
            emptyMatchHandled[*r.BlockIndex] = true
        }
    }
    for i, a := range block.Assertions {
        if a.Disabled || emptyMatchHandled[i] {
            continue
        }
        result := ValidateAssertion(a, rootCtx)
        result.BlockIndex = intPtr(i)
        result.ResultKind = "field"
        results = append(results, result)
    }

    // 4. Extract (only if all assertions passed)
    if allPassed(results) && len(block.Extract) > 0 {
        extractResults := sv.executeExtract(block.Extract, rootCtx)
        results = append(results, extractResults...)
    }

    return results
}
```

`getBlockLoop` returns the first non-nil loop from `block.ForEach`, `block.For`, `block.Repeat`:

```go
type blockLoop struct {
    forEach *ForEachLoop
    forLoop *ForLoop
    repeat  *RepeatLoop
}

func getBlockLoop(block AssertionBlock) *blockLoop {
    if block.ForEach != nil {
        return &blockLoop{forEach: block.ForEach}
    }
    if block.For != nil {
        return &blockLoop{forLoop: block.For}
    }
    if block.Repeat != nil {
        return &blockLoop{repeat: block.Repeat}
    }
    return nil
}
```

### Empty matches error messages

When `$.match` is null (zero matches) and an assertion references `$.match.*`, `EvaluateDocPath` returns `(nil, false)`. The assertion fails with `"path not found: $.match.response.status"`. Enhance this:

In `validateBlock`, after pushing match results with zero matches, check if assertions reference `$.match` or `$.lastMatch` and produce a targeted error.

`formatWhereDescription` serializes where criteria into a human-readable string for error messages:

```go
func formatWhereDescription(entries []WhereEntry) string {
    parts := make([]string, 0, len(entries))
    for _, e := range entries {
        if e.Path != "" {
            parts = append(parts, fmt.Sprintf("%s %s %v", e.Path, e.Operator, e.Value))
        } else if len(e.Or) > 0 {
            parts = append(parts, fmt.Sprintf("or(%s)", formatWhereDescription(e.Or)))
        } else if len(e.And) > 0 {
            parts = append(parts, fmt.Sprintf("and(%s)", formatWhereDescription(e.And)))
        } else if e.Not != nil {
            parts = append(parts, fmt.Sprintf("not(%s)", formatWhereDescription([]WhereEntry{*e.Not})))
        }
    }
    return strings.Join(parts, ", ")
}
```

```go
if len(matchResult.Matches) == 0 {
    // Produce targeted errors for assertions referencing $.match/$.lastMatch,
    // but continue to evaluate assertions that don't (e.g., $.response.body)
    for i, a := range block.Assertions {
        sourcePath, _, _ := resolveSource(a)
        if strings.HasPrefix(sourcePath, "$.match") || strings.HasPrefix(sourcePath, "$.lastMatch") {
            whereDesc := formatWhereDescription(block.Match.Where)
            results = append(results, AssertionResult{
                Passed:     false,
                Error:      fmt.Sprintf("no entries matched {path: %s, where: %s} — $.match is null", block.Match.Path, whereDesc),
                Path:       sourcePath,
                BlockIndex: intPtr(i),
                ResultKind: "field",
            })
        }
    }
    // Do NOT return early — fall through to run non-$.match assertions normally
}
```

---

## 8. Loop Execution (`loop_executor.go`, `step_runner.go`)

### Remove inline loop detection

Delete `getStepLoop` and `getActionLoop` from `loop_executor.go`. Loops are no longer detected from sibling keys — they are explicit nested structures.

### `executeBlockLoop`

New method on `StepValidator` that executes a loop body at the assertion-block level:

```go
func (sv *StepValidator) executeBlockLoop(loop *blockLoop, rootCtx map[string]interface{}) []AssertionResult {
    plan, err := buildIterationPlan(loop.forEach, loop.forLoop, loop.repeat, sv.varCtx)
    if err != nil {
        return []AssertionResult{{Passed: false, Error: err.Error(), ResultKind: "loop"}}
    }

    var allResults []AssertionResult

    for iterIdx, iter := range plan.Iterations {
        if iterIdx > 0 && plan.DelayMs > 0 {
            delayBetweenIterations(iterIdx, plan.DelayMs)
        }
        iter.SetupFn()

        // Update rootCtx variables snapshot for this iteration
        rootCtx["variables"] = sv.varCtx.Snapshot()

        // Execute the loop body (which is itself an assertion block)
        body := extractLoopBody(loop)
        bodyResults := sv.validateBlock(body, rootCtx)
        allResults = append(allResults, bodyResults...)

        // Check repeat.Until
        if loop.repeat != nil && loop.repeat.Until != nil {
            if evaluateUntil(loop.repeat.Until, rootCtx, sv.varCtx) {
                break
            }
        }

        // Clean up iteration variables
        cleanupLoopVars(sv.varCtx, loop)
    }

    setLoopResult(sv.varCtx, plan.LoopName, true, len(plan.Iterations))
    return allResults
}
```

`extractLoopBody` converts the nested fields of the loop struct into an `AssertionBlock`:

```go
func extractLoopBody(loop *blockLoop) AssertionBlock {
    if loop.forEach != nil {
        return AssertionBlock{
            Match:      loop.forEach.Match,
            Assertions: loop.forEach.Assertions,
            Extract:    loop.forEach.Extract,
            ForEach:    loop.forEach.ForEach, // nested loop
            For:        loop.forEach.For,
            Repeat:     loop.forEach.Repeat,
        }
    }
    // Same for forLoop and repeat
    // ...
}
```

This is recursive — a nested loop inside the body is handled by `validateBlock` calling `executeBlockLoop` again.

### Step-level loop restructuring

In `step_runner.go`, `executeStepAt` currently calls `getStepLoop()` and runs the loop body by calling `executeStep()` per iteration. The new pattern:

The step's `ForEach`/`For`/`Repeat` struct now contains the full body. `executeStepAt` extracts the body and runs it:

```go
func (e *TestExecutor) executeStepAt(ctx context.Context, fs flatStep) (StepExecution, error) {
    step := fs.step
    loop := getBlockLoop(/* from step's forEach/for/repeat */)

    if loop == nil {
        return e.executeStepOnce(ctx, fs)
    }

    // Loop body is nested inside the loop struct
    plan, err := buildIterationPlan(...)
    if err != nil { ... }

    loopResult, err := runLoop(plan, e.varCtx, func(iterIdx int, iter Iteration) (map[string]interface{}, error) {
        iter.SetupFn()

        // The loop body may contain an action
        bodyAction := getLoopBodyAction(loop)
        if bodyAction != nil {
            resp, err := e.executeAction(ctx, bodyAction, fs.stepIndex)
            if err != nil { return nil, err }
            e.lastStepResponse = resp
        }

        // Validate assertions/extract from the loop body
        if e.stepValidator != nil {
            bodyBlock := extractLoopBody(loop)
            results := e.stepValidator.validateBlock(bodyBlock, rootCtx)
            // report results...
        }

        return e.lastStepResponse, nil
    })
    // ...
}
```

---

## 9. Variable Context / Extract (`variable_context.go`)

### Dynamic extract keys

Current `Extract` method (lines 263–277) iterates `rules map[string]ExtractRule` with fixed string keys.

Add key interpolation:

```go
func (vc *VariableContext) Extract(rules map[string]ExtractRule, doc map[string]interface{}) error {
    for variable, rule := range rules {
        // Interpolate variable name
        resolvedName, err := vc.Resolve(variable)
        if err != nil {
            return fmt.Errorf("failed to resolve extract key '%s': %w", variable, err)
        }

        value, err := ResolveExtractRule(doc, resolvedName, rule)
        if err != nil {
            return fmt.Errorf("extract '%s' failed: %w", resolvedName, err)
        }
        vc.Set(resolvedName, value)
    }
    return nil
}
```

The `variablePattern` regex (`\{\{([\w]+(?:\.[\w]+|\[\d+\])*)\}\}`) already matches `{{entry.index}}`, so `Resolve("userId_{{entry.index}}")` → `"userId_0"`, `"userId_1"`, etc.

Note: the `Resolve` method returns an error if a variable is not defined. This is the desired behavior for dynamic keys — if the loop variable doesn't exist, the extract key can't be computed and should fail.

### Extract in step_validator.go

The `executeExtract` helper used by `validateBlock`:

```go
func (sv *StepValidator) executeExtract(rules map[string]ExtractRule, rootCtx map[string]interface{}) []AssertionResult {
    var results []AssertionResult
    sortedKeys := sortedExtractKeys(rules)

    for _, variable := range sortedKeys {
        rule := rules[variable]

        // Resolve dynamic key name
        resolvedName, err := sv.varCtx.Resolve(variable)
        if err != nil {
            results = append(results, AssertionResult{
                Passed:     false,
                Error:      fmt.Sprintf("extract key interpolation failed for '%s': %s", variable, err.Error()),
                Path:       variable,
                ResultKind: "extract",
            })
            continue
        }

        value, err := ResolveExtractRule(rootCtx, resolvedName, rule)
        if err != nil {
            results = append(results, AssertionResult{
                Passed:     false,
                Error:      fmt.Sprintf("extract '%s' failed: %s", resolvedName, err.Error()),
                Path:       resolvedName,
                ResultKind: "extract",
            })
            continue
        }

        sv.varCtx.Set(resolvedName, value)
        rootCtx["variables"] = sv.varCtx.Snapshot()
    }
    return results
}
```

---

## 10. TypeScript Type Changes (`shared/config/assertions.ts`)

### `AssertionBlock` — remove deprecated fields

```typescript
// Before
export interface AssertionBlock {
  extract?: Record<string, ExtractRule>;
  match?: { origin?: string; method?: string; url?: string; };
  count?: CountAssertion;
  assertionScope?: 'all' | 'first' | 'last' | 'any';
  assertions: Assertion[];
  service?: string;
  consoleAssertions?: ConsoleLogAssertion[];
  forEach?: ForEachLoop;
}

// After
export interface AssertionBlock {
  extract?: Record<string, ExtractRule>;
  match?: MatchCriteria;
  assertions?: Assertion[];
  forEach?: ForEachLoop;
  for?: ForLoop;
  repeat?: RepeatLoop;
}
```

Removed: `count`, `assertionScope`, `service`, `consoleAssertions`.
Changed: `assertions` is now optional (a block can have just a match with count, or just a loop).
Added: `for`, `repeat` (all loop types now supported at block level).

### `MatchCriteria` — new type

```typescript
export interface MatchCriteria {
  path: string;
  where?: WhereEntry[];
  count?: number | CountAssertion;
  as?: string;
}

export type WhereEntry = WhereAssertion | WhereOr | WhereAnd | WhereNot;

export interface WhereAssertion {
  path: string;        // must start with $$
  operator: string;
  value?: any;
}

export interface WhereOr {
  or: WhereEntry[];
}

export interface WhereAnd {
  and: WhereEntry[];
}

export interface WhereNot {
  not: WhereEntry;
}
```

### `Assertion` — add source fields

```typescript
// Before
export interface Assertion {
  path: string;
  operator: AssertionOperator;
  value?: any;
  disabled?: boolean;
}

// After
export interface Assertion {
  // Source fields — exactly one required
  path?: string | PathWithTransform;
  count?: string;
  type?: string;
  keys?: string;
  values?: string;
  entries?: string;

  operator: AssertionOperator;
  value?: any | ValueRef;
  disabled?: boolean;
}

export interface PathWithTransform {
  from: string;        // must start with $
  transform: string;
}

export interface ValueRef {
  from: string;         // must start with $
  transform?: string;
}
```

### `AssertionOperator` — remove deprecated operators

```typescript
// Remove: 'type', 'length', 'arrayContains', 'arrayNotContains'
export type AssertionOperator =
  | 'eq' | 'eqIgnoreCase' | 'ne'
  | 'gt' | 'gte' | 'lt' | 'lte'
  | 'contains' | 'notContains'
  | 'containsIgnoreCase' | 'notContainsIgnoreCase'
  | 'matches' | 'exists' | 'notExists'
  | 'in' | 'notIn'
  | 'isEmpty' | 'notEmpty';
```

### Loop types — add nested body fields

```typescript
export interface ForEachLoop {
  items: unknown[] | string;
  as: string;
  name?: string;
  delayMs?: number;

  // Nested body (assertion-block level)
  match?: MatchCriteria;
  assertions?: Assertion[];
  extract?: Record<string, ExtractRule>;
  forEach?: ForEachLoop;
  for?: ForLoop;
  repeat?: RepeatLoop;

  // Step-level body
  action?: StepAction;

  // Test-level body
  steps?: TestStep[];
}
```

Same additions for `ForLoop` and `RepeatLoop`.

### Remove `ConsoleLogAssertion`

Delete the `ConsoleLogAssertion` interface entirely. Console log filtering now uses `MatchCriteria` with `path: "$.consoleLogs"`.

---

## 11. TypeScript Validator Changes

### `constants.ts`

```typescript
// Remove from VALID_ASSERTION_OPERATORS:
// 'type', 'length', 'arrayContains', 'arrayNotContains'

// Remove entirely:
// VALID_ASSERTION_SCOPES
// VALID_CONSOLE_LOG_LEVELS
// VALID_MESSAGE_OPERATORS
// VALID_MESSAGE_FILTER_KEYS
// VALID_CONSOLE_LOG_ASSERTION_KEYS

// Replace VALID_MATCH_CRITERIA_KEYS:
// Before: new Set(['origin', 'method', 'url'])
// After:  new Set(['path', 'where', 'count', 'as'])

// Replace VALID_ASSERTION_KEYS:
// Before: new Set(['path', 'operator', 'value', 'disabled'])
// After:  new Set(['path', 'count', 'type', 'keys', 'values', 'entries', 'operator', 'value', 'disabled'])

// Replace VALID_ASSERTION_BLOCK_KEYS:
// Before: new Set(['assertions', 'match', 'service', 'consoleAssertions', 'extract', 'assertionScope', 'count', 'forEach', 'for', 'repeat'])
// After:  new Set(['assertions', 'match', 'extract', 'forEach', 'for', 'repeat'])

// Add:
// VALID_WHERE_ENTRY_KEYS = new Set(['path', 'operator', 'value', 'or', 'and', 'not'])
// VALID_TRANSFORMS = new Set(['length', 'type', 'keys', 'values', 'entries'])
// VALID_SOURCE_FIELDS = new Set(['path', 'count', 'type', 'keys', 'values', 'entries'])

// Update VALID_FOR_EACH_KEYS to include body fields:
// new Set(['items', 'as', 'name', 'delayMs', 'match', 'assertions', 'extract', 'forEach', 'for', 'repeat', 'action', 'steps'])
// Same for VALID_FOR_KEYS and VALID_REPEAT_KEYS
```

### `validate-assertions.ts`

#### `validateAssertionBlock` — rewrite

```typescript
export function validateAssertionBlock(block: Record<string, unknown>, ctx: string, r: ValidationResult): void {
    // Check for unknown keys
    validateKeys(block, VALID_ASSERTION_BLOCK_KEYS, ctx, r);

    // Match (optional)
    if ('match' in block) {
        validateMatchCriteria(block.match, `${ctx}.match`, r);
    }

    // Extract (optional)
    if ('extract' in block) {
        validateExtractRules(block.extract, `${ctx}.extract`, r);
    }

    // Assertions (optional)
    if ('assertions' in block) {
        validateAssertions(block.assertions, ctx, r);
    }

    // Loop modifiers (at most one)
    validateLoopModifiers(block, ctx, r, { allowDocPaths: true, level: 'assertion-block' });
}
```

#### `validateMatchCriteria` — new function

```typescript
function validateMatchCriteria(match: unknown, ctx: string, r: ValidationResult): void {
    if (!isPlainObject(match)) {
        r.error(`${ctx} must be an object`);
        return;
    }

    validateKeys(match, VALID_MATCH_CRITERIA_KEYS, ctx, r);

    // path (required)
    if (!('path' in match) || typeof match.path !== 'string' || !match.path) {
        r.error(`${ctx}.path is required and must be a non-empty string`);
    } else if (!match.path.startsWith('$.')) {
        r.error(`${ctx}.path must start with "$." (e.g., "$.traffic", "$.consoleLogs")`);
    }

    // where (optional, non-empty if present)
    if ('where' in match) {
        if (!Array.isArray(match.where)) {
            r.error(`${ctx}.where must be an array`);
        } else if (match.where.length === 0) {
            r.error(`${ctx}.where must be non-empty; omit where entirely to match all elements`);
        } else {
            match.where.forEach((entry, i) => {
                validateWhereEntry(entry, `${ctx}.where[${i}]`, r);
            });
        }
    }

    // count (optional)
    if ('count' in match) {
        if (typeof match.count === 'number') {
            if (!Number.isInteger(match.count) || match.count < 0) {
                r.error(`${ctx}.count must be a non-negative integer`);
            }
        } else if (isPlainObject(match.count)) {
            validateCountAssertion(match.count, `${ctx}.count`, r);
        } else {
            r.error(`${ctx}.count must be a number or {operator, value} object`);
        }
    }

    // as (optional)
    if ('as' in match) {
        if (typeof match.as !== 'string' || !match.as || !/^\w+$/.test(match.as)) {
            r.error(`${ctx}.as must be a non-empty alphanumeric string`);
        }
    }
}
```

#### `validateWhereEntry` — new function (recursive)

```typescript
function validateWhereEntry(entry: unknown, ctx: string, r: ValidationResult): void {
    if (!isPlainObject(entry)) {
        r.error(`${ctx} must be an object`);
        return;
    }

    validateKeys(entry, VALID_WHERE_ENTRY_KEYS, ctx, r);

    const hasAssertion = 'path' in entry;
    const hasOr = 'or' in entry;
    const hasAnd = 'and' in entry;
    const hasNot = 'not' in entry;

    // Must be exactly one of: assertion, or, and, not
    const typeCount = [hasAssertion, hasOr, hasAnd, hasNot].filter(Boolean).length;
    if (typeCount === 0) {
        r.error(`${ctx} must have 'path' (assertion), 'or', 'and', or 'not'`);
        return;
    }
    if (typeCount > 1) {
        r.error(`${ctx} cannot mix assertion fields with 'or'/'and'/'not'`);
        return;
    }

    if (hasAssertion) {
        // Validate as assertion with $$ prefix
        const path = entry.path;
        if (typeof path !== 'string' || !path.startsWith('$$.')) {
            r.error(`${ctx}.path must start with "$$." (e.g., "$$.request.method")`);
        }
        if ('operator' in entry) {
            validateOperator(entry.operator, ctx, r);
        }
    } else if (hasOr) {
        if (!Array.isArray(entry.or) || entry.or.length === 0) {
            r.error(`${ctx}.or must be a non-empty array`);
        } else {
            entry.or.forEach((child, i) => {
                validateWhereEntry(child, `${ctx}.or[${i}]`, r);
            });
        }
    } else if (hasAnd) {
        if (!Array.isArray(entry.and) || entry.and.length === 0) {
            r.error(`${ctx}.and must be a non-empty array`);
        } else {
            entry.and.forEach((child, i) => {
                validateWhereEntry(child, `${ctx}.and[${i}]`, r);
            });
        }
    } else if (hasNot) {
        if (!isPlainObject(entry.not)) {
            r.error(`${ctx}.not must be a where entry object`);
        } else {
            validateWhereEntry(entry.not, `${ctx}.not`, r);
        }
    }
}
```

#### `validateAssertion` — update for source fields and transforms

```typescript
function validateAssertion(assertion: Record<string, unknown>, ctx: string, r: ValidationResult): void {
    validateKeys(assertion, VALID_ASSERTION_KEYS, ctx, r);

    // Exactly one source field
    const sourceFields = ['path', 'count', 'type', 'keys', 'values', 'entries'];
    const present = sourceFields.filter(f => f in assertion);
    if (present.length === 0) {
        r.error(`${ctx} must have exactly one source field (${sourceFields.join(', ')})`);
    } else if (present.length > 1) {
        r.error(`${ctx} has multiple source fields (${present.join(', ')}); only one is allowed`);
    }

    // Validate the source field
    const sourceField = present[0];
    if (sourceField === 'path') {
        const path = assertion.path;
        if (typeof path === 'string') {
            validatePathFormat(path, `${ctx}.path`, r);
        } else if (isPlainObject(path)) {
            // Object form: { from, transform }
            validatePathWithTransform(path, `${ctx}.path`, r);
        } else {
            r.error(`${ctx}.path must be a string or {from, transform} object`);
        }
    } else {
        // Shorthand — must be a string path
        const val = assertion[sourceField];
        if (typeof val !== 'string') {
            r.error(`${ctx}.${sourceField} must be a string path`);
        } else {
            validatePathFormat(val, `${ctx}.${sourceField}`, r);
        }
    }

    // Operator
    if ('operator' in assertion) {
        validateOperator(assertion.operator, ctx, r);
    }

    // Value — check for ValueRef form
    if ('value' in assertion && isPlainObject(assertion.value)) {
        const val = assertion.value as Record<string, unknown>;
        if ('from' in val && typeof val.from === 'string' && val.from.startsWith('$.')) {
            validatePathFormat(val.from, `${ctx}.value.from`, r);
            if ('transform' in val) {
                if (!VALID_TRANSFORMS.has(val.transform as string)) {
                    r.error(`${ctx}.value.transform must be one of: ${[...VALID_TRANSFORMS].join(', ')}`);
                }
            }
        }
        // Otherwise treat as literal object — no validation needed
    }
}

function validatePathWithTransform(obj: Record<string, unknown>, ctx: string, r: ValidationResult): void {
    if (!('from' in obj) || typeof obj.from !== 'string') {
        r.error(`${ctx}.from is required and must be a string`);
    } else if (!obj.from.startsWith('$.')) {
        r.error(`${ctx}.from must start with "$."`);
    } else {
        validatePathFormat(obj.from, `${ctx}.from`, r);
    }

    if (!('transform' in obj) || !VALID_TRANSFORMS.has(obj.transform as string)) {
        r.error(`${ctx}.transform is required and must be one of: ${[...VALID_TRANSFORMS].join(', ')}`);
    }
}
```

### `validate-loops.ts`

#### Loop body validation — recursive

The key change: loops now contain their body. Validation must check the body fields based on the level:

```typescript
export function validateLoopModifiers(
    obj: Record<string, unknown>,
    ctx: string,
    r: ValidationResult,
    options?: LoopValidationOptions & { level?: 'test' | 'step' | 'assertion-block' }
): 'forEach' | 'for' | 'repeat' | null {
    // ... existing mutual exclusion check ...

    if (obj.forEach) {
        validateForEachLoop(obj.forEach, `${ctx}.forEach`, r, options);
        validateLoopBody(obj.forEach, `${ctx}.forEach`, r, options?.level ?? 'assertion-block');
    }
    // Same for for, repeat

    // When a loop is present at step level, the parent step must not also have
    // assertions/extract as sibling keys — those belong inside the loop body.
    if (options?.level === 'step' && (obj.forEach || obj.for || obj.repeat)) {
        if ('assertions' in obj && obj.assertions) {
            r.error(`${ctx}: step-level loop body contains its own assertions; remove top-level 'assertions'`);
        }
        if ('extract' in obj && obj.extract) {
            r.error(`${ctx}: step-level loop body contains its own extract; remove top-level 'extract'`);
        }
    }
}

function validateLoopBody(
    loop: Record<string, unknown>,
    ctx: string,
    r: ValidationResult,
    level: 'test' | 'step' | 'assertion-block'
): void {
    const hasAction = 'action' in loop;
    const hasSteps = 'steps' in loop;
    const hasAssertions = 'assertions' in loop || 'match' in loop || 'extract' in loop;

    // Level-specific validation
    if (level === 'test') {
        if (!hasSteps) {
            r.error(`${ctx} at test level must have a 'steps' array`);
        }
        if (hasAction) r.error(`${ctx} at test level cannot have 'action'`);
        if (hasAssertions) r.error(`${ctx} at test level cannot have 'match'/'assertions'/'extract'`);
        if (hasSteps) {
            // Validate each step in the steps array
            validateStepsArray(loop.steps, `${ctx}.steps`, r);
        }
    } else if (level === 'step') {
        if (hasSteps) r.error(`${ctx} at step level cannot have 'steps'`);
        if (hasAction) {
            validateAction(loop.action, `${ctx}.action`, r);
        }
        if ('match' in loop) validateMatchCriteria(loop.match, `${ctx}.match`, r);
        if ('assertions' in loop) validateAssertions(loop.assertions, ctx, r);
        if ('extract' in loop) validateExtractRules(loop.extract, `${ctx}.extract`, r);
    } else {
        // assertion-block level
        if (hasSteps) r.error(`${ctx} at assertion-block level cannot have 'steps'`);
        if (hasAction) r.error(`${ctx} at assertion-block level cannot have 'action'`);
        if ('match' in loop) validateMatchCriteria(loop.match, `${ctx}.match`, r);
        if ('assertions' in loop) validateAssertions(loop.assertions, ctx, r);
        if ('extract' in loop) validateExtractRules(loop.extract, `${ctx}.extract`, r);
    }

    // repeat.until — validate entries as standard assertions (same struct, supports transforms and ValueRef)
    if ('until' in loop && Array.isArray(loop.until)) {
        (loop.until as unknown[]).forEach((entry, i) => {
            validateAssertion(entry as Record<string, unknown>, `${ctx}.until[${i}]`, r);
        });
    }

    // Nested loops (recursive)
    validateLoopModifiers(loop, ctx, r, { allowDocPaths: true, level: level === 'test' ? 'step' : 'assertion-block' });
}
```

#### Remove forEach+match mutual exclusion

Current (lines 333–338 of `validate-assertions.ts`):
```typescript
if (block.forEach && (block.match || block.service)) {
    r.error(`${ctx}: forEach cannot be combined with match or service`);
}
```

Delete this check. Nesting makes forEach+match composable — a loop body can contain its own match.

---

## 12. `$` path validation in where context

The validator must enforce that `$$` paths only appear inside `where` arrays. This is handled naturally by `validateWhereEntry` (requires `$$.` prefix) and the existing assertion path validation (requires `$.` prefix). No additional global check needed — if someone writes `$$` in a regular assertion, `validatePathFormat` already rejects it since it doesn't start with `$.`.

Add to `validatePathFormat`:
```typescript
if (path.startsWith('$$') && !inWhereContext) {
    r.error(`${ctx}: $$ paths are only valid inside match.where`);
}
```

Where `inWhereContext` is a boolean parameter threaded through validation. In practice, the simpler approach: `validateWhereEntry` calls a `validateWherePath` that accepts `$$.` prefix, and `validatePathFormat` (used everywhere else) rejects `$$` — no threading needed.

---

## 13. ResolveAssertionBlocks update (`variable_context.go`)

Current `ResolveAssertionBlocks` (lines 173–231) resolves `{{var}}` in assertion paths, values, match URL/origin, and console assertion messages.

After the change:
- Remove match URL/origin resolution (match no longer has those fields)
- Remove console assertion resolution (console assertions removed)
- Add resolution for `where` entry values
- Add resolution for source field paths (count, type, keys, values, entries)
- Add resolution for `value.from` paths (if value is a ValueRef)

```go
func (vc *VariableContext) ResolveAssertionBlocks(blocks []AssertionBlock) []AssertionBlock {
    resolved := make([]AssertionBlock, len(blocks))
    for i, block := range blocks {
        resolved[i] = block

        // Resolve match.where values
        if block.Match != nil {
            resolved[i].Match = vc.resolveMatchCriteria(block.Match)
        }

        // Resolve assertions
        for j, a := range block.Assertions {
            resolved[i].Assertions[j] = vc.resolveAssertion(a)
        }

        // Resolve nested loop body
        if block.ForEach != nil {
            resolved[i].ForEach = vc.resolveForEachBody(block.ForEach)
        }
        // Same for For, Repeat
    }
    return resolved
}

func (vc *VariableContext) resolveAssertion(a Assertion) Assertion {
    // Resolve source path (string form)
    if p, ok := a.Path.(string); ok {
        a.Path, _ = vc.Resolve(p)
    }
    // Resolve shorthand paths
    if a.Count != "" { a.Count, _ = vc.Resolve(a.Count) }
    if a.Type != "" { a.Type, _ = vc.Resolve(a.Type) }
    if a.Keys != "" { a.Keys, _ = vc.Resolve(a.Keys) }
    if a.Values != "" { a.Values, _ = vc.Resolve(a.Values) }
    if a.Entries != "" { a.Entries, _ = vc.Resolve(a.Entries) }

    // Resolve value
    a.Value, _ = vc.resolveValue(a.Value)
    return a
}

func (vc *VariableContext) resolveMatchCriteria(match *MatchCriteria) *MatchCriteria {
    resolved := *match
    // match.path is not resolved — it must be a static $.-prefixed path (e.g., "$.traffic").
    // Variable interpolation in match.path is not supported by design.

    // Resolve where entry values
    for i, entry := range resolved.Where {
        resolved.Where[i] = vc.resolveWhereEntry(entry)
    }
    return &resolved
}

func (vc *VariableContext) resolveWhereEntry(entry WhereEntry) WhereEntry {
    if entry.Path != "" {
        entry.Value, _ = vc.resolveValue(entry.Value)
    }
    for i, child := range entry.Or {
        entry.Or[i] = vc.resolveWhereEntry(child)
    }
    for i, child := range entry.And {
        entry.And[i] = vc.resolveWhereEntry(child)
    }
    if entry.Not != nil {
        resolved := vc.resolveWhereEntry(*entry.Not)
        entry.Not = &resolved
    }
    return entry
}
```

Note: `where` entry paths (e.g., `$$.request.method`) should NOT have `{{var}}` resolved — they are `$$`-prefixed paths, not variable references. Only the `value` field in where entries gets variable resolution. The `path` field is resolved by `EvaluateDocPath` at match time with the `$$` scoped context.

However, there's an exception: a user might write `{ "path": "$$.request.url", "operator": "contains", "value": "{{endpoint}}" }` where `{{endpoint}}` in the value needs resolution. This is already handled by `resolveValue` on the entry's `Value` field.

Where entry values also support the ValueRef form for root-context references: `"value": { "from": "$.variables.userId" }`. This works because `resolveValue` is called with `rootCtx`, so the `from` path resolves against the full root document. This enables comparisons like "match traffic where the response body ID equals a previously extracted variable."
