import * as fs from 'fs';
import * as path from 'path';
import { resolveDefinitions } from '@dokkimi/definition-resolver';
import { fetchJson, fetchJsonOrThrow } from '../lib/cli-utils';
import { loadConfig, buildServiceUrl } from '@dokkimi/config';
import { stripIds } from '../lib/editor';
import { outcomeOf } from '../lib/outcome';
import { trackEvent } from '@dokkimi/telemetry';
import type {
  LatestRunResponse,
  DefinitionSnapshot,
  InstanceDetail,
  InstanceSummary,
  HttpLogsResponse,
  DatabaseLogsResponse,
  ConsoleLogsResponse,
  TestExecutionLogsResponse,
  AssertionResult,
  ArtifactRow,
  ArtifactsResponse,
  MessageLogsResponse,
} from '../lib/inspect-types';

import { dumpPath } from '@dokkimi/config';
import { getProjectPath, latestRunUrl } from '../lib/project-path';
import { buildRunMenuItems, fetchAllRuns, pickRun } from '../lib/run-picker';
import { enterAltScreen, exitAltScreen } from '../lib/terminal';

// ---------------------------------------------------------------------------
// Core dump logic — callable from both the `dump` command and auto-dump
// ---------------------------------------------------------------------------

export interface WriteDumpOptions {
  ctUrl: string;
  instances: InstanceSummary[];
  runId: string;
  runStatus: string;
  createdAt: string;
  completedAt: string | null;
  outputPath: string;
  inlineArtifacts?: boolean;
}

export async function writeDump(opts: WriteDumpOptions): Promise<void> {
  const resolved = path.resolve(opts.outputPath);
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  // Streamed instance by instance, to a file renamed only once complete: a
  // failed fetch leaves no partial dump
  const partial = `${resolved}.partial`;
  const stream = fs.createWriteStream(partial);
  try {
    await streamDump(stream, opts);
  } catch (err) {
    stream.destroy();
    fs.rmSync(partial, { force: true });
    throw err;
  }
  fs.renameSync(partial, resolved);
}

async function streamDump(
  stream: fs.WriteStream,
  opts: WriteDumpOptions,
): Promise<void> {
  const {
    ctUrl,
    instances,
    runId,
    runStatus,
    createdAt,
    completedAt,
    inlineArtifacts = false,
  } = opts;

  stream.write('{\n');
  stream.write(`  "runId": ${JSON.stringify(runId)},\n`);
  stream.write(`  "status": ${JSON.stringify(runStatus)},\n`);
  stream.write(`  "createdAt": ${JSON.stringify(createdAt)},\n`);
  stream.write(`  "completedAt": ${JSON.stringify(completedAt)},\n`);
  stream.write(`  "instances": [\n`);

  for (let i = 0; i < instances.length; i++) {
    const instanceData = await dumpInstance(ctUrl, runId, instances[i], {
      inlineArtifacts,
    });
    const json = JSON.stringify(instanceData, null, 2);
    const indented = json.replace(/^/gm, '    ');
    stream.write(indented);
    if (i < instances.length - 1) {
      stream.write(',');
    }
    stream.write('\n');
  }

  stream.write('  ]\n');
  stream.write('}\n');

  await new Promise<void>((resolve) => stream.end(resolve));
}

// ---------------------------------------------------------------------------
// CLI command handler
// ---------------------------------------------------------------------------

