# VSCode Test Explorer Integration

## Goal

Replace the custom webview sidebar with VS Code's native Test Explorer API. The extension should:

1. Discover `.dokkimi/` definition files and display them as a test tree (beaker icon in the Activity Bar).
2. Let users run definitions from the Test Explorer UI (click play, select subsets, re-run failures).
3. Reflect results from CLI-initiated `dokkimi run` in the Test Explorer — not just runs started from VS Code.

The key insight: `dokkimi run` already produces all the data needed to populate Test Explorer results. The `dokkimi dump` command writes structured JSON with per-instance pass/fail status, assertion results (expected vs actual), error messages, and more. The extension just needs to read that data.

## How It Works Today

### Extension (current state)

- Custom webview sidebar lists `.dokkimi/` files in categories (definitions, fragments, init files, baselines)
- CodeLens "Run Definition" button opens a terminal and runs `dokkimi run <path>`
- `$ref` link provider makes `$ref` paths clickable
- Schema validation (JSON + YAML) provides squiggles and Problems panel entries

### CLI

- `dokkimi run [target]` resolves definitions, submits to Control Tower, polls for completion, and prints results
- `dokkimi run --ci` is a non-interactive variant: line-buffered output, exits with code 0/1
- `dokkimi dump` fetches the last run's results from Control Tower and writes structured JSON to `~/.dokkimi/generated/dump.json`
- `dokkimi dump --failed` filters to only failed instances

### Dump output structure

`dokkimi dump` writes to `~/.dokkimi/generated/dump.json` by default. The JSON has this shape:

```json
{
  "runId": "...",
  "status": "COMPLETED | FAILED",
  "createdAt": "...",
  "completedAt": "...",
  "instances": [
    {
      "name": "definition-name",
      "status": "STOPPED | FAILED | ...",
      "testStatus": "PASSED | FAILED | null",
      "errorMessage": "... | null",
      "definition": { "name": "...", "items": [...], "tests": [...] },
      "items": [{ "itemDefinitionName": "...", "status": "...", "readinessStatus": "..." }],
      "testExecutionLogs": [{ "eventType": "step_started | step_completed | ...", "message": "...", "stepIndex": 0, "error": "..." }],
      "assertionResults": [
        {
          "stepIndex": 0,
          "assertionIndex": 0,
          "assertionType": "status | body | header | ...",
          "passed": false,
          "expected": 200,
          "actual": 422,
          "path": "response.status",
          "operator": "eq",
          "blockIndex": 0,
          "resultKind": "self | httpCall | consoleLog"
        }
      ],
      "httpLogs": [...],
      "databaseLogs": [...],
      "consoleLogs": [...]
    }
  ]
}
```

The dump fetches data from Control Tower's API (it is not a local-only operation — Control Tower must be running). Each instance corresponds to one definition file. `assertionResults` contains every assertion with its pass/fail status, expected/actual values, and the path that was checked.

## Proposed Architecture

### Part 1: CLI auto-dumps after every run

**Problem:** Today, `dokkimi dump` is a separate command the user runs manually. The extension cannot get structured results unless someone runs `dokkimi dump` first.

**Solution:** Have `dokkimi run` automatically call `dump()` when the run completes (both interactive and CI modes). This means `~/.dokkimi/generated/dump.json` is always up to date with the latest run results.

**Where to add it in `apps/cli/src/commands/run.ts`:**

The `triggerRun()` function (line 191) handles the post-run flow. After the telemetry tracking and baseline check (lines 236-278), and before `printHint()` (line 281), auto-dump should run:

```
// After telemetry + baseline check, before printHint():
await autoDump(ctUrl, config, lastResult);
```

The `autoDump` function should:
- Call the dump logic from `commands/dump.ts` (refactor `dump()` so the core logic is callable without CLI arg parsing)
- Write to the default path (`~/.dokkimi/generated/dump.json`)
- Be best-effort — failures should log a warning but not block the run
- Run in both interactive and CI modes

For CI mode (line 452-456), add the auto-dump before `process.exit()`:

```
if (ciMode) {
  await fetchAction(`${ctUrl}/runs/stop`, 'POST');
  await autoDump(ctUrl, config, lastResult);  // <-- add here
  process.exit(lastResult?.passed ? 0 : 1);
}
```

**Why auto-dump instead of having the extension run `dokkimi dump`:**
- The CLI already has the Control Tower URL, config, and run context — no need to re-resolve
- Avoids a race condition where the extension tries to dump before the run fully completes
- Works regardless of whether the run was started from the extension or the terminal
- The dump file becomes a reliable contract: "after any `dokkimi run`, the dump file has the results"

### Part 2: Test discovery via TestController

**Extension file: `src/test-controller.ts`**

Register a `vscode.TestController` that discovers definition files and builds a test tree.

**Test item hierarchy:**

```
TestController ("Dokkimi")
  └── Definition ("health-checks")        ← file URI, range at line 0
        ├── Test ("Health check returns OK")   ← file URI, range at the test's `name:` line
        └── Test ("Another test")
```

**Discovery logic:**
1. `resolveHandler` scans `**/.dokkimi/**/*.{json,yaml,yml}` using `vscode.workspace.findFiles`
2. Skip config files (`config.json`, `config.yaml`, `config.yml`)
3. Parse each file (JSON or YAML via `js-yaml`)
4. A file is a runnable definition if it has both `name` (string) and `items` (array)
5. Each entry in the `tests` array with a `name` field becomes a child test item
6. To set `testItem.range` for child tests, scan the file's lines to find the `name:` line for each test

**File watching:**
- Watch `**/.dokkimi/**/*.{json,yaml,yml}` for changes/creates/deletes
- Re-run discovery on any change

