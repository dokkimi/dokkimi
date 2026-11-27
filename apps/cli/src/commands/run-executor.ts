import * as path from 'path';
import { resolveDefinitions } from '@dokkimi/definition-resolver';
import {
  fetchJson,
  fetchPostWithError,
  TIMEOUT_CREATE_RUN,
} from '../lib/cli-utils';
import { type DokkimiConfig } from '@dokkimi/config';
import { warnIfVersionMismatch } from '../lib/version';
import {
  pollForCompletion,
  type RunOnceResult,
  type RunStatusInstance,
} from '../lib/run-display';
import { pollForCompletionCI } from '../lib/ci-display';
import { uploadBaselinesForDefinition } from '../lib/baseline-upload';
import {
  ensureServicesRunning,
  resolveAppRoot,
} from '@dokkimi/service-manager';
import {
  resolveRegistryCredentials,
  type RegistryCredential,
} from '../lib/registry-credentials';
import {
  definitionHasUiSteps,
  submitDefinition,
  type CreateRunResponse,
} from './run-helpers';
import type { LatestRunResponse } from '../lib/inspect-types';
import { getProjectPath, latestRunUrl } from '../lib/project-path';
import { INVALID_STATUS, outcomeOf } from '../lib/outcome';
import type { ResolverError } from '@dokkimi/definition-resolver';

export async function executeRun(
  ctUrl: string,
  config: DokkimiConfig,
  target: string | undefined,
  abort: AbortController,
  filterNames?: string[],
  ciMode?: boolean,
  timeoutMs?: number,
  onFilesResolved?: (files: string[]) => Promise<void>,
): Promise<RunOnceResult> {
  const appRoot = resolveAppRoot(__dirname);
  await ensureServicesRunning(appRoot, config, undefined, abort.signal);

  const result = resolveDefinitions(target);

  if (result.consumedFiles.length > 0 && onFilesResolved) {
    await onFilesResolved(result.consumedFiles);
  }

  warnIfVersionMismatch(result.config);

  // Files with validation errors are listed with the run's definitions, and
  // fail it. Before, next to valid ones they were skipped quietly, with exit
  // 0, and no file's errors or warnings were shown.
  const errorFiles = result.errors.filter((e) => e.errors.length > 0);
  const invalidInstances: RunStatusInstance[] = errorFiles.map((e) => {
    const name = path.basename(e.file, path.extname(e.file));
    return {
      id: `invalid-${name}`,
      name,
      status: INVALID_STATUS,
      errorMessage: 'Invalid definition',
    };
  });
  printProblems(result.errors);

  if (errorFiles.length > 0 && result.definitions.length === 0) {
    console.log('No valid definitions to run.');
    console.log('');
    return {
      passed: false,
      runId: null,
      runStatus: '',
      instances: invalidInstances,
      consumedFiles: result.consumedFiles,
    };
  }

  let definitions = result.definitions;

  // Filter to only specific definitions (e.g. re-running failed only)
  if (filterNames && filterNames.length > 0) {
    const nameSet = new Set(filterNames);
    definitions = definitions.filter((d) => nameSet.has(d.name));
  }

  // Before, a target that matched nothing (a typo) passed
  if (definitions.length === 0) {
    console.error(
      target
        ? `\x1b[31mNo definitions match "${target}".\x1b[0m`
        : '\x1b[31mNo definitions found.\x1b[0m',
    );
    return {
      passed: false,
      runId: null,
      runStatus: '',
      instances: [],
      consumedFiles: result.consumedFiles,
    };
  }

  if (!ciMode) {
    console.log('');
  }
  if (filterNames && filterNames.length > 0) {
    console.log(`Re-running ${definitions.length} failed definition(s)...`);
    console.log('');
  }

  // Resolve registry credentials (Docker config or registries.yaml)
  let registryCredentials: RegistryCredential[];
  try {
    registryCredentials = resolveRegistryCredentials();
  } catch (err) {
    console.error(
      `\x1b[31m${err instanceof Error ? err.message : String(err)}\x1b[0m`,
    );
    return { passed: false, runId: null, runStatus: '', instances: [] };
  }

  const projectPath = result.dokkimiDir
    ? path.dirname(result.dokkimiDir)
    : undefined;

  const createBody: Record<string, unknown> = {
    definitions: definitions.map((d) => d.name),
  };
  if (projectPath) {
    createBody.projectPath = projectPath;
  }
  if (registryCredentials.length > 0) {
    createBody.registryCredentials = registryCredentials;
  }

  // Creating a run first cleans up earlier runs. Before, the CLI gave up
  // after 10s while Control Tower went on and created the run, which then
  // blocked every later run.
  const createResult = await fetchPostWithError<CreateRunResponse>(
    `${ctUrl}/runs`,
    createBody,
    TIMEOUT_CREATE_RUN,
  );

  if ('error' in createResult) {
    console.error(`\x1b[31mFailed to create run: ${createResult.error}\x1b[0m`);
    return { passed: false, runId: null, runStatus: '', instances: [] };
  }
  const createRes = createResult.data;

  const { runId } = createRes;
  if (ciMode) {
    // The MCP server reads this line
    console.log(`[Dokkimi] Run ${runId}`);
  }
  const instanceMap = new Map<string, string>();
  for (const inst of createRes.instances) {
    instanceMap.set(inst.name, inst.id);
  }

  let hasUiSteps = false;
  let baselinesUploaded = 0;

  // Upload baselines before submitting definitions so they're on disk
  // before any test can complete and trigger the visual-match diff job.
  for (const def of definitions) {
    if (abort.signal.aborted) {
      return { passed: false, runId, runStatus: '', instances: [] };
    }
    const instanceId = instanceMap.get(def.name);
    if (!instanceId) {
      continue;
    }
    baselinesUploaded += await uploadBaselinesForDefinition(
      ctUrl,
      instanceId,
      def.sourceFile,
      def.definition as Record<string, unknown>,
    );
  }

  for (const def of definitions) {
    if (abort.signal.aborted) {
      return { passed: false, runId, runStatus: '', instances: [] };
    }
    const instanceId = instanceMap.get(def.name);
    if (!instanceId) {
      continue;
    }

    if (!hasUiSteps && definitionHasUiSteps(def)) {
      hasUiSteps = true;
    }

    const submitErr = await submitDefinition(ctUrl, runId, instanceId, def);
    if (submitErr) {
      console.error(
        `\x1b[31mFailed to submit "${def.name}": ${submitErr}\x1b[0m`,
      );
    }
  }

  const pollResult = ciMode
    ? await pollForCompletionCI(
        ctUrl,
        runId,
        abort,
        invalidInstances,
        timeoutMs,
        definitions.length + invalidInstances.length,
      )
    : await pollForCompletion(ctUrl, runId, abort, invalidInstances, timeoutMs);
  return {
    ...pollResult,
    hasUiSteps,
    baselinesUploaded,
    consumedFiles: result.consumedFiles,
  };
}

