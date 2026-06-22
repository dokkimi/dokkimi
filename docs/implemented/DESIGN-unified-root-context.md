# Consistent Root Document for Assertions

## Problem

### 1. `$` is context-dependent

`$` means different things depending on whether an assertion is in a "self-block" (an assertion block with no `match` — asserts against the step's own request/response) or a "match block" (an assertion block with a `match` — asserts against matched traffic entries).

**Without `match`** — `$` is the unified root context:

```json
{
  "response": { "status": 201, "body": { "id": "abc" } },
  "request": { "method": "POST", "body": { "name": "Alice" } },
  "responseTime": 150,
  "variables": { "token": "xyz" },
  "traffic": [ ... ],
  "consoleLogs": [ ... ],
  "dbLogs": [ ... ],
  "timeline": [ ... ]
}
```

**With `match`** — `$` silently switches to a per-log document:

```json
{
  "request": { ... },
  "response": { ... },
  "responseTime": 150
}
```

This means `$.response.status` resolves against completely different documents depending on sibling keys. A user who writes `$.variables.token` in a match-block assertion gets a silent "not found" — no error, just a broken assertion. The syntax is identical; the semantics are not.

The "self-block" concept itself is an artifact of this inconsistency. With a consistent root, there is no meaningful distinction between assertion blocks with and without match — they all assert against the same root context.

### 2. Match uses a separate mini-language with no operators

Match criteria only support implicit equality (`"method": "POST"`, `"origin": "api-gateway"`). There is no way to filter on response-side fields, use operators like `gte` or `contains`, or reference variables. This means the filter and the assertion are doing fundamentally the same thing — comparing a value — but with two different syntaxes of different expressiveness.

This also means match can only filter on the request, not the response. A user who wants "find the POST that returned 201" can't express it — they have to match all POSTs and then assert on the response, even when they know exactly which entry they want.

### 3. `count` is a redundant mini-language

The `count` field on match blocks is a separate assertion structure with its own operator/value semantics that duplicates what standard assertion operators already do. Console log assertion blocks have the same `count` structure inside `consoleAssertions`, creating a second instance of the same redundancy.

### 4. `.length` is a surprising magic property in paths

`EvaluateDocPath` special-cases the segment `"length"` to return array/string length. This looks like a key access but acts as a function. It's the only such magic property, making it inconsistent — and it silently intercepts any object that has an actual key called `"length"`.

### 5. No way to compare two document paths

Assertion `value` only accepts literals or `{{var}}` interpolation. There is no way to write "assert that the body of traffic entry 0 equals the body of traffic entry 1" without extracting one side into a variable first.

### 6. Loops are inline modifiers with ambiguous ordering

Loops (`forEach`, `for`, `repeat`) are sibling keys on the same object as `match` and `assertions`. When both a loop and a match exist on the same block, the structure doesn't communicate which wraps which. Currently this is sidestepped by banning the combination (`forEach` + `match` is a validation error), but that's a limitation, not a design choice.

### 7. `consoleAssertions` and `service` are redundant concepts

Console log assertions use a separate `consoleAssertions` field with its own filter structure (`service`, `level`, `message` fields). The `service` field on assertion blocks filters traffic by service name. Both are special-purpose filters that duplicate what a general-purpose match/filter system would provide.

## Solution

### 1. `$` always means root document; `$$` is the scoped iterator

Two path roots:

- **`$`** — always the unified root context. Never changes meaning.
- **`$$`** — the current element in a match `where` filter. Only valid inside a `where` array.

`$$` is strictly a match feature. Loops do not use `$$` — they use `as` (required) and `name` (optional) as they do today. The reason is structural: `$$` refers to the element currently being tested by the filter, which is internal to the match engine. Loops iterate over already-resolved values and bind them to named variables via `as`, so there is no anonymous "current element" to reference — the variable name _is_ the reference. Bare `$$` (without a trailing `.field`) is invalid — `$$` is always followed by a dot and a field path (e.g., `$$.request.method`).

There is no "self-block" concept. All assertion blocks assert against the root context. Some blocks have a `match` that filters and populates results first; some don't. The distinction is just whether a filter runs before assertions, not a change in what `$` means.

### 2. Match uses assertion syntax with `where`

Match is no longer a separate mini-language. It declares a source array (`path`), filter criteria (`where`), and an optional name (`as`).

Inside the `where` array, `$$` refers to the current element being tested. `where` uses the same operators and variable references as standard assertions. Transform shorthands (`count`, `type`, `keys`, `values`, `entries`) and object-form `path` are not supported in `where` entries — filters operate on direct field values. If you need to filter by a derived value (e.g., array length), match more broadly and assert in the `assertions` block.

```json
{
  "match": {
    "path": "$.traffic",
    "where": [
      { "path": "$$.origin", "operator": "eq", "value": "api-gateway" },
      { "path": "$$.request.method", "operator": "eq", "value": "POST" },
      {
        "path": "$$.request.url",
        "operator": "contains",
        "value": "/api/users"
      },
      { "path": "$$.response.status", "operator": "gte", "value": 200 }
    ],
    "count": 1
  },
  "assertions": [{ "path": "$.match.response.body.id", "operator": "exists" }]
}
```

This solves several problems at once:

- **Full operator support in filters** — `gte`, `contains`, `regex`, etc. all work because `where` uses real assertions
- **Response-side filtering** — `$$.response.status`, `$$.response.body.*` are just paths
- **Variable references in filters** — `"value": "{{expectedOrigin}}"` works the same as in assertions
- **One syntax to learn** — the same assertion object structure is used for both filtering and validating
- **No "any" scope needed** — filters are expressive enough to select exactly the entries you want

#### `where` logic

`where` is AND by default — all entries must pass for an element to be included. For OR logic, use an `or` block; for explicit AND grouping inside an `or`, use an `and` block.

Simple OR:

```json
{
  "where": [
    { "path": "$$.origin", "operator": "eq", "value": "api-gateway" },
    {
      "or": [
        { "path": "$$.request.method", "operator": "eq", "value": "POST" },
        { "path": "$$.request.method", "operator": "eq", "value": "PUT" }
      ]
    }
  ]
}
```

Top-level `where` entries are AND. An `or` entry passes if at least one of its child entries passes. An `and` entry passes if all of its child entries pass. A `not` entry inverts the result of its child entry. All three can nest and interleave freely, giving full boolean expressiveness:

```json
{
  "where": [
    {
      "or": [
        {
          "and": [
            { "path": "$$.request.method", "operator": "eq", "value": "POST" },
            { "path": "$$.response.status", "operator": "eq", "value": 201 }
          ]
        },
        {
          "and": [
            { "path": "$$.request.method", "operator": "eq", "value": "PUT" },
            { "path": "$$.response.status", "operator": "eq", "value": 200 }
          ]
        }
      ]
    }
  ]
}
```

Top-level `where` is implicitly AND, so an explicit `and` block is only needed inside `or`. For simple single-field OR, the `in` operator is often sufficient: `{ "path": "$$.request.method", "operator": "in", "value": ["POST", "PUT"] }`.

`$$` resolves to the current element being tested everywhere inside the `where` array, including inside `or`, `and`, and `not` blocks at any nesting depth.

Negation in `where` uses individual negation operators (`ne`, `notContains`, `notExists`, `notIn`, etc.) for simple cases. For negating a group of conditions, use a `not` block:

Simple negation (single assertion):

```json
{ "path": "$$.request.headers.x-internal", "operator": "notExists" }
```

Group negation with `not`:

```json
{
  "not": {
    "and": [
      { "path": "$$.request.method", "operator": "eq", "value": "POST" },
      {
        "path": "$$.request.url",
        "operator": "contains",
        "value": "/api/users"
      }
    ]
  }
}
```

A `not` block wraps a single where entry (assertion, `or`, or `and`) and inverts its result. `not` can nest inside `or`/`and` and vice versa.

#### Root-context references in `where` values

Where entry values support the same ValueRef form as standard assertions: `"value": { "from": "$.variables.userId" }`. The `from` path resolves against the root context, enabling filters like "match traffic where the response ID equals a previously extracted variable":

```json
{
  "where": [
    {
      "path": "$$.response.body.id",
      "operator": "eq",
      "value": { "from": "$.variables.expectedId" }
    }
  ]
}
```

#### `count` on match

Match supports an optional `count` field that asserts on the number of matched entries. This is sugar — it desugars into a standard count assertion on `$.matches`, but co-locates the cardinality expectation with the filter.

A number means `eq`:

```json
"match": { "path": "$.traffic", "where": [...], "count": 1 }
```

Object form for other operators:

```json
"match": { "path": "$.traffic", "where": [...], "count": { "operator": "gte", "value": 2 } }
```

When `count` on match fails, the error includes the full match context:

> `match count failed: expected exactly 1 entry matching {path: $.traffic, where: [origin eq "api-gateway", method eq "POST", url contains "/api/users"]}, found 3`

Both `count` on match and the `count` assertion shorthand (`{ "count": "$.matches", ... }`) are supported. Use `count` on match for the common case; use the assertion shorthand when asserting count of a different source (e.g., `as`-named results from a previous match).

#### Match results

When a match block filters, the results are injected into the root context as:

- `$.matches` — array of all matched documents
- `$.match` — shorthand for `$.matches[0]` (the first match)
- `$.lastMatch` — shorthand for the last element of `$.matches`

These keys are scoped to the block that produced them. When a nested block runs its own match (e.g., a match inside a forEach that itself iterates over outer match results), the inner match pushes new values for `$.matches`/`$.match`/`$.lastMatch`. When the inner block completes, the outer match's values are restored. This is stack-based: each match pushes, each block exit pops.

`$.matches`/`$.match`/`$.lastMatch` do not persist to subsequent blocks or steps — they are always cleared when the block that set them completes.

Example — nested match with stack behavior:

```json
{
  "match": {
    "path": "$.traffic",
    "where": [
      { "path": "$$.request.method", "operator": "eq", "value": "POST" }
    ],
    "as": "postRequests"
  },
  "forEach": {
    "items": "$.variables.postRequests",
    "as": "entry",
    "match": {
      "path": "$.dbLogs",
      "where": [
        { "path": "$$.query", "operator": "contains", "value": "INSERT" }
      ]
    },
    "assertions": [{ "path": "$.match.query", "operator": "exists" }]
  }
}
```

In this example, the outer match populates `$.matches` with POST traffic and saves to `postRequests`. The inner match (per iteration) pushes new `$.matches`/`$.match` with the matching DB logs. When each inner block completes, the outer match's `$.matches`/`$.match` are restored. The `as`-named `postRequests` variable is unaffected by inner match scoping — it persists for the remainder of the step.

#### Optional `as` on match

Match supports an optional `as` key that saves the matches array to `$.variables.<name>`, accessible via `$.variables.<name>` in paths and `{{name}}` in interpolation:

```json
{
  "match": {
    "path": "$.traffic",
    "where": [ ... ],
    "as": "postRequests"
  },
  "assertions": [
    { "count": "$.variables.postRequests", "operator": "eq", "value": 1 },
    { "path": "$.variables.postRequests[0].response.status", "operator": "eq", "value": 201 }
  ]
}
```

`$.matches`/`$.match`/`$.lastMatch` are always populated by the most recent match (overwriting any previous values) and cleared after the block completes. `as`-named variables persist for the remainder of the step, the same as other variables — they are not block-scoped.

This asymmetry is intentional: `$.match` is "current match context" (ephemeral, scoped to the block), while `as` is "save this for later" (persistent, survives across blocks). If `as` were block-scoped, it would be redundant with `$.match`. Use `as` when nesting matches or when you need to reference results from a previous match block.

#### `path` on match

Required. In practice this will almost always be `$.traffic`, but the design is general — it works on any array in the root context (`$.consoleLogs`, `$.dbLogs`, or any array extracted into variables).

#### `where` on match

Optional. If `where` is omitted, all elements in the source array are included (no filtering). This is useful for asserting on the total count of an array:

```json
"match": { "path": "$.traffic", "count": 5 }
```

When `where` is present, it must be a non-empty array. An empty `where: []` is a validation error — omit `where` entirely to match all elements.

#### Empty matches behavior

If the match filter finds zero entries, `$.matches` is an empty array, and `$.match` / `$.lastMatch` are null. Any assertion referencing `$.match.*` or `$.lastMatch.*` must fail with a clear, actionable error — not a generic "path not found" but something like: `"no traffic matched {where criteria} — $.match is null"`. The error should include the filter criteria so the user knows exactly what filter produced zero results.

#### Timeline indices on traffic entries

Each entry in `$.traffic` includes `requestTimelineIndex` and `responseTimelineIndex` — the entry's position in the current step's chronologically sorted `$.timeline` array. These are step-scoped indices (both `$.traffic` and `$.timeline` are filtered to the current step's time window). Cross-step ordering is implicit — steps execute sequentially. `responseTimelineIndex` is `null` for requests that have not received a response (in-flight, timed out, or one-way). `requestTimelineIndex` is always present.

This enables ordering assertions without new operators:

```json
{
  "path": "$.matches[0].requestTimelineIndex",
  "operator": "lt",
  "value": { "from": "$.matches[1].requestTimelineIndex" }
}
```

### 3. Remove `.length` from path resolution; add negative indexing

`EvaluateDocPath` no longer special-cases `"length"` as a path segment. Paths are pure data access — dot segments resolve object keys, bracket segments resolve array indices. Nothing else.

Length (and other derived values) are accessed through transforms (see below).

**Negative indexing:** Array bracket access supports negative indices. `$.arr[-1]` resolves to the last element, `$.arr[-2]` to the second-to-last, etc. This applies anywhere bracket indexing works — `$.matches[-1]`, `$.response.body.items[-1]`, etc.

### 4. Assertion source resolution

An assertion resolves a value from the root context, then compares it with `operator`/`value`. The resolution source is specified by one of the following mutually exclusive fields:

#### `path` — direct value (string or object form)

String form resolves the path and uses the value directly:

```json
{ "path": "$.response.status", "operator": "eq", "value": 200 }
```

Object form resolves a path and applies a transform:

```json
{
  "path": { "from": "$.response.body.users", "transform": "length" },
  "operator": "gte",
  "value": 1
}
```

#### Transform shorthands

Each transform has a top-level shorthand that replaces `path`. These are sugar for the object form with the corresponding `transform`:

| Shorthand | Equivalent `path` object                    | Example                                                                                                  |
| --------- | ------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `count`   | `{ "from": "...", "transform": "length" }`  | `{ "count": "$.matches", "operator": "gte", "value": 2 }`                                                |
| `type`    | `{ "from": "...", "transform": "type" }`    | `{ "type": "$.val", "operator": "eq", "value": "string" }`                                               |
| `keys`    | `{ "from": "...", "transform": "keys" }`    | `{ "keys": "$.response.body", "operator": "contains", "value": "id" }`                                   |
| `values`  | `{ "from": "...", "transform": "values" }`  | `{ "values": "$.response.body", "operator": "contains", "value": "Alice" }`                              |
| `entries` | `{ "from": "...", "transform": "entries" }` | `{ "entries": "$.response.body", "operator": "contains", "value": { "key": "name", "value": "Alice" } }` |

All shorthands accept a string (path to resolve). The assertion object must have exactly one source field (`path`, `count`, `type`, `keys`, `values`, or `entries`).

Note: `count` appears in three contexts with different roles. As an **assertion source field**, it is a shorthand for `transform: "length"` (e.g., `{ "count": "$.matches", "operator": "gte", "value": 2 }`). As a **field on match**, it asserts the cardinality of the matched results (e.g., `"count": 1`). As a **field on `repeat`**, it specifies the number of iterations (e.g., `"count": 3`). These are distinct: each lives on a different parent object (assertion, match, repeat loop).

#### `value` — the comparison target

`value` accepts a literal (current behavior) or an object with `from` + optional `transform` to resolve from the document.

`from` must be a `$.`-prefixed path (e.g., `"from": "$.traffic[1].request.body"`). If `value` is an object but does not contain a `from` key starting with `$.`, it is treated as a literal value. The `$.` prefix (with the dot) is required to avoid false positives — a literal value like `{ "from": "$50", "amount": 500 }` is correctly treated as a literal object, not a document-path reference.

Literal:

```json
{ "path": "$.response.status", "operator": "eq", "value": 200 }
```

Document path:

```json
{
  "path": "$.traffic[0].request.body",
  "operator": "eq",
  "value": { "from": "$.traffic[1].request.body" }
}
```

Document path with transform:

```json
{
  "path": { "from": "$.response.body.users", "transform": "length" },
  "operator": "eq",
  "value": { "from": "$.response.body.roles", "transform": "length" }
}
```

#### Evaluation pipeline

1. Resolve the source (`path`, `count`, `type`, `keys`, `values`, or `entries`) against the root context
2. If the source is an object with `transform`, or a transform shorthand, apply the transform
3. Resolve `value` — if it's an object with a `$.`-prefixed `from` key, resolve and optionally transform; otherwise use as-is (literal)
4. Compare with `operator`

**Transform errors:** If a transform receives the wrong input type, it must fail with a clear error describing the type mismatch — not silently return null. Specific cases:

- `length` on a number, boolean, object, or null → error
- `keys`, `values`, `entries` on a non-object (including array) → error
- `type` accepts any input (never errors)

#### Supported transforms

| Transform | Input        | Output                                                                           |
| --------- | ------------ | -------------------------------------------------------------------------------- |
| `length`  | array/string | numeric length                                                                   |
| `type`    | any          | type label: `"string"`, `"number"`, `"boolean"`, `"array"`, `"object"`, `"null"` |
| `keys`    | object       | sorted array of key names                                                        |
| `values`  | object       | array of values (in sorted key order)                                            |
| `entries` | object       | array of `{ "key": "...", "value": ... }` objects                                |

### 5. Remove `count` as a standalone block field

The `count` field on assertion blocks (the sibling key to `match` and `assertions`) is removed. Count validation is expressed in two ways:

**`count` on match** (preferred for match cardinality):

```json
"match": { "path": "$.traffic", "where": [...], "count": 1 }
```

**`count` assertion shorthand** (for non-match arrays or `as`-named results):

```json
{ "count": "$.variables.postRequests", "operator": "gte", "value": 2 }
```

### 6. Remove `assertionScope`

The `assertionScope` field (`all`, `first`, `last`, `any`) is removed. With `$.matches` as an array on the root document, users express scope through paths and loops:

| Old `assertionScope`        | New equivalent                                                                    |
| --------------------------- | --------------------------------------------------------------------------------- |
| `"first"` (or single-match) | `$.match.*`                                                                       |
| `"last"`                    | `$.lastMatch.*` or `$.matches[-1].*`                                              |
| `"all"`                     | forEach over `$.matches`                                                          |
| `"any"`                     | not needed — `where` is expressive enough to filter to the exact entries you want |

`$.match` covers the most common case (single expected match). For multi-match scenarios, forEach over `$.matches` composes naturally with the loop system.

### 7. Remove `consoleAssertions` field and `service` field

The `consoleAssertions` field on assertion blocks is removed. Console log filtering uses the same `match.where` pattern as everything else:

```json
{
  "match": {
    "path": "$.consoleLogs",
    "where": [
      { "path": "$$.service", "operator": "eq", "value": "user-service" },
      { "path": "$$.level", "operator": "eq", "value": "ERROR" },
      { "path": "$$.message", "operator": "contains", "value": "timeout" }
    ],
    "count": 0
  }
}
```

Example — asserting on matched console log content:

```json
{
  "match": {
    "path": "$.consoleLogs",
    "where": [
      { "path": "$$.service", "operator": "eq", "value": "payment-service" },
      { "path": "$$.level", "operator": "eq", "value": "INFO" },
      {
        "path": "$$.message",
        "operator": "contains",
        "value": "charge completed"
      }
    ],
    "count": 1
  },
  "assertions": [
    {
      "path": "$.match.message",
      "operator": "contains",
      "value": "{{orderId}}"
    }
  ]
}
```

The `service` field on assertion blocks (used to filter traffic by service name) is also removed — subsumed by `$$.origin` in a `where` filter.

### 8. Loops nest their content

Loops (`forEach`, `for`, `repeat`) are no longer inline modifiers. The loop body is nested inside the loop object. The body's shape matches the level it wraps:

- **Step-level loop body** — can contain `action`, `match`, `assertions`, `extract`, nested loops
- **Assertion-level loop body** — can contain `match`, `assertions`, `extract`, nested loops. No `action`.
- **Test-level loop body** — contains `steps` array

`$$` is **not** used in loops — `$$` refers to the element being tested by a filter, which is internal to the match engine. Loops iterate over already-resolved values and bind them to named variables via `as`, so the variable name is the reference. Loops use `as` (required) and `name` (optional) as they do today.

#### forEach (nested)

Before (inline modifier):

```json
{
  "forEach": { "items": "$.matches", "as": "entry" },
  "assertions": [
    {
      "path": "$.variables.entry.response.status",
      "operator": "eq",
      "value": 200
    }
  ]
}
```

After (nested content):

```json
{
  "forEach": {
    "items": "$.matches",
    "as": "entry",
    "assertions": [
      {
        "path": "$.variables.entry.response.status",
        "operator": "eq",
        "value": 200
      }
    ]
  }
}
```

#### Match inside a loop

```json
{
  "forEach": {
    "items": "$.variables.endpoints",
    "as": "endpoint",
    "match": {
      "path": "$.traffic",
      "where": [
        {
          "path": "$$.request.url",
          "operator": "contains",
          "value": "{{endpoint}}"
        }
      ],
      "count": { "operator": "gte", "value": 1 }
    },
    "assertions": [
      { "path": "$.match.response.status", "operator": "eq", "value": 200 }
    ]
  }
}
```

#### Loop inside a match

```json
{
  "match": {
    "path": "$.traffic",
    "where": [
      { "path": "$$.request.method", "operator": "eq", "value": "POST" }
    ]
  },
  "forEach": {
    "items": "$.matches",
    "as": "entry",
    "assertions": [
      {
        "path": "$.variables.entry.response.status",
        "operator": "lt",
        "value": 400
      }
    ]
  }
}
```

#### Nested loops

```json
{
  "forEach": {
    "items": "$.variables.users",
    "as": "user",
    "forEach": {
      "items": "$.variables.user.roles",
      "as": "role",
      "assertions": [
        { "path": "$.variables.role", "operator": "ne", "value": "admin" }
      ]
    }
  }
}
```

#### `for` and `repeat` (same pattern)

```json
{
  "for": {
    "from": 0,
    "to": 5,
    "as": "i",
    "action": {
      "type": "httpRequest",
      "method": "GET",
      "url": "api/items/{{i}}"
    },
    "assertions": [
      { "path": "$.response.status", "operator": "eq", "value": 200 }
    ]
  }
}
```

```json
{
  "repeat": {
    "count": 3,
    "as": "attempt",
    "until": [{ "path": "$.response.status", "operator": "eq", "value": 200 }],
    "action": { "type": "httpRequest", "method": "GET", "url": "api/health" }
  }
}
```

`repeat.until` accepts standard assertions — the same struct as everywhere else, including transform shorthands and object-form `path`/`value`. For example: `"until": [{ "count": "$.matches", "operator": "gte", "value": 1 }]`.

#### Test-level loop

The loop body contains a `steps` array, matching the level it wraps:

```json
{
  "forEach": {
    "items": "{{users}}",
    "as": "user",
    "steps": [
      {
        "action": {
          "type": "httpRequest",
          "method": "POST",
          "url": "api/users",
          "body": { "name": "{{user.name}}" }
        }
      },
      {
        "assertions": [
          { "path": "$.response.status", "operator": "eq", "value": 201 }
        ]
      }
    ]
  }
}
```

#### Execution order within a block

When `match`, loops, `assertions`, and `extract` coexist on the same object, execution order is:

1. `match` runs first (populates `$.matches`/`$.match`/`$.lastMatch`)
2. Loop runs (if present), with its nested body (each iteration runs the full execution order recursively)
3. `assertions` run (against root context with match results available)
4. `extract` runs last (only if all assertions passed)

If a loop is present alongside assertions, the assertions outside the loop run after the loop completes. Assertions inside the loop body run per iteration. Extract inside a loop body runs per iteration.

This order applies recursively at each nesting level. A forEach body with its own match, assertions, and extract follows the same 1-2-3-4 sequence per iteration.

One loop per nesting level — `forEach`/`for`/`repeat` are mutually exclusive on the same object.

#### Extract in loops

Extract inside a loop body runs per iteration. Extract keys support `{{var}}` interpolation, allowing dynamic variable names. The loop executor injects an `index` property (zero-based iteration index) on the `as` variable for each iteration, so `{{entry.index}}` resolves to `0`, `1`, etc.:

```json
{
  "forEach": {
    "items": "$.matches",
    "as": "entry",
    "assertions": [
      {
        "path": "$.variables.entry.response.status",
        "operator": "eq",
        "value": 200
      }
    ],
    "extract": {
      "userId_{{entry.index}}": "$.variables.entry.response.body.id"
    }
  }
}
```

Without dynamic keys, extract in a loop overwrites the same variable each iteration — only the last iteration's value survives. Dynamic keys make extract in loops useful for collecting per-iteration values.

Extract paths in a match block resolve against the root context (same as assertions). `"userId": "$.response.body.id"` must become `"userId": "$.match.response.body.id"`.

### Full before/after example

Before:

```json
{
  "match": {
    "origin": "api-gateway",
    "method": "POST",
    "url": "user-service/api/users"
  },
  "count": { "operator": "eq", "value": 1 },
  "assertionScope": "first",
  "assertions": [
    { "path": "$.request.body.email", "operator": "eq", "value": "{{email}}" },
    { "path": "$.response.status", "operator": "eq", "value": 201 }
  ]
}
```

After:

```json
{
  "match": {
    "path": "$.traffic",
    "where": [
      { "path": "$$.origin", "operator": "eq", "value": "api-gateway" },
      { "path": "$$.request.method", "operator": "eq", "value": "POST" },
      {
        "path": "$$.request.url",
        "operator": "contains",
        "value": "/api/users"
      }
    ],
    "count": 1
  },
  "assertions": [
    {
      "path": "$.match.request.body.email",
      "operator": "eq",
      "value": "{{email}}"
    },
    { "path": "$.match.response.status", "operator": "eq", "value": 201 }
  ]
}
```

Example — filtering on response (previously impossible):

```json
{
  "match": {
    "path": "$.traffic",
    "where": [
      { "path": "$$.request.method", "operator": "eq", "value": "POST" },
      {
        "path": "$$.request.url",
        "operator": "contains",
        "value": "/api/users"
      },
      { "path": "$$.response.status", "operator": "eq", "value": 201 }
    ],
    "count": { "operator": "gte", "value": 1 }
  },
  "assertions": [{ "path": "$.match.response.body.id", "operator": "exists" }]
}
```

## Operator Cleanup

### Remove `length` operator

The `length` assertion operator is redundant with the `count` shorthand / `transform: "length"`. Remove it.

### Remove `type` operator

The `type` assertion operator is redundant with the `type` shorthand / `transform: "type"`. With the shorthand, `type` checks compose with any operator (`eq`, `ne`, `in`), making a dedicated `type` operator unnecessary.

Before:

```json
{ "path": "$.val", "operator": "type", "value": "string" }
```

After (equivalent options):

```json
{ "type": "$.val", "operator": "eq", "value": "string" }
{ "type": "$.val", "operator": "ne", "value": "string" }
{ "type": "$.val", "operator": "in", "value": ["string", "number"] }
```

### Unify `contains` / `arrayContains`

Currently three separate operators exist:

- `contains` / `notContains` — string substring match
- `arrayContains` / `arrayNotContains` — array element membership
- (no `objContains` exists)

These should be unified into `contains` / `notContains` that dispatch based on the type of the actual value:

| Actual type | `contains` behavior |
| ----------- | ------------------- |
| string      | substring match     |
| array       | element membership  |
| object      | key membership      |

For any other actual type (`number`, `boolean`, `null`), `contains` fails with a type error — not a silent false. The error should name the actual type and suggest the correct approach. This catches cases where a path resolves to an unexpected type rather than silently passing or failing.

This cuts four operators to two, removes the need for users to pick the right variant, and adds object key checking for free.

`containsIgnoreCase` / `notContainsIgnoreCase` remain string-only (case comparison doesn't apply to arrays/objects). If the actual value is not a string, these operators fail with a type error.

Note: `arrayContains` / `arrayNotContains` predate this branch. This cleanup can ship alongside or independently.

## Scope of Changes

### Code changes (test-agent, Go)

- **`assertion_engine.go`**
  - `EvaluateDocPath`: remove `.length` special case; add negative indexing support for array brackets; add `$$` resolution (resolve against scoped iterator context when path starts with `$$`)
  - `CompareValues`: remove `length`, `type`, `arrayContains`, `arrayNotContains` operators; update `contains`/`notContains` to dispatch on type
  - `ValidateAssertion`: support transform shorthands (`count`, `type`, `keys`, `values`, `entries`) as alternative source fields; support object form for `path` and `value` with `from`/`transform`
- **`block_validators.go`**
  - `ValidateHttpCallBlock`: rewrite match logic — iterate over `match.path` source array, run `match.where` assertions against each element using `$$` scoping (with recursive `or`/`and`/`not` support), collect passing elements as `matches`. Inject `$.matches`, `$.match`, `$.lastMatch` into root context with stack-based push/pop for nested matches. If `as` is set, also save to `$.variables.<name>`. Desugar `count` on match into a count assertion before running assertions. Remove block-level `count`, `assertionScope`, and per-log document assembly. Remove `ValidateSelfBlock` — all blocks run assertions against root context.
  - `ValidateConsoleLogBlock`: remove entirely — console log filtering uses the same `match.where` pattern.
- **`document_assembler.go`** — Add `requestTimelineIndex`/`responseTimelineIndex` to traffic entries. Add helper to inject `matches`/`match`/`lastMatch` keys into root context.
- **`step_validator.go`** — Remove self-block vs match-block distinction. All assertion blocks run against root context. Update extract logic in match blocks to resolve against root context. Support `{{var}}` interpolation in extract keys for dynamic variable names in loops.
- **`loop_executor.go`** — Restructure loop execution to support nested body content. Loop body becomes a context-aware execution scope (step-level body allows actions; assertion-level body does not). Remove inline loop modifier pattern.
- **`step_runner.go`** — Remove step-level and action-level loop modifier detection (`getStepLoop`, `getActionLoop`). Loops are now explicit nested structures within the step definition.

### Code changes (definition-validator, TypeScript)

- **`validate-assertions.ts`** — Support transform shorthands and object form for `path`/`value`. Remove block-level `count`, `assertionScope`, `consoleAssertions`, `service`, `length` operator, `type` operator validation. Update `contains` validation. Add `from`/`transform` field validation. Validate `from` has `$.`-prefixed path (with the dot, not just `$`). Validate new `match` structure: require `path` (string), validate optional `where` (non-empty array of assertion objects with `$$`-prefixed paths, with recursive `or`/`and`/`not` support). Validate optional `count` on match (number or `{operator, value}` object). Validate optional `as` on match. Validate `$$` is only used inside `where` context.
- **`validate-loops.ts`** — Restructure loop validation for nested body content. Loop body validated recursively — step-level bodies allow `action`, assertion-level bodies do not, test-level bodies contain `steps`. Remove inline loop modifier validation from step/action/assertion-block levels. Remove forEach+match mutual exclusion check (nesting makes this composable).

### Definition file changes

All `.dokkimi/` definition files need migration:

Loop restructuring:

- Inline loop modifiers (`forEach`/`for`/`repeat` as sibling keys) → nested loop objects with body content inside
- Step-level and action-level loop modifiers → nested loop at appropriate level
- Test-level loop modifiers → nested loop with `steps` array

Match block migration:

- `match: { origin, method, url }` → `match: { path: "$.traffic", where: [...] }` with `$$`-prefixed assertion paths
- `$.response.*` in match-block assertions → `$.match.response.*`
- `$.request.*` in match-block assertions → `$.match.request.*`
- `$.responseTime` in match-block assertions → `$.match.responseTime`
- `count` blocks → `count` on match (e.g., `"count": 1`) or `{ "count": "$.matches", ... }` assertion
- `assertionScope` → remove (use `$.match`, `$.lastMatch`, or forEach over `$.matches`)
- Extract rules inside match blocks: `$.response.*` → `$.match.response.*`

Console log / service migration:

- `consoleAssertions` with `service`/`level`/`message` → `match: { path: "$.consoleLogs", where: [...] }` + regular `assertions`
- `service` field on assertion blocks → `$$.origin` in match `where`

Other assertion migrations:

- `$.x.y.length` → `{ "count": "$.x.y", ... }` or `{ "path": { "from": "$.x.y", "transform": "length" }, ... }`
- `{ "operator": "type", ... }` → `{ "type": "$.x.y", "operator": "eq", ... }`
- `arrayContains` → `contains`
- `arrayNotContains` → `notContains`

### Documentation changes

Primary reference:

- **`shared/docs/dokkimi-instructions.md`** — Update assertion block section, assertion paths table, match block examples, operator table, remove count/assertionScope/consoleAssertions/service docs, add source resolution and transform docs, add negative indexing, add `$$` and `where` docs, add `or` in `where`, add `as` on match, update loop docs for nested structure

Design docs (superseded — add "superseded by consistent-root-document.md" note):

- **`docs/implemented/DESIGN-unified-root-context.md`** — Root context assembly; superseded by `$.match`/`$.matches` injection and `$$` scoping
- **`docs/implemented/DESIGN-loops.md`** — Loop design; superseded by nested loop structure
- **`docs/implemented/DESIGN-inline-validation.md`** — References `assertionScope` and `consoleAssertions`

npm/CLI:

- **`scripts/npm-readme.md`** — Update match block example

Astro doc pages:

- **`apps/landing/src/pages/docs/assertions.astro`** — Assertion syntax, operators, match blocks, transforms, `$$`/`where`
- **`apps/landing/src/pages/docs/loops.astro`** — Nested loop structure, forEach/for/repeat body content
- **`apps/landing/src/pages/docs/tests-and-steps.astro`** — Step-level assertion blocks, match blocks within steps

Astro blog posts (contain removed concepts):

- **`apps/landing/src/content/blog/posted/03-how-traffic-interception-works.md`** — Uses `consoleAssertions`, per-log `$` paths in match blocks
- **`apps/landing/src/content/blog/posted/10-console-log-assertions.md`** — Heavily uses `consoleAssertions`; needs full rewrite to use `match: { path: "$.consoleLogs", where: [...] }` pattern

Astro tutorials (contain removed concepts):

- **`apps/landing/src/content/tutorials/posted/04-testing-llm-integrations.md`** — Uses `assertionScope`, `arrayContains`, `consoleAssertions`

VSCode extension:

- **`apps/vscode`** — Update autocomplete, snippets, and validation for new match structure, `$$`, removed fields/operators

Build artifacts (regenerated from source — no manual edits, but verify after build):

- `.publish-staging/shared/docs/dokkimi-instructions.md`
- `.publish-staging/apps/cli/dist/dokkimi-instructions.md`
- `apps/cli/dist/dokkimi-instructions.md`

## Migration Path

This is a breaking change. Since Dokkimi is greenfield with no backwards compatibility requirement, all changes ship at once:

1. Update `EvaluateDocPath` — remove `.length` special case, add negative indexing, add `$$` resolution
2. Add `requestTimelineIndex`/`responseTimelineIndex` to traffic entry assembly
3. Update assertion engine — support transform shorthands and object form for `path`/`value`
4. Update `CompareValues` — remove `length`/`type`/`arrayContains`/`arrayNotContains`, unify `contains`
5. Rewrite match logic — implement `where`-based filtering with `$$` scoping and recursive `or`/`and`/`not` support, inject `$.matches`/`$.match`/`$.lastMatch` with stack-based push/pop, desugar `count` on match, support optional `as`
6. Remove self-block concept — unify all assertion blocks against root context
7. Remove `count` block, `assertionScope`, `consoleAssertions`, `service` fields
8. Restructure loop execution — nested body content, context-aware validation, remove inline modifier pattern
9. Update definition validator (match, loops, transforms, `or`/`and`/`not`, `as`, dynamic extract keys)
10. Update all definition files (match blocks, extract paths, console log assertions, loop restructuring)
11. Update all documentation
12. Ship as a single release
