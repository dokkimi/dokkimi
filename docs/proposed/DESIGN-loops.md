# Design: Loop Support in Test Definitions

## Problem

Test definitions today are purely sequential. There is no way to repeat steps, iterate over data, or loop over numeric ranges. Users who need to poll an eventually-consistent endpoint, test multiple inputs, or iterate over extracted arrays must copy-paste steps manually.

## Proposal

Add three loop modifiers — `forEach`, `for`, and `repeat` — as optional fields that can attach to any level of the definition hierarchy. They are not new action types or wrapper constructs. They are modifiers that mean "do this thing more than once."

No `if`/`else` or branching logic. Loops only.

---

## Core Concept

A loop modifier is an optional field on an existing definition object. When present, the test-agent checks for it before executing the object's normal behavior, and iterates accordingly.

The same three modifiers work at every level of the hierarchy:

| Level               | What gets repeated                                                   |
| ------------------- | -------------------------------------------------------------------- |
| **Test**            | All steps in the test                                                |
| **Step**            | The action + extract + assertions                                    |
| **Action**          | Just the action (extract + assertions run once after all iterations) |
| **Assertion block** | The assertions per array element                                     |
| **UI sub-step**     | The UI interaction(s)                                                |

The modifiers are mutually exclusive — a given object can have at most one of `forEach`, `for`, or `repeat`.

---

## The Three Modifiers

### `forEach` — iterate over data

Iterate over an array, running the attached object once per item.

| Field     | Type            | Required | Description                                                                                                                                                                                                      |
| --------- | --------------- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `items`   | array \| string | Yes      | Inline array, `"{{varName}}"` referencing an extracted array, or a `$` path (assertion level only — resolves against the root context, e.g., `"$.response.body"`, `"$.request.body.users"`, `"$.response.data"`) |
| `as`      | string          | Yes      | Variable name for the current item and loop namespace                                                                                                                                                            |
| `delayMs` | integer         | No       | Pause between iterations (default 0)                                                                                                                                                                             |

**Variables set per iteration:**

| Variable           | Type    | Description               |
| ------------------ | ------- | ------------------------- |
| `{{<as>}}`         | any     | The current item          |
| `{{<as>.__index}}` | integer | 0-based iteration counter |
| `{{<as>.__items}}` | array   | The full items array      |

**Semantics:**

- If `items` is a string (`"{{varName}}"`), the variable must resolve to an array at loop entry.
- If `items` resolves to an empty array, the loop body is skipped entirely (zero iterations, no error).

---

### `for` — iterate over a numeric range

Iterate from one number to another with a configurable step.

| Field     | Type    | Required | Description                                                                                |
| --------- | ------- | -------- | ------------------------------------------------------------------------------------------ |
| `from`    | integer | Yes      | Start value (inclusive)                                                                    |
| `to`      | integer | Yes      | End value (inclusive)                                                                      |
| `step`    | integer | No       | Increment per iteration (default 1). Can be negative for descending ranges. Must not be 0. |
| `as`      | string  | Yes      | Variable name for the current range value and loop namespace                               |
| `delayMs` | integer | No       | Pause between iterations (default 0)                                                       |

**Variables set per iteration:**

| Variable           | Type    | Description                                                     |
| ------------------ | ------- | --------------------------------------------------------------- |
| `{{<as>}}`         | integer | Current value in the range (from, from+step, from+2\*step, ...) |
| `{{<as>.__index}}` | integer | 0-based iteration counter (0, 1, 2, ...)                        |

**Validation rules:**

- If `step` is positive (or omitted), `from` must be <= `to`.
- If `step` is negative, `from` must be > `to`.
- `step: 0` is an error.
- `from == to` is valid — produces exactly 1 iteration.

---

### `repeat` — while loop with safety cap

Repeat up to `count` times, optionally stopping early when a condition is met.

| Field     | Type        | Required | Description                                                        |
| --------- | ----------- | -------- | ------------------------------------------------------------------ |
| `count`   | integer     | Yes      | Max iterations (safety cap)                                        |
| `as`      | string      | Yes      | Variable name for the current iteration counter and loop namespace |
| `delayMs` | integer     | No       | Pause between iterations (default 0)                               |
| `until`   | assertion[] | No       | Stop early when all assertions pass                                |

**Variables set per iteration:**

| Variable   | Type    | Description               |
| ---------- | ------- | ------------------------- |
| `{{<as>}}` | integer | 0-based iteration counter |