/** Every file's errors and warnings, as `dokkimi validate` shows them */
function printProblems(problems: ResolverError[]): void {
  const withProblems = problems.filter(
    (p) => p.errors.length > 0 || p.warnings.length > 0,
  );
  if (withProblems.length === 0) {
    return;
  }
  console.log('');
  for (const { file, errors, warnings } of withProblems) {
    console.log(`${file}:`);
    for (const message of errors) {
      console.log(`  \x1b[31merror\x1b[0m  ${message}`);
    }
    for (const message of warnings) {
      console.log(`  \x1b[33mwarn\x1b[0m   ${message}`);
    }
  }
  console.log('');
}

/** The definitions that didn't pass in the last run of the target's project */
export async function readFailedNames(
  ctUrl: string,
  target?: string,
): Promise<string[]> {
  try {
    // Before, the current folder's project, whatever the target
    const { dokkimiDir } = resolveDefinitions(target);
    const projectPath = dokkimiDir
      ? path.dirname(dokkimiDir)
      : getProjectPath();
    const run = await fetchJson<LatestRunResponse>(
      latestRunUrl(ctUrl, projectPath),
    );
    if (!run) {
      return [];
    }
    // Every definition that didn't pass: failed, cancelled, never run
    return run.instances
      .filter((i) => outcomeOf(run.status, i) !== 'passed')
      .map((i) => i.name);
  } catch {
    return [];
  }
}
