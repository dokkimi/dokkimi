import path from 'path';
import fs from 'fs';
import os from 'os';
import { spawn } from 'child_process';
import { DokkimiConfig, buildServiceUrl } from '@dokkimi/config';
import {
  isProcessAlive,
  killProcess,
  execSilent,
  isCommandAvailable,
  startDocker,
} from '@dokkimi/platform';

// ---------------------------------------------------------------------------
// Constants — post-consolidation there is exactly one service.
// ---------------------------------------------------------------------------

const SERVICE_DIRECTORY = 'control-tower';
const SERVICE_LABEL = 'Control Tower';
const SERVICE_ID = 'control-tower';

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

// daemon.json schema. `services` is tolerated for cleanup of pre-consolidation
// installs that wrote an LPS/TVS/CWS entry map — see shutdownServices.
interface DaemonState {
  startedAt: string;
  shuttingDown?: boolean;
  pid?: number;
  services?: Record<string, { pid: number }>;
}

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const DOKKIMI_DIR = path.join(os.homedir(), '.dokkimi');
const DAEMON_JSON = path.join(DOKKIMI_DIR, 'daemon.json');
const DAEMON_LOCK = path.join(DOKKIMI_DIR, 'daemon.lock');
const LOGS_DIR = path.join(DOKKIMI_DIR, 'logs');

// ---------------------------------------------------------------------------
// Daemon state helpers
// ---------------------------------------------------------------------------

function readDaemonState(): DaemonState | null {
  try {
    const raw = fs.readFileSync(DAEMON_JSON, 'utf8');
    const state = JSON.parse(raw) as DaemonState;
    if (state.shuttingDown) {
      return null;
    }
    return state;
  } catch {
    return null;
  }
}

function writeDaemonState(state: DaemonState): void {
  fs.mkdirSync(DOKKIMI_DIR, { recursive: true });
  const tmp = DAEMON_JSON + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
  fs.renameSync(tmp, DAEMON_JSON);
}

function deleteDaemonState(): void {
  try {
    fs.unlinkSync(DAEMON_JSON);
  } catch {}
}

/**
 * Returns the Control Tower PID from daemon.json, tolerating both the new
 * flat shape (`state.pid`) and the legacy pre-consolidation shape
 * (`state.services.controlTower.pid`).
 */
function getControlTowerPid(state: DaemonState | null): number | null {
  if (!state) {
    return null;
  }
  if (typeof state.pid === 'number') {
    return state.pid;
  }
  return state.services?.controlTower?.pid ?? null;
}

// ---------------------------------------------------------------------------
// Process helpers (delegated to @dokkimi/platform)
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Health check
// ---------------------------------------------------------------------------

interface HealthResponse {
  status: string;
  service?: string;
}

async function checkHealth(
  url: string,
): Promise<{ healthy: boolean; detail?: string }> {
  try {
    const res = await fetch(`${url}/health`, {
      signal: AbortSignal.timeout(2000),
    });
    if (!res.ok) {
      return { healthy: false, detail: `HTTP ${res.status}` };
    }
    const body = (await res.json()) as HealthResponse;
    // Verify it's our service (not a foreign process on the same port)
    if (body.service && body.service !== SERVICE_ID) {
      return { healthy: false, detail: `wrong service: ${body.service}` };
    }
    // HTTP 200 + valid service identity = the process is up.
    // "unhealthy" or "degraded" means a downstream dependency is down,
    // not that the service itself needs to be respawned.
    return { healthy: true };
  } catch {
    return { healthy: false, detail: 'not reachable' };
  }
}

// ---------------------------------------------------------------------------
// Locking (simple file-based)
// ---------------------------------------------------------------------------

