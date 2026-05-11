import { execSync, execFileSync } from 'child_process';
import type { Platform, ExecOptions } from './platform';

export const unix: Platform = {
  isProcessAlive(pid: number): boolean {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  },

  killProcess(pid: number): Promise<{ forceKilled: boolean }> {
    return new Promise((resolve) => {
      try {
        process.kill(-pid, 'SIGTERM');
      } catch {
        try {
          process.kill(pid, 'SIGTERM');
        } catch {
          resolve({ forceKilled: false });
          return;
        }
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
            process.kill(-pid, 'SIGKILL');
          } catch {}
          try {
            process.kill(pid, 'SIGKILL');
          } catch {}
          resolve({ forceKilled: true });
        }
      }, 500);
    });
  },

  findProcessesByPattern(pattern: string): number[] {
    try {
      const output = execSync(`pgrep -f "${pattern}"`, {
        encoding: 'utf8',
        timeout: 5000,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
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
      execSync(`which ${cmd}`, {
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
    // Prefer VS Code, then fall back to OS default
    try {
      execFileSync('code', [filePath], { stdio: 'ignore' });
      return;
    } catch {}
    try {
      if (process.platform === 'darwin') {
        execFileSync('open', ['-t', filePath], { stdio: 'ignore' });
      } else {
        execFileSync('xdg-open', [filePath], { stdio: 'ignore' });
      }
    } catch {}
  },

  startDocker(): void {
    try {
      if (process.platform === 'darwin') {
        execSync('open -gja Docker', {
          encoding: 'utf8',
          stdio: ['pipe', 'pipe', 'pipe'],
          timeout: 5000,
        });
      } else {
        execSync('systemctl start docker', {
          encoding: 'utf8',
          stdio: ['pipe', 'pipe', 'pipe'],
          timeout: 5000,
        });
      }
    } catch {}
  },

  getDiskSpaceAvailable(): number | null {
    try {
      const output = execSync("df -h ~ | tail -1 | awk '{print $4}'", {
        encoding: 'utf8',
        timeout: 5000,
        stdio: ['pipe', 'pipe', 'pipe'],
      }).trim();

      const match = output.match(/^([\d.]+)([GMTK])/i);
      if (!match) {
        return null;
      }
      const value = parseFloat(match[1]);
      const unit = match[2].toUpperCase();
      if (unit === 'T') {
        return value * 1024;
      }
      if (unit === 'G') {
        return value;
      }
      if (unit === 'M') {
        return value / 1024;
      }
      return value / (1024 * 1024);
    } catch {
      return null;
    }
  },
};
