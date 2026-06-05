# Run History — Local Per-Project Storage

## Problem

Run artifacts (dump files, definition snapshots, screenshots) are stored in a single global location (`~/.dokkimi/`). This causes three problems:

1. **Cross-project collisions.** Switching between projects overwrites the dump file. `--failed` picks up failures from the wrong project. With multiple repos using Dokkimi on one machine, this is a regular occurrence.
2. **No run history.** Only the most recent run's results are stored. Sequential `run_tests` calls overwrite previous results. The dump file and instance snapshots are wiped when a new run starts.
3. **`teardownExistingRuns` destroys everything.** `createRun` calls `teardownExistingRuns` which deletes _all_ runs from the DB — not just the current project's. This means Project A starting a run wipes Project B's data. The `projectPath` field on the run is stored but the teardown ignores it.

## Current state

There are two storage layers, both broken for history:

1. **SQLite DB** (`~/.dokkimi/dokkimi.db`): Traffic logs, console logs, DB logs, assertion results, instance items, run records. `teardownExistingRuns` does `prisma.run.delete` on every run, which cascades and deletes all related log rows.
2. **Filesystem** (`~/.dokkimi/storage/instances/{instanceId}/`): Definition snapshots, init files, screenshots, baselines. `teardownExistingRuns` calls `deleteInstance()` for every instance, wiping all directories.
3. **Dump files** (`~/.dokkimi/generated/dump.json`): Hardcoded global path. Every `dokkimi dump` overwrites the previous one.

The `projectPath` filter on `GET /runs/latest` works correctly in isolation — it queries the right run. But it provides false safety because the teardown behind it deletes all projects' data indiscriminately.

## Approach

Keep run artifacts in the global `~/.dokkimi/` directory, organized per-run by timestamp. Each run gets its own folder with everything needed for debugging — dump files, definition snapshots, logs, and artifacts. CT writes instance data directly into the run folder instead of a flat `storage/` directory. Completed runs in the DB are retained up to a configurable history limit, and CT owns all pruning (both DB rows and filesystem directories). The DB's `projectPath` field provides per-project scoping for queries and pruning — no need for project-local storage.

### Storage structure

```
~/.dokkimi/runs/{YYYYMMDD-HHmmss}/
  dump.json          (generated on demand via `dokkimi dump`)
  dump_failed.json   (generated on demand via `dokkimi dump --failed`)
  snapshots/{definition-name}/
    definition.json
    artifacts/
    db-init-files/
```

- **Timestamp ID** (`YYYYMMDD-HHmmss`): Human-readable, naturally sorted. Uniqueness is guaranteed by CT's single-run-at-a-time constraint — only one run can be active per project, so timestamp collisions are impossible.
- **Definition name as folder key**: Navigable — `ls snapshots/` shows meaningful names instead of UUIDs. The resolver already enforces unique definition names within a run.
- **Global directory**: All runs live under `~/.dokkimi/runs/`, avoiding repo pollution — no `.gitignore` entries, no VSCode watcher exclusions, no auto-modifying project files. CT always has write access to `~/.dokkimi/` regardless of project directory permissions.
- **Dump files**: Not auto-generated. Created on demand when the user runs `dokkimi dump` (or the MCP `dump_results` tool). Written into the run's folder so they don't overwrite each other.

### DB retention and pruning

The SQLite DB retains completed runs (and their logs/assertions) up to the `maxRunHistory` limit. CT owns all pruning — both DB rows and the corresponding `~/.dokkimi/runs/{timestamp}/` directory on disk. This avoids orphans (CLI deletes folder but DB rows remain, or vice versa).

CT enforces a single active run per project. When a new run is created, CT:

1. Stops the active run for this `projectPath` (if any)
2. Counts completed runs for this `projectPath`
3. If the count exceeds `maxRunHistory`, deletes the oldest runs — both `prisma.run.delete` (cascading to all related rows) and `fs.rm` on the `runs/{timestamp}/` directory