**Semantics:**

- Without `until`: runs exactly `count` times.
- With `until`: runs up to `count` times. The `until` check runs after each iteration completes, so the loop always executes at least once. `until` is evaluated independently of `stopOnFailure` — it controls loop termination, not pass/fail. If an iteration's assertions fail but `until` passes, the loop stops (the `until` condition was met). If `stopOnFailure` is `false`, assertion failures are collected but don't prevent `until` evaluation.
- `until` is an array of assertions using the same individual assertion shape (`path`, `operator`, `value`). All must pass for the loop to stop.
- No `break` on `forEach` or `for`. Those iterate a known space; early exit is conditional logic. If you need "iterate until you find X," use `repeat` with `until`.

---

## `until` Assertion Scope

The `until` assertions evaluate against different documents depending on what the loop is attached to:

| Loop level                            | `until` evaluates against                                                                                                                        |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Action** (`httpRequest`)            | The root context (`$.response.status`, `$.response.body.*`, etc.)                                                                                |
| **Action** (`dbQuery`)                | The root context (`$.response.success`, `$.response.data[*].*`, etc.)                                                                            |
| **Step** with an `httpRequest` action | The root context (`$.response.status`, `$.response.body.*`, etc.)                                                                                |
| **Step** with a `dbQuery` action      | The root context (`$.response.success`, `$.response.data[*].*`, etc.)                                                                            |
| **Step** with a `ui` action           | Variable interpolation in `path` and `value` — e.g., `"path": "{{hasMore}}", "operator": "eq", "value": false`                                   |
| **UI sub-step group**                 | Same as above — use `{{varName}}` to reference extracted variables                                                                               |
| **Step** with a `parallel` action     | Not applicable — `until` has no single response to evaluate. Use `repeat` without `until` for simple count-based repetition of parallel actions. |
| **Step** with a `wait` action         | Not applicable — `wait` produces no response. Use `repeat` without `until`.                                                                      |
| **Test**                              | The last step's response document from the most recent iteration                                                                                 |

---

## Interaction with `stopOnFailure`

`stopOnFailure` applies **per-iteration**. If a loop iteration's assertions fail and `stopOnFailure` is `true` (the default), the loop terminates immediately — remaining iterations are skipped. The step is marked as failed.

If `stopOnFailure` is `false`, the loop continues to the next iteration despite assertion failures. All failures are collected and reported.

This is consistent with how `stopOnFailure` already works for sequential steps — it just extends to iterations within a loop.

---

## Interaction with `extract`

**Inside the loop body:** Extract rules write to the flat map using last-write-wins, same as every other extract. Each iteration overwrites the previous value.

**On the looped step itself (step-level `extract`):** When a step has a loop modifier, the step-level `extract` operates on the **last iteration's** response document.

```json
{
  "name": "Poll until done",
  "repeat": {
    "count": 20,
    "as": "attempt",
    "delayMs": 1000,
    "until": [
      { "path": "$.response.body.status", "operator": "eq", "value": "done" }
    ]
  },
  "action": {
    "type": "httpRequest",
    "method": "GET",
    "url": "order-service/api/orders/{{orderId}}"
  },
  "extract": {
    "finalStatus": "$.response.body.status"
  }
}
```

Here `finalStatus` is extracted from whichever iteration was last (either the one where `until` passed, or the `count`-th iteration).

**Path syntax:** All paths in this doc use the unified `$` root context syntax from `DESIGN-unified-root-context.md`. Extract and assertion paths both use `$.` prefix — `$.response.body.status` in extract, `$.response.body.status` in assertions. One path system everywhere.

### `transform` — converting objects to arrays for iteration

Extract currently supports two forms: a simple path string (`"varName": "$.response.body.field"`) and a regex object (`{ "path", "pattern", "group" }`). This design adds `transform` as an optional field on the object form, which converts an object into an array suitable for `forEach`.

`transform` can be used in two ways:

**With `path`** — transform an object from the response in one shot:

| Field       | Type   | Required | Description                                          |
| ----------- | ------ | -------- | ---------------------------------------------------- |
| `path`      | string | Yes      | Path to the source value (must resolve to an object) |
| `transform` | enum   | Yes      | `"keys"`, `"values"`, or `"entries"`                 |

**With `from`** — transform a variable that already exists in the context:

