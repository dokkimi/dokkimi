import path from 'path';
import fs from 'fs';
import os from 'os';
import { processStartTime } from '@dokkimi/platform';

export const DOKKIMI_DIR = path.join(os.homedir(), '.dokkimi');
export const DAEMON_JSON = path.join(DOKKIMI_DIR, 'daemon.json');
export const DAEMON_LOCK = path.join(DOKKIMI_DIR, 'daemon.lock');
export const LOGS_DIR = path.join(DOKKIMI_DIR, 'logs');

export interface DaemonState {
  startedAt: string;
  shuttingDown?: boolean;
  pid?: number;
  /** When the process with that pid was started (ms), to tell it from a later process given the same pid */
  pidStartedAt?: number;
}

export function readDaemonState(): DaemonState | null {
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

export function writeDaemonState(state: DaemonState): void {
  fs.mkdirSync(DOKKIMI_DIR, { recursive: true });
  const tmp = DAEMON_JSON + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
  fs.renameSync(tmp, DAEMON_JSON);
}

export function deleteDaemonState(): void {
  try {
    fs.unlinkSync(DAEMON_JSON);
  } catch {}
}

/**
 * Whether pid is still the process that started at startedAt (ms). A pid is
 * reused once its process ends, often after a reboot: without this check,
 * Dokkimi would kill, or wait on, whatever process has it now.
 */
export function isSameProcess(pid: number, startedAt: number): boolean {
  const actual = processStartTime(pid);
  // The OS reports the start to the second
  return actual !== null && Math.abs(actual - startedAt) < 3000;
}

/** The daemon's pid, when that process is still running */
export function getControlTowerPid(state: DaemonState | null): number | null {
  if (
    typeof state?.pid !== 'number' ||
    typeof state.pidStartedAt !== 'number'
  ) {
    return null;
  }
  return isSameProcess(state.pid, state.pidStartedAt) ? state.pid : null;
}

export async function acquireLock(
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<() => void> {
  fs.mkdirSync(DOKKIMI_DIR, { recursive: true });
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    signal?.throwIfAborted();
    try {
      const fd = fs.openSync(DAEMON_LOCK, 'wx');
      fs.writeSync(fd, `${process.pid} ${Math.round(performance.timeOrigin)}`);
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

      // The lock is stale when its holder has ended: its pid is gone, or now
      // belongs to another process
      try {
        const [lockPid, lockStartedAt] = fs
          .readFileSync(DAEMON_LOCK, 'utf8')
          .trim()
          .split(' ')
          .map(Number);
        if (
          !isNaN(lockPid) &&
          !isNaN(lockStartedAt) &&
          !isSameProcess(lockPid, lockStartedAt)
        ) {
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
