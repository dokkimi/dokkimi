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

export function runDirPath(projectPath: string, createdAt: Date): string {
  return path.join(
    projectPath,
    '.dokkimi',
    '__runs__',
    formatRunTimestamp(createdAt),
  );
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
