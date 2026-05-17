import { execSync, execFileSync, spawn } from 'child_process';
import * as os from 'os';
import type {
  Platform,
  ExecOptions,
  SpawnOptions,
  SpawnResult,
} from './platform';

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
        resolve({ forceKilled: false });
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

  findProcessesByPattern(pattern: string): number[] {
    try {
      const output = execSync(
        `wmic process where "CommandLine like '%${pattern.replace(/'/g, "\\'")}%'" get ProcessId`,
        { encoding: 'utf8', timeout: 5000, stdio: ['pipe', 'pipe', 'pipe'] },
      );
      return output
        .split('\n')
        .map((line) => parseInt(line.trim(), 10))
        .filter((pid) => !isNaN(pid) && pid !== process.pid);
    } catch {
      return [];
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

  spawnInShell(
    cmd: string,
    args: string[],
    opts: SpawnOptions,
    callback: (err: Error | null) => void,
  ): SpawnResult {
    const proc = spawn(cmd, args, {
      cwd: opts.cwd,
      env: opts.env ?? process.env,
      shell: 'cmd.exe',
      stdio: 'ignore',
      windowsHide: true,
    });

    proc.on('close', (code) => {
      callback(
        code === 0 ? null : new Error(`Process exited with code ${code}`),
      );
    });

    proc.on('error', (err) => {
      callback(err);
    });

    return { process: proc };
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
