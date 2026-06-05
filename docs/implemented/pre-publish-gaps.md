# Pre-Publish Gaps

Features and fixes to ship before the next publish. All build on top of the run-history-limit work (per-project scoping, per-run storage, `maxRunHistory` config, `GET /runs/history` endpoint).

## 1. Structured dump path output

**Problem:** The MCP `dump_results` tool parses stdout for `__DUMP_PATH__=<path>` to return the dump file location to the LLM. The `dump` CLI command never emits this — it only writes `Dump written to <path>` to stderr. The tool works today because it falls back to parsing stderr, but that's a human-readable message that could change without warning.

**Fix:** After writing the dump file, emit `__DUMP_PATH__=<resolved path>` to stdout in `apps/cli/src/commands/dump.ts` (line ~186). Keep the stderr message for human consumers. The MCP tool already handles both — this just makes the structured path the primary channel.

**Files:**
- `apps/cli/src/commands/dump.ts` — add `process.stdout.write(`__DUMP_PATH__=${path.resolve(outputFile)}\n`)` before the stderr message

## 2. Project-aware `get_config` / `set_config` MCP tools

**Problem:** The per-project config system is fully implemented (`projects[path]` in `~/.dokkimi/config.json`, the config TUI supports global vs project scope, `getConcurrencyPrefs(projectPath)` / `getMaxRunHistory(projectPath)` resolve with fallback). But the MCP tools that LLMs use to read and write config don't expose any of it:

- `get_config` calls `getConcurrencyPrefs()` with no project path, so it always returns global values. It doesn't show `maxRunHistory` at all. It doesn't indicate whether a value comes from a project override, global setting, or hardcoded default.
- `set_config` only accepts `maxConcurrentTests`, `maxBootingTests`, and `telemetry`. No `maxRunHistory`. No `scope` parameter. All writes go to global config.

This means an LLM can't help users tune per-project settings — one of the main use cases the run-history branch built.

**Changes to `get_config`:**

1. Resolve project path using the same pattern as all other MCP tools: `import { findDokkimiDir } from '../lib/dokkimi-dir'`, then `const dokkimiDir = findDokkimiDir(process.cwd()); const projectPath = dokkimiDir ? path.dirname(dokkimiDir) : undefined;`
2. Call `getConcurrencyPrefs(projectPath)` and `getMaxRunHistory(projectPath)` with the resolved project path
3. Add `maxRunHistory` to the response
4. Add source annotations to each value: `"source": "project" | "global" | "default"`

Response shape:

```json
{
  "projectPath": "/Users/avi/git/my-project",
  "maxConcurrentTests": { "value": 6, "default": 6, "source": "default" },
  "maxBootingTests": { "value": 2, "default": 2, "source": "default" },
  "maxRunHistory": { "value": 5, "default": 2, "source": "project" },
  "telemetry": { "value": true, "default": true, "source": "default" }
}
```

Source resolution for each setting: check `prefs.projects?.[projectPath]?.[key]` (or the nested equivalent for concurrency) for `"project"`, then `prefs[key]` for `"global"`, else `"default"`. When no project path is resolvable (MCP server running outside any project), omit `projectPath` from the response and only return global+default sources — project overrides exist in the config file but don't apply.

**Changes to `set_config`:**

1. Add `maxRunHistory` to the `key` enum
2. Add an optional `scope` parameter: `z.enum(['project', 'global']).optional()`. When omitted, default to `"project"` if a project path is resolvable via `findDokkimiDir(process.cwd())`, otherwise `"global"`
3. When scope resolves to `"project"`, pass the project path to `setConcurrencyPrefs(prefs, projectPath)` / `setMaxRunHistory(value, projectPath)`. When `"global"`, pass `undefined` as the project path
4. If scope is explicitly `"project"` but no project path is resolvable, return an error

**Files:**
- `apps/mcp/src/tools/config.ts` — both `registerGetConfig` and `registerSetConfig`
- Import `getMaxRunHistory`, `setMaxRunHistory`, `getUserPrefs` from `@dokkimi/config`
- Import `findDokkimiDir` from `../lib/dokkimi-dir` (same import as `diagnose.ts`, `get-run-history.ts`, `diff-traffic.ts`, `watch-run.ts`, `get-container-status.ts`)

## 3. Historical run access: `--run` flag for `inspect` and `dump`, `runTimestamp` param for `dump_results`

**Problem:** Run history is retained in the DB and queryable via `GET /runs/history`, but the CLI and MCP tools can only access the latest run. There's no way to inspect or dump a previous run's results.

### Timestamp format

The filesystem folder name uses `YYYYMMDD-HHmmss` format, produced by `formatRunTimestamp(date)` in `shared/config/paths.ts`. This is the same function used by `runDirPath()` and `dumpPath()`. The `--run` flag accepts this format as input, and matching works by calling `formatRunTimestamp(new Date(run.createdAt))` against the user-provided string.

### CLI: `dokkimi inspect --run <timestamp>`

Currently `inspect` always queries `GET /runs/latest`. With `--run`, it should query `GET /runs/history` and find the matching run.