| Field       | Type   | Required | Description                                                         |
| ----------- | ------ | -------- | ------------------------------------------------------------------- |
| `from`      | string | Yes      | Variable reference (e.g., `"{{users}}"`) that resolves to an object |
| `transform` | enum   | Yes      | `"keys"`, `"values"`, or `"entries"`                                |

`transform` is mutually exclusive with `pattern`. `from` is mutually exclusive with `path`.

**What each transform produces:**

| Transform   | Input                | Output                                                     |
| ----------- | -------------------- | ---------------------------------------------------------- |
| `"keys"`    | `{ "a": 1, "b": 2 }` | `["a", "b"]`                                               |
| `"values"`  | `{ "a": 1, "b": 2 }` | `[1, 2]`                                                   |
| `"entries"` | `{ "a": 1, "b": 2 }` | `[{ "key": "a", "value": 1 }, { "key": "b", "value": 2 }]` |

If the source resolves to a non-object (array, string, number, null), it is a validation error.

**Example — `path` + `transform` (extract and transform from response):**

```json
{
  "name": "Get config and iterate its keys",
  "action": {
    "type": "httpRequest",
    "method": "GET",
    "url": "service-a/api/config"
  },
  "extract": {
    "config": "$.response.body.settings",
    "configKeys": { "path": "$.response.body.settings", "transform": "keys" }
  }
},
{
  "name": "Verify each setting exists in DB",
  "forEach": {
    "items": "{{configKeys}}",
    "as": "setting"
  },
  "action": {
    "type": "dbQuery",
    "database": "postgres-db",
    "query": "SELECT * FROM settings WHERE key = '{{setting}}'"
  },
  "assertions": [
    {
      "assertions": [
        { "path": "$.response.data[0].key", "operator": "eq", "value": "{{setting}}" }
      ]
    }
  ]
}
```

**Example — `from` + `transform` (transform an existing variable):**

When the object was extracted in a prior step and you need to iterate it later:

```json
{
  "name": "Get user metadata",
  "action": {
    "type": "httpRequest",
    "method": "GET",
    "url": "user-service/api/users/{{userId}}/metadata"
  },
  "extract": {
    "metadata": "$.response.body.metadata"
  }
},
{
  "name": "Transform metadata for iteration",
  "extract": {
    "metaPairs": { "from": "{{metadata}}", "transform": "entries" }
  }
},
{
  "name": "Log each metadata pair",
  "forEach": {
    "items": "{{metaPairs}}",
    "as": "meta"
  },
  "action": {
    "type": "httpRequest",
    "method": "POST",
    "url": "audit-service/api/log",
    "body": { "field": "{{meta.key}}", "value": "{{meta.value}}" }
  }
}
```

The `from` form is also valid at the test level, so you can derive variables before any steps run:

```json
{
  "name": "Validate all user fields",
  "extract": {
    "fieldNames": { "from": "{{userTemplate}}", "transform": "keys" }
  },
  "steps": [...]
}
```

This keeps `forEach` simple — it only knows about arrays — and puts object-to-array conversion in `extract` where data shaping already lives.

---

## Interaction with `parallel`

- **`parallel` action inside a loop body:** Allowed. A `forEach` step whose action is `type: parallel` works as expected — each iteration runs the parallel actions concurrently.
- **Loop inside a `parallel` action:** Not allowed. `parallel` is for simple concurrent actions, not orchestration.
- **Parallel loop iterations:** Not supported. Loop iterations always run sequentially. Running iterations concurrently would create race conditions with last-write-wins variable scoping and make `until`/`delayMs` semantics undefined. If you need concurrent requests, use the `parallel` action type directly.

---

## Error Handling

If an action **fails** during a loop iteration (e.g., network error, timeout, container crash), the loop terminates immediately regardless of `stopOnFailure`. The step is marked as failed. `stopOnFailure` controls what happens with assertion failures, not action execution errors.

For `repeat` with `until`: `completed` in the loop result document means "the `until` condition passed," not "ran without errors." If the loop terminates due to an action error, `completed` is `false`.

---

## Loop Result Document

All three modifiers expose a result document for step-level assertions:

```json
{
  "iterations": 5,
  "completed": true
}
```

| Field        | Type    | Description                                                                                          |
| ------------ | ------- | ---------------------------------------------------------------------------------------------------- |
| `iterations` | integer | How many times the loop actually ran                                                                 |
| `completed`  | boolean | `repeat` with `until`: did the condition pass? All other cases: `true` (unless terminated by error). |

This lets you catch cases like a poll that exhausted its retries:

