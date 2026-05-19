# MCP Branch Review Items

Issues found during review of the `dokkimi-mcp` branch that should be addressed before merge.

## High Priority

### ~~1. Shell injection in VSCode test-runner~~ DONE
Fixed to use `cp.spawn('dokkimi', ['run', '--ci', target], { shell: true })` — args array avoids injection, shell mode ensures cross-platform command resolution.

### ~~2. Dump path duplicated in 4 places~~ DONE
Extracted `DUMP_DIR`, `DUMP_PATH`, `DUMP_FAILED_PATH` to `shared/config/paths.ts`. All four consumers now import from `@dokkimi/config`.

### ~~3. run_tests success flag override~~ DONE
Removed the `parsed.success = code === 0` override. The dump file's `success` flag is now trusted when available; exit code is only used as fallback when the dump can't be parsed.

## Medium Priority

### ~~4. VSCode activation event~~ WON'T FIX
Accepted tradeoff. `workspaceContains` avoids loading the extension in every workspace. If a user creates `.dokkimi/` mid-session, they reload VSCode — standard behavior for workspace-scoped extensions.

### ~~5. Unused spawnInShell in platform~~ DONE
Removed `spawnInShell` from the Platform interface and both implementations. The VSCode extension uses `cp.spawn` directly with piped stdio.

### ~~6. Unused @dokkimi/platform dependency in VSCode~~ DONE
Removed `@dokkimi/platform` from `apps/vscode/package.json`.

## Low Priority

### 7. Planning doc open questions
**File:** `docs/proposed/mcp-server.md:216-227`

Several open questions listed in the doc were resolved by the implementation. Update or remove to avoid confusion.