The `projectPath` on the run record is the scoping key. Other projects' runs are never touched.

### Run ID format

The DB primary key (`Run.id`) stays as UUID — no schema change needed. The timestamp (`YYYYMMDD-HHmmss`) is derived from `Run.createdAt` and used only for the filesystem folder name. A composite index `@@index([projectPath, createdAt])` is added to support the pruning query (`WHERE projectPath = X ORDER BY createdAt DESC`).

### Retention config

- A global `maxRunHistory` config setting (default 2) controls how many runs to keep per project. Kept low because retained DB logs (traffic, console, DB) add up — each run can produce thousands of log rows.
- `dokkimi clean` prunes all run folders and DB data for the current project. `dokkimi clean --all` prunes all projects.
- Exposed via `get_config` / `set_config` MCP tools and the config TUI.

### `projectPath` — kept as API filter

CT is a shared daemon serving multiple projects. The MCP server and CLI know which project they're in (via `findDokkimiDir(process.cwd())`), CT does not. `projectPath` stays as:

1. A field on the `Run` DB record (already stored on creation)
2. A query param on `GET /runs/latest` and any future history endpoints
3. The scoping key for retention pruning — CT only prunes runs matching the current project's path

What changes: `teardownExistingRuns` respects `projectPath` instead of deleting everything globally.

### CLI project resolution

Every CLI command that reads run data (`inspect`, `dump`, `run --failed`, etc.) needs to resolve which project the user means. The resolution order:

1. **Explicit flag**: `--project <path>` overrides everything.
2. **`cwd` traversal**: Walk up from `process.cwd()` looking for a `.dokkimi/` directory. This means the user can be in any subdirectory of the project (e.g., `src/services/api/`) and the CLI still finds the right `.dokkimi/` folder. The stored `projectPath` in the DB is the parent of `.dokkimi/`, so `findDokkimiDir(cwd)` → `path.dirname(result)` gives the match key.
3. **Interactive picker**: If neither flag nor traversal yields a project, query CT for all distinct `projectPath` values that have runs, and prompt the user to select one. Then select a run from that project.

The traversal (step 2) must be robust: the stored `projectPath` is an absolute path set at run creation time. The CLI's resolved path from `cwd` must match exactly — use `path.resolve()` / `fs.realpathSync()` to normalize symlinks and relative segments before comparing.

**Known limitation:** If a project directory is moved or renamed after runs have been recorded, the stored `projectPath` values become stale. Those orphaned runs won't match the new path and won't be pruned automatically. `dokkimi clean` is the escape hatch — it clears all run data for the current project (by current path), and `dokkimi clean --all` clears everything.

### `dokkimi inspect` with history

With multiple runs per project, `inspect` needs to know which run to show.

- **Default** (no flags): Show the latest run for the current project (resolved via `cwd` traversal). Same behavior as today.
- **`--run <timestamp>`**: Show a specific run from the current project's history. The timestamp is the run directory name (e.g., `20260603-141522`).
- **`--project <path>`**: Explicit project override when not in the project directory. Combine with `--run` for full specificity.
- **Interactive picker** (future): If the user runs `dokkimi inspect` outside a project directory with no flags, show a project → run picker. Lower priority — the flags cover all use cases.

The same pattern applies to `dokkimi dump` (which run to dump) and any future command that reads historical run data.

### Configuration

Operational settings live in `~/.dokkimi/config.json` (user prefs). Every setting supports per-project overrides via a `projects` key, keyed by absolute project path:

```json
{
  "maxRunHistory": 2,
  "concurrency": {
    "maxConcurrentTests": 6,
    "maxBootingTests": 2
  },
  "projects": {
    "/Users/avi/git/heavy-project": {
      "maxRunHistory": 1,
      "concurrency": {
        "maxConcurrentTests": 2
      }
    },
    "/Users/avi/git/lightweight-project": {
      "maxRunHistory": 5,
      "concurrency": {
        "maxConcurrentTests": 10
      }
    }
  }
}
```