export async function dump(args: string[]): Promise<void> {
  if (args.includes('--help') || args.includes('-h')) {
    console.log('Usage: dokkimi dump [path] [--run] [-o <file>]');
    console.log('');
    console.log(
      'Output a raw JSON data dump of a run for LLM-assisted debugging.',
    );
    console.log('');
    console.log('By default, writes to ~/.dokkimi/runs/{timestamp}/dump.json');
    console.log('');
    console.log('Arguments:');
    console.log(
      '  [path]              Filter to definitions matching a definition file (.json, .yml, .yaml) or .dokkimi/ folder',
    );
    console.log('                      Defaults to all definitions in the run');
    console.log('');
    console.log('Options:');
    console.log(
      '  --run [runId]       Browse run history, or target a specific run by ID',
    );
    console.log(
      '  -o, --output <file> Write to a specific file instead of the default location',
    );
    console.log('  --failed            Only include instances that failed');
    console.log(
      '  --inline-artifacts  Embed text artifacts (HTML) inline in the JSON.',
    );
    console.log(
      '                      For paste workflows where the LLM cannot read',
    );
    console.log(
      '                      file paths. PNG artifacts stay as paths regardless.',
    );
    process.exit(0);
  }

  const explicitOutput = parseOutputFlag(args);
  const failedOnly = parseBoolFlag(args, '--failed');
  const inlineArtifacts = parseBoolFlag(args, '--inline-artifacts');
  const runFlag = parseRunFlag(args);
  const config = loadConfig();
  const ctUrl = buildServiceUrl(config.services.controlTower);

  const selectedRun = await resolveRun(ctUrl, runFlag);
  if (!selectedRun) {
    return;
  }

  const runProjectPath = selectedRun.projectPath ?? getProjectPath();
  const defaultFile = failedOnly ? 'dump_failed.json' : 'dump.json';
  let outputFile =
    explicitOutput ??
    (runProjectPath
      ? dumpPath(runProjectPath, new Date(selectedRun.createdAt), failedOnly)
      : path.join(process.cwd(), defaultFile));

  if (
    explicitOutput &&
    fs.existsSync(explicitOutput) &&
    fs.statSync(explicitOutput).isDirectory()
  ) {
    outputFile = path.join(explicitOutput, defaultFile);
  }

  let instances = selectedRun.instances;
  const target = args.find((a) => !a.startsWith('-'));
  if (target) {
    const result = resolveDefinitions(target);
    const names = new Set(result.definitions.map((d) => d.name));
    const runNames = new Set(instances.map((i) => i.name));
    const missing = [...names].filter((n) => !runNames.has(n));
    if (missing.length > 0) {
      for (const name of missing) {
        console.error(
          `\x1b[33mwarn\x1b[0m  "${name}" was not part of the selected run`,
        );
      }
    }
    instances = instances.filter((i) => names.has(i.name));
    if (instances.length === 0) {
      console.error(`No matching definitions found in the selected run.`);
      process.exit(1);
    }
  }

  if (failedOnly) {
    instances = instances.filter(
      (i) => outcomeOf(selectedRun.status, i) !== 'passed',
    );
    if (instances.length === 0) {
      console.error('No failed instances in the selected run.');
      process.exit(0);
    }
  }

  try {
    await writeDump({
      ctUrl,
      instances,
      runId: selectedRun.runId,
      runStatus: selectedRun.status,
      createdAt: selectedRun.createdAt,
      completedAt: selectedRun.completedAt,
      outputPath: outputFile,
      inlineArtifacts,
    });
  } catch (err) {
    // Before, a failed fetch became an empty list in the dump
    console.error(
      `Dump failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    process.exit(1);
  }
  console.log(`Dump written to ${path.resolve(outputFile)}`);

  trackEvent('cli_dump_result', {
    instance_count: instances.length,
    failed_only: failedOnly,
    inline_artifacts: inlineArtifacts,
    has_filter: !!target,
    output_is_default: !explicitOutput,
  });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function parseBoolFlag(args: string[], flag: string): boolean {
  const idx = args.indexOf(flag);
  if (idx === -1) {
    return false;
  }
  args.splice(idx, 1);
  return true;
}

async function resolveRun(
  ctUrl: string,
  runFlag: string | null,
): Promise<LatestRunResponse | null> {
  if (runFlag === 'picker') {
    const allRuns = await fetchAllRuns(ctUrl);
    if (!allRuns) {
      console.error('No run history found. Run `dokkimi run` first.');
      process.exit(1);
    }
    const items = await buildRunMenuItems(ctUrl, allRuns);
    enterAltScreen();
    try {
      return await pickRun(items, 'Select a run to dump:');
    } finally {
      exitAltScreen();
    }
  }

  if (runFlag) {
    const run = await fetchJson<LatestRunResponse>(
      `${ctUrl}/runs/${runFlag}/status`,
    );
    if (!run) {
      console.error(`Run ${runFlag} not found.`);
      process.exit(1);
    }
    return run;
  }

  const projectPath = getProjectPath();
  const run = await fetchJson<LatestRunResponse>(
    latestRunUrl(ctUrl, projectPath),
  );
  if (!run) {
    console.error('No run history found. Run `dokkimi run` first.');
    process.exit(1);
  }
  return run;
}

function parseRunFlag(args: string[]): string | null {
  const idx = args.indexOf('--run');
  if (idx === -1) {
    return null;
  }
  const next = args[idx + 1];
  if (!next || next.startsWith('-')) {
    args.splice(idx, 1);
    return 'picker';
  }
  args.splice(idx, 2);
  return next;
}

function parseOutputFlag(args: string[]): string | null {
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '-o' || args[i] === '--output') {
      const value = args[i + 1];
      if (!value || value.startsWith('-')) {
        console.error('--output requires a file path');
        process.exit(1);
      }
      args.splice(i, 2);
      return value;
    }
  }
  return null;
}

interface DumpOptions {
  inlineArtifacts: boolean;
}

/** How many of each kind of log the dump asks for */
const LOG_LIMITS = { http: 500, database: 500, console: 1000, message: 500 };
const DUMP_FETCH_TIMEOUT_MS = 30000;

const get = <T>(url: string, allow404 = false) =>
  fetchJsonOrThrow<T>(url, { allow404, timeoutMs: DUMP_FETCH_TIMEOUT_MS });

async function dumpInstance(
  ctUrl: string,
  runId: string,
  instance: InstanceSummary,
  opts: DumpOptions,
): Promise<unknown> {
  const [
    definition,
    instanceDetail,
    httpRes,
    dbRes,
    consoleRes,
    msgRes,
    execRes,
    assertions,
    artifactsRes,
  ] = await Promise.all([
    // An instance that was never submitted has no definition
    get<DefinitionSnapshot>(
      `${ctUrl}/runs/${runId}/instances/${instance.id}/definition`,
      true,
    ),
    get<InstanceDetail>(`${ctUrl}/namespaces/instances/${instance.id}`),
    get<HttpLogsResponse>(
      `${ctUrl}/logs/http/instance/${instance.id}?limit=${LOG_LIMITS.http}`,
    ),
    get<DatabaseLogsResponse>(
      `${ctUrl}/logs/database/instance/${instance.id}?limit=${LOG_LIMITS.database}`,
    ),
    get<ConsoleLogsResponse>(
      `${ctUrl}/logs/console/instance/${instance.id}?limit=${LOG_LIMITS.console}`,
    ),
    get<MessageLogsResponse>(
      `${ctUrl}/logs/message/instance/${instance.id}?limit=${LOG_LIMITS.message}`,
    ),
    get<TestExecutionLogsResponse>(
      `${ctUrl}/logs/test-execution/instance/${instance.id}`,
    ),
    get<AssertionResult[]>(
      `${ctUrl}/logs/assertion-results/instance/${instance.id}`,
    ),
    get<ArtifactsResponse>(`${ctUrl}/artifacts/instance/${instance.id}`),
  ]);

  // Name each list the server cut off, with its full count
  const truncated: Record<string, { included: number; total: number }> = {};
  for (const [key, res] of Object.entries({
    testExecutionLogs: execRes,
    httpLogs: httpRes,
    databaseLogs: dbRes,
    consoleLogs: consoleRes,
    messageLogs: msgRes,
  })) {
    if (res && res.total > res.logs.length) {
      truncated[key] = { included: res.logs.length, total: res.total };
    }
  }

  return {
    name: instance.name,
    status: instance.status,
    testStatus: instance.testStatus ?? null,
    errorMessage: instance.errorMessage ?? null,
    definition,
    items: instanceDetail?.items ?? [],
    testExecutionLogs: (execRes?.logs ?? []).map((l) => stripIds(l)),
    assertionResults: (assertions ?? []).map((a) => stripIds(a)),
    httpLogs: (httpRes?.logs ?? []).map((l) => stripIds(l)),
    databaseLogs: (dbRes?.logs ?? []).map((l) => stripIds(l)),
    consoleLogs: (consoleRes?.logs ?? []).map((l) => stripIds(l)),
    messageLogs: (msgRes?.logs ?? []).map((l) => stripIds(l)),
    artifacts: hydrateArtifacts(
      artifactsRes?.artifacts ?? [],
      opts.inlineArtifacts,
    ),
    ...(Object.keys(truncated).length > 0 ? { truncated } : {}),
  };
}

/**
 * Artifact URIs are absolute paths. When `inline` is true, embed text
 * artifact contents (HTML) inline for paste workflows where the LLM has
 * no filesystem access. PNG screenshots and diffs stay as paths regardless.
 */
function hydrateArtifacts(rows: ArtifactRow[], inline: boolean): unknown[] {
  return rows.map((a) => {
    const base = {
      type: a.type,
      name: a.name,
      stepIndex: a.stepIndex,
      subStepIndex: a.subStepIndex,
      path: a.uri,
      ...(a.verdict ? { verdict: a.verdict } : {}),
      createdAt: a.createdAt,
    };
    if (!inline || a.type !== 'html') {
      return base;
    }
    try {
      const content = fs.readFileSync(a.uri, 'utf-8');
      return { ...base, content };
    } catch {
      return base;
    }
  });
}