### Part 3: Run profile (extension-initiated runs)

**Extension file: `src/test-runner.ts`**

Register a "Run" profile via `controller.createRunProfile()`.

**Run handler flow:**
1. Collect selected test items. Since `dokkimi run` operates at the definition-file level (not individual tests), deduplicate to a set of definition files.
2. For each definition file:
   - Mark all its test items as `enqueued`, then `started`
   - Spawn `dokkimi run --ci <relativePath>` with `stdio: ['ignore', 'pipe', 'pipe']` (need stdout/stderr for the output channel)
   - Stream stdout to a "Dokkimi" `OutputChannel` so the user can watch progress
   - When the process exits, read `~/.dokkimi/generated/dump.json` (which was auto-written by the CLI per Part 1)
   - Parse the dump and report results to the test run (see Part 4)
3. Handle cancellation: `token.onCancellationRequested` → kill the child process

**Why `--ci` mode:** It exits cleanly with code 0/1 instead of waiting for keyboard input. The extension doesn't need the interactive TUI.

### Part 4: Reading dump results into Test Explorer

**After a run completes (either extension-initiated or CLI-initiated):**

1. Read `~/.dokkimi/generated/dump.json`
2. Parse the JSON into the `DumpOutput` shape
3. For each instance in the dump:
   - Find the matching definition test item by comparing `instance.name` to `testItem.label`
   - If `testStatus` is `PASSED` or `COMPLETED`: mark the definition and all child tests as passed
   - If `testStatus` is `FAILED`: build a `TestMessage` from the failed assertions and mark as failed
   - If `testStatus` is `SKIPPED`: mark as skipped
4. For failed assertions, build a readable error message:
   ```
   status at response.status  (eq)
     expected: 200
     received: 422
   body at response.body.error  (contains)
     expected: "success"
     received: "insufficient funds"
   ```

**Granularity limitation:** The CLI runs entire definitions, not individual tests within a definition. When a definition fails, all child tests are marked as failed with the same error. A future CLI enhancement could add per-test result tracking, but that's out of scope here.

### Part 5: File watcher for CLI-initiated runs

**This is what connects CLI runs to the Test Explorer.**

The extension watches `~/.dokkimi/generated/dump.json` for changes using `fs.watch` (not `vscode.workspace.createFileSystemWatcher`, since the dump file is outside the workspace).

When the dump file changes:
1. Read and parse the JSON
2. Create a new `TestRun` via `controller.createTestRun(new TestRunRequest())`
3. For each instance in the dump, find the matching test item and report results (same logic as Part 4)

This means:
- User runs `dokkimi run` from a terminal
- CLI completes, auto-dumps to `~/.dokkimi/generated/dump.json`
- Extension detects the file change
- Test Explorer updates with green/red results

**Debounce:** The dump file is written as a stream (not atomically), so debounce the watcher by ~500ms to avoid reading a partially-written file.

### Part 6: Remove the sidebar

Delete the custom webview sidebar and its dependencies:

**Files to delete:**
- `src/sidebar-provider.ts`
- `src/webview/` (entire directory)

**`package.json` changes:**
- Remove `viewsContainers` and `views` from `contributes`
- Remove `build:webview`, `copy:codicons` from scripts
- Remove `react`, `react-dom`, `styled-components`, `@vscode/codicons` and their `@types/*` from dependencies

**Keep:**
- CodeLens provider (inline "Run Definition" button)
- `$ref` link provider
- Schema validation (JSON + YAML)
- Snippets

### Part 7: CodeLens enhancement (optional, lower priority)

The current CodeLens shows one "Run Definition" lens at line 0 of each definition file. Enhancement options:

- Add per-test CodeLens on each `- name:` line in the `tests` array (still runs the full definition since the CLI doesn't support test-level runs)
- Change the CodeLens command to trigger a Test Explorer run instead of opening a terminal (so results show up in the tree)

## Task List

### CLI changes (`apps/cli/`)

- [ ] **Refactor `dump()` in `commands/dump.ts`** — Extract the core dump logic into a callable function (e.g., `writeDump(ctUrl, storageDir, instances, outputPath)`) separate from CLI arg parsing. The existing `dump()` command handler calls this function after parsing args. The new `autoDump` function also calls it.

- [ ] **Add auto-dump to `commands/run.ts`** — After a run completes (after telemetry tracking, before `printHint()`), call the extracted dump function to write results to `~/.dokkimi/generated/dump.json`. Do this in both interactive and CI code paths. Wrap in try/catch so dump failures don't affect the run exit code.

### Extension changes (`apps/vscode/`)

- [ ] **Create `src/test-controller.ts`** — `TestController` with `resolveHandler` that discovers definition files, parses them, and builds the test item tree. Include `FileSystemWatcher` for `.dokkimi/` files.

- [ ] **Create `src/test-runner.ts`** — Run profile handler. Spawns `dokkimi run --ci <path>`, streams output to an `OutputChannel`, reads the dump file after completion, and reports results to the test run.

- [ ] **Create `src/dump-watcher.ts`** — Watches `~/.dokkimi/generated/dump.json` with `fs.watch`. On change (debounced), reads the dump, matches instances to test items, and creates a test run with results. This is what makes CLI-initiated runs appear in the Test Explorer.

- [ ] **Update `src/extension.ts`** — Remove sidebar provider registration. Add test controller activation. Keep CodeLens and `$ref` link provider.

- [ ] **Update `package.json`** — Remove `viewsContainers`, `views`, webview build scripts, and React/styled-components/codicons dependencies.

- [ ] **Delete sidebar and webview files** — `src/sidebar-provider.ts`, `src/webview/` directory.

- [ ] **Build and verify** — `yarn build`, `npx tsc --noEmit`, test with the extension development host.
