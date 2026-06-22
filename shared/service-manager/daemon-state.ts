import path from 'path';
import fs from 'fs';
import os from 'os';
import { isProcessAlive } from '@dokkimi/platform';

export const DOKKIMI_DIR = path.join(os.homedir(), '.dokkimi');
export const DAEMON_JSON = path.join(DOKKIMI_DIR, 'daemon.json');
export const DAEMON_LOCK = path.join(DOKKIMI_DIR, 'daemon.lock');
export const LOGS_DIR = path.join(DOKKIMI_DIR, 'logs');

export interface DaemonState {
  startedAt: string;
  shuttingDown?: boolean;
  pid?: number;
  services?: Record<string, { pid: number }>;
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

export function getControlTowerPid(state: DaemonState | null): number | null {
  if (!state) {
    return null;
  }
  if (typeof state.pid === 'number') {
    return state.pid;
  }
  return state.services?.controlTower?.pid ?? null;
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

      try {
        const lockPid = parseInt(
          fs.readFileSync(DAEMON_LOCK, 'utf8').trim(),
          10,
        );
        if (!isNaN(lockPid) && !isProcessAlive(lockPid)) {
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
