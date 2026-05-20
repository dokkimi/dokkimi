import {
  prompt,
  fetchJson,
  fetchAction,
  checkService,
  sleep,
} from '../lib/cli-utils';
import { loadConfig, buildServiceUrl } from '@dokkimi/config';
import { formatDuration, statusColor } from '../lib/formatting';
import { clearLines } from '../lib/terminal';
import { execSilent } from '@dokkimi/platform';

const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
const POLL_INTERVAL_MS = 2000;
const RENDER_INTERVAL_MS = 100;
const MAX_POLL_TIME_MS = 60000;
const DOKKIMI_NS_PREFIX = 'dokkimi-';
const SYSTEM_NAMESPACE = 'dokkimi-system';

const TERMINAL_STATUSES = new Set(['STOPPED', 'FAILED']);

interface RunStatus {
  runId: string;
  status: string;
  instances: {
    id: string;
    name: string;
    status: string;
    testStatus?: string;
    errorMessage?: string;
  }[];
}

export async function clean(args: string[]): Promise<void> {
  if (args.includes('--help') || args.includes('-h')) {
    console.log('Usage: dokkimi clean [options]');
    console.log('');
    console.log('Stop all running instances and clean up resources.');
    console.log('Directly cleans K8s namespaces if Dokkimi is not running.');
    console.log('');
    console.log('Options:');
    console.log('  --force, -f    Skip confirmation prompt');
    console.log('  --json         Output results as JSON (implies --force)');
    console.log('  --help, -h     Show this help message');
    process.exit(0);
  }

  const jsonMode = args.includes('--json');
  const force = jsonMode || args.includes('--force') || args.includes('-f');

  const config = loadConfig();
  const ctUrl = buildServiceUrl(config.services.controlTower);

  // Check CT is running
  const ctCheck = await checkService('Dokkimi', ctUrl);

  // Find orphaned K8s namespaces regardless of CT status
  const orphanedNamespaces = findDokkimiNamespaces();

  if (jsonMode) {
    const nothingToClean = ctCheck.healthy
      ? await isNothingToCleanCT(ctUrl, orphanedNamespaces)
      : orphanedNamespaces.length === 0;

    if (nothingToClean) {
      console.log(JSON.stringify({ success: true }));
      return;
    }

    const originalLog = console.log;
    const originalExit = process.exit;
    console.log = () => {};
    // Prevent sub-functions from exiting early
    process.exit = (() => {}) as never;
    let success = true;
    let error: string | undefined;
    try {
      if (ctCheck.healthy) {
        await cleanViaCT(ctUrl, true, orphanedNamespaces);
      } else {
        await cleanDirectK8s(true, orphanedNamespaces);
      }
    } catch (err) {
      success = false;
      error = err instanceof Error ? err.message : String(err);
    }
    console.log = originalLog;
    process.exit = originalExit;
    console.log(
      JSON.stringify({
        success,
        ...(error ? { error } : {}),
      }),
    );
    return;
  }

  if (ctCheck.healthy) {
    await cleanViaCT(ctUrl, force, orphanedNamespaces);
  } else {
    await cleanDirectK8s(force, orphanedNamespaces);
  }
}

async function isNothingToCleanCT(
  ctUrl: string,
  orphanedNamespaces: string[],
): Promise<boolean> {
  const latestRun = await fetchJson<RunStatus>(`${ctUrl}/runs/latest`);
  const instanceCount = latestRun?.instances?.length ?? 0;
  return instanceCount === 0 && orphanedNamespaces.length === 0;
}

/**
 * Clean via CT API (graceful path), then clean any remaining K8s namespaces.
 */
