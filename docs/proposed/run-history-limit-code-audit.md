# Run History & Storage — Code Audit

Two independent reviews of the `mcp-updates` branch (~2,100 lines across 35 files).
Both rated it ship-ready with minor fixes. **All issues below have been addressed.**

---

## Must Fix — DONE

### 1. RunStorageService loses state on CT restart
Added `resolveInstanceDir()` which derives the path from DB on cache miss (queries
the instance's run for `projectPath` + `createdAt` + `definitionName`). All async
storage methods (`writeDefinition`, `readDefinition`, `persistArtifact`,
`persistBaseline`, `writeInitFiles`, etc.) now use this fallback. Also added
`hasInstance()` check in `ensureInstanceRegistered` to skip redundant DB queries
when the instance is already cached.

---

## Should Fix — DONE

### 2. `diff_traffic` — compare full status code distributions
Now compares per-status-code counts (`{200: 3, 500: 1}`) instead of just
`curr[0].statusCode` vs `prev[0].statusCode`. Reports `previousStatusCounts` and
`currentStatusCounts` in the diff output.

### 3. `watch_run` — query by runId directly
When a `runId` is provided, now queries `/runs/:runId/status` directly instead of
`/runs/latest`. No longer breaks when a new run starts while watching a specific run.

### 4. `cleanupRunStorage` — only swallow ENOENT
All three `catch {}` blocks in `clean.ts` now log a warning for non-ENOENT errors.

### 5. Variable shadowing: `console` in `diagnose.ts`
Renamed to `consoleLogs`.

---

## Nice to Have — DONE

### 6. `get_traffic` — document filtering and add `filteredCount`
Added `filteredCount` field to the response when filters are active. Updated the tool
description to note that filters are applied client-side after fetching `limit` rows.

### 7. `prepareForNewRun` — boundary guard
Added `Math.max(1, maxRunHistory - 1)` so `maxRunHistory=1` keeps at least 1 completed
run instead of zero.

### 8. `dump-results.ts` — look for structured path output
Now checks stdout for `__DUMP_PATH__=...` first, falls back to the stderr regex.
(The CLI dump command still needs to emit the structured line — this makes the MCP
tool ready to consume it.)

### 9. Duplicate `path.isAbsolute` guard pattern
Extracted `resolveUri(uri, storageDir)` helper in `cli-utils.ts`. All 4 occurrences
in `baselines.ts`, `inspect-step-detail.ts`, and `inspect-test-flow.ts` now use it.

---

## Cosmetic — DONE

- Design doc stale `__runs__/` reference in `run-history-limit.md:91` — fixed.
- `editRunHistory` returning `false` / `formatRunTimestamp` local timezone /
  `projectRunsDir` macOS-only strip — left as-is (no behavioral impact).