```json
{
  "name": "Poll for completion",
  "repeat": {
    "count": 20,
    "as": "attempt",
    "delayMs": 1000,
    "until": [
      { "path": "$.response.body.status", "operator": "eq", "value": "done" }
    ]
  },
  "action": {
    "type": "httpRequest",
    "method": "GET",
    "url": "order-service/api/orders/{{orderId}}"
  },
  "assertions": [
    {
      "assertions": [{ "path": "$.completed", "operator": "eq", "value": true }]
    }
  ]
}
```

---

## Examples by Level

### Test level — multi-step loop body

A `forEach` on a test repeats all the test's steps for each item.

```json
{
  "tests": [
    {
      "name": "Verify order {{order.id}}",
      "forEach": {
        "items": "{{orders}}",
        "as": "order"
      },
      "steps": [
        {
          "name": "Poll until processed",
          "repeat": {
            "count": 15,
            "as": "attempt",
            "delayMs": 1000,
            "until": [
              {
                "path": "$.response.body.status",
                "operator": "ne",
                "value": "pending"
              }
            ]
          },
          "action": {
            "type": "httpRequest",
            "method": "GET",
            "url": "order-service/api/orders/{{order.id}}"
          }
        },
        {
          "name": "Verify final status",
          "action": {
            "type": "httpRequest",
            "method": "GET",
            "url": "order-service/api/orders/{{order.id}}"
          },
          "assertions": [
            {
              "assertions": [
                {
                  "path": "$.response.body.status",
                  "operator": "eq",
                  "value": "{{order.expected_status}}"
                }
              ]
            }
          ]
        }
      ]
    }
  ]
}
```

### Test level — run a test N times with a range

```json
{
  "tests": [
    {
      "name": "Load test batch {{batch}}",
      "for": {
        "from": 1,
        "to": 5,
        "as": "batch"
      },
      "steps": [
        {
          "name": "Submit batch",
          "action": {
            "type": "httpRequest",
            "method": "POST",
            "url": "batch-service/api/batches",
            "body": { "batchNumber": "{{batch}}" }
          },
          "assertions": [
            {
              "assertions": [
                { "path": "$.response.status", "operator": "eq", "value": 202 }
              ]
            }
          ]
        }
      ]
    }
  ]
}
```

### Action level — repeat the action, assert once after

A loop modifier on the action repeats just the action execution. Extract and assertions on the step run once after all iterations complete, against the last iteration's response. Loop modifiers on actions don't interact with extract — extract is a step-level concept that runs after the action (including all its iterations) completes.

```json
{
  "name": "Seed 10 users then verify count",
  "action": {
    "type": "httpRequest",
    "method": "POST",
    "url": "user-service/api/users",
    "body": { "name": "test-user-{{i}}" },
    "for": { "from": 1, "to": 10, "as": "i" }
  },
  "assertions": [
    {
      "assertions": [
        { "path": "$.response.status", "operator": "eq", "value": 201 }
      ]
    }
  ]
}
```

Compare with the same loop at step level — where assertions run per iteration:

```json
{
  "name": "Create user {{i}} and verify each",
  "for": { "from": 1, "to": 10, "as": "i" },
  "action": {
    "type": "httpRequest",
    "method": "POST",
    "url": "user-service/api/users",
    "body": { "name": "test-user-{{i}}" }
  },
  "assertions": [
    {
      "assertions": [
        { "path": "$.response.status", "operator": "eq", "value": 201 }
      ]
    }
  ]
}
```

### Action level — forEach to fire multiple requests

```json
{
  "name": "Notify all subscribers",
  "action": {
    "type": "httpRequest",
    "method": "POST",
    "url": "notification-service/api/notify",
    "body": { "userId": "{{sub.id}}", "message": "Update available" },
    "forEach": {
      "items": "{{subscribers}}",
      "as": "sub",
      "delayMs": 100
    }
  },
  "extract": {
    "lastNotifyResponse": "$.response.body"
  }
}
```

Here `extract` runs once after all notifications are sent, pulling from the last response.

### Step level — forEach with extracted data

```json
{
  "name": "Get all users",
  "action": {
    "type": "dbQuery",
    "database": "postgres-db",
    "query": "SELECT id, email FROM users"
  },
  "extract": {
    "users": "$.response.data"
  }
},
{
  "name": "Verify API returns each user",
  "forEach": {
    "items": "{{users}}",
    "as": "user"
  },
  "action": {
    "type": "httpRequest",
    "method": "GET",
    "url": "user-service/api/users/{{user.id}}"
  },
  "assertions": [
    {
      "assertions": [
        { "path": "$.response.status", "operator": "eq", "value": 200 },
        { "path": "$.response.body.email", "operator": "eq", "value": "{{user.email}}" }
      ]
    }
  ]
}
```

