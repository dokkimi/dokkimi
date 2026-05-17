import type { ChildProcess } from 'child_process';

export interface ExecOptions {
  timeout?: number;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  input?: string;
}

export interface SpawnOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
}

export interface SpawnResult {
  process: ChildProcess;
}

export interface Platform {
  isProcessAlive(pid: number): boolean;
  killProcess(pid: number): Promise<{ forceKilled: boolean }>;
  findProcessesByPattern(pattern: string): number[];
  execSilent(cmd: string, opts?: ExecOptions): string;
  isCommandAvailable(cmd: string): boolean;
  openFile(filePath: string): void;
  startDocker(): void;
  getDiskSpaceAvailable(): number | null;
  spawnInShell(
    cmd: string,
    args: string[],
    opts: SpawnOptions,
    callback: (err: Error | null) => void,
  ): SpawnResult;
}
