import {
  prompt,
  fetchJson,
  fetchAction,
  checkService,
  sleep,
} from '../lib/cli-utils';
import { loadConfig, buildServiceUrl, DOKKIMI_DIR } from '@dokkimi/config';
import { getProjectPath, latestRunUrl } from '../lib/project-path';
import { formatDuration, statusColor } from '../lib/formatting';
import { clearLines } from '../lib/terminal';
import { execSilent } from '@dokkimi/platform';
import * as fs from 'fs';
import * as path from 'path';

const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
const POLL_INTERVAL_MS = 2000;
const RENDER_INTERVAL_MS = 100;
const MAX_POLL_TIME_MS = 60000;

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
    console.log('');
    console.log('Options:');
    console.log('  --all          Clean all projects (not just current)');
    console.log('  --force, -f    Skip confirmation prompt');
    console.log('  --json         Output results as JSON (implies --force)');
    console.log('  --help, -h     Show this help message');
    process.exit(0);
  }

  const jsonMode = args.includes('--json');
  const force = jsonMode || args.includes('--force') || args.includes('-f');
  const all = args.includes('--all');

  const config = loadConfig();
  const ctUrl = buildServiceUrl(config.services.controlTower);

  // Check CT is running
  const ctCheck = await checkService('Dokkimi', ctUrl);

  // Find orphaned Docker resources regardless of CT status
  const orphanedContainers = findDokkimiContainers();

  if (jsonMode) {
    const nothingToClean = ctCheck.healthy
      ? await isNothingToCleanCT(ctUrl, orphanedContainers)
      : orphanedContainers.length === 0;

    if (nothingToClean && !all) {
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
        await cleanViaCT(ctUrl, true, orphanedContainers, all);
      } else {
        await cleanDirectDocker(true, orphanedContainers);
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
    await cleanViaCT(ctUrl, force, orphanedContainers, all);
  } else {
    await cleanDirectDocker(force, orphanedContainers);
  }
}

async function isNothingToCleanCT(
  ctUrl: string,
  orphanedContainers: string[],
): Promise<boolean> {
  const projectPath = getProjectPath();
  const latestRun = await fetchJson<RunStatus>(
    latestRunUrl(ctUrl, projectPath),
  );
  const instanceCount = latestRun?.instances?.length ?? 0;
  return instanceCount === 0 && orphanedContainers.length === 0;
}

/**
 * Clean via CT API (graceful path), then clean any remaining Docker resources.
 */