Resolution order: `projects[projectPath][key]` → top-level `key` → hardcoded default. The config loader resolves the project path via `findDokkimiDir(cwd)` and does a single lookup. If outside a project directory, only global values apply.

Per-project overrides live in the global file (not committed to the repo) to avoid merge conflicts — different developers on the same repo may want different concurrency or history limits for their machine.

**Config TUI changes:**

The `dokkimi config` TUI gains project awareness. When launched inside a project directory:

- Each setting shows its effective value and source (`project`, `global`, or `default`)
- Editing a setting prompts for scope: "This project" or "Global default"
- "This project" writes to `projects[projectPath]`; "Global default" writes to the top-level key
- An "Unset" option removes a project override, falling back to global

When launched outside a project directory, only global settings are shown.

**CLI changes:**

```bash
dokkimi config set maxRunHistory 5              # sets global default
dokkimi config set maxRunHistory 5 --project    # sets for current project (resolved via cwd)
dokkimi config unset maxRunHistory --project    # removes project override, falls back to global
```

**MCP changes:**

`get_config` returns effective values with source annotations:

```json
{
  "maxRunHistory": { "value": 5, "source": "project" },
  "concurrency": {
    "maxConcurrentTests": { "value": 6, "source": "global" },
    "maxBootingTests": { "value": 2, "source": "default" }
  }
}
```

`set_config` accepts an optional `scope` parameter (`"project"` or `"global"`, default `"project"` when in a project directory).

**Known limitation:** Same stale-path issue as `projectPath` on runs — renaming a project directory orphans its config overrides. Harmless (orphaned entries sit unused) and cleanable manually.

## Implementation phases

### Phase 1: Scoped teardown and DB retention

Fix the core problem first: stop deleting other projects' data, and retain completed runs up to the history limit. This is the prerequisite for everything else.

**CT changes:**

- **`teardownExistingRuns` → `prepareForNewRun(projectPath)`**: Stop active runs for this project only. Prune completed runs beyond `maxRunHistory` for this project (delete DB rows + filesystem). Leave other projects' runs untouched.
- **Cascading deletes**: Verify that `prisma.run.delete` cascades to `NamespaceInstance`, `InstanceItem`, `HttpLog`, `ConsoleLog`, `DatabaseLog`, `TestExecutionLog`, `AssertionResult`, `Artifact`. If not, add `onDelete: Cascade` to the Prisma schema.
- **Prisma migration**: Add `@@index([projectPath, createdAt])` composite index on `Run` for the pruning query.
- **`maxRunHistory` config**: Add to `~/.dokkimi/config.json` (user prefs), `UserPrefs` type, and config loader. Support per-project overrides via the `projects` key. CT receives the effective value from the CLI when creating a run.
- **`dokkimi clean --all`**: New CT endpoint or extend existing clean to accept an `all` flag. Deletes all runs across all projects.

**Migration:** Existing data in `~/.dokkimi/storage/` and `~/.dokkimi/generated/dump.json` is orphaned. No automatic migration — `dokkimi clean` removes it. No active users to worry about.

**DB size:**

With retained logs, the SQLite file will grow. At 2 runs × ~500 traffic logs each, this is ~4MB — fine for local use. Add a note to `dokkimi doctor` if the DB exceeds a threshold (e.g., 500MB).

### Phase 2: Move CT instance storage into per-run folders

Moves CT's instance snapshots from `~/.dokkimi/storage/instances/` into `~/.dokkimi/runs/{timestamp}/snapshots/{definition-name}/`. Artifact paths become durable — they survive across runs because each run's artifacts live in its own folder.

**CT changes:**

