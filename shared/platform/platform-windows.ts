import { execSync, execFileSync } from 'child_process';
import * as os from 'os';
import type { Platform, ExecOptions } from './platform';

export const windows: Platform = {
  isProcessAlive(pid: number): boolean {
    try {
      const output = execSync(`tasklist /FI "PID eq ${pid}" /NH`, {
        encoding: 'utf8',
        timeout: 3000,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      return output.includes(String(pid));
    } catch {
      return false;
    }
  },

  killProcess(pid: number): Promise<{ forceKilled: boolean }> {
    return new Promise((resolve) => {
      try {
        execSync(`taskkill /PID ${pid} /T`, {
          timeout: 3000,
          stdio: ['pipe', 'pipe', 'pipe'],
        });
      } catch {
        // Without /F, taskkill only asks the process to close, and fails at
        // once for one without a window, like the daemon: force it.
        if (!this.isProcessAlive(pid)) {
          resolve({ forceKilled: false });
          return;
        }
        try {
          execSync(`taskkill /PID ${pid} /T /F`, {
            timeout: 3000,
            stdio: ['pipe', 'pipe', 'pipe'],
          });
        } catch {}
        resolve({ forceKilled: true });
        return;
      }

      let checks = 0;
      const interval = setInterval(() => {
        checks++;
        if (!this.isProcessAlive(pid)) {
          clearInterval(interval);
          resolve({ forceKilled: false });
        } else if (checks >= 6) {
          clearInterval(interval);
          try {
            execSync(`taskkill /PID ${pid} /T /F`, {
              timeout: 3000,
              stdio: ['pipe', 'pipe', 'pipe'],
            });
          } catch {}
          resolve({ forceKilled: true });
        }
      }, 500);
    });
  },

  processStartTime(pid: number): number | null {
    try {
      const output = execFileSync(
        'powershell',
        [
          '-NoProfile',
          '-Command',
          `(Get-Process -Id ${Math.trunc(pid)}).StartTime.ToUniversalTime().ToString('o')`,
        ],
        { encoding: 'utf8', timeout: 10000, stdio: ['pipe', 'pipe', 'pipe'] },
      ).trim();
      const ms = Date.parse(output);
      return output && !isNaN(ms) ? ms : null;
    } catch {
      return null;
    }
  },

  execSilent(cmd: string, opts?: ExecOptions): string {
    return execSync(cmd, {
      encoding: 'utf8',
      timeout: opts?.timeout ?? 5000,
      cwd: opts?.cwd,
      env: opts?.env,
      input: opts?.input,
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
  },

  isCommandAvailable(cmd: string): boolean {
    try {
      execSync(`where ${cmd}`, {
        encoding: 'utf8',
        timeout: 3000,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      return true;
    } catch {
      return false;
    }
  },

  openFile(filePath: string): void {
    const editor = process.env.EDITOR;
    if (editor) {
      try {
        execFileSync(editor, [filePath], { stdio: 'ignore' });
        return;
      } catch {}
    }
    try {
      execFileSync('cmd', ['/c', 'start', '""', filePath], { stdio: 'ignore' });
    } catch {}
  },

  startDocker(): void {
    try {
      execFileSync(
        'cmd',
        [
          '/c',
          'start',
          '""',
          'C:\\Program Files\\Docker\\Docker\\Docker Desktop.exe',
        ],
        { stdio: ['pipe', 'pipe', 'pipe'], timeout: 5000 },
      );
    } catch {}
  },

  getDiskSpaceAvailable(): number | null {
    try {
      const drive = os.homedir().slice(0, 2);
      const output = execSync(
        `wmic logicaldisk where "DeviceID='${drive}'" get FreeSpace /value`,
        { encoding: 'utf8', timeout: 5000, stdio: ['pipe', 'pipe', 'pipe'] },
      ).trim();
      const match = output.match(/FreeSpace=(\d+)/);
      if (!match) {
        return null;
      }
      return parseInt(match[1], 10) / (1024 * 1024 * 1024);
    } catch {
      return null;
    }
  },
};