async function cleanViaCT(
  ctUrl: string,
  force: boolean,
  orphanedContainers: string[],
  all = false,
): Promise<void> {
  // --all: delete all runs across all projects via bulk endpoint
  if (all) {
    if (!force) {
      const answer = await prompt(
        'Delete all runs across all projects? (Y/n) ',
      );
      if (answer === 'n' || answer === 'no') {
        console.log('Aborted.');
        process.exit(0);
      }
    }

    const startTime = Date.now();
    await fetchAction(`${ctUrl}/runs/all`, 'DELETE');
    cleanupDokkimiDockerResources();

    console.log('');
    console.log(
      `\x1b[32mClean complete (all projects).\x1b[0m  \x1b[90m(${formatDuration(Date.now() - startTime)})\x1b[0m`,
    );
    console.log('');
    return;
  }

  const projectPath = getProjectPath();
  const latestRun = await fetchJson<RunStatus>(
    latestRunUrl(ctUrl, projectPath),
  );

  const hasRun = latestRun && latestRun.instances.length > 0;
  const active = hasRun
    ? latestRun!.instances.filter((i) => !TERMINAL_STATUSES.has(i.status))
    : [];
  const stopped = hasRun
    ? latestRun!.instances.filter((i) => TERMINAL_STATUSES.has(i.status))
    : [];

  const totalToClean =
    active.length + stopped.length + orphanedContainers.length;

  if (totalToClean === 0) {
    console.log('No instances or containers found. Nothing to clean.');
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
  if (orphanedContainers.length > 0) {
    console.log(
      `Found ${orphanedContainers.length} orphaned Docker container${orphanedContainers.length === 1 ? '' : 's'}.`,
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
            ? '\x1b[32m✔\x1b[0m'
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
            '\x1b[33mTimeout waiting for graceful stop. Forcing Docker cleanup...\x1b[0m',
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

    // Delete all runs for current project
    const deleteUrl = projectPath
      ? `${ctUrl}/runs/all?projectPath=${encodeURIComponent(projectPath)}`
      : `${ctUrl}/runs/${runId}`;
    await fetchAction(deleteUrl, 'DELETE');
  }

  // Phase 2: Force-remove any remaining Docker containers and networks
  cleanupDokkimiDockerResources();

  console.log('');
  console.log(
    `\x1b[32mClean complete.\x1b[0m  \x1b[90m(${formatDuration(Date.now() - startTime)})\x1b[0m`,
  );
  console.log('');
}

/**
 * Clean directly via Docker when CT is not running.
 */
async function cleanDirectDocker(
  force: boolean,
  containers: string[],
): Promise<void> {
  if (containers.length === 0) {
    // Also check for orphaned networks
    const networks = findDokkimiNetworks();
    if (networks.length === 0) {
      console.log('No Dokkimi containers or networks found. Nothing to clean.');
      process.exit(0);
    }
  }

  console.log('');
  console.log(
    `Dokkimi is not running. Found Docker resources to clean up directly.`,
  );
  if (containers.length > 0) {
    console.log(`  ${containers.length} container(s)`);
  }
  console.log('');

  if (!force) {
    const answer = await prompt('Delete all Dokkimi Docker resources? (Y/n) ');
    if (answer === 'n' || answer === 'no') {
      console.log('Aborted.');
      process.exit(0);
    }
  }

  const startTime = Date.now();
  cleanupDokkimiDockerResources();

  console.log('');
  console.log(
    `\x1b[32mClean complete.\x1b[0m  \x1b[90m(${formatDuration(Date.now() - startTime)})\x1b[0m`,
  );
  console.log('');
}

// ---------------------------------------------------------------------------
// Docker helpers
// ---------------------------------------------------------------------------

function findDokkimiContainers(): string[] {
  try {
    const output = execSilent(
      'docker ps -a --filter "label=dokkimi" --format "{{.Names}}"',
      { timeout: 10000 },
    );
    return output.split('\n').filter(Boolean);
  } catch {
    return [];
  }
}

function findDokkimiNetworks(): string[] {
  try {
    const output = execSilent(
      'docker network ls --filter "label=dokkimi" --format "{{.Name}}"',
      { timeout: 10000 },
    );
    return output.split('\n').filter(Boolean);
  } catch {
    return [];
  }
}

function cleanupDokkimiDockerResources(): void {
  // Remove containers
  const containers = findDokkimiContainers();
  if (containers.length > 0) {
    console.log('');
    console.log(
      `Removing ${containers.length} Docker container${containers.length === 1 ? '' : 's'}...`,
    );
    for (const name of containers) {
      try {
        execSilent(`docker rm -f ${name}`, { timeout: 10000 });
      } catch (err) {
        console.log(
          `  \x1b[33mFailed to remove container ${name}: ${err instanceof Error ? err.message : err}\x1b[0m`,
        );
      }
    }
  }

  // Remove networks
  const networks = findDokkimiNetworks();
  if (networks.length > 0) {
    console.log('');
    console.log(
      `Removing ${networks.length} Docker network${networks.length === 1 ? '' : 's'}...`,
    );
    for (const name of networks) {
      try {
        execSilent(`docker network rm ${name}`, { timeout: 10000 });
      } catch (err) {
        console.log(
          `  \x1b[33mFailed to remove network ${name}: ${err instanceof Error ? err.message : err}\x1b[0m`,
        );
      }
    }
  }

  // Remove legacy global storage
  cleanupLegacyStorage();
}

function cleanupLegacyStorage(): void {
  const dirs = [
    path.join(DOKKIMI_DIR, 'storage'),
    path.join(DOKKIMI_DIR, 'generated'),
  ];
  for (const dir of dirs) {
    try {
      fs.rmSync(dir, { recursive: true });
    } catch {}
  }

  const projectPath = getProjectPath();
  if (projectPath) {
    const runsDir = path.join(projectPath, '.dokkimi', '__runs__');
    try {
      fs.rmSync(runsDir, { recursive: true });
    } catch {}
  }
}