The `GET /runs/history` response items have the same shape as `GET /runs/latest` — both return `{ runId, status, createdAt, completedAt, instances[] }` where each instance has `{ id, name, status, testStatus, errorMessage }`. This is the same `LatestRunResponse` type the CLI already uses. So after resolving the run from history, the rest of the `inspect` flow (`inspectRun(ctUrl, run.runId, instances, storageDir)`) works unchanged — `inspectRun` fetches per-instance data using the instance IDs, and those CT endpoints (`/logs/http/instance/:id`, `/namespaces/instances/:id`, etc.) work with any instance ID regardless of which run it belongs to.

Resolution logic:
1. Parse `--run <timestamp>` from args
2. If present, fetch `GET /runs/history?projectPath=<path>` and find the run where `formatRunTimestamp(new Date(run.createdAt))` matches the provided timestamp
3. If no match, error with available timestamps from history so the user can pick one
4. If `--run` is not provided, fall back to `GET /runs/latest` (current behavior)

Updated help text:

```
Usage: dokkimi inspect [path] [--run <timestamp>]

Inspect test results and traffic logs from a run.

Arguments:
  [path]              Path to a specific definition file (.json, .yml, .yaml) or .dokkimi/ folder
                      Defaults to all definitions in the run

Options:
  --run <timestamp>   Inspect a specific run from history (e.g. 20260603-141522)
                      Defaults to the latest run
  --help, -h          Show this help message
```

### CLI: `dokkimi dump --run <timestamp>`

Same resolution pattern as `inspect`. Currently `dump` always targets the latest run. With `--run`, it fetches the specified run from history and writes the dump to that run's folder (`~/.dokkimi/runs/{projectPath}/{timestamp}/dump.json`).

The output path derivation already uses `dumpPath(projectPath, createdAt, failedOnly)` — this just needs to resolve `createdAt` from the specified run instead of always using the latest.

Updated help text:

```
Usage: dokkimi dump [path] [--run <timestamp>] [-o <file>] [--failed] [--inline-artifacts]

Output a raw JSON data dump of a run for LLM-assisted debugging.

By default, writes to ~/.dokkimi/runs/{project}/{timestamp}/dump.json

Arguments:
  [path]              Filter to definitions matching a definition file (.json, .yml, .yaml) or .dokkimi/ folder
                      Defaults to all definitions in the run

Options:
  --run <timestamp>   Dump a specific run from history (e.g. 20260603-141522)
                      Defaults to the latest run
  -o, --output <file> Write to a specific file instead of the default location
  --failed            Only include instances that failed
  --inline-artifacts  Embed text artifacts (HTML) inline in the JSON.
                      For paste workflows where the LLM cannot read
                      files from disk.
  --help, -h          Show this help message
```

### Shared `--run` parsing

Both `inspect` and `dump` need the same arg-parsing and run-resolution logic. Extract a shared helper (e.g. in `apps/cli/src/lib/run-resolution.ts` or inline in `apps/cli/src/lib/project-path.ts`):

```typescript
async function resolveRun(
  ctUrl: string,
  projectPath: string | undefined,
  runTimestamp: string | undefined,
): Promise<LatestRunResponse>
```

Returns the matching run or exits with an error listing available timestamps.

### MCP: `dump_results` accepts optional `runTimestamp`

Add an optional `runTimestamp` parameter to the `dump_results` MCP tool. When provided, pass `--run <timestamp>` to the `dokkimi dump` CLI command. Default behavior (no timestamp) is unchanged — dumps the latest run.

**Files:**
- `apps/cli/src/commands/inspect.ts` — parse `--run`, use shared resolver, update help text
- `apps/cli/src/commands/dump.ts` — parse `--run`, use shared resolver, update help text
- `apps/cli/src/lib/project-path.ts` (or new `run-resolution.ts`) — shared `resolveRun` helper
- `apps/mcp/src/tools/dump-results.ts` — add `runTimestamp` param, pass `--run` to CLI

### CT endpoint note

No new CT endpoint is needed. `GET /runs/history` already returns `createdAt` and instance data for each run, and all existing per-instance endpoints work with any instance ID regardless of which run it belongs to. The CLI resolves the target run client-side and then uses the instance IDs from that run.

## 4. DB size warning in `dokkimi doctor`

**Problem:** With run history retention, the SQLite DB grows over time. `dokkimi doctor` already reports DB size (e.g. "initialized (4.2 MB)") but doesn't warn when it gets large. The run-history design doc specifies a 500MB threshold warning.

**Fix:** In the `checkDatabase()` function in `apps/cli/src/commands/doctor.ts` (~line 184), add a warning when the DB exceeds 500MB:

```typescript
const mb = size / (1024 * 1024);
if (mb > 500) {
  return {
    name: 'Database',
    pass: true,
    detail: `initialized (${sizeLabel}) — large; consider running \`dokkimi clean\` or reducing maxRunHistory`,
  };
}
```

This should `pass: true` (it's not a failure — the DB works fine) but surface the size concern in the doctor output. The existing `warning` display path in doctor is only for the `.dokkimi/` directory check, so this is just advisory text in the detail field.

**Files:**
- `apps/cli/src/commands/doctor.ts` — `checkDatabase()` function

## Implementation order

1. **Structured dump path** — one line, zero risk
2. **DB size warning** — three lines, zero risk
3. **`get_config` / `set_config` project awareness** — contained to one file, no CT changes
4. **`--run` flag for inspect/dump + MCP `runTimestamp`** — largest change; verify `formatRunTimestamp` round-trips correctly with CT's `createdAt` dates before coding the resolver
