# MCP Server — Future Work

Follow-up items from the `dokkimi-mcp` branch review that would meaningfully improve the LLM experience.

## ~~1. Config MCP tools~~ DONE

Added `get_config` and `set_config` MCP tools that read/write `~/.dokkimi/config.json` directly via the `@dokkimi/config` user-prefs API — no CLI subprocess needed.

`get_config` returns all settings with current values, defaults, and whether the default is active. `set_config` accepts a key (`maxNamespaces`, `maxBooting`, `context`, `telemetry`) and value, validates the input, and reports whether a reboot is needed.

---

## 2. Run history depth > 1

**Problem:** Only the most recent run's results are stored. If an LLM runs tests for folder A then folder B, folder A's results are lost — the dump file is overwritten. This is the single biggest friction point for non-trivial workflows.

**Impact:**
- Sequential `run_tests` calls lose prior results
- `dump_results` can only access the last run
- LLMs must remember to batch everything into a single `run_tests` call (the tool description warns about this, but it's a workaround, not a fix)

**Proposed approach:**

### Option A: Run ID–based history (recommended)
- Assign each run a stable ID (already exists as `runId` in the CT database)
- Store dump files per-run: `~/.dokkimi/generated/dump-{runId}.json`
- `run_tests` returns the `runId` in its response
- `dump_results` accepts an optional `runId` parameter; defaults to latest
- Add a configurable retention policy (e.g. keep last 5 runs, or runs from the last hour)

### Option B: Append-mode results
- `run_tests` returns full results inline (already partially does this)
- Don't depend on the dump file as the primary result channel
- Simpler but loses the ability to re-query results after the fact

### Cleanup
Either option needs a cleanup mechanism — disk usage from accumulated dump files. Options:
- Cap by count (keep N most recent)
- Cap by age (delete runs older than X hours)
- `dokkimi clean` already cleans K8s resources; extend it to prune old dumps

---

## ~~3. Rerun failed tests~~ DONE

Added `--failed` flag to `dokkimi run` that reads the dump file from the last run, extracts failed definition names, and reruns only those. Exits with an error if there's no prior run or no failures.

Added `failedOnly` boolean parameter to the MCP `run_tests` tool — passes `--failed` to the CLI when set.

---

## ~~4. `--json` output flag for CLI commands~~ DONE

Implemented `--json` flag for `doctor`, `status`, and `clean`. Each command outputs a single JSON object to stdout when `--json` is passed; formatted terminal output is unchanged without the flag. For `clean`, `--json` implies `--force`.

MCP tools (`doctor.ts`, `status.ts`, `clean.ts`) now pass `--json` to the CLI and `JSON.parse` the result directly — all ANSI stripping and regex parsing has been removed.

`run` was not changed since the MCP `run_tests` tool already reads the dump file directly rather than parsing CLI output.