async function cleanViaCT(
  ctUrl: string,
  force: boolean,
  orphanedNamespaces: string[],
): Promise<void> {
  const latestRun = await fetchJson<RunStatus>(`${ctUrl}/runs/latest`);

  const hasRun = latestRun && latestRun.instances.length > 0;
  const active = hasRun
    ? latestRun!.instances.filter((i) => !TERMINAL_STATUSES.has(i.status))
    : [];
  const stopped = hasRun
    ? latestRun!.instances.filter((i) => TERMINAL_STATUSES.has(i.status))
    : [];

  // Figure out which namespaces CT doesn't know about
  const ctInstanceIds = new Set((latestRun?.instances ?? []).map((i) => i.id));
  const unknownNamespaces = orphanedNamespaces.filter(
    (ns) => !ctInstanceIds.has(ns.replace(DOKKIMI_NS_PREFIX, '')),
  );

  const totalToClean =
    active.length + stopped.length + unknownNamespaces.length;

  if (totalToClean === 0) {
    console.log('No instances or namespaces found. Nothing to clean.');
    process.exit(0);
  }

  console.log('');
  if (active.length > 0) {
    console.log(
      `Found ${active.length} active instance${active.length === 1 ? '' : 's'}.`,
    );
  }
  if (stopped.length > 0) {
    console.log(
      `Found ${stopped.length} stopped instance${stopped.length === 1 ? '' : 's'} to delete.`,
    );
  }
  if (unknownNamespaces.length > 0) {
    console.log(
      `Found ${unknownNamespaces.length} orphaned K8s namespace${unknownNamespaces.length === 1 ? '' : 's'}.`,
    );
  }
  console.log('');

  if (!force) {
    const answer = await prompt('Stop active instances and delete all? (Y/n) ');
    if (answer === 'n' || answer === 'no') {
      console.log('Aborted.');
      process.exit(0);
    }
  }

  const startTime = Date.now();

  // Phase 1: Stop and delete via CT
  if (hasRun) {
    const runId = latestRun!.runId;

    if (active.length > 0) {
      await fetchAction(`${ctUrl}/runs/stop`, 'POST');
      console.log(
        `Stopping ${latestRun!.instances.length} instance${latestRun!.instances.length === 1 ? '' : 's'}...`,
      );
      console.log('');

      // Poll until all instances are terminal
      let lastPrinted = '';
      let tick = 0;

      while (true) {
        const status = await fetchJson<RunStatus>(
          `${ctUrl}/runs/${runId}/status`,
        );
        const instances = status?.instances ?? latestRun!.instances;
        const allTerminal = instances.every((i) =>
          TERMINAL_STATUSES.has(i.status),
        );

        const spinner = SPINNER_FRAMES[tick % SPINNER_FRAMES.length];
        const lines = instances.map((inst) => {
          const name = inst.name.padEnd(30);
          const isDone = TERMINAL_STATUSES.has(inst.status);
          const prefix = isDone
            ? '\x1b[32m\u2714\x1b[0m'
            : `\x1b[36m${spinner}\x1b[0m`;
          const color = isDone ? '\x1b[32m' : statusColor(inst.status);
          const statusText = `${color}${inst.status.padEnd(12)}\x1b[0m`;
          const duration = `  \x1b[90m(${formatDuration(Date.now() - startTime)})\x1b[0m`;
          return `  ${prefix} ${name}  ${statusText}${duration}`;
        });

        const block = lines.join('\n');
        clearLines(lastPrinted);
        console.log(block);
        lastPrinted = block;

        if (allTerminal) {
          break;
        }

        if (Date.now() - startTime > MAX_POLL_TIME_MS) {
          console.log('');
          console.log(
            '\x1b[33mTimeout waiting for graceful stop. Forcing K8s cleanup...\x1b[0m',
          );
          break;
        }

        tick++;
        await sleep(
          tick % (POLL_INTERVAL_MS / RENDER_INTERVAL_MS) === 0
            ? RENDER_INTERVAL_MS
            : RENDER_INTERVAL_MS,
        );
      }
    }

    // Delete run via CT
    await fetchAction(`${ctUrl}/runs/${runId}`, 'DELETE');
  }

  // Phase 2: Force-delete any remaining K8s namespaces
  const remaining = findDokkimiNamespaces();
  if (remaining.length > 0) {
    console.log('');
    console.log(
      `Cleaning ${remaining.length} remaining K8s namespace${remaining.length === 1 ? '' : 's'}...`,
    );
    deleteNamespaces(remaining);
  }

  // Phase 3: Clean up orphaned registry credential secrets from dokkimi-system
  deleteOrphanedRegistrySecrets();

  console.log('');
  console.log(
    `\x1b[32mClean complete.\x1b[0m  \x1b[90m(${formatDuration(Date.now() - startTime)})\x1b[0m`,
  );
  console.log('');
}