### Step level — forEach with inline data (data-driven testing)

```json
{
  "name": "Reject {{input.email}}",
  "forEach": {
    "items": [
      { "email": "", "expectedError": "Email required" },
      { "email": "not-an-email", "expectedError": "Invalid email" },
      { "email": "a@b", "expectedError": "Invalid domain" }
    ],
    "as": "input"
  },
  "action": {
    "type": "httpRequest",
    "method": "POST",
    "url": "user-service/api/users",
    "body": { "email": "{{input.email}}" }
  },
  "assertions": [
    {
      "assertions": [
        { "path": "$.response.status", "operator": "eq", "value": 400 },
        {
          "path": "$.response.body.error",
          "operator": "contains",
          "value": "{{input.expectedError}}"
        }
      ]
    }
  ]
}
```

### Step level — for with numeric range

```json
{
  "name": "Create user {{i}}",
  "for": {
    "from": 1,
    "to": 10,
    "as": "i"
  },
  "action": {
    "type": "httpRequest",
    "method": "POST",
    "url": "user-service/api/users",
    "body": {
      "name": "test-user-{{i}}",
      "email": "test-{{i}}@example.com"
    }
  },
  "assertions": [
    {
      "assertions": [
        { "path": "$.response.status", "operator": "eq", "value": 201 }
      ]
    }
  ]
}
```

### Step level — for with step (descending)

```json
{
  "name": "Delete item at priority {{p}}",
  "for": {
    "from": 100,
    "to": 0,
    "step": -10,
    "as": "p"
  },
  "action": {
    "type": "httpRequest",
    "method": "DELETE",
    "url": "item-service/api/items/by-priority/{{p}}"
  }
}
```

### Step level — repeat (simple count, no until)

```json
{
  "name": "Warm up the cache (attempt {{attempt}})",
  "repeat": {
    "count": 5,
    "as": "attempt",
    "delayMs": 200
  },
  "action": {
    "type": "httpRequest",
    "method": "GET",
    "url": "service-a/api/expensive-query"
  }
}
```

### Step level — repeat with until (polling)

```json
{
  "name": "Poll status (attempt {{attempt}})",
  "repeat": {
    "count": 20,
    "as": "attempt",
    "delayMs": 1000,
    "until": [
      {
        "path": "$.response.body.status",
        "operator": "eq",
        "value": "completed"
      }
    ]
  },
  "action": {
    "type": "httpRequest",
    "method": "GET",
    "url": "order-service/api/orders/{{orderId}}"
  },
  "extract": {
    "orderStatus": "$.response.body.status"
  },
  "assertions": [
    {
      "assertions": [{ "path": "$.completed", "operator": "eq", "value": true }]
    }
  ]
}
```

### Step level — parallel action inside a loop

```json
{
  "name": "Verify user {{user.name}} in both stores",
  "forEach": {
    "items": "{{users}}",
    "as": "user"
  },
  "action": {
    "type": "parallel",
    "actions": [
      {
        "type": "httpRequest",
        "method": "GET",
        "url": "user-service/api/users/{{user.id}}"
      },
      {
        "type": "dbQuery",
        "database": "postgres-db",
        "query": "SELECT * FROM users WHERE id = {{user.id}}"
      }
    ]
  }
}
```

### Assertion block level — forEach over response array

`forEach` on an assertion block iterates over an array and runs the inner assertions per element. At this level, `items` supports the same three forms as everywhere else — a `$` path resolves against the root context:

```json
{
  "name": "Get all users and validate each",
  "action": {
    "type": "httpRequest",
    "method": "GET",
    "url": "user-service/api/users"
  },
  "assertions": [
    {
      "assertions": [
        { "path": "$.response.status", "operator": "eq", "value": 200 },
        { "path": "$.response.body", "operator": "length", "value": 3 }
      ]
    },
    {
      "forEach": {
        "items": "$.response.body",
        "as": "user"
      },
      "assertions": [
        {
          "path": "{{user.email}}",
          "operator": "matches",
          "value": "^.+@.+\\..+$"
        },
        { "path": "{{user.active}}", "operator": "eq", "value": true },
        { "path": "{{user.id}}", "operator": "type", "value": "number" }
      ]
    }
  ]
}
```