- **Storage path**: CT derives the run's storage root from `Run.createdAt` (`~/.dokkimi/runs/{YYYYMMDD-HHmmss}/snapshots/`). No project path needed in the filesystem layout.
- **Folder key**: Use definition name instead of instance ID for the snapshot subfolder.
- **`RunStorageService`**: `registerInstance` takes `createdAt` and `definitionName` to derive the path. No more global `storageDir` config.
- **Instance storage**: Every feature that reads/writes instance data (artifacts, baselines, init files, visual matching) uses the new path convention.
- **Pruning update**: `prepareForNewRun` deletes `~/.dokkimi/runs/{timestamp}/` directories for pruned runs.

### Phase 3: Per-run dump files

Moves dump files from the global path to `~/.dokkimi/runs/{timestamp}/`. Generated on demand, not at run completion.

**CLI changes:**

- **`writeDump`**: Write `dump.json` and `dump_failed.json` into `~/.dokkimi/runs/{timestamp}/`.
- **`DUMP_PATH` / `DUMP_FAILED_PATH`**: Replaced by `dumpPath(createdAt)` which resolves to the run's folder.
- **`--failed`**: Read from the latest run folder (via CT API query scoped by `projectPath`).
- **`dokkimi dump`**: Resolve to the latest (or specified) run folder.
- **`dokkimi inspect --run <timestamp>`**: Pick a specific run from history.

**MCP changes:**

- **`run_tests`**: Return the run's timestamp ID in the response.
- **`dump_results`**: Accept an optional `runId` (timestamp) parameter. Default to the latest run for the current project.
- **`get_config` / `set_config`**: Add `maxRunHistory` as a configurable key. `get_config` returns source annotations. `set_config` accepts `scope` parameter.

### Phase 4: History endpoints and new MCP tools

New capabilities unlocked by DB retention and per-run storage.

- **`GET /runs/history`**: Return the last N runs for a project, with status and timing. Enables the CLI interactive picker and MCP history tools.
- **MCP `diagnose` tool**: Cross-reference failures with traffic, container status, and console logs from the current run — all queryable from the DB. Returns a surgical diagnosis in one call instead of requiring 5+ tool calls.
- **MCP traffic diff** (future): Compare traffic between the current (failed) run and the previous (passing) run for the same definition.

## What we decided not to do

- **Append-mode results**: Returning full results inline from `run_tests` and not depending on dump files. Loses the ability to re-query and debug after the fact.
- **Per-project config in the repo**: Considered `.dokkimi/config.yaml` `settings:` key for per-project overrides, but this gets committed and causes merge conflicts when developers want different values. Per-project overrides live in the global `~/.dokkimi/config.json` under `projects[path]` instead — local to the machine, no repo changes.
- **Project-local run storage**: Initially implemented run artifacts under `{project}/.dokkimi/__runs__/`, but reverted to global `~/.dokkimi/runs/`. Project-local storage required auto-modifying `.gitignore` and `.vscode/settings.json` to suppress repo pollution, expanded CT's write surface to arbitrary project directories, and made the stale-path problem worse (moved projects orphan both filesystem dirs and DB rows). The DB's `projectPath` scoping provides all the per-project isolation needed without touching the project directory.
- **Symlinks for `latest`**: Considered a `latest` symlink pointing to the most recent run folder. Not needed — the CLI queries CT for the latest run and derives the path.
- **Per-project SQLite DBs**: Considered and rejected — confusing and unnecessary. A single shared DB with `projectPath` scoping is simpler and sufficient.
- **Remove `projectPath`**: Considered during the K8s migration audit. CT is a shared daemon and needs a discriminator to return the right project's data. Keeping `projectPath` as the scoping key on API queries and retention pruning.
- **Auto-generate dump files**: Dump files are generated on demand (`dokkimi dump`), not automatically at run completion. Avoids writing potentially large files that may never be read. The DB has all the data; the dump is a convenience export.
- **Change Run.id to timestamp**: The DB primary key stays UUID. The timestamp is derived from `createdAt` for folder naming only. No schema change to the ID format.
