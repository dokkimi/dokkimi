export interface ExecOptions {
  timeout?: number;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  input?: string;
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
}