The same example using a variable reference (if the array was extracted in a prior step):

```json
{
  "forEach": {
    "items": "{{users}}",
    "as": "user"
  },
  "assertions": [
    {
      "path": "{{user.email}}",
      "operator": "matches",
      "value": "^.+@.+\\..+$"
    },
    { "path": "{{user.active}}", "operator": "eq", "value": true }
  ]
}
```

`forEach` is a modifier on what is otherwise a Self assertion block — not a new block type. The validator checks for the optional `forEach` key on assertion blocks the same way it checks for it on steps. It cannot combine with `match` or `service`. Inter-service traffic already has `assertionScope` (`all`, `first`, `last`, `any`) for controlling which matched entries are asserted on.

`for` and `repeat` are not supported at the assertion level — iterating assertions by count or polling condition doesn't have a meaningful use case.

### UI sub-step level — forEach over data

```json
{
  "name": "Test invalid inputs",
  "forEach": {
    "items": ["bad@", "", "missing"],
    "as": "email"
  },
  "action": {
    "type": "ui",
    "target": "frontend",
    "steps": [
      { "type": { "selector": "#email", "text": "{{email}}" } },
      { "click": "#submit" },
      { "waitFor": "[data-testid='error']" }
    ]
  }
}
```

Note: this puts `forEach` at the step level, which repeats the entire UI action (all sub-steps). To loop a subset of UI sub-steps within a single UI action, use a **sub-step group** — an entry in the UI `steps` array that has a loop modifier (`forEach`, `for`, or `repeat`) and a `steps` array instead of a regular sub-step key (`click`, `type`, etc.). The validator distinguishes sub-step groups from regular sub-steps by the presence of a loop modifier key. A sub-step group with both a loop modifier and a regular sub-step key (e.g., `{ "forEach": {...}, "click": "#btn", "steps": [...] }`) is a validation error — the loop modifier + `steps` is the discriminant:

```json
{
  "action": {
    "type": "ui",
    "target": "frontend",
    "steps": [
      { "visit": "/form" },
      {
        "forEach": {
          "items": ["bad@", "", "missing"],
          "as": "email"
        },
        "steps": [
          { "type": { "selector": "#email", "text": "{{email}}" } },
          { "click": "#submit" },
          { "waitFor": "[data-testid='error']" }
        ]
      },
      { "screenshot": "after-all-inputs" }
    ]
  }
}
```

### UI sub-step level — repeat with until (scroll to load all)

```json
{
  "action": {
    "type": "ui",
    "target": "frontend",
    "steps": [
      { "visit": "/search?q=widgets" },
      {
        "repeat": {
          "count": 20,
          "as": "scroll",
          "delayMs": 500,
          "until": [{ "path": "{{hasMore}}", "operator": "eq", "value": false }]
        },
        "steps": [
          { "click": "[data-testid='load-more']" },
          {
            "waitFor": {
              "selector": "[data-testid='spinner']",
              "absent": true
            }
          },
          {
            "extract": {
              "hasMore": {
                "from": "exists",
                "selector": "[data-testid='load-more']"
              }
            }
          }
        ]
      },
      {
        "extract": {
          "totalResults": {
            "from": "count",
            "selector": "[data-testid='result-item']"
          }
        }
      }
    ]
  }
}
```

### UI sub-step level — for with range

```json
{
  "action": {
    "type": "ui",
    "target": "frontend",
    "steps": [
      { "visit": "/dashboard" },
      {
        "for": {
          "from": 1,
          "to": 5,
          "as": "tab"
        },
        "steps": [
          { "click": "[data-testid='tab-{{tab}}']" },
          { "waitFor": "[data-testid='tab-content-{{tab}}']" }
        ]
      }
    ]
  }
}
```

---

## Before and After

Here is the "Parallel DB queries with variable extraction then sequential verification" test from `parallel-steps-and-variables.json`, rewritten with `forEach`:

**Before (copy-paste):**

