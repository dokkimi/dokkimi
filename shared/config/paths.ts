import * as os from 'os';
import * as path from 'path';

export const DOKKIMI_DIR = path.join(os.homedir(), '.dokkimi');

export function formatRunTimestamp(date: Date): string {
  const y = date.getFullYear();
  const mo = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  const h = String(date.getHours()).padStart(2, '0');
  const mi = String(date.getMinutes()).padStart(2, '0');
  const s = String(date.getSeconds()).padStart(2, '0');
  return `${y}${mo}${d}-${h}${mi}${s}`;
}

export function projectRunsDir(projectPath: string): string {
  const stripped = projectPath.replace(/^\//, '');
  return path.join(DOKKIMI_DIR, 'runs', stripped);
}

export function runDirPath(projectPath: string, createdAt: Date): string {
  return path.join(projectRunsDir(projectPath), formatRunTimestamp(createdAt));
}

export function dumpPath(
  projectPath: string,
  createdAt: Date,
  failed = false,
): string {
  return path.join(
    runDirPath(projectPath, createdAt),
    failed ? 'dump_failed.json' : 'dump.json',
  );
}
