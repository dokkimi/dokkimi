# Run History — Local Per-Project Storage

## Problem

Run artifacts (dump files, definition snapshots, screenshots) are stored in a single global location (`~/.dokkimi/`). This causes two problems:

1. **Cross-project collisions.** Switching between projects overwrites the dump file. `--failed` picks up failures from the wrong project. With multiple repos using Dokkimi on one machine, this is a regular occurrence.
2. **No run history.** Only the most recent run's results are stored. Sequential `run_tests` calls overwrite previous results. The dump file and instance snapshots are wiped when a new run starts.

## Approach

Move run artifacts into the project's `.dokkimi/` directory, organized by timestamp. Each run gets its own folder with everything needed for debugging — dump files, definition snapshots, logs, and artifacts. CT writes instance data directly into the run folder instead of a global `storage/` directory.

### Storage structure

```
my-project/.dokkimi/__runs__/{YYYYMMDD-HHmmss}/
  dump.json
  dump_failed.json
  snapshots/{definition-name}/
    definition.json
    artifacts/
    db-init-files/
```

- **Timestamp ID** (`YYYYMMDD-HHmmss`): Human-readable, naturally sorted, unique (can't start two runs in the same second).
- **Definition name as folder key**: Navigable — `ls snapshots/` shows meaningful names instead of UUIDs. The resolver already enforces unique definition names within a run.
- **`__runs__/`**: Double underscores signal auto-generated content, visually distinct from user-authored definition folders.
- **`.gitignore`**: Add `.dokkimi/__runs__/` to the project's `.gitignore`.

### What lives in the dump file

The dump is a self-contained snapshot captured at run completion. It includes:

- Run metadata (ID, status, timestamps)
- Per-instance: resolved definition (all `$ref` expanded, variables interpolated), items, status, error messages
- HTTP, database, console, and test execution logs (inline)
- Assertion results (inline)
- Artifact references (file paths into `snapshots/{definition-name}/artifacts/`)

Artifact paths point to files within the same run folder, so they remain valid as long as the run folder exists. No dangling pointers.

### Retention

- A global `maxRunHistory` config setting (default 5) controls how many run folders to keep per project.
- After each run completes, the CLI deletes the oldest folders beyond the limit.
- `dokkimi clean` also prunes old run folders.
- Exposed via `get_config` / `set_config` MCP tools and the config TUI.

### Configuration

All configuration stays global (`~/.dokkimi/config.json`). No per-project config overrides — keeps the TUI simple and avoids the complexity of inheritance/precedence. If per-project overrides are needed later, they can be added without breaking the global model.

## Implementation phases

### Phase 1: Local per-project dump files (CLI only, no CT changes)

Moves dump files from the global path to `.dokkimi/__runs__/{timestamp}/`. Solves the cross-project collision problem. Low risk — CT continues writing instance snapshots to the global `~/.dokkimi/storage/` path as before.

**CLI changes:**

- **`writeDump`**: Write `dump.json` and `dump_failed.json` into `.dokkimi/__runs__/{timestamp}/` in the project directory.
- **`DUMP_PATH` / `DUMP_FAILED_PATH`**: These are currently global constants. They need to resolve dynamically based on the project's `.dokkimi/` path and the current (or latest) run timestamp.
- **`--failed`**: Read from the latest run folder for the current project, not the global path.
- **Retention**: After each run, scan `__runs__/`, sort by timestamp, delete folders beyond `maxRunHistory`.
- **`dokkimi clean`**: Extend to prune `__runs__/` folders.
- **`dokkimi dump`**: Resolve to the current project's latest run folder.

**MCP changes:**

- **`run_tests`**: Return the run's timestamp ID in the response.
- **`dump_results`**: Accept an optional `runId` (timestamp) parameter. Default to the latest run for the current project.
- **`get_config` / `set_config`**: Add `maxRunHistory` as a configurable key.

**Other:**

- **VS Code extension**: Update any references to the global dump path.
- **`.gitignore`**: The `get_reference` MCP tool should mention in its setup/best practices output that `__runs__/` is auto-generated and should be added to `.gitignore`. This is where the LLM learns about Dokkimi — the right moment to handle it once, not on every run. The CLI itself does not create or modify `.gitignore`.

**Limitation:** Artifact paths in the dump still point to `~/.dokkimi/storage/instances/{instanceId}/`, which CT wipes on the next run. Dump data (logs, assertions, definitions) is fully inline and unaffected — only artifact file references become stale. This is the same behavior as today.

### Phase 2: Move CT instance storage into the run folder

Moves CT's instance snapshots from `~/.dokkimi/storage/instances/` into `.dokkimi/__runs__/{timestamp}/snapshots/{definition-name}/`. Artifact paths in the dump become durable — they survive across runs because each run's artifacts live in its own folder.

**CT changes:**

- **Storage path**: The CLI passes the run's storage root (`{project}/.dokkimi/__runs__/{timestamp}/snapshots/`) when creating a run. CT writes instance data there instead of the global path.
- **Folder key**: Use definition name instead of instance ID for the snapshot subfolder.
- **Cleanup**: `teardownExistingRuns` currently deletes `storage/instances/` — this should target the project-scoped run folder instead. Every feature that reads/writes instance data (artifacts, baselines, init files, visual matching) needs to be updated to use the new path convention.

**Risk:** This is the riskier change. The storage path threads through multiple CT modules (storage service, run cleanup, namespace lifecycle, visual matching). Should be done after phase 1 is stable.

## What we decided not to do

- **Run history for LLMs**: The LLM already has `run_tests` results in its context window. Storing multiple runs doesn't meaningfully improve the LLM workflow — the real problem was cross-project collisions.
- **Append-mode results**: Returning full results inline from `run_tests` and not depending on dump files. Loses the ability to re-query and debug after the fact.
- **Per-project config overrides**: Makes the config TUI complex (global vs local, inheritance display). All settings stay global for now.
- **Symlinks for `latest`**: Considered a `latest` symlink pointing to the most recent run folder. Not needed — the CLI can just sort `__runs__/` by timestamp to find the latest.