```json
{
  "name": "Parallel DB queries with variable extraction then sequential verification",
  "variables": {
    "redisConnStr": "redis://:dokkimi@redis-db:6379"
  },
  "steps": [
    {
      "name": "Query Alice from Postgres",
      "action": {
        "type": "dbQuery",
        "database": "postgres-db",
        "query": "SELECT * FROM users WHERE name = 'Alice' LIMIT 1"
      },
      "extract": { "aliceId": "$.data[0].id", "aliceEmail": "$.data[0].email" }
    },
    {
      "name": "Query Bob from Postgres",
      "action": {
        "type": "dbQuery",
        "database": "postgres-db",
        "query": "SELECT * FROM users WHERE name = 'Bob' LIMIT 1"
      },
      "extract": { "bobId": "$.data[0].id", "bobEmail": "$.data[0].email" }
    },
    {
      "name": "Cache both users in Redis",
      "action": {
        "type": "httpRequest",
        "method": "POST",
        "url": "service-a/cache-users",
        "body": {
          "queries": [
            {
              "databaseType": "redis",
              "connectionString": "{{redisConnStr}}",
              "command": "SET user:alice:id {{aliceId}}"
            },
            {
              "databaseType": "redis",
              "connectionString": "{{redisConnStr}}",
              "command": "SET user:bob:id {{bobId}}"
            }
          ]
        }
      }
    },
    {
      "name": "Read Alice from Redis",
      "action": {
        "type": "httpRequest",
        "method": "POST",
        "url": "service-a/read-cache",
        "body": {
          "queries": [
            {
              "databaseType": "redis",
              "connectionString": "{{redisConnStr}}",
              "command": "GET user:alice:id"
            }
          ]
        }
      },
      "assertions": [
        {
          "assertions": [
            {
              "path": "response.body.queryResults[0][0].result",
              "operator": "eq",
              "value": "{{aliceId}}"
            }
          ]
        }
      ]
    },
    {
      "name": "Read Bob from Redis",
      "action": {
        "type": "httpRequest",
        "method": "POST",
        "url": "service-a/read-cache",
        "body": {
          "queries": [
            {
              "databaseType": "redis",
              "connectionString": "{{redisConnStr}}",
              "command": "GET user:bob:id"
            }
          ]
        }
      },
      "assertions": [
        {
          "assertions": [
            {
              "path": "response.body.queryResults[0][0].result",
              "operator": "eq",
              "value": "{{bobId}}"
            }
          ]
        }
      ]
    }
  ]
}
```

**After (with loops):**

```json
{
  "name": "DB queries with variable extraction then verification",
  "variables": {
    "redisConnStr": "redis://:dokkimi@redis-db:6379",
    "userNames": ["Alice", "Bob"]
  },
  "steps": [
    {
      "name": "Query {{name}} from Postgres",
      "forEach": {
        "items": "{{userNames}}",
        "as": "name"
      },
      "action": {
        "type": "dbQuery",
        "database": "postgres-db",
        "query": "SELECT * FROM users WHERE name = '{{name}}' LIMIT 1"
      },
      "extract": {
        "userId": "$.response.data[0].id"
      }
    },
    {
      "name": "Cache {{name}} in Redis",
      "forEach": {
        "items": "{{userNames}}",
        "as": "name"
      },
      "action": {
        "type": "httpRequest",
        "method": "POST",
        "url": "service-a/cache-users",
        "body": {
          "queries": [
            {
              "databaseType": "redis",
              "connectionString": "{{redisConnStr}}",
              "command": "SET user:{{name}}:id {{userId}}"
            }
          ]
        }
      }
    },
    {
      "name": "Read {{name}} from Redis and verify",
      "forEach": {
        "items": "{{userNames}}",
        "as": "name"
      },
      "action": {
        "type": "httpRequest",
        "method": "POST",
        "url": "service-a/read-cache",
        "body": {
          "queries": [
            {
              "databaseType": "redis",
              "connectionString": "{{redisConnStr}}",
              "command": "GET user:{{name}}:id"
            }
          ]
        }
      },
      "assertions": [
        {
          "assertions": [
            {
              "path": "$.response.body.queryResults[0][0].result",
              "operator": "eq",
              "value": "{{userId}}"
            }
          ]
        }
      ]
    }
  ]
}
```

Note: this example highlights the last-write-wins tradeoff. `userId` is overwritten each iteration, so the verification step's `{{userId}}` only holds the last user's ID. For this specific pattern, a test-level `forEach` over users (repeating all three steps per user) would be more correct:

