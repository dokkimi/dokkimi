import * as path from 'path';
import { resolveDefinitions } from '@dokkimi/definition-resolver';
import { fetchJson, fetchPostWithError } from '../lib/cli-utils';
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

  // Build skipped instances for files with validation errors
  const errorFiles = result.errors.filter((e) => e.errors.length > 0);
  const skippedInstances: RunStatusInstance[] = errorFiles.map((e) => {
    const name = path.basename(e.file, path.extname(e.file));
    return {
      id: `skipped-${name}`,
      name,
      status: 'SKIPPED',
      testStatus: 'SKIPPED',
      errorMessage: 'Invalid definition',
    };
  });

  if (errorFiles.length > 0 && result.definitions.length === 0) {
    console.log('');
    console.log('No valid definitions to run.');
    console.log('');
    for (const inst of skippedInstances) {
      console.log(
        `  \x1b[90m–\x1b[0m ${inst.name.padEnd(30)}  \x1b[90mSKIPPED\x1b[0m     \x1b[90mInvalid definition\x1b[0m`,
      );
    }
    console.log('');
    return {
      passed: false,
      runId: null,
      instances: skippedInstances,
      consumedFiles: result.consumedFiles,
    };
  }

  let definitions = result.definitions;

  // Filter to only specific definitions (e.g. re-running failed only)
  if (filterNames && filterNames.length > 0) {
    const nameSet = new Set(filterNames);
    definitions = definitions.filter((d) => nameSet.has(d.name));
  }

  if (definitions.length === 0) {
    console.log('No runnable definitions found.');
    return {
      passed: true,
      runId: null,
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
    return { passed: false, runId: null, instances: [] };
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

  const createResult = await fetchPostWithError<CreateRunResponse>(
    `${ctUrl}/runs`,
    createBody,
  );

  if ('error' in createResult) {
    console.error(`\x1b[31mFailed to create run: ${createResult.error}\x1b[0m`);
    return { passed: false, runId: null, instances: [] };
  }
  const createRes = createResult.data;

  const { runId } = createRes;
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
      return { passed: false, runId, instances: [] };
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
      return { passed: false, runId, instances: [] };
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
        skippedInstances,
        timeoutMs,
        definitions.length + skippedInstances.length,
      )
    : await pollForCompletion(ctUrl, runId, abort, skippedInstances);
  return {
    ...pollResult,
    hasUiSteps,
    baselinesUploaded,
    consumedFiles: result.consumedFiles,
  };
}

export function parseJUnitFlag(args: string[]): string | null {
  const idx = args.indexOf('--junit');
  if (idx === -1) {
    return null;
  }
  const value = args[idx + 1];
  if (!value || value.startsWith('-')) {
    console.error('--junit requires a file path');
    process.exit(1);
  }
  args.splice(idx, 2);
  return value;
}

export async function readFailedNames(ctUrl: string): Promise<string[]> {
  try {
    const projectPath = getProjectPath();
    const run = await fetchJson<LatestRunResponse>(
      latestRunUrl(ctUrl, projectPath),
    );
    if (!run) {
      return [];
    }
    return run.instances
      .filter((i) => (i.testStatus ?? i.status) === 'FAILED')
      .map((i) => i.name);
  } catch {
    return [];
  }
}
