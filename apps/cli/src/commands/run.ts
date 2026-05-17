import * as path from 'path';
import { resolveDefinitions } from '@dokkimi/definition-resolver';
import { fetchJson, fetchPostWithError, fetchAction } from '../lib/cli-utils';
import { loadConfig, buildServiceUrl, DokkimiConfig } from '@dokkimi/config';
import { warnIfVersionMismatch } from '../lib/version';
import { checkForUpdate } from '../lib/update-check';
import {
  pollForCompletion,
  type RunOnceResult,
  type RunStatusInstance,
} from '../lib/run-display';
import { pollForCompletionCI } from '../lib/ci-display';
import { inspectRun } from '../lib/inspect-run';
import { baselines } from './baselines';
import { uploadBaselinesForDefinition } from '../lib/baseline-upload';
import {
  ensureServicesRunning,
  resolveAppRoot,
} from '@dokkimi/service-manager';
import {
  resolveRegistryCredentials,
  type RegistryCredential,
} from '../lib/registry-credentials';
import { trackEvent, detectK8sProvider } from '@dokkimi/telemetry';
import {
  definitionHasUiSteps,
  detectTargetType,
  trackRunError,
  submitDefinition,
  type CreateRunResponse,
} from './run-helpers';
import { writeDump, DEFAULT_DUMP_FAILED_PATH } from './dump';
import type { LatestRunResponse } from '../lib/inspect-types';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const WATCH_DEBOUNCE_MS = 500;

// ---------------------------------------------------------------------------
// Command
// ---------------------------------------------------------------------------

