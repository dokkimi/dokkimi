import path from 'path';
import fs from 'fs';
import { spawn } from 'child_process';
import {
  DokkimiConfig,
  DOKKIMI_VERSION,
  buildServiceUrl,
  concurrencyDifference,
  resolveConcurrency,
} from '@dokkimi/config';
import { isProcessAlive, killProcess } from '@dokkimi/platform';

import {
  LOGS_DIR,
  readDaemonState,
  writeDaemonState,
  deleteDaemonState,
  getControlTowerPid,
  acquireLock,
} from './daemon-state';
import {
  checkHealth,
  ensureDockerRunning,
  runPrismaMigrate,
  type Health,
} from './environment';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SERVICE_DIRECTORY = 'control-tower';

// How long a running daemon that doesn't answer is waited for before it is
// restarted: it may be busy, or still starting
const UNRESPONSIVE_GRACE_MS = 20000;

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface ServiceStatus {
  running: boolean;
  startedAt: string | null;
  healthy: boolean;
  pid: number | null;
  port: number;
  detail?: string;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function ensureServicesRunning(
  appRoot: string,
  config: DokkimiConfig,
  timeoutMs: number = 60000,
  signal?: AbortSignal,
): Promise<void> {
  const { host } = config.services.controlTower;
  const url = buildServiceUrl(config.services.controlTower);

  // A healthy remote Control Tower (CONTROL_TOWER_HOST) owns its own Docker.
  // A local one still needs local Docker, which may have been quit since it
  // started, and its health check does not cover Docker.
  const isLocal =
    host === 'localhost' || host === '127.0.0.1' || host === '0.0.0.0';
  if (isLocal || !(await checkHealth(url)).healthy) {
    await ensureDockerRunning(120000, signal);
  }

  const lockTimeoutMs = timeoutMs + 60000;
  const releaseLock = await acquireLock(lockTimeoutMs, signal);

  try {
    signal?.throwIfAborted();

    runPrismaMigrate(appRoot, config);

    const state = readDaemonState();
    const pid = getControlTowerPid(state);
    let health = await checkHealth(url);
    if (!health.healthy && pid !== null) {
      health = await waitForHealth(url, UNRESPONSIVE_GRACE_MS, signal);
    }

    if (health.healthy) {
      if (!isLocal) {
        return;
      }
      // A daemon of another version (e.g. still running after an upgrade),
      // or with other concurrency than this command's (a changed DOKKIMI_MAX_*
      // variable or saved setting: the daemon read them when it started)
      const differences = [
        health.version !== DOKKIMI_VERSION &&
          `version ${health.version ?? '(unknown)'}, not ${DOKKIMI_VERSION}`,
        health.concurrency &&
          concurrencyDifference(health.concurrency, resolveConcurrency(config)),
      ].filter((d): d is string => typeof d === 'string');
      if (differences.length === 0) {
        return;
      }
      // Restart it, unless that would end a run
      const difference = differences.join('; ');
      if (pid === null || health.activeRun) {
        const running = `[Dokkimi] Control Tower is running with ${difference}.`;
        console.warn(
          pid === null
            ? `${running} It wasn't started by this CLI, so it is used; stop it to switch.`
            : `${running} It is running tests, so it is used for now; it is restarted on a later command once they're done.`,
        );
        return;
      }
      console.log(`[Dokkimi] Restarting Control Tower (${difference})`);
      await stopProcess(pid);
    } else if (pid !== null) {
      console.log(
        `[Dokkimi] Restarting unresponsive Control Tower (pid ${pid})`,
      );
      await stopProcess(pid);
    }

    console.log('[Dokkimi] Starting...');

    const servicePath = path.join(appRoot, 'services', SERVICE_DIRECTORY);

    fs.mkdirSync(LOGS_DIR, { recursive: true });
    const logPath = path.join(LOGS_DIR, `${SERVICE_DIRECTORY}.log`);
    const fallbackPath = path.join(LOGS_DIR, `${SERVICE_DIRECTORY}.stderr.log`);
    const fallbackFd = fs.openSync(fallbackPath, 'w');
    const stdio: import('child_process').StdioOptions = [
      'ignore',
      fallbackFd,
      fallbackFd,
    ];

    const proc = spawn('node', ['dist/main.js'], {
      cwd: servicePath,
      stdio,
      detached: true,
      env: {
        ...process.env,
        LOG_FILE: logPath,
        // Pin sidecar images to this release. Devs testing locally built
        // sidecars can override with DOKKIMI_APP_VERSION=latest.
        DOKKIMI_APP_VERSION: process.env.DOKKIMI_APP_VERSION ?? DOKKIMI_VERSION,
      },
    });

    proc.unref();
    fs.closeSync(fallbackFd);

    if (!proc.pid) {
      throw new Error('Failed to start Dokkimi');
    }

    writeDaemonState({
      startedAt: new Date().toISOString(),
      pid: proc.pid,
      pidStartedAt: Date.now(),
    });

    if ((await waitForHealth(url, timeoutMs, signal, true)).healthy) {
      console.log('[Dokkimi] Ready.');
      return;
    }
    throw new Error(
      'Timed out waiting for Dokkimi to start. ' +
        'Check logs at ~/.dokkimi/logs/ for details.',
    );
  } finally {
    releaseLock();
  }
}

export async function shutdownServices(): Promise<void> {
  const releaseLock = await acquireLock(30000);

  try {
    const state = readDaemonState();
    const pid = getControlTowerPid(state);
    if (pid === null) {
      // No state, or its process has ended (its pid may be another's now)
      deleteDaemonState();
      console.log('[Dokkimi] No Control Tower started by this CLI is running.');
      return;
    }

    writeDaemonState({ ...state!, shuttingDown: true });
    console.log('[Dokkimi] Stopping...');
    await stopProcess(pid);
    deleteDaemonState();
    console.log('[Dokkimi] Stopped.');
  } finally {
    releaseLock();
  }
}

export async function getServiceStatus(
  config: DokkimiConfig,
): Promise<ServiceStatus> {
  const state = readDaemonState();
  const svc = config.services.controlTower;
  const url = buildServiceUrl(svc);
  const health = await checkHealth(url);
  const pid = getControlTowerPid(state);

  return {
    running: health.healthy,
    startedAt: state?.startedAt ?? null,
    healthy: health.healthy,
    pid,
    port: svc.port,
    detail: health.detail,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Polls health until healthy or timeoutMs has passed; returns the last check */
async function waitForHealth(
  url: string,
  timeoutMs: number,
  signal?: AbortSignal,
  reportProgress = false,
): Promise<Health> {
  const start = Date.now();
  let health = await checkHealth(url);
  for (
    let polls = 1;
    !health.healthy && Date.now() - start < timeoutMs;
    polls++
  ) {
    signal?.throwIfAborted();
    if (reportProgress && polls % 5 === 0) {
      const elapsed = Math.round((Date.now() - start) / 1000);
      console.log(`[Dokkimi] Still starting... (${elapsed}s elapsed)`);
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
    health = await checkHealth(url);
  }
  return health;
}

/** Stops the daemon process, and throws if it is still running after */
async function stopProcess(pid: number): Promise<void> {
  const { forceKilled } = await killProcess(pid);
  if (forceKilled) {
    console.log(
      `[Dokkimi] Process (pid ${pid}) did not exit gracefully — force-killed.`,
    );
  }
  if (isProcessAlive(pid)) {
    throw new Error(`Control Tower (pid ${pid}) could not be stopped`);
  }
}

export function resolveAppRoot(callerDirname: string): string {
  let dir = callerDirname;
  for (let i = 0; i < 10; i++) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const pkg = require(path.join(dir, 'package.json'));
      if (pkg.workspaces) {
        return dir;
      }
    } catch {}
    dir = path.dirname(dir);
  }
  throw new Error(`Could not find monorepo root from ${callerDirname}`);
}