/**
 * Clean directly via kubectl when CT is not running.
 */
async function cleanDirectK8s(
  force: boolean,
  namespaces: string[],
): Promise<void> {
  if (namespaces.length === 0) {
    console.log('No Dokkimi namespaces found. Nothing to clean.');
    process.exit(0);
  }

  console.log('');
  console.log(
    `Dokkimi is not running. Found ${namespaces.length} K8s namespace${namespaces.length === 1 ? '' : 's'} to clean up directly.`,
  );
  for (const ns of namespaces) {
    console.log(`  \x1b[90m${ns}\x1b[0m`);
  }
  console.log('');

  if (!force) {
    const answer = await prompt('Delete all Dokkimi namespaces? (Y/n) ');
    if (answer === 'n' || answer === 'no') {
      console.log('Aborted.');
      process.exit(0);
    }
  }

  const startTime = Date.now();
  deleteNamespaces(namespaces);

  // Clean up orphaned registry credential secrets from dokkimi-system
  deleteOrphanedRegistrySecrets();

  console.log('');
  console.log(
    `\x1b[32mClean complete.\x1b[0m  \x1b[90m(${formatDuration(Date.now() - startTime)})\x1b[0m`,
  );
  console.log('');
}

// ---------------------------------------------------------------------------
// K8s helpers
// ---------------------------------------------------------------------------

function findDokkimiNamespaces(): string[] {
  try {
    const output = execSilent(
      "kubectl get namespaces -o jsonpath='{.items[*].metadata.name}'",
      { timeout: 10000 },
    );
    return output
      .split(/\s+/)
      .filter(
        (ns: string) =>
          ns.startsWith(DOKKIMI_NS_PREFIX) && ns !== SYSTEM_NAMESPACE,
      );
  } catch {
    return [];
  }
}

function deleteOrphanedRegistrySecrets(): void {
  try {
    const output = execSilent(
      `kubectl get secrets -n ${SYSTEM_NAMESPACE} -l dokkimi.io/resource-type=registry-credentials -o jsonpath='{.items[*].metadata.name}'`,
      { timeout: 10000 },
    );
    const secrets = output.split(/\s+/).filter(Boolean);
    if (secrets.length === 0) {
      return;
    }

    console.log('');
    console.log(
      `Cleaning ${secrets.length} orphaned registry secret${secrets.length === 1 ? '' : 's'}...`,
    );
    for (const name of secrets) {
      try {
        execSilent(`kubectl delete secret ${name} -n ${SYSTEM_NAMESPACE}`, {
          timeout: 10000,
        });
      } catch (err) {
        console.log(
          `  \x1b[33mFailed to delete secret ${name}: ${err instanceof Error ? err.message : err}\x1b[0m`,
        );
      }
    }
  } catch {
    // kubectl not available or dokkimi-system doesn't exist — skip silently
  }
}

function deleteNamespaces(namespaces: string[]): void {
  for (const ns of namespaces) {
    try {
      console.log(`  Deleting ${ns}...`);
      execSilent(`kubectl delete namespace ${ns} --wait=false`, {
        timeout: 15000,
      });
    } catch (err) {
      console.log(
        `  \x1b[33mFailed to delete ${ns}: ${err instanceof Error ? err.message : err}\x1b[0m`,
      );
    }
  }
}
