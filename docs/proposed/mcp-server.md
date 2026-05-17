# MCP Server Design

## Problem

Dokkimi's install process injects pointers into LLM context files (CLAUDE.md, etc.) so AI tools know how to write definition files. In practice, LLMs often ignore these pointers — especially in agentic mode where they prefer reading source code over referenced docs. Users end up with AI assistants that produce invalid definitions or miss Dokkimi conventions entirely.

More importantly: even when the AI writes a valid definition, the user still has to manually run tests, interpret failures, and feed errors back to the AI. The dream is: **"write me Dokkimi tests" → the AI writes, validates, runs, debugs, fixes, and iterates autonomously.**

## Proposal

Ship a local MCP server that exposes the full Dokkimi lifecycle as tools. The AI doesn't just learn how to write definitions — it can validate them, execute test runs, read failure output, and iterate until tests pass. The MCP server is the glue that enables a fully agentic workflow with no additional prompting.

## How MCP Works (for context)

- MCP is a protocol for giving AI tools (Claude Code, Cursor, Windsurf, etc.) access to custom tools and data
- The server runs as a local subprocess — no network, no auth, no daemon
- The AI tool spawns it via stdio and communicates over JSON-RPC
- The user configures it once (or Dokkimi's install does it automatically)

## Architecture

```
apps/mcp/                    # New app in the monorepo
├── src/
│   ├── index.ts             # Entry point, MCP server setup
│   ├── tools/
│   │   ├── get-reference.ts     # get_reference tool
│   │   ├── list-fragments.ts    # list_fragments tool
│   │   ├── validate.ts          # validate_file tool
│   │   ├── resolve.ts           # resolve_definition tool
│   │   ├── run.ts               # run_tests tool
│   │   └── dump.ts              # dump_results tool
│   └── resources/
│       └── spec.ts              # Full spec as an MCP resource
├── package.json
└── tsconfig.json
```

Dependencies (all local packages):

- `@dokkimi/definition-validator` — validation logic
- `@dokkimi/definition-resolver` — $ref resolution and ${{VAR}} interpolation
- `@modelcontextprotocol/sdk` — MCP server SDK

### CLI integration

`run_tests` and `dump_results` invoke the Dokkimi CLI under the hood. The CLI auto-boots Control Tower and the K8s environment as needed — the MCP server doesn't manage any lifecycle itself. `run_tests` blocks until the run completes and returns structured results. While blocking, it forwards the CLI's stdout as MCP progress notifications (`notifications/progress`) so the AI and user see real-time updates (pods starting, tests running, etc.) instead of a silent hang.

## The Agentic Loop

The MCP server enables this autonomous workflow:

```
1. get_reference("tests")       → AI learns how to write definitions
2. list_fragments()             → AI discovers existing services/mocks to $ref
3. AI writes definition files   → (using its native file tools)
4. validate_file(path)          → catch structural errors before running
5. run_tests(path)              → execute the tests, get pass/fail + dump file paths
6. IF failures:
     AI reads dump_failed.json → get detailed failure data (logs, assertions, traffic)
     AI fixes definitions
     GOTO 4
7. Done — tests pass
```

No human in the loop. The AI drives the entire cycle.

## Tools

### `get_reference`

Returns the relevant section of the Dokkimi specification. This is the AI's starting point — it should call this before writing any definition file.

**Input:**

- `topic` (string, optional) — one of:
  - **Definition authoring:** `"service"`, `"database"`, `"mock"`, `"tests"`, `"assertions"`, `"variables"`, `"ui"`, `"config"`, `"ref"`
  - **Full spec:** `"all"` (or omitted)

**Output:**

- `content` (string) — the relevant markdown section with all field names, types, operators, constraints, and examples

**When the AI calls this:** First — before writing anything. Gives it the complete schema so it produces correct definitions on the first try.

### `list_fragments`

Lists all shared fragment files in the user's `.dokkimi/` folder with their type, name, and description.

**Input:**

- `projectPath` (string, optional) — path to the project root. Defaults to cwd.

**Output:**

- `fragments` (array of `{ filePath, type, name, description? }`)

**When the AI calls this:** Before writing a new definition, to discover existing services/databases/mocks that can be `$ref`'d instead of duplicated.

### `validate_file`

Validates a definition file on disk and returns structured errors/warnings. Fast, no-network check before committing to a full run.

**Input:**

- `filePath` (string) — path to a .dokkimi/ file

**Output:**

- `valid` (boolean)
- `errors` (array of `{ message, path, line?, suggestion? }`)
- `warnings` (array, same shape)

**When the AI calls this:** After writing or editing a definition. Catches schema errors instantly so the AI can fix them before attempting a run.

### `resolve_definition`

Resolves all `$ref` references and `${{VAR}}` interpolations in a definition file, returning the fully-expanded result.

**Input:**

- `filePath` (string) — path to a definition file

**Output:**

- `resolved` (object) — the fully resolved definition
- `errors` (array) — resolution errors (missing refs, undefined vars, circular refs)

**When the AI calls this:** To verify that `$ref`s and variables resolve correctly before running.

### `run_tests`

Executes `dokkimi run` against a definition file or pattern and returns structured results. This is the core action tool — it actually runs the tests.

**Input:**

- `target` (string, optional) — file path, pattern, or subfolder (same as `dokkimi run` target argument). Defaults to the full `.dokkimi/` directory.

**Output:**

- `success` (boolean) — did all tests pass?
- `summary` (object) — `{ total, passed, failed, skipped }`
- `results` (array of `{ definitionName, status, failedTests?, errorMessage? }`)
- `dumpFilePath` (string) — path to the full dump file (e.g., `~/.dokkimi/generated/dump.json`)
- `dumpFailedFilePath` (string) — path to the failed-only dump file (e.g., `~/.dokkimi/generated/dump_failed.json`)

The CLI auto-generates both dump files after every run. The AI can read these directly using its native file tools — no need to call `dump_results` separately in the common case.

**When the AI calls this:** After validation passes. This runs the actual tests against a live K8s environment and reports back whether they passed.

### `dump_results`

Regenerates the dump output from the last run and returns the file path. The AI then reads the file using its native file tools (which already handle large files with offset/limit).

In practice, `run_tests` already returns paths to auto-generated dump files, so this tool is mainly useful for manual/on-demand regeneration.

**Input:**

- `target` (string, optional) — filter to a specific definition file
- `failedOnly` (boolean, optional) — if true, only include failed instances. Defaults to false (all results).

**Output:**

- `filePath` (string) — path to the dump file (e.g., `~/.dokkimi/generated/dump.json`)

The dump file contains instances with assertion results (expected vs actual), HTTP traffic logs, console logs, database logs, and step-by-step execution timelines.

**When the AI calls this:** When it needs to regenerate or re-filter dump data from the last run. Not needed in the typical loop since `run_tests` already provides dump file paths.

## Resources

### `dokkimi://spec`

The full Dokkimi specification as a readable MCP resource. This is a fallback — the `get_reference` tool is preferred because it's scoped, but some MCP clients may prefer loading resources into context.

## Installation & Configuration

The `dokkimi init` command (or install script) will automatically add MCP configuration to the user's global settings for detected AI tools:

**Claude Code** (`~/.claude.json`):

```json
{
  "mcpServers": {
    "dokkimi": {
      "command": "dokkimi",
      "args": ["mcp"]
    }
  }
}
```

**Cursor** (`~/.cursor/mcp.json`):

```json
{
  "mcpServers": {
    "dokkimi": {
      "command": "dokkimi",
      "args": ["mcp"]
    }
  }
}
```

Always global — if `dokkimi` isn't on PATH in a given project, the AI tool simply won't connect to the MCP server. No harm done.

The MCP server is invoked as a subcommand of the main CLI (`dokkimi mcp`), so no separate binary is needed. The CLI entry point detects the `mcp` subcommand and starts the MCP server in stdio mode.

## What This Does NOT Do

- **No file writing** — the AI tool's native file tools handle creating/editing definitions. The MCP server reads, validates, runs, and reports.
- **No interactive TUI** — `dokkimi inspect` and `dokkimi baselines` are human-facing. The MCP server uses `dokkimi dump` (machine-readable) instead.
- **No long-running watch** — `run_tests` executes a single run and returns. The AI drives the retry loop, not the MCP server.

## Open Questions

1. **Should `validate` auto-resolve before validating?** Currently the validator and resolver are separate steps. The MCP tool could run both in sequence so the AI gets a complete picture in one call.

2. **Should we expose a `scaffold_definition` tool?** Given a natural-language description ("test my user service against postgres"), generate a skeleton definition. Could accelerate the "write" step but is more opinionated.

3. **Project discovery** — how does the MCP server find the `.dokkimi/` folder? Walk up from cwd? Require explicit path? Use the same logic as the CLI?

4. **Should the context file pointer be kept?** Belt-and-suspenders alongside the MCP server, or remove it to avoid confusion?

5. ~~**`run_tests` timeout**~~ — Resolved: blocking. MCP over stdio has no inherent timeout, and AI tools are built to wait for long-running operations.