export async function run(args: string[]): Promise<void> {
  if (args.includes('--help') || args.includes('-h')) {
    console.log('Usage: dokkimi run [target] [--watch]');
    console.log('');
    console.log('Run definition(s) headless and stream results.');
    console.log('');
    console.log('Arguments:');
    console.log('  [target]  What to run. Can be:');
    console.log(
      '            - A directory containing .dokkimi/        dokkimi run /path/to/project',
    );
    console.log(
      '            - A .dokkimi/ directory directly           dokkimi run .dokkimi/',
    );
    console.log(
      '            - A subfolder within .dokkimi/             dokkimi run .dokkimi/auth-tests',
    );
    console.log(
      '            - A specific definition file               dokkimi run .dokkimi/test.yml',
    );
    console.log(
      '            - A substring to match file names          dokkimi run auth',
    );
    console.log(
      '            - A glob pattern                           dokkimi run "auth/**"',
    );
    console.log(
      '            - A regex pattern                          dokkimi run "auth.*service"',
    );
    console.log(
      '            Defaults to the current directory when run from inside .dokkimi/,',
    );
    console.log(
      '            otherwise .dokkimi/ in the current directory (or nearest parent)',
    );
    console.log('');
    console.log('Options:');
    console.log(
      '  --watch, -w          Re-run automatically when definition files change',
    );
    console.log(
      '  --ci                 CI-friendly output (no interactive UI, exit with 0/1)',
    );
    console.log(
      '  --timeout=SECONDS    Fail after SECONDS if not complete (default: 600 in CI)',
    );
    console.log('');
    console.log('Keyboard shortcuts:');
    console.log('  r              Re-run definitions');
    console.log('  f              Re-run only failed definitions');
    console.log('  i              Inspect last run results');
    console.log('  q / ESC / ^C   Stop and exit');
    process.exit(0);
  }

  checkForUpdate();

  const ciMode = args.includes('--ci');
  const watchMode = args.includes('--watch') || args.includes('-w');
  const timeoutArg = args.find((a) => a.startsWith('--timeout='));
  const timeoutMs = timeoutArg
    ? parseInt(timeoutArg.split('=')[1], 10) * 1000
    : ciMode
      ? 10 * 60 * 1000
      : undefined;
  const target = args.find(
    (a) => !a.startsWith('-') && !a.startsWith('--timeout'),
  );

  const config = loadConfig();
  const ctUrl = buildServiceUrl(config.services.controlTower);

  let abort: AbortController | null = null;
  let lastResult: RunOnceResult | null = null;
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  let inspecting = false;
  let pendingTrigger = false;
  let hasPendingBaselines = false;
  let inFlight: Promise<void> = Promise.resolve();
  let isExiting = false;

  // ---------------------------------------------------------------------------
  // Cleanup — stop namespaces, preserve data for analysis
  // ---------------------------------------------------------------------------

  async function cleanup(): Promise<void> {
    if (isExiting) {
      return;
    }
    isExiting = true;
    if (abort) {
      abort.abort();
      abort = null;
    }
    watcher?.close();
    try {
      await inFlight;
    } catch {}
    await fetchAction(`${ctUrl}/runs/stop`, 'POST').catch(() => {});
    if (process.stdin.isTTY) {
      process.stdin.setRawMode(false);
    }
    console.log('');
    process.exit(lastResult?.passed === false ? 1 : 0);
  }

  // ---------------------------------------------------------------------------
  // Run trigger
  // ---------------------------------------------------------------------------

  function clearRunOutput(): void {
    if (process.stdout.isTTY && !ciMode) {
      process.stdout.write('\x1b[u\x1b[J');
    }
  }

  let triggerCount = 0;

  async function stopAndWaitForPreviousRun(
    signal?: AbortSignal,
  ): Promise<void> {
    if (!lastResult?.runId) {
      return;
    }
    const runId = lastResult.runId;
    console.log('\x1b[90mStopping previous run...\x1b[0m');
    await fetchAction(`${ctUrl}/runs/stop`, 'POST').catch(() => {});

    const maxWaitMs = 30_000;
    const pollIntervalMs = 500;
    const start = Date.now();
    while (Date.now() - start < maxWaitMs) {
      signal?.throwIfAborted();
      try {
        const run = await fetchJson<{
          status: string;
          instances: { status: string }[];
        }>(`${ctUrl}/runs/${runId}/status`);
        if (run?.status !== 'PENDING' && run?.status !== 'RUNNING') {
          return;
        }
      } catch {
        return;
      }
      await new Promise((r) => setTimeout(r, pollIntervalMs));
    }
  }

  async function triggerRun(
    filterNames?: string[],
    triggerSource?: string,
  ): Promise<void> {
    if (abort) {
      abort.abort();
      abort = null;
    }
    try {
      await inFlight;
    } catch {}

    abort = new AbortController();

    await stopAndWaitForPreviousRun(abort.signal);

    clearRunOutput();
    if (process.stdout.isTTY && !ciMode) {
      process.stdout.write('\x1b[s');
    }

    const runStart = Date.now();
    const trigger =
      triggerSource ?? (triggerCount === 0 ? 'initial' : 'manual_rerun');
    triggerCount++;

    try {
      lastResult = await executeRun(
        ctUrl,
        config,
        target,
        abort,
        filterNames,
        ciMode,
        timeoutMs,
        watchMode ? updateWatcher : undefined,
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`\n\x1b[31m${msg}\x1b[0m\n`);
      lastResult = { passed: false, runId: null, instances: [] };
      trackRunError(err);
      return;
    }

    // Track run result
    if (lastResult.runId) {
      const passed = lastResult.instances.filter(
        (i) =>
          (i.testStatus ?? i.status) === 'PASSED' ||
          (i.testStatus ?? i.status) === 'COMPLETED',
      );
      const failed = lastResult.instances.filter(
        (i) => (i.testStatus ?? i.status) === 'FAILED',
      );
      const skipped = lastResult.instances.filter(
        (i) => (i.testStatus ?? i.status) === 'SKIPPED',
      );
      const errorFileCount = lastResult.instances.filter(
        (i) => i.errorMessage === 'Invalid definition',
      ).length;
      trackEvent('cli_run_result', {
        definition_count: lastResult.instances.length,
        passed_count: passed.length,
        failed_count: failed.length,
        skipped_count: skipped.length,
        error_file_count: errorFileCount,
        duration_ms: Date.now() - runStart,
        watch_mode: watchMode,
        target_type: detectTargetType(target),
        trigger,
        k8s_provider: detectK8sProvider(),
        has_ui_steps: lastResult.hasUiSteps ?? false,
        baselines_uploaded: lastResult.baselinesUploaded ?? 0,
        has_pending_baselines: hasPendingBaselines,
      });
    }

    // Check for pending baselines (best-effort, don't block on failure)
    hasPendingBaselines = false;
    if (lastResult.runId) {
      try {
        const res = await fetchJson<{ hasPending: boolean }>(
          `${ctUrl}/artifacts/run/${lastResult.runId}/has-pending`,
        );
        hasPendingBaselines = res?.hasPending ?? false;
      } catch {}
    }

    // Auto-dump results for extension and MCP consumption (best-effort)
    if (lastResult.runId) {
      try {
        const latestRun = await fetchJson<LatestRunResponse>(
          `${ctUrl}/runs/latest`,
        );
        if (latestRun) {
          const dumpOpts = {
            ctUrl,
            storageDir: config.storage.dir,
            instances: latestRun.instances,
            runId: latestRun.runId,
            runStatus: latestRun.status,
            createdAt: latestRun.createdAt,
            completedAt: latestRun.completedAt,
          };
          await writeDump(dumpOpts);

          const failedInstances = latestRun.instances.filter(
            (i) => i.testStatus === 'FAILED' || i.status === 'FAILED',
          );
          if (failedInstances.length > 0) {
            await writeDump({
              ...dumpOpts,
              instances: failedInstances,
              outputPath: DEFAULT_DUMP_FAILED_PATH,
            });
          }
        }
      } catch {}
    }

    if (!ciMode) {
      printHint();
    }
  }

  function printHint(): void {
    if (!process.stdout.isTTY || !lastResult?.runId) {
      return;
    }
    const hasFailures = lastResult.instances.some(
      (i) => (i.testStatus ?? i.status) === 'FAILED',
    );
    const failedHint = hasFailures ? ', f to re-run failed' : '';
    const baselinesHint = hasPendingBaselines ? ', b to review baselines' : '';
    if (watchMode) {
      console.log(
        `\x1b[90mWaiting for changes... (r to re-run${failedHint}, i to inspect${baselinesHint}, q/Ctrl+C to quit)\x1b[0m`,
      );
    } else {
      console.log(
        `\x1b[90mPress r to re-run${failedHint}, i to inspect${baselinesHint}, q/Ctrl+C to exit\x1b[0m`,
      );
    }
  }

  function scheduleTrigger(
    filterNames?: string[],
    triggerSource?: string,
  ): void {
    if (inspecting) {
      pendingTrigger = true;
      return;
    }
    if (debounceTimer) {
      clearTimeout(debounceTimer);
    }
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      inFlight = triggerRun(filterNames, triggerSource);
    }, WATCH_DEBOUNCE_MS);
  }

  // ---------------------------------------------------------------------------
  // File watcher (watch mode only)
  // ---------------------------------------------------------------------------

  let watcher: ReturnType<typeof import('chokidar').watch> | null = null;
  let watchedFiles = new Set<string>();

  async function updateWatcher(files: string[]): Promise<void> {
    const newFiles = new Set(files);
    if (!watcher) {
      const chokidar = await import('chokidar');
      const w = chokidar.watch([...newFiles], {
        ignoreInitial: true,
        awaitWriteFinish: { stabilityThreshold: 100 },
      });
      const onFileChange = () => scheduleTrigger(undefined, 'watch');
      w.on('change', onFileChange);
      w.on('unlink', onFileChange);
      watcher = w;
      watchedFiles = newFiles;
      console.log(
        `\x1b[90mWatching ${newFiles.size} definition file(s) for changes...\x1b[0m`,
      );
      return;
    }

    const toAdd = [...newFiles].filter((f) => !watchedFiles.has(f));
    const toRemove = [...watchedFiles].filter((f) => !newFiles.has(f));
    if (toAdd.length > 0) {
      watcher.add(toAdd);
    }
    if (toRemove.length > 0) {
      watcher.unwatch(toRemove);
    }
    watchedFiles = newFiles;
  }

  // ---------------------------------------------------------------------------
  // Keyboard (q/Ctrl+C = quit, r = re-run, i = inspect)
  // ---------------------------------------------------------------------------

  function attachKeyboard(): void {
    if (!process.stdin.isTTY) {
      return;
    }
    process.stdin.removeAllListeners('data');
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', onKey);
  }

  function onKey(key: string): void {
    if (key === 'q' || key === '\x03') {
      cleanup();
    } else if (key === 'r') {
      scheduleTrigger(undefined, 'manual_rerun');
    } else if (key === 'f') {
      const failedNames = (lastResult?.instances ?? [])
        .filter((i) => (i.testStatus ?? i.status) === 'FAILED')
        .map((i) => i.name);
      if (failedNames.length === 0) {
        return;
      }
      scheduleTrigger(failedNames, 'rerun_failed');
    } else if (key === 'i') {
      if (inspecting) {
        return;
      }
      if (!lastResult?.runId || lastResult.instances.length === 0) {
        return;
      }
      inspecting = true;
      trackEvent('cli_run_inspect', {});
      process.stdin.removeListener('data', onKey);
      inspectRun(
        ctUrl,
        lastResult.runId,
        lastResult.instances,
        config.storage.dir,
      ).finally(() => {
        inspecting = false;
        attachKeyboard();
        if (pendingTrigger) {
          pendingTrigger = false;
          scheduleTrigger();
        }
      });
    } else if (key === 'b') {
      if (inspecting || !hasPendingBaselines) {
        return;
      }
      inspecting = true;
      process.stdin.removeListener('data', onKey);
      baselines([]).finally(async () => {
        // Re-check whether there are still pending baselines
        if (lastResult?.runId) {
          try {
            const res = await fetchJson<{ hasPending: boolean }>(
              `${ctUrl}/artifacts/run/${lastResult.runId}/has-pending`,
            );
            hasPendingBaselines = res?.hasPending ?? false;
          } catch {}
        }
        inspecting = false;
        printHint();
        attachKeyboard();
        if (pendingTrigger) {
          pendingTrigger = false;
          scheduleTrigger();
        }
      });
    }
  }

  if (!ciMode) {
    attachKeyboard();
  }
  process.on('SIGINT', cleanup);

  // ---------------------------------------------------------------------------
  // Initial run
  // ---------------------------------------------------------------------------

  if (process.stdout.isTTY && !ciMode) {
    process.stdout.write('\x1b[s');
  }
  inFlight = triggerRun();
  await inFlight;

  // CI mode: exit immediately with appropriate code
  // Auto-dump already ran inside triggerRun(), no need to dump again.
  if (ciMode) {
    await fetchAction(`${ctUrl}/runs/stop`, 'POST');
    process.exit((lastResult as RunOnceResult | null)?.passed ? 0 : 1);
  }

  // Nothing to run and not watching for changes: exit immediately
  if (!(lastResult as RunOnceResult | null)?.runId && !watchMode) {
    cleanup();
  }

  // Non-TTY without watch: exit immediately with appropriate code
  if (!process.stdout.isTTY && !watchMode) {
    await fetchAction(`${ctUrl}/runs/stop`, 'POST');
    process.exit((lastResult as RunOnceResult | null)?.passed ? 0 : 1);
  }

  // TTY / watch: keyboard listener (and optionally watcher) keeps process alive
}

// ---------------------------------------------------------------------------
// Execute a single run (resolve → create → submit → poll)
// ---------------------------------------------------------------------------

async function executeRun(
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
        `  \x1b[90m\u2013\x1b[0m ${inst.name.padEnd(30)}  \x1b[90mSKIPPED\x1b[0m     \x1b[90mInvalid definition\x1b[0m`,
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

  const createBody: Record<string, unknown> = {
    definitions: definitions.map((d) => d.name),
  };
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
