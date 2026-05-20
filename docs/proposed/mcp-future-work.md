# MCP Server — Future Work

Follow-up items from the `dokkimi-mcp` branch review that would meaningfully improve the LLM experience.

## 1. Config MCP tools

**Problem:** `dokkimi config` is a fully interactive TUI (arrow-key menus, alternate screen buffer). The MCP server can't shell out to it, so LLMs have no visibility into or control over Dokkimi settings.

**Settings currently managed by `dokkimi config`:**
- Concurrency: `maxNamespaces` (default 6), `maxBooting` (default 2)
- Kubernetes context override
- Telemetry on/off

**Proposed approach:**

### `get_config` MCP tool
Read the config file and preference stores directly (no CLI needed) and return structured JSON with all current settings and their defaults.

### `set_config` MCP tool
Write to the same preference stores that `dokkimi config` uses. The MCP tool reads/writes the config directly — no CLI flags needed since the TUI remains the CLI interface.

Accepts a key-value pair:
```
set_config({ key: "maxNamespaces", value: 10 })
set_config({ key: "context", value: "docker-desktop" })
set_config({ key: "telemetry", value: false })
```

**Note:** Changes to concurrency and K8s context require a service reboot to take effect. `set_config` should report whether a reboot is needed in its response but not reboot automatically. The `reboot` MCP tool (implemented) can be called separately.

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

## 3. Rerun failed tests

**Problem:** After a test run, the most common next step is to fix the failures and rerun only the failed definitions. The CLI supports this in watch mode (press `f`), but there's no non-interactive way to do it — meaning the MCP server can't offer it.

**Why it matters for LLMs:** The typical LLM workflow is: run tests → read failures → edit definition or code → rerun. Today the LLM has to parse the failed definition names from `run_tests` output and manually construct a pattern to pass back as a target. A dedicated "rerun failed" flow would make this loop tighter and less error-prone.

**Proposed approach:**

### Phase 1: CLI flag
Add `--failed` to `dokkimi run`:
```
dokkimi run --failed
```
Reads the last run's results (from the dump file or CT API), extracts the names of failed definitions, and reruns only those. Exits with an error if there's no prior run or no failures.

The plumbing already exists — the watch-mode `f` key handler does exactly this:
1. Reads `lastResult.instances` filtered to `FAILED` status
2. Passes the names as `filterNames` to the run function
3. The run function filters `definitions` to only those names

Extracting this into a `--failed` flag is straightforward.

### Phase 2: MCP tool parameter
Add a `failedOnly` boolean parameter to `run_tests`:
```
run_tests({ failedOnly: true })
```
When set, passes `--failed` to the CLI. The tool description should note that this requires a prior run to have completed.

**Alternative:** A separate `rerun_failed` tool. Simpler discovery for the LLM, but adds yet another tool. The parameter on `run_tests` is cleaner since it's the same operation with a filter.

---

## ~~4. `--json` output flag for CLI commands~~ DONE

Implemented `--json` flag for `doctor`, `status`, and `clean`. Each command outputs a single JSON object to stdout when `--json` is passed; formatted terminal output is unchanged without the flag. For `clean`, `--json` implies `--force`.

MCP tools (`doctor.ts`, `status.ts`, `clean.ts`) now pass `--json` to the CLI and `JSON.parse` the result directly — all ANSI stripping and regex parsing has been removed.

`run` was not changed since the MCP `run_tests` tool already reads the dump file directly rather than parsing CLI output.