```json
{
  "name": "Query, cache, and verify {{user}}",
  "variables": {
    "redisConnStr": "redis://:dokkimi@redis-db:6379"
  },
  "forEach": {
    "items": ["Alice", "Bob"],
    "as": "user"
  },
  "steps": [
    {
      "name": "Query {{user}} from Postgres",
      "action": {
        "type": "dbQuery",
        "database": "postgres-db",
        "query": "SELECT * FROM users WHERE name = '{{user}}' LIMIT 1"
      },
      "extract": { "userId": "$.response.data[0].id" }
    },
    {
      "name": "Cache {{user}} in Redis",
      "action": {
        "type": "httpRequest",
        "method": "POST",
        "url": "service-a/cache-users",
        "body": {
          "queries": [
            {
              "databaseType": "redis",
              "connectionString": "{{redisConnStr}}",
              "command": "SET user:{{user}}:id {{userId}}"
            }
          ]
        }
      }
    },
    {
      "name": "Verify {{user}} in Redis",
      "action": {
        "type": "httpRequest",
        "method": "POST",
        "url": "service-a/read-cache",
        "body": {
          "queries": [
            {
              "databaseType": "redis",
              "connectionString": "{{redisConnStr}}",
              "command": "GET user:{{user}}:id"
            }
          ]
        }
      },
      "assertions": [
        {
          "assertions": [
            {
              "path": "$.response.body.queryResults[0][0].result",
              "operator": "eq",
              "value": "{{userId}}"
            }
          ]
        }
      ]
    }
  ]
}
```

---

## Nesting

Loops can nest — a `forEach` on a test can contain steps with `repeat`, or a `for` step can contain a UI action with its own `forEach` on sub-steps. Each loop writes to the flat map under its own `as` name, so inner loop variables don't clobber outer loop variables (as long as the `as` names are different).

No artificial depth limit and no iteration cap. If a user writes a loop that runs 10,000 times, that's their test — the existing `config.timeoutSeconds` already guards against runaway execution.

---

## Variable Scoping

The variable context remains a **flat map**, same as today. Loop variables are namespaced via the required `as` field, so nested loops never collide.

**How it works:**

Every loop variable is prefixed with the `as` name. A `forEach` with `"as": "user"` writes `user`, `user.__index`, and `user.__items` to the flat map. A nested `repeat` with `"as": "attempt"` writes `attempt` to the same map. They never collide because they have different names.

After a loop ends, its variables remain in the map holding the last iteration's values — same as `extract` and every other variable in the system. There is no cleanup, no scoping stack, no hidden behavior.

**Example — nested loops:**

```
Flat map before loops: { orderId: "abc", pgConnStr: "..." }

forEach (as: "order"):
  iteration 0: { ..., order: {id: 1}, order.__index: 0, order.__items: [...] }

  repeat (as: "attempt"):
    iteration 0: { ..., attempt: 0 }
    iteration 1: { ..., attempt: 1 }
    extract:     { ..., status: "done" }

  After inner loop: order is still {id: 1}, attempt is 1, status is "done"

  iteration 1: { ..., order: {id: 2}, order.__index: 1 }
  ...

After outer loop: order is {id: 2}, order.__index is 1, attempt is 1, status is "done"
```

**The user controls naming.** If two loops use the same `as` value, the second overwrites the first — same as if two `extract` rules use the same key. Loop `as` names and extract variable names share the same flat namespace — if a loop has `as: "status"` and an extract rule writes `status`, the extract overwrites the loop variable mid-iteration. Naming is the user's responsibility, same as every other variable name in the system.

**`extract` inside loops** uses last-write-wins within the flat map. Each iteration overwrites the previous value. This is the natural fit for `repeat`/polling where you care about the final value. For `forEach` where you need data from all iterations, use a test-level loop so each iteration completes its full step sequence before the variable is overwritten.

---

## Summary

Three modifiers, one concept, every level:

| Modifier  | Drives Iteration           | Key Fields                                       |
| --------- | -------------------------- | ------------------------------------------------ |
| `forEach` | Data array                 | `items`, `as` (required), `delayMs`              |
| `for`     | Numeric range              | `from`, `to`, `step`, `as` (required), `delayMs` |
| `repeat`  | Count + optional condition | `count`, `as` (required), `delayMs`, `until`     |

All variables are namespaced under the required `as` field. `{{<as>}}` is the current value (item, range value, or 0-based counter). `{{<as>.__index}}` is the 0-based iteration counter. `forEach` additionally exposes `{{<as>.__items}}` (the full array). All three support `delayMs`. They attach as optional fields on tests, steps, actions, assertion blocks, or UI sub-steps. The variable context is a flat map — no scoping stack, no cleanup. Naming is the user's responsibility.
