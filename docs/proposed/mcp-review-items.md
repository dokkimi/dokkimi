# MCP Branch Review Items

Issues found during review of the `dokkimi-mcp` branch that should be addressed before merge.

## High Priority

### 1. Shell injection in VSCode test-runner
**File:** `apps/vscode/src/test-runner.ts:114-115`

The target string is interpolated into a shell command with only single-quote escaping. Backticks and `$()` are still dangerous. Should use `cp.spawn('dokkimi', ['run', '--ci', target])` with `shell: false` instead.

### ~~2. Dump path duplicated in 4 places~~ DONE
Extracted `DUMP_DIR`, `DUMP_PATH`, `DUMP_FAILED_PATH` to `shared/config/paths.ts`. All four consumers now import from `@dokkimi/config`.

### 3. run_tests success flag override
**File:** `apps/mcp/src/tools/run-tests.ts:167`

`parsed.success = code === 0` overwrites whatever the dump file actually reported. If the process exits 0 but tests failed (or vice versa), this masks the real result.

## Medium Priority

### 4. VSCode activation event
**File:** `apps/vscode/package.json:17`

Changed from `onStartupFinished` to `workspaceContains:**/.dokkimi/**`. If a user opens a workspace then creates `.dokkimi/` for the first time, the extension won't activate until they reload VSCode.

### 5. Unused spawnInShell in platform
**Files:**
- `shared/platform/platform-unix.ts`
- `shared/platform/platform-windows.ts`
- `shared/platform/platform.ts`

`spawnInShell` was added to the Platform interface and both implementations but is never called anywhere on this branch. Remove if not needed, or document what it's for.

### 6. Unused @dokkimi/platform dependency in VSCode
**File:** `apps/vscode/package.json:85`

`@dokkimi/platform` was added as a dependency but is never imported. Increases bundle size for no reason.

## Low Priority

### 7. Planning doc open questions
**File:** `docs/proposed/mcp-server.md:216-227`

Several open questions listed in the doc were resolved by the implementation. Update or remove to avoid confusion.
