export interface ExecOptions {
  timeout?: number;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  input?: string;
}

export interface Platform {
  isProcessAlive(pid: number): boolean;
  killProcess(pid: number): Promise<{ forceKilled: boolean }>;
  /**
   * When a running process started (ms since the epoch, to the second), or
   * null when there is none or it can't be read. With the PID it identifies a
   * process: a PID is reused, a start time isn't.
   */
  processStartTime(pid: number): number | null;
  execSilent(cmd: string, opts?: ExecOptions): string;
  isCommandAvailable(cmd: string): boolean;
  openFile(filePath: string): void;
  startDocker(): void;
  getDiskSpaceAvailable(): number | null;
}