async function acquireLock(
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<() => void> {
  fs.mkdirSync(DOKKIMI_DIR, { recursive: true });
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    signal?.throwIfAborted();
    try {
      // Exclusive create — fails if file already exists
      const fd = fs.openSync(DAEMON_LOCK, 'wx');
      fs.writeSync(fd, String(process.pid));
      fs.closeSync(fd);
      return () => {
        try {
          fs.unlinkSync(DAEMON_LOCK);
        } catch {}
      };
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') {
        throw err;
      }

      // Check for stale lock
      try {
        const lockPid = parseInt(
          fs.readFileSync(DAEMON_LOCK, 'utf8').trim(),
          10,
        );
        if (!isNaN(lockPid) && !isProcessAlive(lockPid)) {
          // Stale lock — remove and retry
          try {
            fs.unlinkSync(DAEMON_LOCK);
          } catch {}
          continue;
        }
      } catch {}

      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
  throw new Error('Timed out waiting for daemon.lock');
}

// ---------------------------------------------------------------------------
// Docker helpers
// ---------------------------------------------------------------------------

function isDockerRunning(): boolean {
  try {
    execSilent('docker info', { timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

function isKubernetesRunning(): boolean {
  try {
    const output = execSilent('kubectl cluster-info', { timeout: 10000 });
    return output.includes('is running at');
  } catch {
    return false;
  }
}

async function ensureDockerAndK8sRunning(
  timeoutMs: number = 120000,
  signal?: AbortSignal,
): Promise<void> {
  // Fail fast if required binaries are not installed
  if (!isCommandAvailable('docker')) {
    throw new Error(
      'Docker is not installed. Install Docker Desktop from https://www.docker.com/products/docker-desktop/',
    );
  }
  if (!isCommandAvailable('kubectl')) {
    throw new Error(
      'kubectl is not installed. Enable Kubernetes in Docker Desktop (Settings → Kubernetes → Enable Kubernetes).',
    );
  }

  const needsDockerStart = !isDockerRunning();

  if (needsDockerStart) {
    console.log('[Dokkimi] Docker is not running. Starting Docker...');
    startDocker();
  }

  if (!needsDockerStart && isKubernetesRunning()) {
    return;
  }

  const deadline = Date.now() + timeoutMs;
  let dockerReady = !needsDockerStart;
  let dockerBecameReadyAt: number | null = dockerReady ? Date.now() : null;
  let pollCount = 0;

  while (Date.now() < deadline) {
    signal?.throwIfAborted();

    if (!dockerReady) {
      dockerReady = isDockerRunning();
      if (dockerReady) {
        dockerBecameReadyAt = Date.now();
        console.log('[Dokkimi] Docker is ready. Waiting for Kubernetes...');
      }
    }

    if (dockerReady && isKubernetesRunning()) {
      console.log('[Dokkimi] Kubernetes is ready.');
      return;
    }

    // If Docker has been running for 15s and K8s still isn't up,
    // it's likely not enabled — fail early with a clear message.
    if (dockerReady && dockerBecameReadyAt) {
      const k8sWait = Date.now() - dockerBecameReadyAt;
      if (k8sWait > 15000) {
        throw new Error(
          'Kubernetes is not running. Enable it in Docker Desktop (Settings → Kubernetes → Enable Kubernetes), then restart Docker Desktop.',
        );
      }
    }

    pollCount++;
    if (pollCount % 5 === 0) {
      const elapsed = Math.round((Date.now() - (deadline - timeoutMs)) / 1000);
      if (!dockerReady) {
        console.log(`[Dokkimi] Waiting for Docker... (${elapsed}s elapsed)`);
      } else {
        console.log(
          `[Dokkimi] Waiting for Kubernetes... (${elapsed}s elapsed)`,
        );
      }
    }

    await new Promise((resolve) => setTimeout(resolve, 2000));
  }

  if (!dockerReady) {
    throw new Error(
      'Timed out waiting for Docker to start. Please start Docker Desktop manually.',
    );
  }
  throw new Error(
    'Timed out waiting for Kubernetes. Ensure Kubernetes is enabled in Docker Desktop settings.',
  );
}

// ---------------------------------------------------------------------------
// Prisma migration
// ---------------------------------------------------------------------------

/**
 * Runs `prisma migrate deploy` to apply any pending database migrations.
 * Idempotent — only applies migrations that haven't been run yet.
 * Surfaces failures as warnings so users can diagnose install issues
 * (if we swallow them, Control Tower will later hit "table does not exist"
 * errors that are much harder to trace back to the real cause).
 */
function runPrismaMigrate(appRoot: string, config: DokkimiConfig): void {
  const schemaPath = path.join(
    appRoot,
    'shared',
    'prisma',
    'sqlite',
    'schema.prisma',
  );
  const configPath = path.join(appRoot, 'shared', 'prisma', 'prisma.config.ts');
  if (!fs.existsSync(schemaPath)) {
    console.warn(
      `[Dokkimi] Skipping database migration: schema not found at ${schemaPath}`,
    );
    return;
  }
  if (!fs.existsSync(configPath)) {
    console.warn(
      `[Dokkimi] Skipping database migration: prisma.config.ts not found at ${configPath}. ` +
        `Prisma v7 requires this file to supply the datasource URL.`,
    );
    return;
  }

  // Resolve the database URL (expand ~ to homedir)
  const dbUrl = config.database.url.replace(/^file:~/, `file:${os.homedir()}`);

  // Try local prisma binary first, fall back to npx
  const localPrisma = path.join(appRoot, 'node_modules', '.bin', 'prisma');
  const prismaBin = fs.existsSync(localPrisma)
    ? `"${localPrisma}"`
    : 'npx prisma';

  try {
    // Prisma v7 requires the datasource URL from prisma.config.ts — the
    // schema can no longer contain `url`. Pass --config explicitly so the
    // CLI doesn't rely on CWD-based auto-discovery.
    execSilent(`${prismaBin} migrate deploy --config="${configPath}"`, {
      cwd: appRoot,
      env: { ...process.env, DATABASE_URL: dbUrl },
      // 2 minutes — cold starts (npx fetch, prisma engine load, first-time
      // migrate) can easily exceed 15s, especially on slower/fresh machines.
      timeout: 120000,
    });
  } catch (err) {
    const execErr = err as {
      message?: string;
      stdout?: Buffer | string;
      stderr?: Buffer | string;
    };
    const stderr = execErr.stderr?.toString().trim() ?? '';
    const stdout = execErr.stdout?.toString().trim() ?? '';
    const detail = stderr || stdout || execErr.message || String(err);
    console.warn(
      `[Dokkimi] Database migration failed — Control Tower will likely fail health checks.\n` +
        `  Schema: ${schemaPath}\n` +
        `  DATABASE_URL: ${dbUrl}\n` +
        `  Prisma binary: ${prismaBin}\n` +
        `  Error:\n${detail
          .split('\n')
          .map((l) => `    ${l}`)
          .join('\n')}`,
    );
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Ensure Control Tower is running as a background daemon.
 */
export async function ensureServicesRunning(
  appRoot: string,
  config: DokkimiConfig,
  timeoutMs: number = 60000,
  signal?: AbortSignal,
): Promise<void> {
  // Start Docker before acquiring the lock — lets Docker boot in parallel
  // with any other caller that may already hold the lock.
  await ensureDockerAndK8sRunning(120000, signal);

  const lockTimeoutMs = timeoutMs + 60000;
  const releaseLock = await acquireLock(lockTimeoutMs, signal);

  try {
    signal?.throwIfAborted();

    // Ensure database migrations are applied before spawning services
    runPrismaMigrate(appRoot, config);

    const state = readDaemonState();
    const url = buildServiceUrl(config.services.controlTower);
    const health = await checkHealth(url);

    // Health check is the source of truth. PID liveness is only used
    // to decide whether to kill a stale process before respawning.
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

    // Log file path — the service's ColoredLoggerService writes here
    // with built-in rotation (10 MB max, 1 backup). The fd below is
    // a fallback for uncaught errors / framework output that bypasses
    // the NestJS logger.
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

    // Poll /health until healthy
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

/**
 * Shut down Control Tower and any orphaned pre-consolidation daemons.
 *
 * Reads both the new flat shape (`state.pid`) and the legacy
 * `state.services.*` map, so an upgraded desktop cleans up stray LPS/TVS/CWS
 * PIDs that a prior install wrote.
 */
export async function shutdownServices(): Promise<void> {
  const releaseLock = await acquireLock(30000);

  try {
    const state = readDaemonState();
    if (!state) {
      console.log('[Dokkimi] Not running.');
      return;
    }

    // Signal intentional shutdown
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

/**
 * Get the status of Control Tower.
 *
 * Returns health-check results combined with daemon.json PID info.
 * Used by `dokkimi status` and internally by `ensureServicesRunning`.
 */
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

/**
 * Resolves the monorepo root from the compiled JS __dirname.
 *
 * Callers pass their own __dirname so the traversal is correct regardless
 * of whether this runs from electron/dist/ or cli/dist/bin/.
 */
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
