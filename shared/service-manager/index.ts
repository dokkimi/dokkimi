import path from 'path';
import fs from 'fs';
import { spawn } from 'child_process';
import { DokkimiConfig, buildServiceUrl } from '@dokkimi/config';
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
} from './environment';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SERVICE_DIRECTORY = 'control-tower';
const SERVICE_LABEL = 'Control Tower';

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
  await ensureDockerRunning(120000, signal);

  const lockTimeoutMs = timeoutMs + 60000;
  const releaseLock = await acquireLock(lockTimeoutMs, signal);

  try {
    signal?.throwIfAborted();

    runPrismaMigrate(appRoot, config);

    const state = readDaemonState();
    const url = buildServiceUrl(config.services.controlTower);
    const health = await checkHealth(url);

    if (health.healthy) {
      return;
    }

    const pid = getControlTowerPid(state);
    if (pid !== null && isProcessAlive(pid)) {
      console.log(`[Dokkimi] Stopping stale process (pid ${pid})`);
      await killProcess(pid);
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
      env: { ...process.env, LOG_FILE: logPath },
    });

    proc.unref();
    fs.closeSync(fallbackFd);

    if (!proc.pid) {
      throw new Error('Failed to start Dokkimi');
    }

    const startedAt = state?.startedAt ?? new Date().toISOString();
    writeDaemonState({
      startedAt,
      pid: proc.pid,
    });

    const deadline = Date.now() + timeoutMs;
    let pollCount = 0;

    while (Date.now() < deadline) {
      signal?.throwIfAborted();
      const result = await checkHealth(url);
      if (result.healthy) {
        console.log('[Dokkimi] Ready.');
        return;
      }
      pollCount++;
      if (pollCount % 5 === 0) {
        const elapsed = Math.round(
          (Date.now() - (deadline - timeoutMs)) / 1000,
        );
        console.log(`[Dokkimi] Still starting... (${elapsed}s elapsed)`);
      }
      await new Promise((resolve) => setTimeout(resolve, 1000));
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
    if (!state) {
      console.log('[Dokkimi] Not running.');
      return;
    }

    writeDaemonState({ ...state, shuttingDown: true });

    console.log('[Dokkimi] Stopping...');

    const pidsToKill: Array<{ name: string; pid: number }> = [];
    if (typeof state.pid === 'number') {
      pidsToKill.push({ name: SERVICE_LABEL, pid: state.pid });
    }
    if (state.services) {
      for (const [name, entry] of Object.entries(state.services)) {
        pidsToKill.push({ name, pid: entry.pid });
      }
    }

    await Promise.all(
      pidsToKill.map(async ({ pid }) => {
        const { forceKilled } = await killProcess(pid);
        if (forceKilled) {
          console.log(
            `[Dokkimi] Process (pid ${pid}) did not exit gracefully — force-killed.`,
          );
        }
      }),
    );

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
